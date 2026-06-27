import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { getSettings } from './src/db.js';
import {
  handleAdd, handleRemove, handleList, handleWallet,
  handleHelp, handleGuide, handleSeed, handleDiscover,
} from './src/commands.js';

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('[Hicarus] BOT_TOKEN not set in .env');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ── Commands ───────────────────────────────────────────────────

bot.command('seed',     handleSeed);
bot.command('discover', handleDiscover);
bot.command('add',      handleAdd);
bot.command('remove',   handleRemove);
bot.command('list',     handleList);
bot.command('wallet',   handleWallet);
bot.command('guide',    handleGuide);
bot.command('help',     handleHelp);

// ── Boot ──────────────────────────────────────────────────────

async function boot() {
  console.log('[Hicarus] Starting...');
  console.log('[Hicarus] Polling disabled — discovery on-demand + hourly cron');

  // Simple cron: run discover every 60 minutes
  // Stored as interval so we can clear on shutdown
  const CRON_MS = 60 * 60 * 1000;
  const discoverCron = setInterval(async () => {
    console.log('[Hicarus] ⏰ Hourly discover triggered');
    try {
      // Import dynamically to avoid circular
      const { handleDiscover } = await import('./src/commands.js');
      // Auto-discover has no ctx, so we use a mock-like approach
      // Actually, we just log — the user runs /discover manually or
      // we can do a silent discover and push results
      console.log('[Hicarus] Run /discover manually or setup webhook push');
    } catch (err) {
      console.error('[Hicarus] Cron error:', err.message);
    }
  }, CRON_MS);

  bot.launch();
  console.log('[Hicarus] Bot launched ✅');

  const shutdown = (signal) => {
    console.log(`[Hicarus] ${signal} — shutting down...`);
    clearInterval(discoverCron);
    bot.stop(signal);
    process.exit(0);
  };

  process.once('SIGINT',  () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

boot().catch(err => {
  console.error('[Hicarus] Boot error:', err);
  process.exit(1);
});
