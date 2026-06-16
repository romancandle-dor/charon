import { now, pruneSeen } from '../utils.js';
import { numSetting, boolSetting } from '../db/settings.js';
import { upsertCandidate, updateCandidateStatus, recentEligibleCandidates, candidateById } from '../db/candidates.js';
import { storeDecision, storeBatchDecision, logDecisionEvent } from '../db/decisions.js';
import { enrichCandidate, filterForStrategy } from './candidateBuilder.js';
import { decideCandidateBatch } from './llm.js';
import { allEnabledStrategies } from '../db/settings.js';
import { createDryRunPosition, createLivePosition, canOpenMorePositions, openPositionCount, tradingMode } from '../db/positions.js';
import { sendBatchReveal, sendTelegram, sendPositionOpen, sendTradeIntent } from '../telegram/send.js';
import { candidateSummary } from '../telegram/format.js';
import { createTradeIntent } from '../db/intents.js';
import { isMintOnCooldown, isRouteOnCooldown } from '../db/cooldowns.js';
import { refreshCandidateForExecution, evictWeakestForEntry } from '../execution/positions.js';
import { executeLiveBuy } from '../execution/router.js';
import { graduated } from '../signals/graduated.js';
import { setDegenHandler } from '../signals/trending.js';
import { setCandidateHandler } from '../signals/feeClaim.js';
import { short } from '../format.js';
import { escapeHtml } from '../format.js';

export const seenSignalCandidates = new Map();

setDegenHandler(maybeProcessDegenCandidate);
setCandidateHandler(processCandidateFromSignals);

async function processForStrategy(signals, strat, base) {
  if (!canOpenMorePositions()) {
    // If replace-weakest is enabled (and this strat is eligible), don't drop the
    // signal here — let it flow through filters/decision and evict at the BUY gate.
    const replaceEligible = boolSetting('replace_weakest_when_full', false)
      && (!boolSetting('replace_only_sniper', true) || strat.id === 'sniper');
    if (!replaceEligible) {
      const max = numSetting('max_open_positions', 3);
      console.log(`[${strat.id}] max positions (${openPositionCount()}/${max}), skip ${signals.mint.slice(0, 8)}`);
      return;
    }
  }

  const mintCooldown = isMintOnCooldown(signals.mint);
  if (mintCooldown) {
    console.log(`[${strat.id}] cooldown ${signals.mint.slice(0, 8)} (${(mintCooldown / 60000).toFixed(0)}m remaining)`);
    return;
  }

  const route = signals.route || signals.label || 'unknown';
  const routeCooldown = isRouteOnCooldown(route);
  if (routeCooldown) {
    // Smart-money override: a token with strong smart_degen/sniper presence is a
    // different beast from whatever rugged the route. Don't let a blanket route
    // cooldown blind the sniper to a high-conviction runner. Mint cooldown still
    // applies (checked above) so we never re-buy the exact loser.
    const sd = Number(base.trending?.smart_degen_count ?? base.metrics?.trendingSmartDegenCount ?? 0);
    const snp = Number(base.trending?.sniper_count ?? 0);
    const bypassSd = numSetting('route_cooldown_bypass_smart_degen', 0);
    const bypassSnp = numSetting('route_cooldown_bypass_sniper', 0);
    const bypass = (bypassSd > 0 && sd >= bypassSd) || (bypassSnp > 0 && snp >= bypassSnp);
    if (bypass) {
      console.log(`[${strat.id}] route cooldown ${route} BYPASSED for ${signals.mint.slice(0, 8)} (sd=${sd}/snp=${snp})`);
    } else {
      console.log(`[${strat.id}] route cooldown ${route} (${(routeCooldown / 60000).toFixed(0)}m remaining)`);
      return;
    }
  }

  const candidate = filterForStrategy(base, strat);
  const signature = signals.signature || null;
  const candidateId = upsertCandidate(candidate, signature);

  if (!candidate.filters.passed) {
    console.log(`[${strat.id}] filtered ${candidate.token.mint.slice(0, 8)}... ${candidate.filters.failures.join('; ')}`);
    return;
  }

  let rows, batchDecision, batchId;

  if (!strat.use_llm) {
    const selfRow = candidateById(candidateId);
    rows = selfRow ? [selfRow] : [];
    batchId = null;
    batchDecision = {
      verdict: 'BUY',
      confidence: 100,
      selected_candidate_id: candidateId,
      selected_mint: candidate.token.mint,
      selected_row: selfRow,
      reason: `Strategy '${strat.id}' is rule-based (use_llm: false); filters passed.`,
      risks: [],
      suggested_tp_percent: strat.tp_percent ?? numSetting('default_tp_percent', 50),
      suggested_sl_percent: strat.sl_percent ?? numSetting('default_sl_percent', -25),
      raw: null,
    };
  } else {
    rows = recentEligibleCandidates(numSetting('llm_candidate_pick_count', 10));
    batchDecision = await decideCandidateBatch(rows, candidateId);
    batchId = storeBatchDecision(candidateId, rows, batchDecision);
  }

  const selectedRow = batchDecision.selected_row;
  const selectedThisCandidate = selectedRow?.id === candidateId;
  const currentDecision = selectedThisCandidate
    ? batchDecision
    : {
        ...batchDecision,
        verdict: 'WATCH',
        reason: selectedRow
          ? `Batch #${batchId} screened ${rows.length}; selected ${short(selectedRow.candidate.token.mint)} instead. ${batchDecision.reason || ''}`.trim()
          : `Batch #${batchId} screened ${rows.length}; no buy selected. ${batchDecision.reason || ''}`.trim(),
      };

  const stratLabel = strat.name || strat.id;
  const currentDecisionId = storeDecision(candidateId, candidate, { ...currentDecision, strategy_id: strat.id });
  currentDecision.id = currentDecisionId;
  updateCandidateStatus(candidateId, currentDecision.verdict.toLowerCase());

  if (selectedRow && !selectedThisCandidate) {
    const selectedDecisionId = storeDecision(selectedRow.id, selectedRow.candidate, { ...batchDecision, strategy_id: strat.id });
    batchDecision.id = selectedDecisionId;
    updateCandidateStatus(selectedRow.id, batchDecision.verdict.toLowerCase());
  } else if (selectedThisCandidate) {
    batchDecision.id = currentDecisionId;
  }

  if (batchId) await sendBatchReveal(batchId, rows, batchDecision, candidateId);

  const agentEnabled = boolSetting('agent_enabled', true);
  const minConfidence = numSetting('llm_min_confidence', 60);

  if (selectedRow && agentEnabled && batchDecision.verdict === 'BUY' && batchDecision.confidence >= minConfidence) {
    if (!canOpenMorePositions()) {
      // Try replace-weakest-when-full before giving up the slot.
      const evicted = await evictWeakestForEntry(strat);
      if (!evicted || !canOpenMorePositions()) {
        const max = numSetting('max_open_positions', 3);
        console.log(`[${strat.id}] max positions (${openPositionCount()}/${max}), skip buy ${selectedRow.candidate.token.mint}`);
        logDecisionEvent({
          batchId, triggerCandidateId: candidateId, selectedRow, rows, decision: batchDecision,
          action: 'entry_skipped_max_positions',
          guardrails: { maxOpenPositions: max, openPositions: openPositionCount(), strategy: strat.id, replaceAttempted: Boolean(boolSetting('replace_weakest_when_full', false)) },
        });
        return;
      }
      console.log(`[${strat.id}] replaced #${evicted.id} (${evicted.victimPnl?.toFixed?.(1)}%) to free slot for ${selectedRow.candidate.token.mint.slice(0, 8)}`);
    }
    await handleApprovedBuy(selectedRow, batchDecision, batchId, rows, candidateId, strat);
  } else {
    logDecisionEvent({
      batchId, triggerCandidateId: candidateId, selectedRow, rows, decision: batchDecision,
      action: selectedRow ? 'entry_not_approved' : 'no_candidate_selected',
      guardrails: {
        agentEnabled, confidenceThreshold: minConfidence,
        openPositions: openPositionCount(), maxOpenPositions: numSetting('max_open_positions', 3),
        strategy: strat.id,
      },
    });
  }
}

function dedupKey(mint, stratId, bucket) {
  return `${stratId}:${mint}:${bucket}`;
}

export async function processCandidateFromSignals(signals) {
  const strats = allEnabledStrategies();
  if (strats.length === 0) return;
  if (!canOpenMorePositions()) {
    // Only short-circuit here if replace-weakest is OFF (or no enabled strat is
    // eligible). Otherwise let strategies run so the BUY gate can evict.
    const anyReplaceEligible = boolSetting('replace_weakest_when_full', false)
      && (!boolSetting('replace_only_sniper', true) || strats.some(s => s.id === 'sniper'));
    if (!anyReplaceEligible) {
      const max = numSetting('max_open_positions', 3);
      console.log(`[agent] max positions (${openPositionCount()}/${max}), skip ${signals.mint.slice(0, 8)}`);
      return;
    }
  }

  const bucket = Math.floor(now() / (10 * 60 * 1000));
  pruneSeen(seenSignalCandidates, 30 * 60 * 1000);

  const deduplicated = strats.filter(s => {
    const key = dedupKey(signals.mint, s.id, bucket);
    if (seenSignalCandidates.has(key)) return false;
    seenSignalCandidates.set(key, now());
    return true;
  });
  if (deduplicated.length === 0) return;

  const base = await enrichCandidate(signals);
  for (const strat of deduplicated) {
    await processForStrategy(signals, strat, base);
  }
}

export async function handleApprovedBuy(selectedRow, decision, batchId, rows = [], triggerCandidateId = null, strat = null) {
  const mode = tradingMode();
  if (!strat) strat = { id: 'unknown', position_size_sol: numSetting('dry_run_buy_sol', 0.1), tp_percent: numSetting('default_tp_percent', 50), sl_percent: numSetting('default_sl_percent', -25), trailing_enabled: boolSetting('default_trailing_enabled', true), trailing_percent: numSetting('default_trailing_percent', 20) };
  const freshSelectedRow = await refreshCandidateForExecution(selectedRow, strat);
  const executionRows = rows.map(row => row.id === freshSelectedRow.id ? freshSelectedRow : row);
  if (!freshSelectedRow.candidate.filters?.passed) {
    updateCandidateStatus(freshSelectedRow.id, 'stale_rejected');
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'entry_rejected_fresh_filters',
      guardrails: {
        failures: freshSelectedRow.candidate.filters?.failures || [],
        refreshedAtMs: freshSelectedRow.candidate.executionRefresh?.refreshedAtMs,
      },
    });
    await sendTelegram([
      '🛑 <b>Execution rejected on fresh check</b>',
      '',
      candidateSummary(freshSelectedRow.candidate, decision),
      '',
      `Failures: ${escapeHtml((freshSelectedRow.candidate.filters?.failures || []).join('; ') || 'fresh execution guard failed')}`,
    ].join('\n'));
    return;
  }

  if (mode === 'dry_run') {
    const positionId = await createDryRunPosition(freshSelectedRow.id, freshSelectedRow.candidate, decision, `llm_batch_${batchId}`, strat);
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'dry_run_entry',
      guardrails: { maxOpenPositions: numSetting('max_open_positions', 3), openPositions: openPositionCount(), strategy: strat.id },
      execution: { positionId },
    });
    await sendPositionOpen(positionId);
    return;
  }

  if (mode === 'confirm') {
    const intentId = createTradeIntent(freshSelectedRow.id, freshSelectedRow.candidate, decision, mode, 'pending_confirmation');
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'confirm_intent_created',
      guardrails: { maxOpenPositions: numSetting('max_open_positions', 3), openPositions: openPositionCount(), strategy: strat.id },
      execution: { intentId },
    });
    await sendTradeIntent(intentId, freshSelectedRow.candidate, decision);
    return;
  }

  try {
    await executeLiveBuy(freshSelectedRow, decision, batchId, executionRows, triggerCandidateId);
  } catch (err) {
    const intentId = createTradeIntent(freshSelectedRow.id, freshSelectedRow.candidate, decision, mode, 'execution_failed');
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'live_entry_failed',
      guardrails: { maxOpenPositions: numSetting('max_open_positions', 3), openPositions: openPositionCount(), strategy: strat.id },
      execution: { intentId, error: err.message },
    });
    await sendTelegram([
      '🛑 <b>Live trade failed</b>',
      '',
      candidateSummary(freshSelectedRow.candidate, decision),
      '',
      `Intent #${intentId} stored.`,
      `Error: ${escapeHtml(err.message)}`,
    ].join('\n'));
  }
}

export async function maybeProcessDegenCandidate(mint, trendingToken) {
  if (!boolSetting('trending_allow_degen', false)) return;
  pruneSeen(seenSignalCandidates, 10 * 60 * 1000);
  const bucket = Math.floor(now() / (5 * 60 * 1000));
  const key = `trending:${mint}:${bucket}`;
  if (seenSignalCandidates.has(key)) return;
  seenSignalCandidates.set(key, now());
  const graduatedCoin = graduated.get(mint);
  await processCandidateFromSignals({
    mint,
    graduatedCoin: graduatedCoin || null,
    trendingToken,
    route: graduatedCoin ? 'graduated_trending' : 'trending',
  });
}
