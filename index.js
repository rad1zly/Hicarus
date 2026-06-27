import 'dotenv/config';
import { Telegraf, session } from 'telegraf';
import { getSettings } from './src/db.js';
import { startPolling, stopPolling, pollOnce, pendingAlerts } from './src/monitor.js';
import { formatAlert } from './src/format.js';
import {
  handleAdd, handleRemove, handleList, handleWallet,
  handleSettings, handleSet, handleStats, handleRecent, handleHelp,
  handleGuide, handleSearch, handleAutodiscover,
} from './src/commands.js';

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('[WalletFeeder] BOT_TOKEN not set in .env');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN, {
  contextType: {},
});

// Middleware: attach userId to ctx for convenience
bot.use((ctx, next) => {
  ctx.userId = ctx.from?.id;
  return next();
});

// ── Commands ───────────────────────────────────────────────────

bot.command('add', handleAdd);
bot.command('remove', handleRemove);
bot.command('list', handleList);
bot.command('wallet', handleWallet);
bot.command('settings', handleSettings);
bot.command('set', handleSet);
bot.command('stats', handleStats);
bot.command('recent', handleRecent);
bot.command('help', handleHelp);
bot.command('guide', handleGuide);
bot.command('search', handleSearch);
bot.command('autodiscover', handleAutodiscover);

// Manual feed trigger
bot.command('feed', async (ctx) => {
  if (ctx.from.id !== parseInt(process.env.AUTHORIZED_USER_ID)) {
    return ctx.reply('⛔ Unauthorized.');
  }
  await ctx.reply('🔄 Polling now...');
  const alerts = await pollOnce();
  if (alerts.length === 0) {
    return ctx.reply('✅ Polling done — no new trades found.');
  }
  ctx.reply(`✅ Polling done — ${alerts.length} new trade(s) detected.`);
});

// ── Alert dispatcher ───────────────────────────────────────────
// Every 5 seconds, flush pending alerts to Telegram

const ALERT_DISPATCH_MS = 5000;

function startAlertDispatcher() {
  setInterval(async () => {
    if (pendingAlerts.length === 0) return;
    const userId = parseInt(process.env.AUTHORIZED_USER_ID);
    const alertsToSend = pendingAlerts.splice(0); // drain

    for (const alert of alertsToSend) {
      try {
        const { text, parse_mode } = formatAlert(alert);
        await bot.telegram.sendMessage(userId, text, { parse_mode });
      } catch (err) {
        console.error('[Dispatcher] Send alert error:', err.message);
        // Put back in queue if failed
        pendingAlerts.unshift(alert);
        break;
      }
    }
  }, ALERT_DISPATCH_MS);
}

// ── Boot ──────────────────────────────────────────────────────

async function boot() {
  console.log('[WalletFeeder] Starting...');
  const userId = parseInt(process.env.AUTHORIZED_USER_ID);
  const settings = getSettings(userId);
  const interval = settings?.poll_interval || parseInt(process.env.DEFAULT_POLL_INTERVAL || 30);

  startPolling(interval);
  startAlertDispatcher();

  bot.launch();
  console.log('[WalletFeeder] Bot launched ✅');

  // Graceful shutdown
  const shutdown = async (signal) => {
    console.log(`[WalletFeeder] ${signal} — shutting down...`);
    stopPolling();
    bot.stop(signal);
    process.exit(0);
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

boot().catch(err => {
  console.error('[WalletFeeder] Boot error:', err);
  process.exit(1);
});
