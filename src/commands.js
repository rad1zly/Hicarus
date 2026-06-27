/**
 * Hicarus — Telegram Command Handlers
 * Focus: wallet discovery via GMGN API, push to Telegram.
 */

import { spawn } from 'child_process';
import { addWallet, removeWallet, listWallets } from './db.js';
import { getWalletStats } from './gmgn.js';

// ── Validators ─────────────────────────────────────────────────

function isValidSolanaAddress(addr) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr?.trim());
}

function unauthorized(ctx) {
  ctx.reply('⛔ Kamu tidak diizinkan menggunakan bot ini.');
}

// ── /discover ─────────────────────────────────────────────────
// Run discovery: executes hourly_discover.py and streams output

export async function handleDiscover(ctx) {
  const userId = ctx.from.id;
  if (userId !== parseInt(process.env.AUTHORIZED_USER_ID)) {
    return unauthorized(ctx);
  }

  ctx.reply('🔍 *Discover* — running discovery...\n\nHasil akan dikirim otomatis.');

  return new Promise((resolve) => {
    const py = spawn('python3', ['hourly_discover.py'], {
      cwd: '/home/ubuntu/hicarus',
    });

    let output = '';
    py.stdout.on('data', (d) => { output += d.toString(); });
    py.stderr.on('data', (d) => { output += d.toString(); });
    py.on('close', (code) => {
      if (code === 0) {
        ctx.reply('✅ *Discover complete* — results sent above.', { parse_mode: 'Markdown' });
      } else {
        ctx.reply(`❌ Discover failed (code ${code}):\n\`${output.slice(-500)}\``, { parse_mode: 'Markdown' });
      }
      resolve();
    });
    py.on('error', (err) => {
      ctx.reply(`❌ Error: ${err.message}`);
      resolve();
    });
  });
}

// ── /add /remove /list /wallet /guide /help ──────────────────

export async function handleAdd(ctx) {
  const userId = ctx.from.id;
  if (userId !== parseInt(process.env.AUTHORIZED_USER_ID)) return unauthorized(ctx);
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 1) return ctx.reply('📝 Format: `/add <wallet_address>`');
  const wallet = args[0].trim();
  if (!isValidSolanaAddress(wallet)) return ctx.reply('❌ Alamat wallet tidak valid.');
  const added = addWallet(wallet, args.slice(1).join(' ') || null, userId);
  ctx.reply(added ? `✅ Wallet ditambahkan.\n\`${wallet}\`` : '⚠️ Sudah ada.');
}

export async function handleRemove(ctx) {
  const userId = ctx.from.id;
  if (userId !== parseInt(process.env.AUTHORIZED_USER_ID)) return unauthorized(ctx);
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 1) return ctx.reply('📝 Format: `/remove <wallet_address>`');
  const removed = removeWallet(args[0].trim(), userId);
  ctx.reply(removed ? '✅ Wallet dihapus.' : '❌ Wallet tidak ditemukan.');
}

export async function handleList(ctx) {
  const userId = ctx.from.id;
  if (userId !== parseInt(process.env.AUTHORIZED_USER_ID)) return unauthorized(ctx);
  const wallets = listWallets(userId);
  if (wallets.length === 0) return ctx.reply('📭 Watchlist kosong. Bot auto-add wallets setiap jam.');

  let text = `📋 *Watchlist* (${wallets.length})\n`;
  text += `━━━━━━━━━━━━━━━━━━━━\n\n`;

  wallets.forEach((w, i) => {
    const pnl = typeof w.total_pnl === 'number' ? (w.total_pnl >= 0 ? '+' + w.total_pnl.toFixed(2) : w.total_pnl.toFixed(2)) : '—';
    const conf = w.confidence || 0;
    text += `${i + 1}. ${w.label || 'Wallet'}\n`;
    text += `\`${w.wallet}\`\n`;
    text += `   📊 ${conf}x · PnL: ${pnl} SOL · ${w.active ? '🟢 Aktif' : '⚪ Paused'}\n\n`;
  });

  text += `━━━━━━━━━━━━━━━━━━━━\n`;
  text += `Full address = tap untuk copy`;
  ctx.reply(text, { parse_mode: 'Markdown' });
}

export async function handleWallet(ctx) {
  const userId = ctx.from.id;
  if (userId !== parseInt(process.env.AUTHORIZED_USER_ID)) return unauthorized(ctx);
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 1) return ctx.reply('📝 Format: `/wallet <address>`');
  const wallet = args[0].trim();
  if (!isValidSolanaAddress(wallet)) return ctx.reply('❌ Alamat tidak valid.');

  ctx.reply('🔍 Fetching dari GMGN...');
  try {
    const stats = await getWalletStats(wallet);
    let text = `👛 \`${wallet}\`\n\n`;
    if (stats) {
      const pnl = stats.realized_profit || stats.total_pnl || 0;
      const wr = stats.winrate || stats.win_rate || 0;
      const trades = stats.buy || stats.total_trades || 0;
      const tags = (stats.common?.tags || []).join(', ') || '-';
      const created = stats.common?.created_token_count || 0;
      text += `• Realized P&L: $${parseFloat(pnl).toFixed(2)}\n`;
      text += `• Win Rate: ${typeof wr === 'number' ? (wr * 100).toFixed(1) + '%' : wr}\n`;
      text += `• Total Trades: ${trades}\n`;
      text += `• Tokens Created: ${created}\n`;
      text += `• Tags: ${tags}\n`;
    } else {
      text += `Tidak ada data.`;
    }
    text += `\n🔗 https://gmgn.ai/sol/address/${wallet}`;
    ctx.reply(text, { parse_mode: 'Markdown' });
  } catch (err) {
    ctx.reply(`❌ Error: ${err.message}`);
  }
}

export async function handleGuide(ctx) {
  const text = `📊 *The Distributor — Pattern*\n\n` +
    `Dev wallet yang:\\n` +
    `• Create token → buy di launch\\n` +
    `• Sell 1-3x dal am detik\\n` +
    `• Profit konsisten\\n` +
    `• Ulangi pada token baru\\n\n` +
    `*Hicarus menemukan wallet2 ini setiap jam.*\\n\n` +
    `Ketik `/discover` untuk cari sekarang.`;
  ctx.reply(text, { parse_mode: 'Markdown' });
}

export async function handleHelp(ctx) {
  const text = `🆘 *Hicarus — Help*\n\n` +
    `*Commands*\n` +
    `/discover — Cari dev wallet baru sekarang\n` +
    `/add <wallet> — Add wallet ke watchlist\n` +
    `/list — Lihat watchlist\n` +
    `/wallet <addr> — GMGN stats\n` +
    `/guide — Penjelasan pattern\n` +
    `/help — Show this\n\n` +
    `Hicarus auto-discover setiap jam dan push hasil ke sini.`;
  ctx.reply(text, { parse_mode: 'Markdown' });
}
