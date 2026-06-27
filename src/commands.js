/**
 * Hicarus — Telegram Command Handlers
 * Focus: wallet discovery, not real-time alerts.
 */

import {
  addWallet, removeWallet, listWallets, getActiveWallets,
  getSettings, updateSettings,
  getRecentAlerts,
} from './db.js';
import {
  getWalletTxs, getWalletStats, getTokenTraders
} from './gmgn.js';

// ── Seed Dev Wallets ────────────────────────────────────────────
// These are the starting point for discovery loop.

export const SEED_WALLETS = [
  {
    wallet: '8inTY66csRNgKNtGhqGhd4odAV2VeJBDcRVuF7UE3Eeh',
    label: 'Seed Dev A — 1,935 tokens',
  },
  {
    wallet: '6WM3V5hPSbbb7WNsLmo2QbbAc7vwJ6dumg1ypPXdv3cR',
    label: 'Seed Dev B — 658 tokens',
  },
];

// ── Validators ─────────────────────────────────────────────────

function isValidSolanaAddress(addr) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr?.trim());
}

function unauthorized(ctx) {
  ctx.reply('⛔ Kamu tidak diizinkan menggunakan bot ini.');
}

// ── /seed ─────────────────────────────────────────────────────
// Add hardcoded seed wallets to watchlist

export async function handleSeed(ctx) {
  const userId = ctx.from.id;
  if (userId !== parseInt(process.env.AUTHORIZED_USER_ID)) {
    return unauthorized(ctx);
  }

  let added = 0;
  for (const { wallet, label } of SEED_WALLETS) {
    const ok = addWallet(wallet, label, userId);
    if (ok) added++;
  }

  ctx.reply(
    `🌱 Seed wallets ditambahkan: ${added}\n\n` +
    SEED_WALLETS.map((s, i) => `${i + 1}. \`${s.wallet.slice(0, 12)}...\` — ${s.label}`).join('\n') +
    `\n\nSekarang coba /discover untuk mencari wallet baru.`
  , { parse_mode: 'Markdown' });
}

// ── /discover ─────────────────────────────────────────────────
// Run the discovery loop — find new dev wallets

export async function handleDiscover(ctx) {
  const userId = ctx.from.id;
  if (userId !== parseInt(process.env.AUTHORIZED_USER_ID)) {
    return unauthorized(ctx);
  }

  await ctx.reply('🔍 *Hicarus Discover*\nMenganalisis token dari seed wallets...\n\nEstimasi: 30-60 detik.', { parse_mode: 'Markdown' });

  try {
    // Get seed wallets + any user-added wallets
    const watchedWallets = getActiveWallets();
    const seedPlusUser = watchedWallets.length > 0 ? watchedWallets : SEED_WALLETS;

    // Collect unique tokens from recent sell events
    const tokenMap = {};

    for (const { wallet, label } of seedPlusUser) {
      try {
        const txs = await getWalletTxs(wallet, 30);
        for (const tx of txs) {
          if (tx.side?.toLowerCase() === 'sell' && tx.token) {
            if (!tokenMap[tx.token]) {
              tokenMap[tx.token] = {
                symbol: tx.token_symbol || tx.token_ticker || tx.token_name || tx.token.slice(0, 8),
                dev_wallet: wallet,
                ts: tx.timestamp,
              };
            }
          }
        }
      } catch (err) {
        console.warn(`[Discover] Failed: ${wallet.slice(0, 8)}: ${err.message}`);
      }
    }

    const tokenList = Object.values(tokenMap);
    if (tokenList.length === 0) {
      return ctx.reply('❌ Tidak ada token ditemukan dari watchlist.');
    }

    await ctx.reply(`📊 ${tokenList.length} token ditemukan. Mengecek trader data...`, { parse_mode: 'Markdown' });

    // For each token, find dev wallets
    const devWallets = {};

    for (const info of tokenList) {
      try {
        const traders = await getTokenTraders(info.symbol === info.token ? Object.keys(tokenMap).find(k => tokenMap[k] === info) : info.token || Object.keys(tokenMap).find(k => tokenMap[k] === info));
      } catch (_) {}
    }

    // Re-do properly: need token address, not symbol
    for (const [tokenAddr, info] of Object.entries(tokenMap)) {
      try {
        const traders = await getTokenTraders(tokenAddr);
        const watchedAddrs = new Set(seedPlusUser.map(w => w.wallet));

        for (const trader of traders) {
          const tags = trader.maker_token_tags || [];
          const isDev = tags.includes('dev_team') || tags.includes('creator');
          const isKnown = watchedAddrs.has(trader.address);

          if (isDev && !isKnown) {
            const addr = trader.address;
            const profit = parseFloat(trader.profit || 0);
            if (!devWallets[addr]) {
              devWallets[addr] = {
                count: 0, pnl: 0, tokens: [], tags: [...new Set([...(trader.tags || []), ...tags])],
              };
            }
            devWallets[addr].count += 1;
            devWallets[addr].pnl += profit;
            if (!devWallets[addr].tokens.includes(info.symbol)) {
              devWallets[addr].tokens.push(info.symbol);
            }
          }
        }
      } catch (err) {
        console.warn(`[Discover] Trader lookup failed for ${tokenAddr}: ${err.message}`);
      }
    }

    // Sort: count desc, then pnl desc
    const sorted = Object.entries(devWallets)
      .map(([addr, info]) => ({ addr, ...info }))
      .sort((a, b) => b.count - a.count || b.pnl - a.pnl);

    if (sorted.length === 0) {
      return ctx.reply('❌ Tidak ada dev wallet baru ditemukan.');
    }

    // Format
    let text = `🎯 *Discover Results*\n`;
    text += `Dari ${tokenList.length} token · ${sorted.length} dev wallet ditemukan\n`;
    text += `Dihasilkan: ${new Date().toLocaleString()}\n\n`;
    text += `━━━━━━━━━━━━━━━━━━━━\n\n`;

    const high = sorted.filter(w => w.count >= 3);
    const medium = sorted.filter(w => w.count === 2);

    if (high.length > 0) {
      text += `🔥 *HIGH CONFIDENCE* (≥3x)\n`;
      high.slice(0, 8).forEach((w, i) => {
        const short = w.addr.slice(0, 8) + '...' + w.addr.slice(-6);
        const pnlStr = w.pnl >= 0 ? `+${w.pnl.toFixed(2)}` : `${w.pnl.toFixed(2)}`;
        text += `\n${i + 1}. \`${short}\`\n`;
        text += `   📈 ${w.count}x · PnL: ${pnlStr} SOL\n`;
        text += `   🐸 ${w.tokens.slice(0, 4).join(', ')}\n`;
        text += `   /add ${w.addr}\n`;
      });
      text += `\n`;
    }

    if (medium.length > 0) {
      text += `⚡ *MEDIUM* (2x)\n`;
      medium.slice(0, 5).forEach((w) => {
        const short = w.addr.slice(0, 8) + '...' + w.addr.slice(-6);
        const pnlStr = w.pnl >= 0 ? `+${w.pnl.toFixed(2)}` : `${w.pnl.toFixed(2)}`;
        text += `• \`${short}\` · ${w.count}x · PnL: ${pnlStr}\n`;
      });
      text += `\n`;
    }

    text += `━━━━━━━━━━━━━━━━━━━━\n\n`;
    text += `*Confidence: appearances × token diversity × PnL*\n`;
    text += `Gunakan /add <address> untuk add ke watchlist.`;

    ctx.reply(text, { parse_mode: 'Markdown' });

  } catch (err) {
    console.error('[Discover] Error:', err);
    ctx.reply(`❌ Error: ${err.message}`);
  }
}

// ── /add /remove /list /wallet /help /guide ─────────────────

export async function handleAdd(ctx) {
  const userId = ctx.from.id;
  if (userId !== parseInt(process.env.AUTHORIZED_USER_ID)) return unauthorized(ctx);

  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 1) {
    return ctx.reply('📝 Format: `/add <wallet_address> [label]`');
  }
  const wallet = args[0].trim();
  const label = args.slice(1).join(' ') || null;
  if (!isValidSolanaAddress(wallet)) {
    return ctx.reply('❌ Alamat wallet tidak valid.');
  }
  const added = addWallet(wallet, label, userId);
  ctx.reply(added ? `✅ Wallet ditambahkan.\n🪪 \`${wallet}\`\n${label ? `🏷 ${label}` : ''}` : '⚠️ Wallet sudah ada.');
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
  if (wallets.length === 0) {
    return ctx.reply('📭 Watchlist kosong. Gunakan /seed untuk add seed wallets, atau /add <wallet>.');
  }
  let text = `📋 *Watchlist* (${wallets.length})\n\n`;
  wallets.forEach((w, i) => {
    const short = w.wallet.slice(0, 8) + '...' + w.wallet.slice(-6);
    text += `${i + 1}. \`${short}\`\n`;
    if (w.label) text += `   🏷 ${w.label}\n`;
    text += `   ${w.active ? '🟢 Aktif' : '⚪ Paused'}\n\n`;
  });
  ctx.reply(text, { parse_mode: 'Markdown' });
}

export async function handleWallet(ctx) {
  const userId = ctx.from.id;
  if (userId !== parseInt(process.env.AUTHORIZED_USER_ID)) return unauthorized(ctx);
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 1) return ctx.reply('📝 Format: `/wallet <address>`');
  const wallet = args[0].trim();
  if (!isValidSolanaAddress(wallet)) return ctx.reply('❌ Alamat tidak valid.');

  await ctx.reply('🔍 Fetching dari GMGN...');
  try {
    const stats = await getWalletStats(wallet);
    let text = `👛 \`${wallet}\`\n\n`;

    if (stats) {
      const pnl = stats.realized_profit || stats.total_pnl || 0;
      const wr = stats.winrate || stats.win_rate || 0;
      const trades = stats.buy || stats.total_trades || 0;
      const tokens = stats.pnl_stat?.token_num || 0;
      const tags = (stats.common?.tags || []).join(', ') || '-';
      const created = stats.common?.created_token_count || 0;

      text += `📊 *Stats*\n`;
      text += `• Realized P&L: $${parseFloat(pnl).toFixed(2)}\n`;
      text += `• Win Rate: ${typeof wr === 'number' ? (wr * 100).toFixed(1) + '%' : wr}\n`;
      text += `• Total Trades: ${trades}\n`;
      text += `• Tokens Traded: ${tokens}\n`;
      text += `• Tokens Created: ${created}\n`;
      text += `• Tags: ${tags}\n`;
    } else {
      text += `Tidak ada data stats.`;
    }

    text += `\n🔗 https://gmgn.ai/sol/address/${wallet}`;
    ctx.reply(text, { parse_mode: 'Markdown' });
  } catch (err) {
    ctx.reply(`❌ Error: ${err.message}`);
  }
}

export async function handleHelp(ctx) {
  const text = `🆘 *Hicarus — Help*\n\n` +
    `*Discovery*\n` +
    `/seed        — Add 2 seed dev wallets (starting point)\n` +
    `/discover    — Cari dev wallet baru sekarang\n` +
    `/add <wallet> [label] — Add wallet ke watchlist\n` +
    `/list        — Lihat watchlist\n` +
    `/wallet <addr> — Stats dari GMGN\n\n` +
    `*Guide*\n` +
    `/guide       — Penjelasan pattern "The Distributor"\n\n` +
    `*Info*\n` +
    `/help        — Show this\n\n` +
    `Hicarus menemukan wallet baru setiap jam secara otomatis.\n` +
    `Hasil dikirim ke chat ini.`;
  ctx.reply(text, { parse_mode: 'Markdown' });
}

export async function handleGuide(ctx) {
  const text = `📊 *The Distributor — Pattern*\n\n` +
    `Dev wallet yang:\\n` +
    `• Create token → buy di launch\\n` +
    `• Sell dalam 1-3 tx, hit minutes\\n` +
    `• Polkali berulang, profit konsisten\\n\n` +
    `Ini bukan blind copy. Snipper memantau snipers:\\n` +
    `Dev sell → snipers follow → kita reverse engineer\\n` +
    `dari karakteristik yang muncul berulang.\\n\n` +
    `*Discovery loop:*\\n` +
    `Seed wallets → token traded → /token/traders\\n` +
    `→ maker_token_tags=['creator','dev_team']\\n` +
    `→ rank by appearances × PnL\\n` +
    `→ wallet baru ditemukan.\\n\n` +
    `*Kamu tidak perlu add manual.*\\n` +
    `Bot auto-discover setiap jam.`;
  ctx.reply(text, { parse_mode: 'Markdown' });
}
