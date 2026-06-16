import axios from 'axios';
import { ENABLE_LLM, LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, LLM_TIMEOUT_MS } from '../config.js';
import { now, stripThinking, strictJsonFromText } from '../utils.js';
import { numSetting } from '../db/settings.js';
import { db } from '../db/connection.js';
import { allSignalWeights } from '../db/weights.js';

export function normalizeDecision(parsed, fallbackReason = '') {
  const verdict = ['BUY', 'WATCH', 'PASS'].includes(String(parsed?.verdict).toUpperCase())
    ? String(parsed.verdict).toUpperCase()
    : 'WATCH';
  return {
    verdict,
    confidence: Math.max(0, Math.min(100, Number(parsed?.confidence) || 0)),
    reason: String(parsed?.reason || fallbackReason).slice(0, 1000),
    risks: Array.isArray(parsed?.risks) ? parsed.risks.map(String).slice(0, 8) : [],
    suggested_tp_percent: Number(parsed?.suggested_tp_percent) || numSetting('default_tp_percent', 50),
    suggested_sl_percent: Number(parsed?.suggested_sl_percent) || numSetting('default_sl_percent', -25),
    raw: parsed,
  };
}

export function activeLessonsForPrompt(limit = 6) {
  const rows = db.prepare(`
    SELECT lesson, category, priority
    FROM learning_lessons
    WHERE status = 'active'
    ORDER BY priority DESC, id DESC
    LIMIT ?
  `).all(limit);
  return rows.map(row => row.category !== 'general'
    ? `[${row.category}] ${row.lesson}`
    : row.lesson
  );
}

export function compactCandidateForLlm(row) {
  const c = row.candidate;
  const athWindow = c.chart?.windows?.find(window => window.label === 'ath_context_24h_5m' && window.available)
    || c.chart?.windows?.find(window => window.label === 'recent_24h_5m' && window.available);
  return {
    candidate_id: row.id,
    mint: c.token?.mint,
    route: c.signals?.route,
    signals: c.signals,
    token: c.token,
    metrics: c.metrics,
    feeClaim: c.feeClaim,
    trending: c.trending,
    graduation: c.graduation,
    holders: c.holders,
    chart: {
      purpose: 'ATH/range context only. Do not treat large 24h change as bullish/bearish momentum by itself.',
      currentNative: c.chart?.currentNative,
      rangeHighNative: c.chart?.rangeHighNative,
      distanceFromAthPercent: c.chart?.distanceFromAthPercent ?? c.chart?.belowRangeHighPercent,
      topBlastRisk: c.chart?.topBlastRisk,
      athContext24h: athWindow ? {
        current: athWindow.current,
        high: athWindow.high,
        low: athWindow.low,
        distanceFromHighPercent: athWindow.belowHighPercent,
        aboveLowPercent: athWindow.aboveLowPercent,
      } : null,
      windows: c.chart?.windows,
    },
    savedWalletExposure: c.savedWalletExposure,
    twitterNarrative: c.twitterNarrative,
    filters: c.filters,
  };
}

// Rule-based fallback picker used when LLM is disabled or LLM_API_KEY is missing.
// Scores each candidate by on-chain + market signals and returns the strongest
// eligible row as a BUY. Mirrors the LLM's expected return shape so downstream
// code (orchestrator, position creation) works without changes.
function ruleBasedPick(rows, triggerCandidateId) {
  const weights = allSignalWeights();
  const eligible = [];
  const maxScore = 140;
  for (const r of rows || []) {
    if (!r) continue;
    const c = r.candidate || {};
    if (c.filters && c.filters.passed === false) continue;
    const m = c.metrics || {};
    const g = c.gmgn || {};
    const gStat = g.stat || {};
    const gPrice = g.price || {};
    const tags = g.wallet_tags_stat || {};
    const trending = c.trending || {};

    const num = (v) => Number(v) || 0;
    const w = (sig) => weights[sig] ?? 1.0;
    let score = 0;
    score += (num(gStat.top_bundler_trader_percentage) < 0.5 ? 20 * w('top_bundler_trader_percentage') : -10 * w('top_bundler_trader_percentage_penalty'));
    score += (num(gStat.top_rat_trader_percentage) < 0.3 ? 20 * w('top_rat_trader_percentage') : -10 * w('top_rat_trader_percentage_penalty'));
    score += (num(gStat.top_10_holder_rate) < 0.4 ? 10 * w('top_10_holder_rate') : 0);
    score += ((num(m.holderCount) || num(g.holder_count)) >= 200 ? 20 * w('holder_200') : 0);
    score += ((num(m.liquidityUsd) || num(g.liquidity)) >= 5000 ? 20 * w('liquidity_5000') : 0);
    score += (num(gPrice.volume_24h) >= 20000 ? 20 * w('volume_24h_20000') : 0);
    score += ((num(trending.rank) || 999) <= 50 ? 10 * w('trending_rank_50') : 0);
    score += (num(trending.organicScore) >= 50 ? 10 * w('organic_score_50') : 0);
    score += (num(tags.smart_wallets) >= 15 ? 5 * w('smart_wallets_15') : 0);
    score += (num(m.gmgnTotalFeesSol) >= 2 ? 5 * w('gmgn_fees_2') : 0);

    eligible.push({ row: r, score, mint: c.token?.mint || r.mint });
  }

  eligible.sort((a, b) => b.score - a.score);
  const top = eligible[0];
  const tp = numSetting('default_tp_percent', 50);
  const sl = numSetting('default_sl_percent', -25);

  if (!top || top.score < 30) {
    return {
      verdict: 'WATCH',
      confidence: 0,
      selected_candidate_id: null,
      selected_mint: null,
      reason: `Rule-based: no candidate cleared threshold (top score ${top?.score ?? 0}).`,
      risks: ['rule_based_no_pick'],
      suggested_tp_percent: tp,
      suggested_sl_percent: sl,
      raw: null,
    };
  }

  const candId = top.row.id ?? triggerCandidateId ?? null;
  return {
    verdict: 'BUY',
    confidence: Math.min(100, Math.round(top.score / maxScore * 100)),
    selected_candidate_id: candId,
    selected_mint: top.mint,
    selected_row: top.row,
    reason: `Rule-based pick: score ${top.score.toFixed(0)}/${maxScore} (adjusted by learned weights).`,
    risks: ['rule_based_no_llm_review'],
    suggested_tp_percent: tp,
    suggested_sl_percent: sl,
    raw: null,
  };
}

export async function decideCandidateBatch(rows, triggerCandidateId) {
  if (!ENABLE_LLM || !LLM_API_KEY) {
    return ruleBasedPick(rows, triggerCandidateId);
  }

  const system = [
    'You are Charon, a Solana meme coin trench analyst.',
    'Return strict JSON only.',
    'You will receive up to 10 recently matched candidates.',
    'Pick at most one candidate to buy through the configured execution mode.',
    'Use verdict BUY only for the single best unusually strong asymmetric opportunity.',
    'Use WATCH if candidates are interesting but none deserves a buy.',
    'Use PASS if the set is weak or unsafe.',
    'Chart data is ATH/range context. Do not penalize or reward a token only because 24h change is huge; new Pump tokens often do that.',
    'Use distance from ATH/range high and top-blast risk to decide whether entry is late.',
    'Confidence is your conviction from 0 to 100, not probability.',
  ].join(' ');
  const user = {
    task: 'Pick the best dry-run buy candidate from this recent batch, or choose none.',
    recent_lessons: activeLessonsForPrompt(),
    output_schema: {
      verdict: 'BUY|WATCH|PASS',
      selected_candidate_id: 'integer candidate_id when verdict is BUY, otherwise null',
      selected_mint: 'mint string when verdict is BUY, otherwise null',
      confidence: 'number 0-100',
      reason: 'short string',
      risks: ['short strings'],
      suggested_tp_percent: 'positive number',
      suggested_sl_percent: 'negative number',
    },
    trigger_candidate_id: triggerCandidateId,
    candidates: rows.map(compactCandidateForLlm),
  };

  try {
    const res = await axios.post(`${LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      model: LLM_MODEL,
      temperature: 0.2,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(user) },
      ],
    }, {
      timeout: LLM_TIMEOUT_MS,
      headers: { authorization: `Bearer ${LLM_API_KEY}`, 'content-type': 'application/json' },
    });
    const content = res.data?.choices?.[0]?.message?.content || '';
    const parsed = strictJsonFromText(content);
    const decision = normalizeDecision(parsed);
    const selectedId = Number(parsed.selected_candidate_id);
    const selectedMint = String(parsed.selected_mint || '');
    const row = rows.find(item => item.id === selectedId || item.candidate.token?.mint === selectedMint);
    return {
      ...decision,
      selected_candidate_id: decision.verdict === 'BUY' && row ? row.id : null,
      selected_mint: decision.verdict === 'BUY' && row ? row.candidate.token.mint : null,
      selected_row: decision.verdict === 'BUY' && row ? row : null,
    };
  } catch (err) {
    console.log(`[llm] batch failed: ${err.message}`);
    return {
      verdict: 'WATCH',
      confidence: 0,
      selected_candidate_id: null,
      selected_mint: null,
      reason: `LLM failed: ${err.message}`,
      risks: ['llm_error'],
      suggested_tp_percent: numSetting('default_tp_percent', 50),
      suggested_sl_percent: numSetting('default_sl_percent', -25),
      raw: { error: err.message },
    };
  }
}

export async function decideCandidate(candidate) {
  const pseudoRow = { id: 0, candidate };
  const decision = await decideCandidateBatch([pseudoRow], 0);
  return normalizeDecision(decision.raw || decision, decision.reason);
}
