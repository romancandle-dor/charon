import TelegramBot from 'node-telegram-bot-api';
import { TELEGRAM_BOT_TOKEN } from '../config.js';

export const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// --- Outgoing rate limiter -------------------------------------------------
// Telegram allows ~1 message/sec per chat; bursts trigger 429 with a
// `retry_after` that can be tens of minutes. A trading alert that old is
// useless, and (critically) we must NOT let a penalized send block the
// orchestrator, which awaits its sends. So:
//   * pace sends with a min gap to avoid tripping 429 in the first place,
//   * on 429 record a global penalty window and DROP further sends until it
//     clears (rather than queueing them behind a 37-minute wait),
//   * only short retry_after (<= MAX_RETRY_WAIT_MS) is waited out inline.
const MIN_GAP_MS = 1100;          // ~1 msg/sec/chat
const MAX_RETRY_WAIT_MS = 30_000; // inline-retry only for short penalties

let chain = Promise.resolve();
let lastSentAt = 0;
let penaltyUntil = 0;     // epoch ms; sends are dropped until this passes
let droppedDuringPenalty = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function retryAfterMs(err) {
  const secs =
    err?.response?.body?.parameters?.retry_after ??
    err?.response?.parameters?.retry_after ??
    null;
  if (secs != null) return Number(secs) * 1000;
  const m = /retry after (\d+)/i.exec(err?.message || '');
  return m ? Number(m[1]) * 1000 : null;
}

function throttle(method) {
  const original = bot[method].bind(bot);
  bot[method] = (...args) => {
    const run = async () => {
      // In a penalty window: drop the message instead of stalling the queue.
      if (Date.now() < penaltyUntil) {
        droppedDuringPenalty++;
        return null;
      }
      if (droppedDuringPenalty > 0) {
        console.log(`[telegram] penalty cleared, dropped ${droppedDuringPenalty} message(s) during cooldown`);
        droppedDuringPenalty = 0;
      }
      const gap = MIN_GAP_MS - (Date.now() - lastSentAt);
      if (gap > 0) await sleep(gap);
      try {
        const res = await original(...args);
        lastSentAt = Date.now();
        return res;
      } catch (err) {
        const wait = retryAfterMs(err);
        if (wait != null && wait <= MAX_RETRY_WAIT_MS) {
          console.log(`[telegram] 429 on ${method}, short wait ${Math.round(wait / 1000)}s then retry`);
          await sleep(wait + 500);
          const res = await original(...args).catch(() => null);
          lastSentAt = Date.now();
          return res;
        }
        if (wait != null) {
          penaltyUntil = Date.now() + wait;
          console.log(`[telegram] 429 on ${method}, entering ${Math.round(wait / 1000)}s penalty — dropping sends until it clears`);
        }
        lastSentAt = Date.now();
        return null; // swallow: a failed alert must not crash the caller
      }
    };
    // Serialize sends, but never let one rejection poison the chain.
    const result = chain.then(run, run);
    chain = result.catch(() => {});
    return result;
  };
}

['sendMessage', 'editMessageText', 'sendPhoto', 'answerCallbackQuery'].forEach(throttle);
