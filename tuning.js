import { db } from './src/db/connection.js';
import { now } from './src/utils.js';
import { numSetting, setSetting } from './src/db/settings.js';
import { evolveThresholds } from './src/db/thresholds.js';
import { recalcWeightsIfDue } from './src/db/weights.js';
import { clearExpiredCooldowns } from './src/db/cooldowns.js';

const LOG_PREFIX = '[tuning]';

async function analyze() {
  const closed = db.prepare(`
    SELECT id, symbol, pnl_percent, pnl_sol, exit_reason, strategy_id, execution_mode, opened_at_ms, closed_at_ms
    FROM dry_run_positions WHERE status = 'closed' AND pnl_percent IS NOT NULL
    ORDER BY closed_at_ms DESC
  `).all();

  if (closed.length < 5) {
    console.log(`${LOG_PREFIX} only ${closed.length} closed positions, need ≥5`);
    return;
  }

  const recent = closed.slice(0, 20);
  const wins = recent.filter(p => Number(p.pnl_percent) > 0);
  const losses = recent.filter(p => Number(p.pnl_percent) < 0);
  const winRate = wins.length / recent.length;
  const avgPnl = recent.reduce((s, p) => s + Number(p.pnl_percent), 0) / recent.length;
  const avgWinPnl = wins.length ? wins.reduce((s, p) => s + Number(p.pnl_percent), 0) / wins.length : 0;
  const avgLossPnl = losses.length ? losses.reduce((s, p) => s + Number(p.pnl_percent), 0) / losses.length : 0;
  const totalPnlSol = closed.reduce((s, p) => s + Number(p.pnl_sol || 0), 0);

  const byStrategy = {};
  for (const p of closed) {
    const s = p.strategy_id || 'unknown';
    if (!byStrategy[s]) byStrategy[s] = { total: 0, wins: 0, pnl: 0 };
    byStrategy[s].total++;
    if (Number(p.pnl_percent) > 0) byStrategy[s].wins++;
    byStrategy[s].pnl += Number(p.pnl_percent);
  }

  const byExit = {};
  for (const p of closed) {
    const r = p.exit_reason || 'unknown';
    if (!byExit[r]) byExit[r] = { total: 0, wins: 0, pnl: 0 };
    byExit[r].total++;
    if (Number(p.pnl_percent) > 0) byExit[r].wins++;
    byExit[r].pnl += Number(p.pnl_percent);
  }

  const avgHold = closed.reduce((s, p) => {
    if (p.opened_at_ms && p.closed_at_ms) return s + (p.closed_at_ms - p.opened_at_ms);
    return s;
  }, 0) / closed.length;

  const changes = [];

  const currentConfidence = numSetting('llm_min_confidence', 75);
  const currentMaxOpen = numSetting('max_open_positions', 3);
  const currentBuySol = numSetting('dry_run_buy_sol', 0.1);

  if (winRate < 0.25 && currentConfidence > 50) {
    const newConf = Math.max(50, currentConfidence - 10);
    setSetting('llm_min_confidence', String(newConf));
    changes.push(`low WR ${(winRate * 100).toFixed(0)}% → llm_min_confidence ${currentConfidence}→${newConf}`);
  } else if (winRate > 0.45 && currentConfidence < 90) {
    const newConf = Math.min(99, currentConfidence + 5);
    setSetting('llm_min_confidence', String(newConf));
    changes.push(`high WR ${(winRate * 100).toFixed(0)}% → llm_min_confidence ${currentConfidence}→${newConf}`);
  }

  const worstStrategy = Object.entries(byStrategy).sort((a, b) => a[1].pnl / a[1].total - b[1].pnl / b[1].total)[0];
  if (worstStrategy && worstStrategy[1].total >= 5 && worstStrategy[1].pnl / worstStrategy[1].total < -15) {
    console.log(`${LOG_PREFIX} worst strategy: ${worstStrategy[0]} avg ${(worstStrategy[1].pnl / worstStrategy[1].total).toFixed(1)}% (${worstStrategy[1].total} closes)`);
  }

  const lossExits = byExit.SL || byExit.TRAILING_TP?.pnl < 0 ? { total: 0, pnl: 0 } : { total: 0, pnl: 0 };
  const slData = byExit.SL;
  if (slData && slData.total >= 5 && (slData.pnl / slData.total) < -15) {
    const currentSl = numSetting('default_sl_percent', -25);
    const newSl = Math.min(-25, currentSl + 5);
    setSetting('default_sl_percent', String(newSl));
    changes.push(`deep SL losses avg ${(slData.pnl / slData.total).toFixed(1)}% → default_sl_percent ${currentSl}→${newSl}`);
  }

  if (totalPnlSol > 0 && currentBuySol < 1.0) {
    const newSize = Math.min(1.0, currentBuySol + 0.05);
    setSetting('dry_run_buy_sol', String(newSize));
    changes.push(`profitable (${totalPnlSol.toFixed(3)} SOL) → dry_run_buy_sol ${currentBuySol}→${newSize}`);
  } else if (totalPnlSol < -0.5 && currentBuySol > 0.05) {
    const newSize = Math.max(0.03, currentBuySol - 0.03);
    setSetting('dry_run_buy_sol', String(newSize));
    changes.push(`losing (${totalPnlSol.toFixed(3)} SOL) → dry_run_buy_sol ${currentBuySol}→${newSize}`);
  }

  if (!changes.length) {
    console.log(`${LOG_PREFIX} no changes needed — WR ${(winRate * 100).toFixed(0)}% avg ${avgPnl.toFixed(1)}% (${wins.length}W/${losses.length}L) total ${totalPnlSol.toFixed(3)} SOL`);
  } else {
    console.log(`${LOG_PREFIX} ${changes.join(' | ')}`);
  }

  return {
    closed: closed.length,
    window: recent.length,
    wins: wins.length,
    losses: losses.length,
    winRate,
    avgPnl,
    avgWinPnl,
    avgLossPnl,
    totalPnlSol,
    avgHoldMs: avgHold,
    byStrategy,
    byExit,
    changes,
  };
}

async function tune() {
  console.log(`\n${LOG_PREFIX} === tune cycle ${new Date().toISOString()} ===`);
  try {
    clearExpiredCooldowns();
    const closedCount = db.prepare("SELECT COUNT(*) AS c FROM dry_run_positions WHERE status='closed' AND pnl_percent IS NOT NULL").get().c;
    recalcWeightsIfDue(closedCount);
    const result = await evolveThresholds();
    if (result?.changes?.length) {
      console.log(`${LOG_PREFIX} thresholds evolved: ${result.changes.join(', ')}`);
    }
    const analysis = await analyze();
    return analysis;
  } catch (err) {
    console.error(`${LOG_PREFIX} error:`, err.message);
  }
}

if (process.argv[1]?.endsWith('tuning.js')) {
  tune().then(r => {
    if (r) console.log(`${LOG_PREFIX} done — WR ${(r.winRate * 100).toFixed(0)}% (${r.wins}/${r.window}) avg ${r.avgPnl.toFixed(1)}%`);
    process.exit(0);
  }).catch(e => { console.error(e); process.exit(1); });
}

export { tune, analyze };
