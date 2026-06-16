export function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function short(address) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function fmtSol(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(4) : '?';
}

export function fmtUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '?';
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

export function fmtPct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(1)}%` : '?';
}

export function gmgnLink(mint) {
  return `https://gmgn.ai/sol/token/${mint}`;
}

export function txLink(signature) {
  return `https://solscan.io/tx/${signature}`;
}

export function accountLink(address) {
  return `https://solscan.io/account/${address}`;
}

export function fmtDuration(ms) {
  const n = Math.abs(Number(ms) || 0);
  if (n < 60000) return `${Math.round(n / 1000)}s`;
  if (n < 3600000) return `${Math.floor(n / 60000)}m ${Math.round((n % 60000) / 1000)}s`;
  if (n < 86400000) return `${Math.floor(n / 3600000)}h ${Math.floor((n % 3600000) / 60000)}m`;
  return `${Math.floor(n / 86400000)}d ${Math.floor((n % 86400000) / 3600000)}h`;
}

export function pnlEmoji(pnl) {
  const n = Number(pnl || 0);
  if (n > 0) return '🟢';
  if (n < 0) return '🔴';
  return '⚪';
}
