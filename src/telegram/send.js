import { bot } from './bot.js';
import { TELEGRAM_CHAT_ID, TELEGRAM_TOPIC_ID } from '../config.js';
import { now, json } from '../utils.js';
import { db } from '../db/connection.js';
import { escapeHtml, fmtPct, fmtSol, fmtUsd, short, gmgnLink } from '../format.js';
import { numSetting } from '../db/settings.js';
import { candidateSummary, compactCandidateLine, batchRevealSummary, formatPosition } from './format.js';
import { candidateButtons, batchRevealButtons, positionButtons, intentButtons, navKeyboard } from './menus.js';
import { batchById } from '../db/decisions.js';
import { fetchWalletPnl } from '../enrichment/wallets.js';

export async function sendTelegram(text, extra = {}) {
  return bot.sendMessage(TELEGRAM_CHAT_ID, text, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(TELEGRAM_TOPIC_ID ? { message_thread_id: Number(TELEGRAM_TOPIC_ID) } : {}),
    ...extra,
  });
}

export async function sendCandidateAlert(candidateId, candidate, decision) {
  const sent = await sendTelegram(candidateSummary(candidate, decision), candidateButtons(candidateId, decision));
  db.prepare(`
    INSERT INTO alerts (candidate_id, mint, kind, sent_at_ms, telegram_message_id, payload_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(candidateId, candidate.token.mint, 'candidate', now(), sent.message_id, json({ candidate, decision }));
}

export async function sendBatchReveal(batchId, rows, decision, triggerCandidateId) {
  const sent = await sendTelegram(
    batchRevealSummary(batchId, rows, decision, triggerCandidateId),
    batchRevealButtons(batchId, rows, decision, triggerCandidateId),
  );
  db.prepare(`
    INSERT INTO alerts (candidate_id, mint, kind, sent_at_ms, telegram_message_id, payload_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    triggerCandidateId || null,
    decision.selected_mint || rows.find(row => row.id === Number(triggerCandidateId))?.candidate?.token?.mint || 'batch',
    'batch_reveal',
    now(),
    sent.message_id,
    json({ batchId, candidateIds: rows.map(row => row.id), decision, triggerCandidateId }),
  );
}

export async function sendBatch(chatId, batchId) {
  const batch = batchById(batchId);
  if (!batch) return bot.sendMessage(chatId, 'Batch not found.');
  const lines = [
    '🧭 <b>Screening Batch</b>',
    '',
    `Batch: <b>#${batchId}</b> · Decision: <b>${escapeHtml(batch.verdict)}</b> ${fmtPct(batch.confidence)}`,
    batch.reason ? `Reason: ${escapeHtml(String(batch.reason).slice(0, 500))}` : null,
    '',
    ...batch.rows.map((row, index) => compactCandidateLine(row, index + 1)),
  ];
  const keyboard = batch.rows.slice(0, 10).map((row, index) => ([{
    text: `${index + 1}. ${row.candidate.token?.symbol || short(row.candidate.token?.mint || '')}`,
    callback_data: `cand:${row.id}`,
  }]));
  keyboard.push([{ text: 'Positions', callback_data: 'menu:positions' }]);
  return bot.sendMessage(chatId, lines.filter(Boolean).join('\n'), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: keyboard },
  });
}

export async function sendPositionOpen(positionId) {
  const position = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(positionId);
  const label = position?.execution_mode === 'live' ? 'Live buy executed' : 'Dry-run buy stored';
  if (position) await sendTelegram(`✅ <b>${label}</b>\n\n${formatPosition(position)}`, positionButtons(positionId));
}

export async function sendPositionExit(position) {
  const label = position?.execution_mode === 'live' ? 'Live exit' : 'Dry-run exit';
  await sendTelegram(`🏁 <b>${label}: ${escapeHtml(position.exitReason)}</b>\n\n${formatPosition({ ...position, status: 'closed' })}`);
}

export async function sendPnl(chatId, query = null) {
  const sections = [];

  // Dry-run PnL from local DB
  const closed = db.prepare("SELECT * FROM dry_run_positions WHERE status='closed' AND pnl_percent IS NOT NULL").all();
  if (closed.length) {
    const totalPnlSol = closed.reduce((s, p) => s + Number(p.pnl_sol || 0), 0);
    const totalPnlPct = closed.reduce((s, p) => s + Number(p.pnl_percent || 0), 0);
    const wins = closed.filter(p => Number(p.pnl_percent || 0) > 0).length;
    const losses = closed.filter(p => Number(p.pnl_percent || 0) < 0).length;
    const winRate = (wins / closed.length) * 100;
    const best = [...closed].sort((a, b) => Number(b.pnl_percent || 0) - Number(a.pnl_percent || 0))[0];
    const worst = [...closed].sort((a, b) => Number(a.pnl_percent || 0) - Number(b.pnl_percent || 0))[0];
    const totalEmoji = totalPnlSol > 0 ? '🟢' : totalPnlSol < 0 ? '🔴' : '⚪';
    sections.push([
      `🏜️ <b>Dry-Run (${closed.length} closed)</b>`,
      `Win: ${fmtPct(winRate)} (${wins}W/${losses}L) · Avg: ${fmtPct(totalPnlPct / closed.length)}`,
      `${totalEmoji} Total: <b>${fmtPct(totalPnlPct)}</b> (${fmtSol(totalPnlSol)} SOL)`,
      best ? `Best: #${best.id} ${escapeHtml(best.symbol || '')} ${fmtPct(best.pnl_percent)} (${best.exit_reason})` : null,
      worst ? `Worst: #${worst.id} ${escapeHtml(worst.symbol || '')} ${fmtPct(worst.pnl_percent)} (${worst.exit_reason})` : null,
    ].filter(Boolean).join('\n'));
  }

  // Live wallet PnL from Jupiter (skip if dry_run mode only)
  const wallets = db.prepare('SELECT * FROM saved_wallets ORDER BY label').all();
  if (wallets.length) {
    const walletChunks = [];
    for (const wallet of wallets) {
      const pnl = await fetchWalletPnl(wallet.address).catch(() => null);
      if (!pnl || !pnl.totalTrades) {
        walletChunks.push(`• <b>${escapeHtml(wallet.label)}</b>: no live trades yet`);
        continue;
      }
      const winEmoji = (pnl.winRate || 0) >= 50 ? '✅' : '📉';
      const pnlEmoji = (pnl.totalPnlPercent || 0) > 0 ? '🟢' : (pnl.totalPnlPercent || 0) < 0 ? '🔴' : '⚪';
      walletChunks.push([
        `• ${winEmoji} <b>${escapeHtml(wallet.label)}</b>`,
        `  Win: ${fmtPct(pnl.winRate)} · ${pnlEmoji} PnL: <b>${fmtPct(pnl.totalPnlPercent)}</b>`,
        `  Buys: ${pnl.totalTrades} · Wins: ${pnl.wins}`,
      ].join('\n'));
    }
    if (walletChunks.length) sections.push(`💧 <b>Live Wallets</b>\n\n${walletChunks.join('\n\n')}`);
  }

  const text = sections.length
    ? `📊 <b>PnL Overview</b>\n\n${sections.join('\n\n')}`
    : '📊 <b>PnL</b>\n\nNo data yet. Dry-run positions akan muncul setelah ada yang close.';

  return sendOrEdit(chatId, query, text, navKeyboard());
}

async function sendOrEdit(chatId, query, text, extra = {}) {
  if (query) {
    const messageId = query.message?.message_id;
    if (messageId) {
      try {
        return await bot.editMessageText(text, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          ...extra,
        });
      } catch (err) {
        if (/message is not modified/i.test(err.message)) return null;
      }
    }
  }
  return bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra,
  });
}

export async function sendTradeIntent(intentId, candidate, decision) {
  await sendTelegram([
    '🧾 <b>Trade intent awaiting confirmation</b>',
    '',
    candidateSummary(candidate, decision),
    '',
    `Size: <b>${fmtSol(numSetting('dry_run_buy_sol', 0.1))} SOL</b>`,
    'Execution: confirmation required before signing.',
  ].join('\n'), intentButtons(intentId));
}
