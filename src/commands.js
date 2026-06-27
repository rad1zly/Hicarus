import {
  addWallet, removeWallet, listWallets, getActiveWallets,
  getSettings, updateSettings,
  getRecentAlerts,
} from './db.js';
import { getWalletTxs, getWalletPortfolio, getWalletStats, getTopWallets, getNewTokens, getTokenTraders } from './gmgn.js';
import { startPolling, stopPolling, isRunning } from './monitor.js';

// ── Validators ─────────────────────────────────────────────────

function isValidSolanaAddress(addr) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr?.trim());
}

function unauthorized(ctx) {
  ctx.reply('⛔ Kamu tidak diizinkan menggunakan bot ini.');
}

// ── Command handlers ───────────────────────────────────────────

export async function handleAdd(ctx) {
  const userId = ctx.from.id;
  if (userId !== parseInt(process.env.AUTHORIZED_USER_ID)) {
    return unauthorized(ctx);
  }

  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 1) {
    return ctx.reply(
      '📝 Format: `/add <wallet_address> [label]`\n' +
      'Contoh: `/add 7AuHUkJ9qWzw6d2PRK9YgZNJ9yaPwmEXoK add wallet ini`'
    );
  }

  const wallet = args[0].trim();
  const label = args.slice(1).join(' ') || null;

  if (!isValidSolanaAddress(wallet)) {
    return ctx.reply('❌ Alamat wallet tidak valid. Pastikan itu alamat Solana.');
  }

  const added = addWallet(wallet, label, userId);
  if (added) {
    ctx.reply(`✅ Wallet ditambahkan ke watchlist.\n🪪 \`${wallet}\`\n${label ? `🏷 ${label}` : ''}`, { parse_mode: 'Markdown' });
  } else {
    ctx.reply('⚠️ Wallet sudah ada di watchlist.');
  }
}

export async function handleRemove(ctx) {
  const userId = ctx.from.id;
  if (userId !== parseInt(process.env.AUTHORIZED_USER_ID)) {
    return unauthorized(ctx);
  }

  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 1) {
    return ctx.reply('📝 Format: `/remove <wallet_address>`');
  }

  const wallet = args[0].trim();
  const removed = removeWallet(wallet, userId);
  ctx.reply(removed ? `✅ Wallet dihapus dari watchlist.` : `❌ Wallet tidak ditemukan di watchlist kamu.`);
}

export async function handleList(ctx) {
  const userId = ctx.from.id;
  if (userId !== parseInt(process.env.AUTHORIZED_USER_ID)) {
    return unauthorized(ctx);
  }

  const wallets = listWallets(userId);
  if (wallets.length === 0) {
    return ctx.reply('📭 Watchlist kosong. Gunakan `/add <wallet> [label]` untuk menambah.');
  }

  let text = `📋 *Watchlist* (${wallets.length} wallet)\n\n`;
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
  if (userId !== parseInt(process.env.AUTHORIZED_USER_ID)) {
    return unauthorized(ctx);
  }

  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 1) {
    return ctx.reply('📝 Format: `/wallet <wallet_address>`');
  }

  const wallet = args[0].trim();
  if (!isValidSolanaAddress(wallet)) {
    return ctx.reply('❌ Alamat wallet tidak valid.');
  }

  await ctx.reply('🔍 Fetching wallet data dari GMGN...');

  try {
    const [stats, portfolio, txs] = await Promise.all([
      getWalletStats(wallet).catch(() => null),
      getWalletPortfolio(wallet).catch(() => []),
      getWalletTxs(wallet, 10).catch(() => []),
    ]);

    let text = `👛 *Wallet:* \`${wallet}\`\n\n`;

    if (stats) {
      text += `📊 *Stats*\n`;
      text += `• Total P&L: $${stats.total_pnl?.toFixed(2) ?? 'N/A'}\n`;
      text += `• Win Rate: ${stats.win_rate != null ? (stats.win_rate * 100).toFixed(1) + '%' : 'N/A'}\n`;
      text += `• Total Trades: ${stats.total_trades ?? 'N/A'}\n`;
      text += `• Avg Win: $${stats.avg_win?.toFixed(2) ?? 'N/A'}\n`;
      text += `• Avg Loss: $${stats.avg_loss?.toFixed(2) ?? 'N/A'}\n\n`;
    }

    text += `💼 *Portfolio:* ${portfolio.length} tokens\n`;
    if (portfolio.length > 0) {
      const top5 = portfolio.slice(0, 5);
      top5.forEach(t => {
        text += `• ${t.token_symbol || t.symbol || '?'}: $${parseFloat(t.usd_value || 0).toFixed(2)}\n`;
      });
      if (portfolio.length > 5) text += `... dan ${portfolio.length - 5} lagi\n`;
    }

    text += `\n📜 *Recent Txs:* ${txs.length}\n`;
    if (txs.length > 0) {
      txs.slice(0, 3).forEach(tx => {
        const side = tx.side === 'buy' ? '🟢 BUY' : '🔴 SELL';
        const amount = parseFloat(tx.amount || 0).toFixed(4);
        const symbol = tx.token_symbol || tx.token_ticker || tx.token_name || '?';
        const ts = new Date(tx.timestamp * 1000).toLocaleString();
        text += `${side} ${amount} ${symbol} — ${ts}\n`;
      });
    }

    text += `\n🔗 https://gmgn.ai/sol/address/${wallet}`;
    ctx.reply(text, { parse_mode: 'Markdown' });
  } catch (err) {
    ctx.reply(`❌ Error fetching wallet: ${err.message}`);
  }
}

export async function handleSettings(ctx) {
  const userId = ctx.from.id;
  if (userId !== parseInt(process.env.AUTHORIZED_USER_ID)) {
    return unauthorized(ctx);
  }

  const s = getSettings(userId);
  const text = `⚙️ *Pengaturan Kamu*\n\n` +
    `• Poll Interval: ${s.poll_interval}s\n` +
    `• Alert Buys: ${s.alert_buys ? '🟢 ON' : '⚪ OFF'}\n` +
    `• Alert Sells: ${s.alert_sells ? '🟢 ON' : '⚪ OFF'}\n` +
    `• Min USD: $${s.min_amount_usd}\n` +
    `• Auto-Forward: ${s.auto_forward ? '🟢 ON' : '⚪ OFF'}\n\n` +
    `Gunakan:\n` +
    `/set interval <detik>\n` +
    `/set buys on|off\n` +
    `/set sells on|off\n` +
    `/set minusd <amount>`;

  ctx.reply(text, { parse_mode: 'Markdown' });
}

export async function handleSet(ctx) {
  const userId = ctx.from.id;
  if (userId !== parseInt(process.env.AUTHORIZED_USER_ID)) {
    return unauthorized(ctx);
  }

  const args = ctx.message.text.split(' ').slice(2); // /set key val...
  if (args.length < 1) {
    return ctx.reply(
      '📝 Format:\n' +
      '/set interval <detik>\n' +
      '/set buys on|off\n' +
      '/set sells on|off\n' +
      '/set minusd <amount>\n' +
      '/set autolist on|off'
    );
  }

  const key = args[0].toLowerCase();
  const val = args.slice(1).join(' ');

  const patch = {};
  let reply = '';

  switch (key) {
    case 'interval': {
      const n = parseInt(val);
      if (isNaN(n) || n < 10 || n > 300) {
        return ctx.reply('❌ Interval harus 10–300 detik.');
      }
      patch.poll_interval = n;
      // Restart poller with new interval
      if (isRunning()) {
        stopPolling();
        startPolling(n);
      }
      reply = `✅ Poll interval diubah ke ${n}s.`;
      break;
    }
    case 'buys':
    case 'sells': {
      const bool = val === 'on' ? 1 : 0;
      patch[`alert_${key}`] = bool;
      reply = `✅ Alert ${key} ${val === 'on' ? 'diaktifkan' : 'dimatikan'}.`;
      break;
    }
    case 'minusd': {
      const n = parseFloat(val);
      if (isNaN(n) || n < 0) {
        return ctx.reply('❌ Min USD harus angka >= 0.');
      }
      patch.min_amount_usd = n;
      reply = `✅ Min USD threshold diubah ke $${n}.`;
      break;
    }
    case 'autolist':
    case 'autoforward': {
      const bool = val === 'on' ? 1 : 0;
      patch.auto_forward = bool;
      reply = `✅ Auto-forward ${val === 'on' ? 'diaktifkan' : 'dimatikan'}.`;
      break;
    }
    default:
      return ctx.reply(`❌ Key tidak dikenal: ${key}`);
  }

  updateSettings(userId, patch);
  ctx.reply(reply);
}

export async function handleStats(ctx) {
  const userId = ctx.from.id;
  if (userId !== parseInt(process.env.AUTHORIZED_USER_ID)) {
    return unauthorized(ctx);
  }

  const alerts = getRecentAlerts(50);
  const wallets = listWallets(userId);
  const buys = alerts.filter(a => a.side === 'buy').length;
  const sells = alerts.filter(a => a.side === 'sell').length;

  const text = `📈 *Bot Stats*\n\n` +
    `• Wallet di watchlist: ${wallets.length}\n` +
    `• Total alerts (all time): ${alerts.length}\n` +
    `  🟢 Buys: ${buys}\n` +
    `  🔴 Sells: ${sells}\n` +
    `• Polling: ${isRunning() ? '🟢 Aktif' : '⚪ Stopped'}`;

  ctx.reply(text, { parse_mode: 'Markdown' });
}

export async function handleRecent(ctx) {
  const userId = ctx.from.id;
  if (userId !== parseInt(process.env.AUTHORIZED_USER_ID)) {
    return unauthorized(ctx);
  }

  const alerts = getRecentAlerts(10);
  if (alerts.length === 0) {
    return ctx.reply('📭 Belum ada alerts.');
  }

  let text = `📜 *Recent Alerts*\n\n`;
  alerts.forEach(a => {
    const side = a.side === 'buy' ? '🟢 BUY' : '🔴 SELL';
    const short = a.wallet.slice(0, 6) + '...' + a.wallet.slice(-4);
    const ts = new Date(a.timestamp * 1000).toLocaleString();
    const amount = a.amount ? `${parseFloat(a.amount).toFixed(4)} SOL` : '';
    const usd = a.amount_usd ? `$${parseFloat(a.amount_usd).toFixed(2)}` : '';
    text += `${side} ${a.token_ticker || a.token.slice(0, 6)} ${amount} ${usd}\n`;
    text += `   👛 ${short} — ${ts}\n\n`;
  });

  ctx.reply(text, { parse_mode: 'Markdown' });
}

export async function handleHelp(ctx) {
  const text = `🆘 *WalletFeeder — Help*\n\n` +
    `*Wallet Management*\n` +
    `/add <wallet> [label]  — Tambah wallet\n` +
    `/remove <wallet>       — Hapus wallet\n` +
    `/list                  — Lihat watchlist\n` +
    `/wallet <wallet>       — Stats & portfolio\n\n` +
    `*Discovery*\n` +
    `/guide                 — Wallet pattern apa yang worth di-track\n` +
    `/search [pnl|winrate]  — Cari top wallets di GMGN\n` +
    `/autodiscover           — Auto-find new dev wallets\n\n` +
    `*Settings*\n` +
    `/settings              — Lihat pengaturan\n` +
    `/set interval <detik>  — Set poll interval\n` +
    `/set buys on|off       — Toggle buy alerts\n` +
    `/set sells on|off      — Toggle sell alerts\n` +
    `/set minusd <amount>   — Min USD threshold\n\n` +
    `*Info*\n` +
    `/stats                 — Bot statistics\n` +
    `/recent                — Recent alerts\n` +
    `/help                  — Show this\n\n` +
    `WalletFeeder memantau wallet via GMGN API dan menyimpan alerts ke database.`;
  ctx.reply(text, { parse_mode: 'Markdown' });
}

export async function handleGuide(ctx) {
  const text = `📊 *Wallet Pattern yang Worth Di-Track*\n\n` +
    `Jenis wallet yang kamu maksud:\n\n` +
    `🧬 *Dev Wallet — "The Distributor"*\n` +
    `Karakteristik:\n` +
    `• Create token → langsung diamond-hands\n` +
    `• Jual dalam 1-2 transaksi\n` +
    `• Setelah dijual → distribusi naik (price goes up)\n` +
    `• Pola *selalu identik* — bisa dipelajari\n` +
    `• Tanda: buy pertama = create, sell pertama = distribusi\n\n` +
    `Cara cari:\n` +
    `1. Buka gmgn.ai → cari token yang baru pump\n` +
    `2. Buka bagian "Holders" → cari wallet dengan\n` +
    `   "Token Age" paling muda (newest)\n` +
    `3. Cek tab "Txs" — kalau create + dump pattern\n` +
    `   muncul di tx #1-#3, itu dia\n\n` +
    `⚠️ *Tips dari kamu:*\n` +
    `• Pattern identik — artinya mudah di-flag\n` +
    `• Distribution naik setelah sold = high demand\n` +
    `  (arketaker masih mau masuk setelah dev sold)\n` +
    `• Bisa dideteksi via sniper tertentu yang kamu sebut\n` +
    `  — biasanya tools tersebut track:\n` +
    `    - "dev sold" event\n` +
    `    - Followed by "price distribution up"\n` +
    `    - Same wallet, same timing pattern\n\n` +
    `Gimana \`/search\` bisa bantu:\n` +
    `\`/search pnl\` → dapat top wallets\n` +
    `Lihat tx history → cari pattern create+dump\n` +
    `Kalau cocok → \`/add <wallet>\`\n\n` +
    `*Btw — ini sniper-in wallet dev, bukan follow-buy. Wise.* 🤝`;
  ctx.reply(text, { parse_mode: 'Markdown' });
}

export async function handleSearch(ctx) {
  const userId = ctx.from.id;
  if (userId !== parseInt(process.env.AUTHORIZED_USER_ID)) {
    return unauthorized(ctx);
  }

  const args = ctx.message.text.split(' ').slice(1);
  const sort = args[0]?.toLowerCase();
  const validSorts = ['pnl', 'winrate', 'win_rate', 'trades', 'volume'];
  const sortMap = { pnl: 'pnl', winrate: 'win_rate', win_rate: 'win_rate', trades: 'trades', volume: 'volume' };
  const resolvedSort = sortMap[sort] || 'pnl';

  await ctx.reply(`🔍 Mencari top wallets (sort: ${resolvedSort})...`);

  try {
    const wallets = await getTopWallets('sol', resolvedSort, 15);
    if (!wallets || wallets.length === 0) {
      return ctx.reply('❌ Tidak ada hasil dari GMGN.');
    }

    let text = `🏆 *Top 15 Wallets — Sorted by ${resolvedSort.toUpperCase()}*\n\n`;
    wallets.slice(0, 15).forEach((w, i) => {
      const addr = w.address || wwallet || w.address || '?';
      const short = addr.slice(0, 8) + '...' + addr.slice(-6);
      const pnl = w.total_pnl != null ? `$${parseFloat(w.total_pnl).toFixed(0)}` : '-';
      const wr = w.win_rate != null ? `${(parseFloat(w.win_rate) * 100).toFixed(1)}%` : '-';
      const trades = w.total_trades || w.trades || '-';
      text += `${i + 1}. \`${short}\`\n`;
      text += `   PnL: ${pnl} | WR: ${wr} | Trades: ${trades}\n`;
      text += `   /add ${addr}\n\n`;
    });

    text += `Klik /add <address> untuk menambah ke watchlist.`;
    ctx.reply(text, { parse_mode: 'Markdown' });
  } catch (err) {
    ctx.reply(`❌ Error: ${err.message}`);
  }
}

export async function handleAutodiscover(ctx) {
  const userId = ctx.from.id;
  if (userId !== parseInt(process.env.AUTHORIZED_USER_ID)) {
    return unauthorized(ctx);
  }

  await ctx.reply('🔍 *Autodiscover* — mencari dev wallets baru dari watchlist kamu...\n\nProses ini butuh 30-60 detik karena setiap token di-check via GMGN.', { parse_mode: 'Markdown' });

  try {
    // Get all active wallets
    const watchedWallets = getActiveWallets();
    if (watchedWallets.length === 0) {
      return ctx.reply('📭 Watchlist kosong. Add minimal 1 wallet dulu.');
    }

    // Collect all unique tokens from recent sell events
    const tokenMap = {}; // token_addr -> {symbol, dev_wallet, ts}

    for (const { wallet, label } of watchedWallets) {
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
        console.warn(`[Autodiscover] Failed to get txs for ${wallet}: ${err.message}`);
      }
    }

    const tokenList = Object.entries(tokenMap);
    if (tokenList.length === 0) {
      return ctx.reply('❌ Tidak ada token SELL dari watchlist untuk dianalisis.');
    }

    await ctx.reply(`📊 Menemukan ${tokenList.length} token. Mengecek trader data...`, { parse_mode: 'Markdown' });

    // For each token, find dev wallets
    const devWallets = {}; // address -> {count, pnl, tokens[], tags[]}

    for (const [tokenAddr, info] of tokenList) {
      try {
        const traders = await getTokenTraders(tokenAddr);
        for (const trader of traders) {
          const tags = trader.maker_token_tags || [];
          const isDev = tags.includes('dev_team') || tags.includes('creator');
          const isKnown = watchedWallets.some(w => w.wallet === trader.address);

          if (isDev && !isKnown) {
            const addr = trader.address;
            const profit = parseFloat(trader.profit || 0);
            if (!devWallets[addr]) {
              devWallets[addr] = {
                count: 0,
                pnl: 0,
                tokens: [],
                tags: [...new Set([...(trader.tags || []), ...tags])],
              };
            }
            devWallets[addr].count += 1;
            devWallets[addr].pnl += profit;
            devWallets[addr].tokens.push(info.symbol);
          }
        }
      } catch (err) {
        console.warn(`[Autodiscover] Trader lookup failed for ${tokenAddr}: ${err.message}`);
      }
    }

    // Sort by: count desc, then pnl desc
    const sorted = Object.entries(devWallets)
      .map(([addr, info]) => ({ addr, ...info }))
      .sort((a, b) => b.count - a.count || b.pnl - a.pnl);

    if (sorted.length === 0) {
      return ctx.reply('❌ Tidak ada dev wallet baru ditemukan. Coba watchlist dengan lebih banyak wallet aktif.');
    }

    // Format response
    let text = `🎯 *Autodiscover Results*
`;
    text += `Ditemukan ${sorted.length} dev wallet dari ${tokenList.length} token
`;
    text += `Min 3x appearances = high confidence\n\n`;
    text += `━━━━━━━━━━━━━━━━━━━━\n\n`;

    const highConf = sorted.filter(w => w.count >= 3);
    const mediumConf = sorted.filter(w => w.count === 2);
    const lowConf = sorted.filter(w => w.count === 1);

    if (highConf.length > 0) {
      text += `🔥 *HIGH CONFIDENCE* (≥3 tokens)\n\n`;
      for (const w of highConf.slice(0, 5)) {
        const short = w.addr.slice(0, 8) + '...' + w.addr.slice(-6);
        text += `${highConf.indexOf(w) + 1}. \`${short}\`\n`;
        text += `   📈 ${w.count}x | PnL: ${w.pnl >= 0 ? '+' : ''}${w.pnl.toFixed(2)} SOL\n`;
        text += `   🐸 ${w.tokens.slice(0, 3).join(', ')}\n`;
        text += `   /add ${w.addr}\n\n`;
      }
      text += `\n`;
    }

    if (mediumConf.length > 0) {
      text += `⚡ *MEDIUM* (2x) — coba /wallet dulu sebelum add\n\n`;
      for (const w of mediumConf.slice(0, 3)) {
        const short = w.addr.slice(0, 8) + '...' + w.addr.slice(-6);
        text += `• \`${short}\` — ${w.count}x | PnL: ${w.pnl >= 0 ? '+' : ''}${w.pnl.toFixed(2)} SOL\n`;
      }
      text += `\n`;
    }

    if (lowConf.length > 0) {
      text += `🟡 *LOW* (1x) — perlu verification manual\n`;
      text += `Coba: /wallet ${lowConf[0]?.addr} untuk cek pattern\n\n`;
    }

    text += `━━━━━━━━━━━━━━━━━━━━\n\n`;
    text += `💡 *Cara baca:*\n`;
    text += `• appearances = berapa token yg sama-sama ditrading\n`;
    text += `• PnL = profit total dari token tsb\n`;
    text += `• Tag \`creator\` = creating wallet (higher confidence)`;

    ctx.reply(text, { parse_mode: 'Markdown' });

  } catch (err) {
    console.error('[Autodiscover] Error:', err);
    ctx.reply(`❌ Autodiscover error: ${err.message}`);
  }
}
