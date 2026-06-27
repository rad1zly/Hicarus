/**
 * Hicarus — Monitor Module
 *
 * Polling DISABLED — no real-time alerts.
 * Discovery runs on-demand via /discover or hourly cron.
 */

export const pendingAlerts = []; // kept for compatibility

export async function pollOnce() {
  // No polling — discovery is on-demand only
  return [];
}

export function startPolling() {
  console.log('[Hicarus] Polling disabled — discovery on-demand only');
}

export function stopPolling() {}
export function isRunning() { return false; }
