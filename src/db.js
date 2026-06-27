import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'wallets.db');

let _db = null;

export function getDb() {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  initSchema(_db);
  return _db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS watchlist (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet     TEXT    NOT NULL UNIQUE,
      label      TEXT,
      added_by   INTEGER NOT NULL,
      added_at   INTEGER NOT NULL,
      active     INTEGER DEFAULT 1,
      last_tx    TEXT
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet       TEXT    NOT NULL,
      token        TEXT    NOT NULL,
      token_name   TEXT,
      token_ticker TEXT,
      side         TEXT    NOT NULL,
      amount       REAL,
      amount_usd   REAL,
      price        REAL,
      tx_sig       TEXT    NOT NULL UNIQUE,
      timestamp    INTEGER NOT NULL,
      sent         INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS user_settings (
      user_id        INTEGER PRIMARY KEY,
      poll_interval  INTEGER DEFAULT 30,
      auto_forward   INTEGER DEFAULT 0,
      alert_buys     INTEGER DEFAULT 1,
      alert_sells    INTEGER DEFAULT 0,
      min_amount_usd REAL    DEFAULT 5
    );

    CREATE INDEX IF NOT EXISTS idx_watchlist_wallet ON watchlist(wallet);
    CREATE INDEX IF NOT EXISTS idx_alerts_sent ON alerts(sent);
    CREATE INDEX IF NOT EXISTS idx_alerts_wallet ON alerts(wallet);
  `);
}

// ── Watchlist helpers ──────────────────────────────────────────

export function addWallet(wallet, label, userId) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO watchlist (wallet, label, added_by, added_at, active)
    VALUES (?, ?, ?, ?, 1)
  `);
  const result = stmt.run(wallet.trim(), label || null, userId, now);
  return result.changes > 0;
}

export function removeWallet(wallet, userId) {
  const db = getDb();
  const stmt = db.prepare(`
    DELETE FROM watchlist WHERE wallet = ? AND added_by = ?
  `);
  const result = stmt.run(wallet.trim(), userId);
  return result.changes > 0;
}

export function listWallets(userId) {
  const db = getDb();
  return db.prepare(`
    SELECT id, wallet, label, active, last_tx, added_at
    FROM watchlist WHERE added_by = ? ORDER BY added_at DESC
  `).all(userId);
}

export function getActiveWallets() {
  const db = getDb();
  return db.prepare(`SELECT wallet, label, last_tx FROM watchlist WHERE active = 1`).all();
}

export function updateLastTx(wallet, txSig) {
  const db = getDb();
  db.prepare(`UPDATE watchlist SET last_tx = ? WHERE wallet = ?`).run(txSig, wallet);
}

// ── Alert helpers ──────────────────────────────────────────────

export function insertAlert(alert) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO alerts
      (wallet, token, token_name, token_ticker, side, amount, amount_usd, price, tx_sig, timestamp, sent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `);
  const result = stmt.run(
    alert.wallet,
    alert.token,
    alert.tokenName || null,
    alert.tokenTicker || null,
    alert.side,
    alert.amount || null,
    alert.amountUsd || null,
    alert.price || null,
    alert.txSig,
    alert.timestamp || Math.floor(Date.now() / 1000)
  );
  return result.changes > 0;
}

export function getUnsentAlerts() {
  const db = getDb();
  return db.prepare(`SELECT * FROM alerts WHERE sent = 0 ORDER BY timestamp ASC`).all();
}

export function markAlertSent(id) {
  const db = getDb();
  db.prepare(`UPDATE alerts SET sent = 1 WHERE id = ?`).run(id);
}

export function getRecentAlerts(limit = 20) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM alerts ORDER BY timestamp DESC LIMIT ?
  `).all(limit);
}

// ── Settings helpers ────────────────────────────────────────────

export function getSettings(userId) {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM user_settings WHERE user_id = ?`).get(userId);
  if (!row) {
    db.prepare(`INSERT INTO user_settings (user_id) VALUES (?)`).run(userId);
    return getSettings(userId);
  }
  return row;
}

export function updateSettings(userId, patch) {
  const db = getDb();
  const fields = Object.keys(patch)
    .map(k => `${k} = ?`)
    .join(', ');
  const values = Object.values(patch);
  db.prepare(`
    INSERT INTO user_settings (user_id) VALUES (?)
    ON CONFLICT(user_id) DO UPDATE SET ${fields}
  `).run(userId, ...values);
}
