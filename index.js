import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';
import {
  handleAdd, handleRemove, handleList, handleWallet,
  handleHelp, handleGuide, handleDiscover,
} from './src/commands.js';

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('[Hicarus] BOT_TOKEN not set in .env');
  process.exit(1);
}
const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function tg(method, params) {
  const resp = await axios.post(`${TG}/${method}`, params);
  return resp.data;
}

const bot = new Telegraf(BOT_TOKEN);

// ── Register Telegram Bot Commands ───────────────────────────────

const BOT_COMMANDS = [
  { command: 'start',    description: 'Show main menu' },
  { command: 'menu',     description: 'Show main menu' },
  { command: 'discover', description: 'Find dev wallets now' },
  { command: 'list',    description: 'View your watchlist' },
  { command: 'wallet', description: 'GMGN stats for an address' },
  { command: 'guide', description: 'Learn The Distributor pattern' },
  { command: 'help',    description: 'Show all commands' },
];

// ── Inline Keyboard Menu ───────────────────────────────────────

async function sendMainMenu(chatId) {
  const text = `*Hicarus — Wallet Discovery Engine*\n\n` +
    `Every hour, Hicarus finds new dev wallets and sends results here.\n` +
    `Just tap a button or type a command.\n\n` +
    `Next auto-discover: ~1 hour ⏰`;

  await tg('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🚀 Discover Now', callback_data: 'cmd:discover' },
          { text: '📋 Watchlist', callback_data: 'cmd:list' },
        ],
        [
          { text: '👛 Wallet Stats', callback_data: 'cmd:wallet' },
          { text: '📖 Guide', callback_data: 'cmd:guide' },
        ],
        [
          { text: '❓ Help', callback_data: 'cmd:help' },
        ],
      ],
    },
  });
}

// ── Commands ───────────────────────────────────────────────────

bot.command('start', async (ctx) => { await sendMainMenu(ctx.chat.id); });
bot.command('menu',  async (ctx) => { await sendMainMenu(ctx.chat.id); });

bot.command('discover', handleDiscover);
bot.command('add',      handleAdd);
bot.command('remove',   handleRemove);
bot.command('list',     handleList);
bot.command('wallet',   handleWallet);
bot.command('guide',    handleGuide);
bot.command('help',     handleHelp);

// ── Callback query handler ──────────────────────────────────────

bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data;
  const userId = ctx.callbackQuery.from.id;
  const chatId = ctx.chat.id;

  if (userId !== parseInt(process.env.AUTHORIZED_USER_ID)) {
    await ctx.answerCbQuery('⛔ Not authorized', { show_alert: true });
    return;
  }

  switch (data) {
    case 'cmd:discover':
      await ctx.answerCbQuery('🔍');
      await handleDiscover(ctx);
      break;
    case 'cmd:list':
      await ctx.answerCbQuery('📋');
      await handleList(ctx);
      break;
    case 'cmd:wallet':
      await ctx.answerCbQuery('👛');
      await ctx.reply(
        '📝 *Wallet Stats*\n\nSend wallet address:\n\n' +
        'Example: `/wallet 8inTY66csRNgKNtGhqGhd4odAV2VeJBDcRVuF7UE3Eeh`',
        { parse_mode: 'Markdown' }
      );
      break;
    case 'cmd:guide':
      await ctx.answerCbQuery('📖');
      await handleGuide(ctx);
      break;
    case 'cmd:help':
      await ctx.answerCbQuery('❓');
      await handleHelp(ctx);
      break;
    default:
      await ctx.answerCbQuery('Unknown');
  }
});

// ── Boot ──────────────────────────────────────────────────────

async function boot() {
  console.log('[Hicarus] Starting...');

  await bot.telegram.setMyCommands(BOT_COMMANDS);
  console.log('[Hicarus] Commands registered ✅');

  bot.launch();
  console.log('[Hicarus] Bot launched ✅');

  process.once('SIGINT',  () => { bot.stop('SIGINT');  process.exit(0); });
  process.once('SIGTERM', () => { bot.stop('SIGTERM'); process.exit(0); });
}

boot().catch(err => {
  console.error('[Hicarus] Boot error:', err);
  process.exit(1);
});
