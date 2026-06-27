import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
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

// ── Menu ───────────────────────────────────────────────────────

function mainMenuKeyboard() {
  return Markup.keyboard([
    ['🚀 Discover Now', '🌱 Add Seed Wallets'],
    ['📋 Watchlist', '👛 Wallet Stats'],
    ['📖 Guide', '❓ Help'],
  ]).resize().persistent();
}

async function showMenu(ctx) {
  const text = `*Hicarus — Wallet Discovery Engine*\n\n` +
    `Every hour, Hicarus finds new dev wallets and sends results here.\n\n` +
    `Tap a button or type a command:\n` +
    `🚀 *Discover* — find wallets right now\n` +
    `🌱 *Seed* — add starting dev wallets\n` +
    `📋 *Watchlist* — view tracked wallets\n` +
    `👛 *Wallet* — GMGN stats for any address\n\n` +
    `Next auto-discover: ~1 hour ⏰`;
  await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard() });
}

// ── Commands ───────────────────────────────────────────────────

bot.command('start', async (ctx) => {
  await showMenu(ctx);
});

bot.command('menu', async (ctx) => {
  await showMenu(ctx);
});

bot.command('seed',     handleSeed);
bot.command('discover', handleDiscover);
bot.command('add',      handleAdd);
bot.command('remove',   handleRemove);
bot.command('list',     handleList);
bot.command('wallet',   handleWallet);
bot.command('guide',    handleGuide);
bot.command('help',     handleHelp);

// ── Text button handlers ────────────────────────────────────────
// When user taps a ReplyKeyboard button, it sends the text as a message.
// We catch common button texts here.

bot.on('text', async (ctx) => {
  const text = ctx.message.text;
  switch (text) {
    case '🚀 Discover Now':
      return handleDiscover(ctx);
    case '🌱 Add Seed Wallets':
      return handleSeed(ctx);
    case '📋 Watchlist':
      return handleList(ctx);
    case '👛 Wallet Stats':
      await ctx.reply('📝 Format: `/wallet <address>`\nContoh: `/wallet 8inTY66csRNgKNtGhqGhd4odAV2VeJBDcRVuF7UE3Eeh`', { parse_mode: 'Markdown' });
      return;
    case '📖 Guide':
      return handleGuide(ctx);
    case '❓ Help':
      return handleHelp(ctx);
    default:
      return; // Let other text pass — maybe it's a command
  }
});

// ── Boot ──────────────────────────────────────────────────────

async function boot() {
  console.log('[Hicarus] Starting...');

  bot.launch();
  console.log('[Hicarus] Bot launched ✅');

  process.once('SIGINT',  () => { bot.stop('SIGINT');  process.exit(0); });
  process.once('SIGTERM', () => { bot.stop('SIGTERM'); process.exit(0); });
}

boot().catch(err => {
  console.error('[Hicarus] Boot error:', err);
  process.exit(1);
});
