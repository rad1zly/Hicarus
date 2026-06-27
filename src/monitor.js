import { getActiveWallets, insertAlert, updateLastTx } from './db.js';
import { getWalletTxs, getTokenInfo } from './gmgn.js';

let pollingTimer = null;
let isPolling = false;

// Pending alerts to dispatch to Telegram
export const pendingAlerts = [];

/**
 * Main poll cycle — check all active wallets for new SELL events.
 *
 * Pattern: Dev creates token → holds → SELLs in 1-3 tx within seconds.
 * Alert: "🚀 DEV SOLD [TICKER] — BUY NOW"
 *
 * @returns {Promise<Array>} new alerts detected
 */
export async function pollOnce() {
  if (isPolling) return [];
  isPolling = true;
  const newAlerts = [];

  try {
    const wallets = getActiveWallets();
    for (const { wallet, label, last_tx } of wallets) {
      try {
        const txs = await getWalletTxs(wallet, 50);
        if (!txs || txs.length === 0) continue;

        // Sort newest first
        txs.sort((a, b) => b.timestamp - a.timestamp);

        // Find all txs NEWER than last_tx
        let newTxs = txs;
        if (last_tx) {
          const lastIdx = txs.findIndex(tx => tx.signature === last_tx);
          newTxs = lastIdx >= 0 ? txs.slice(0, lastIdx) : txs;
        }

        if (newTxs.length === 0) {
          // No new txs — still update last_tx to newest
          updateLastTx(wallet, txs[0].signature);
          continue;
        }

        // Update last_tx to newest tx signature
        updateLastTx(wallet, txs[0].signature);

        // Process SELL events from newest txs
        for (const tx of newTxs) {
          const side = tx.side?.toLowerCase();

          // Alert on SELL — this is the reverse copy trade trigger
          if (side === 'sell') {
            let tokenName = tx.token_name || null;
            let tokenTicker = tx.token_symbol || tx.token_ticker || null;

            // Enrich with token metadata if missing
            if (!tokenName && tx.token) {
              try {
                const info = await getTokenInfo(tx.token);
                if (info) {
                  tokenName = info.name || tokenName;
                  tokenTicker = info.symbol || tokenTicker;
                }
              } catch (_) {
                // enrichment optional — continue without
              }
            }

            const alert = {
              wallet,
              label: label || null,
              token: tx.token || tx.mint || 'unknown',
              tokenName,
              tokenTicker,
              side: 'sell',
              amount: parseFloat(tx.amount || 0),
              amountUsd: parseFloat(tx.amount_usd || 0),
              price: parseFloat(tx.price || 0),
              txSig: tx.signature,
              timestamp: tx.timestamp,
            };

            // Min USD threshold filter
            const minUsd = parseFloat(process.env.MIN_USD_THRESHOLD || 5);
            if (alert.amountUsd >= minUsd) {
              const inserted = insertAlert(alert);
              if (inserted) {
                newAlerts.push(alert);
                pendingAlerts.push(alert);
              }
            }
          }
        }

      } catch (err) {
        console.error(`[Monitor] Error polling ${wallet}: ${err.message}`);
      }
    }
  } finally {
    isPolling = false;
  }

  return newAlerts;
}

/**
 * Start the polling loop.
 * @param {number} intervalSec - seconds between polls (default 30)
 */
export function startPolling(intervalSec = 30) {
  if (pollingTimer) clearInterval(pollingTimer);
  pollingTimer = setInterval(async () => {
    try {
      await pollOnce();
    } catch (err) {
      console.error('[Monitor] pollOnce error:', err.message);
    }
  }, intervalSec * 1000);
  console.log(`[Monitor] Polling started — interval: ${intervalSec}s`);
}

export function stopPolling() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
    console.log('[Monitor] Polling stopped');
  }
}

export function isRunning() {
  return pollingTimer !== null;
}
