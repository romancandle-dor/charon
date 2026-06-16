import { db } from './connection.js';
import { now, json } from '../utils.js';

const MIN_SAMPLES = 10;
const WEIGHT_FLOOR = 0.3;
const WEIGHT_CEILING = 2.5;
const BOOST_FACTOR = 1.05;
const DECAY_FACTOR = 0.95;
const RECALC_EVERY = 5;

export function defaultWeights() {
  return {
    top_bundler_trader_percentage: 1.0,
    top_rat_trader_percentage: 1.0,
    top_10_holder_rate: 1.0,
    holder_200: 1.0,
    liquidity_5000: 1.0,
    volume_24h_20000: 1.0,
    trending_rank_50: 1.0,
    organic_score_50: 1.0,
    smart_wallets_15: 1.0,
    gmgn_fees_2: 1.0,
    top_bundler_trader_percentage_penalty: 1.0,
    top_rat_trader_percentage_penalty: 1.0,
  };
}

export function ensureWeightsTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS signal_weights (
      signal TEXT PRIMARY KEY,
      weight REAL NOT NULL DEFAULT 1.0,
      wins INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0,
      last_recalc_ms INTEGER
    );
    CREATE TABLE IF NOT EXISTS weight_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signal TEXT NOT NULL,
      weight REAL NOT NULL,
      created_at_ms INTEGER NOT NULL,
      reason TEXT
    );
  `);
  const insert = db.prepare('INSERT OR IGNORE INTO signal_weights (signal, weight) VALUES (?, ?)');
  for (const key of Object.keys(defaultWeights())) insert.run(key, 1.0);
}

export function signalWeight(signal) {
  const row = db.prepare('SELECT weight FROM signal_weights WHERE signal = ?').get(signal);
  return row ? row.weight : 1.0;
}

export function allSignalWeights() {
  const rows = db.prepare('SELECT signal, weight, wins, losses FROM signal_weights').all();
  const map = {};
  for (const row of rows) map[row.signal] = row.weight;
  return map;
}

export function recordWeightSignal(signal, won) {
  const field = won ? 'wins' : 'losses';
  db.prepare(`UPDATE signal_weights SET ${field} = ${field} + 1 WHERE signal = ?`).run(signal);
}

export function recordPositionSignals(position) {
  if (!position || position.status !== 'closed') return;
  const won = Number(position.pnl_percent || 0) > 0;
  let candidate = {};
  try {
    const snapshot = JSON.parse(position.snapshot_json || '{}');
    candidate = snapshot?.candidate || {};
  } catch {}
  const g = candidate.gmgn || {};
  const gStat = g.stat || {};
  const gPrice = g.price || {};
  const tags = g.wallet_tags_stat || {};
  const m = candidate.metrics || {};
  const trending = candidate.trending || {};
  const num = (v) => Number(v) || 0;
  if (num(gStat.top_bundler_trader_percentage) < 0.5) recordWeightSignal('top_bundler_trader_percentage', won);
  if (num(gStat.top_rat_trader_percentage) < 0.3) recordWeightSignal('top_rat_trader_percentage', won);
  if (num(gStat.top_10_holder_rate) < 0.4) recordWeightSignal('top_10_holder_rate', won);
  if ((num(m.holderCount) || num(g.holder_count)) >= 200) recordWeightSignal('holder_200', won);
  if ((num(m.liquidityUsd) || num(g.liquidity)) >= 5000) recordWeightSignal('liquidity_5000', won);
  if (num(gPrice.volume_24h) >= 20000) recordWeightSignal('volume_24h_20000', won);
  if ((num(trending.rank) || 999) <= 50) recordWeightSignal('trending_rank_50', won);
  if (num(trending.organicScore) >= 50) recordWeightSignal('organic_score_50', won);
  if (num(tags.smart_wallets) >= 15) recordWeightSignal('smart_wallets_15', won);
  if (num(m.gmgnTotalFeesSol) >= 2) recordWeightSignal('gmgn_fees_2', won);
  const closeCount = db.prepare('SELECT COUNT(*) AS cnt FROM dry_run_positions WHERE status = ?').get('closed').cnt;
  recalcWeightsIfDue(closeCount);
}

export function recalcWeightsIfDue(closeCount) {
  // DISABLED (madss takeover 2026-06-16): naive winRate>0.5 ? boost : decay
  // spiraled ALL weights toward the 0.3 floor at the bot's normal ~35% WR
  // (asymmetric-payoff trench trading targets a low WR with big winners).
  // Decaying weights crushed rule-based scores so confidence capped at ~49 < 60
  // threshold and Charon opened 0 positions for 27h. Weights now frozen at 1.0.
  // Re-enable only with PnL-weighted logic, not raw win-count.
  return false;
  // eslint-disable-next-line no-unreachable
  if (closeCount < MIN_SAMPLES || closeCount % RECALC_EVERY !== 0) return false;
  const signals = db.prepare('SELECT * FROM signal_weights').all();
  const total = signals.reduce((s, r) => s + r.wins + r.losses, 0);
  if (total < MIN_SAMPLES) return false;
  let changed = false;
  for (const row of signals) {
    const totalRow = row.wins + row.losses;
    if (totalRow < 3) continue;
    const winRate = row.wins / totalRow;
    const direction = winRate > 0.5 ? BOOST_FACTOR : DECAY_FACTOR;
    const newWeight = Math.max(WEIGHT_FLOOR, Math.min(WEIGHT_CEILING, row.weight * direction));
    if (Math.abs(newWeight - row.weight) > 0.01) {
      const reason = `${row.wins}/${totalRow} wins -> ${direction > 1 ? 'boost' : 'decay'} ${row.weight.toFixed(2)} -> ${newWeight.toFixed(2)}`;
      db.prepare('UPDATE signal_weights SET weight = ?, last_recalc_ms = ? WHERE signal = ?')
        .run(newWeight, now(), row.signal);
      db.prepare('INSERT INTO weight_history (signal, weight, created_at_ms, reason) VALUES (?, ?, ?, ?)')
        .run(row.signal, newWeight, now(), reason);
      changed = true;
    }
  }
  if (changed) console.log('[weights] recalculated from', signals.length, 'signals');
  return changed;
}
