/**
 * Format a SELL alert into a Telegram message.
 * This is the reverse copy trade trigger — "dev sold, buy now."
 */
export function formatAlert(alert) {
  const shortWallet = alert.wallet.slice(0, 8) + '...' + alert.wallet.slice(-6);
  const token = alert.token || 'unknown';
  const name = alert.tokenName || '-';
  const ticker = alert.tokenTicker || token.slice(0, 8);
  const amount = alert.amount ? `${parseFloat(alert.amount).toFixed(4)} SOL` : '-';
  const usd = alert.amount_usd ? `$${parseFloat(alert.amount_usd).toFixed(2)}` : '-';
  const price = alert.price ? `$${parseFloat(alert.price).toFixed(6)}` : '-';
  const tx = alert.txSig || '';
  const shortTx = tx.length > 20 ? tx.slice(0, 10) + '...' + tx.slice(-8) : tx;

  const now = Math.floor(Date.now() / 1000);
  const diff = now - (alert.timestamp || now);
  const timeAgo = diff < 60
    ? `${diff}s ago`
    : diff < 3600
    ? `${Math.floor(diff / 60)}m ago`
    : `${Math.floor(diff / 3600)}h ago`;

  // ⚡ Reverse copy trade: dev sold = BUY SIGNAL
  let text = `🚀 *DEV SOLD — BUY NOW*\n\n`;
  text += `🐸 Token: *${ticker}*`;
  if (name !== '-') text += ` — ${name}`;
  text += `\n`;
  text += `💰 Sold: ${amount} ${usd !== '-' ? `(${usd})` : ''}\n`;
  text += `💲 Price: ${price}\n`;
  text += `👛 Wallet: \`${shortWallet}\``;
  if (alert.label) text += ` (${alert.label})`;
  text += `\n`;
  text += `⏱ ${timeAgo}\n`;
  text += `\n🔗 https://gmgn.ai/sol/token/${token}\n`;
  text += `📜 TX: \`${shortTx}\``;

  return { text, parse_mode: 'Markdown' };
}
