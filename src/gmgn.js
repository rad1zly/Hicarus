import axios from 'axios';

const BASE = 'https://openapi.gmgn.ai';
const GMGN_API_KEY = process.env.GMGN_API_KEY || '';

const client = axios.create({
  baseURL: BASE,
  headers: {
    'Authorization': `Bearer ${GMGN_API_KEY}`,
    'Accept': 'application/json',
  },
  timeout: 15000,
});

// Rate limiter — token bucket, 60 req / 60s
let tokens = 60;
const REFILL_RATE = 1; // 1 token per second
let lastRefill = Date.now();

function refillTokens() {
  const now = Date.now();
  const elapsed = (now - lastRefill) / 1000;
  tokens = Math.min(60, tokens + elapsed * REFILL_RATE);
  lastRefill = now;
}

async function rateLimit() {
  refillTokens();
  if (tokens < 1) {
    const wait = Math.ceil((1 - tokens) / REFILL_RATE * 1000);
    await new Promise(r => setTimeout(r, wait));
    refillTokens();
  }
  tokens -= 1;
}

async function get(path, params = {}) {
  await rateLimit();
  const resp = await client.get(path, { params });
  if (resp.data?.code !== 0 && resp.data?.code !== 200) {
    throw new Error(`GMGN API error ${resp.data?.code}: ${resp.data?.msg || 'unknown'}`);
  }
  return resp.data?.data || resp.data;
}

/**
 * Recent transactions for a wallet.
 * Returns array of tx objects with: signature, token, side, amount, amount_usd, price, timestamp
 */
export async function getWalletTxs(address, limit = 50) {
  const data = await get('/v1/wallet/txs', { address, limit });
  return data?.txs || [];
}

/**
 * Current portfolio holdings for a wallet.
 */
export async function getWalletPortfolio(address) {
  const data = await get('/v1/wallet/portfolio', { address });
  return data?.tokens || [];
}

/**
 * Wallet stats: P&L, win rate, total trades.
 */
export async function getWalletStats(address) {
  const data = await get('/v1/wallet/stats', { address });
  return data;
}

/**
 * Token metadata by mint address.
 */
export async function getTokenInfo(mint) {
  const data = await get('/v1/token', { mint });
  return data;
}

/**
 * Trending / new tokens on pump.fun.
 */
export async function getTrending(chain = 'sol', limit = 20) {
  const data = await get('/v1/trending/pump', { chain, limit });
  return data?.tokens || [];
}

/**
 * Top wallets ranking by PnL or win rate.
 * sort: 'pnl' | 'win_rate' | 'trades' | 'volume'
 */
export async function getTopWallets(chain = 'sol', sort = 'pnl', limit = 20) {
  const data = await get('/v1/wallets/ranking', { chain, sort, order: 'desc', limit });
  return data?.wallets || data || [];
}

/**
 * New pump.fun tokens (recently launched).
 */
export async function getNewTokens(chain = 'sol', limit = 30) {
  const data = await get('/v1/new_tokens/pump', { chain, limit });
  return data?.tokens || [];
}

/**
 * Top traders for a token — includes sniper/dev tags.
 * maker_token_tags: 'creator' | 'dev_team' | 'sniper' | 'bundler' | 'paper_hands'
 *
 * Response: array of trader objects
 *   address, profit, realized_profit, maker_token_tags[],
 *   buy_tx_count_cur, sell_tx_count_cur, start_holding_at, end_holding_at
 */
export async function getTokenTraders(mint, chain = 'sol', limit = 30) {
  const resp = await client.get('/v1/token/traders', { params: { address: mint, chain, limit } });
  if (resp.data?.code !== 0 && resp.data?.code !== 200) {
    throw new Error(`GMGN token traders error ${resp.data?.code}: ${resp.data?.msg || 'unknown'}`);
  }
  return resp.data?.data || [];
}
