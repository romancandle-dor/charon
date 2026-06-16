import { db } from './connection.js';
import { now } from '../utils.js';

const LOSS_COOLDOWN_MS = 1 * 60 * 60 * 1000;
const REPEAT_LOSS_COOLDOWN_MS = 4 * 60 * 60 * 1000;
const ROUTE_LOSS_THRESHOLD = 3;

export function applyCooldownOnClose(position, summary) {
  if (!position || position.status !== 'closed') return;
  const pnl = Number(position.pnl_percent || 0);
  if (pnl >= 0) return;
  const mint = position.mint;
  const candidate = safeJsonCandidate(position.snapshot_json);
  const route = candidate?.signals?.route || candidate?.signals?.label || 'unknown';
  const stratId = position.strategy_id || 'unknown';
  const recentLossesForRoute = db.prepare(`
    SELECT COUNT(*) AS cnt FROM cooldowns
    WHERE route = ? AND cooldown_until_ms > ? AND close_pnl_percent < 0
  `).get(route, now()).cnt;
  const cooldownMs = recentLossesForRoute >= ROUTE_LOSS_THRESHOLD
    ? REPEAT_LOSS_COOLDOWN_MS
    : LOSS_COOLDOWN_MS;
  db.prepare(`
    INSERT OR IGNORE INTO cooldowns (mint, route, strategy_id, cooldown_until_ms, reason, created_at_ms, close_pnl_percent)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(mint, route, stratId, now() + cooldownMs, `loss ${pnl.toFixed(1)}%`, now(), pnl);
  console.log(`[cooldown] ${mint.slice(0, 8)} (${route}) → ${(cooldownMs / 3600000).toFixed(0)}h cooldown, pnl=${pnl.toFixed(1)}%`);
}

export function isMintOnCooldown(mint) {
  const row = db.prepare(`
    SELECT cooldown_until_ms FROM cooldowns WHERE mint = ? AND cooldown_until_ms > ? ORDER BY cooldown_until_ms DESC LIMIT 1
  `).get(mint, now());
  if (!row) return null;
  const remaining = row.cooldown_until_ms - now();
  return remaining > 0 ? remaining : null;
}

export function isRouteOnCooldown(route) {
  const row = db.prepare(`
    SELECT cooldown_until_ms FROM cooldowns WHERE route = ? AND cooldown_until_ms > ? ORDER BY cooldown_until_ms DESC LIMIT 1
  `).get(route, now());
  if (!row) return null;
  const remaining = row.cooldown_until_ms - now();
  return remaining > 0 ? remaining : null;
}

export function activeCooldowns() {
  return db.prepare(`
    SELECT mint, route, strategy_id, cooldown_until_ms, reason, close_pnl_percent, created_at_ms
    FROM cooldowns
    WHERE cooldown_until_ms > ?
    ORDER BY cooldown_until_ms ASC
  `).all(now());
}

export function clearCooldown(mintOrRoute) {
  db.prepare(`
    DELETE FROM cooldowns WHERE mint = ? OR route = ?
  `).run(mintOrRoute, mintOrRoute);
}

export function clearExpiredCooldowns() {
  db.prepare('DELETE FROM cooldowns WHERE cooldown_until_ms <= ?').run(now());
}

function safeJsonCandidate(snapshotJson) {
  try {
    const parsed = JSON.parse(snapshotJson);
    return parsed?.candidate || {};
  } catch {
    return {};
  }
}
