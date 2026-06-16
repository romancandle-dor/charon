import { db } from './connection.js';
import { now } from '../utils.js';
import { numSetting, setSetting } from './settings.js';

const WINDOW_CLOSES = 20;
const MIN_CLOSES = 10;
const TARGET_WIN_RATE = 0.35;
const WIN_RATE_TOLERANCE = 0.05;
const CONFIDENCE_STEP = 5;
const CONFIDENCE_FLOOR = 30;
const CONFIDENCE_CEILING = 99;
const SCORE_STEP = 5;
const SCORE_FLOOR = 15;
const SCORE_CEILING = 80;

export function evolveThresholds() {
  const recent = db.prepare(`
    SELECT pnl_percent, exit_reason
    FROM dry_run_positions
    WHERE status = 'closed'
    ORDER BY closed_at_ms DESC
    LIMIT ?
  `).all(WINDOW_CLOSES);

  if (recent.length < MIN_CLOSES) return null;

  const wins = recent.filter(p => Number(p.pnl_percent || 0) > 0).length;
  const winRate = wins / recent.length;
  const changes = [];

  // Evolve llm_min_confidence
  const currentConfidence = numSetting('llm_min_confidence', 75);
  let newConfidence = currentConfidence;
  if (winRate > TARGET_WIN_RATE + WIN_RATE_TOLERANCE) {
    newConfidence = Math.min(CONFIDENCE_CEILING, currentConfidence + CONFIDENCE_STEP);
  } else if (winRate < TARGET_WIN_RATE - WIN_RATE_TOLERANCE) {
    newConfidence = Math.max(CONFIDENCE_FLOOR, currentConfidence - CONFIDENCE_STEP);
  }
  if (newConfidence !== currentConfidence) {
    setSetting('llm_min_confidence', String(newConfidence));
    changes.push(`llm_min_confidence ${currentConfidence} → ${newConfidence} (WR ${(winRate * 100).toFixed(0)}%)`);
  }

  const result = {
    window: recent.length,
    wins,
    losses: recent.length - wins,
    winRate,
    changes,
  };

  if (changes.length) {
    const pnlSum = recent.reduce((s, p) => s + Number(p.pnl_percent || 0), 0);
    console.log(`[evolve] WR=${(winRate * 100).toFixed(0)}% (${wins}/${recent.length}), avgPnl=${(pnlSum / recent.length).toFixed(1)}% — ${changes.join(', ')}`);
  }

  return result;
}
