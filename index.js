import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';
import {
  handleAdd, handleRemove, handleList, handleWallet,
  handleHelp, handleGuide, handleSeed, handleDiscover,
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

// ── Register Telegram Bot Commands (shows in "/" menu) ──────────

const BOT_COMMANDS = [
  { command: 'start',    description: 'Show main menu' },
  { command: 'menu',     description: 'Show main menu' },
  { command: 'seed',     description: 'Add seed dev wallets' },
  { command: 'discover', description: 'Find new dev wallets now' },
  { command: 'list',     description: 'View your watchlist' },
  { command: 'wallet',  description: 'GMGN stats for an address' },
  { command: 'guide',   description: 'Learn The Distributor pattern' },
  { command: 'help',     description: 'Show all commands' },
];

// ── Inline Keyboard Menu ───────────────────────────────────────

async function sendMainMenu(chatId) {
  const text = `*Hicarus — Wallet Discovery Engine*\n\n` +
    `Every hour, Hicarus finds new dev wallets and sends results here.\n\n` +
    `TAP A BUTTON:\n\n` +
    `🚀 *Discover* — find wallets right now\n` +
    `🌱 *Seed* — add starting dev wallets\n` +
    `📋 *Watchlist* — view tracked wallets\n` +
    `👛 *Wallet* — GMGN stats for any address\n` +
    `📖 *Guide* — learn the pattern\n` +
    `❓ *Help* — show all commands\n\n` +
    `Next auto-discover: ~1 hour ⏰`;

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: '🚀 Discover', callback_data: 'cmd:discover' },
        { text: '🌱 Add Seeds', callback_data: 'cmd:seed' },
      ],
      [
        { text: '📋 Watchlist', callback_data: 'cmd:list' },
        { text: '👛 Wallet', callback_data: 'cmd:wallet' },
      ],
      [
        { text: '📖 Guide', callback_data: 'cmd:guide' },
        { text: '❓ Help', callback_data: 'cmd:help' },
      ],
    ],
  };

  await tg('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    reply_markup: replyMarkup,
  });
}

// ── Commands ───────────────────────────────────────────────────

bot.command('start', async (ctx) => {
  await sendMainMenu(ctx.chat.id);
});
bot.command('menu',  async (ctx) => {
  await sendMainMenu(ctx.chat.id);
});

bot.command('seed',     handleSeed);
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
  const msgId = ctx.callbackQuery.message.message_id;

  if (userId !== parseInt(process.env.AUTHORIZED_USER_ID)) {
    await ctx.answerCbQuery('⛔ Not authorized', { show_alert: true });
    return;
  }

  switch (data) {
    case 'cmd:discover':
      await ctx.answerCbQuery('🔍');
      await handleDiscover(ctx);
      break;
    case 'cmd:seed':
      await ctx.answerCbQuery('🌱');
      await handleSeed(ctx);
      break;
    case 'cmd:list':
      await ctx.answerCbQuery('📋');
      await handleList(ctx);
      break;
    case 'cmd:wallet':
      await ctx.answerCbQuery('👛');
      // Edit the menu message to remove keyboard, then ask for address
      await tg('editMessageReplyMarkup', {
        chat_id: chatId,
        message_id: msgId,
        reply_markup: { inline_keyboard: [] },
      });
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
  console.log('[Hicarus] Commands registered with Telegram ✅');

  bot.launch();
  console.log('[Hicarus] Bot launched ✅');

  process.once('SIGINT',  () => { bot.stop('SIGINT');  process.exit(0); });
  process.once('SIGTERM', () => { bot.stop('SIGTERM'); process.exit(0); });
}

boot().catch(err => {
  console.error('[Hicarus] Boot error:', err);
  process.exit(1);
});
