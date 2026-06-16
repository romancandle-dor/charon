import axios from 'axios';
import { ENABLE_LLM, LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, LLM_TIMEOUT_MS } from '../config.js';
import { now, json, stripThinking, strictJsonFromText } from '../utils.js';
import { fmtPct } from '../format.js';
import { db } from '../db/connection.js';
import { summarizeLearningWindow } from './summary.js';

function categorizeLesson(lessonText, summary) {
  const lower = lessonText.toLowerCase();
  if (lower.includes('route') || lower.includes('signal') || lower.includes('source')) return 'route';
  if (lower.includes('filter') || lower.includes('threshold') || lower.includes('mcap') || lower.includes('holder') || lower.includes('liquidity')) return 'filter';
  if (lower.includes('timing') || lower.includes('entry') || lower.includes('late') || lower.includes('early')) return 'timing';
  if (lower.includes('risk') || lower.includes('sl') || lower.includes('stop') || lower.includes('rug')) return 'risk';
  if (lower.includes('tp') || lower.includes('take profit') || lower.includes('exit')) return 'exit';
  return 'general';
}

export function fallbackLessons(summary) {
  const lessons = [];
  const bestRoute = summary.positions.byRoute?.[0];
  const worstRoute = [...(summary.positions.byRoute || [])].sort((a, b) => a.pnlPercent - b.pnlPercent)[0];
  if (bestRoute && bestRoute.count >= 2 && bestRoute.pnlPercent > 0) {
    lessons.push({
      lesson: `Prefer ${bestRoute.route} when other filters are clean; it led the window with ${fmtPct(bestRoute.avgPnlPercent)} avg PnL across ${bestRoute.count} closed dry-runs.`,
      evidence: bestRoute,
      category: 'route',
    });
  }
  if (worstRoute && worstRoute.count >= 2 && worstRoute.pnlPercent < 0) {
    lessons.push({
      lesson: `Be stricter on ${worstRoute.route}; it underperformed with ${fmtPct(worstRoute.avgPnlPercent)} avg PnL across ${worstRoute.count} closed dry-runs.`,
      evidence: worstRoute,
      category: 'route',
    });
  }
  const slCount = summary.positions.worst?.filter(row => row.exitReason === 'SL').length || 0;
  if (slCount >= 2) {
    lessons.push({
      lesson: `Recent worst exits clustered around SL; require stronger fresh pre-entry mcap/liquidity confirmation before accepting late entries.`,
      evidence: { slWorstCount: slCount, worst: summary.positions.worst },
      category: 'risk',
    });
  }
  if (!lessons.length) {
    lessons.push({
      lesson: 'Not enough closed dry-run evidence yet; keep collecting decisions before changing filters aggressively.',
      evidence: { closed: summary.positions.closed },
      category: 'general',
    });
  }
  return lessons.slice(0, 6);
}

export async function generateLessons(summary) {
  const fallback = fallbackLessons(summary);
  if (!ENABLE_LLM || !LLM_API_KEY) return { lessons: fallback, raw: { fallback: true } };
  try {
    const res = await axios.post(`${LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      model: LLM_MODEL,
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content: [
            'You are Charon learning from dry-run trading evidence.',
            'Return strict JSON only.',
            'Do not invent trades or outcomes.',
            'Create compact operational lessons that can improve the next screening prompt.',
          ].join(' '),
        },
        {
          role: 'user',
          content: JSON.stringify({
            task: 'Analyze this dry-run window and produce up to 6 lessons for future candidate screening.',
            output_schema: {
              lessons: [{ lesson: 'short actionable rule', evidence: 'specific supporting data', category: 'route|filter|timing|risk|exit|general' }],
            },
            summary,
          }),
        },
      ],
    }, {
      timeout: LLM_TIMEOUT_MS,
      headers: { authorization: `Bearer ${LLM_API_KEY}`, 'content-type': 'application/json' },
    });
    const parsed = strictJsonFromText(res.data?.choices?.[0]?.message?.content || '');
    const validCategories = new Set(['route', 'filter', 'timing', 'risk', 'exit', 'general']);
    const lessons = Array.isArray(parsed.lessons)
      ? parsed.lessons.map(item => {
          const cat = String(item.category || '').toLowerCase();
          return {
            lesson: String(item.lesson || '').slice(0, 500),
            evidence: item.evidence ?? {},
            category: validCategories.has(cat) ? cat : categorizeLesson(String(item.lesson || ''), summary),
          };
        }).filter(item => item.lesson)
      : [];
    return { lessons: lessons.length ? lessons.slice(0, 6) : fallback, raw: parsed };
  } catch (err) {
    console.log(`[learn] LLM failed: ${err.message}`);
    return { lessons: fallback, raw: { error: err.message, fallback: true } };
  }
}

let _lastAutoLearningMs = 0;
const AUTO_LEARNING_COOLDOWN_MS = 30 * 60 * 1000;
const AUTO_LEARNING_WINDOW_MS = 12 * 60 * 60 * 1000;

export async function autoLearning() {
  const nowMs = now();
  if (nowMs - _lastAutoLearningMs < AUTO_LEARNING_COOLDOWN_MS) return null;
  _lastAutoLearningMs = nowMs;
  try {
    const summary = summarizeLearningWindow(AUTO_LEARNING_WINDOW_MS);
    if (summary.positions.closed < 1) return null;
    const { lessons, raw } = await generateLessons(summary);
    const runId = storeLearningRun(AUTO_LEARNING_WINDOW_MS, summary, lessons, raw);
    console.log(`[learn] auto run #${runId}: ${summary.positions.closed} closed, ${lessons.length} lessons`);
    return runId;
  } catch (err) {
    console.log(`[learn] auto failed: ${err.message}`);
    return null;
  }
}

export function resetAutoLearningCooldown() {
  _lastAutoLearningMs = 0;
}

export function storeLearningRun(windowMs, summary, lessons, raw) {
  const result = db.prepare(`
    INSERT INTO learning_runs (created_at_ms, window_ms, summary_json, lessons_json, raw_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(now(), windowMs, json(summary), json(lessons), json(raw));
  const runId = Number(result.lastInsertRowid);
  const insert = db.prepare(`
    INSERT INTO learning_lessons (run_id, created_at_ms, status, lesson, evidence_json, category, priority)
    VALUES (?, ?, 'active', ?, ?, ?, ?)
  `);
  for (const item of lessons) {
    const cat = item.category || categorizeLesson(item.lesson, summary);
    const priority = cat === 'route' || cat === 'risk' ? 2 : cat === 'filter' ? 1 : 0;
    insert.run(runId, now(), item.lesson, json(item.evidence || {}), cat, priority);
  }
  return runId;
}
