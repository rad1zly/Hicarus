# WalletFeeder

**Smart Money Wallet Pooler** — Solana reverse copy trade signal bot.

Track dev wallets via GMGN API → get real-time SELL alerts → reverse copy trade.

---

## What It Does

```
Dev CREATE token → DEV BUY (hold) → DEV SELL 🚨
                                          ↑
                              You BUY HERE (reverse copy)
                                          ↓
                              Price distributes up → you SCALP SELL
```

WalletFeeder polls GMGN every 30s, detects **SELL events** from tracked dev wallets, and sends Telegram alerts so you can enter simultaneously with the dev's distribution — then ride the momentum upward.

---

## Pattern: "The Distributor"

Dev wallets that create → buy at launch → sell in 1-3 transactions within seconds → profitable every time.

**Real examples from tracked wallets:**

| Token | Dev BUY | Dev SELL Total | Net |
|-------|---------|----------------|-----|
| EC | 2.0 SOL | 2.492 SOL | +24.6% |
| GODSHOG | 2.0 SOL | 2.565 SOL | +28.3% |
| DENTACOIN | 2.0 SOL | 2.437 SOL | +21.9% |
| GALAXY | 3.5 SOL | 9.020 SOL | +157% |

The key: after dev sells, new buyers absorb the supply and price **distributes upward** — that's your entry momentum.

---

## Commands

### Wallet Management
```
/add <wallet> [label]   Add wallet to watchlist
/remove <wallet>        Remove wallet
/list                   List all watched wallets
/wallet <wallet>        Stats + portfolio via GMGN
```

### Discovery
```
/guide                  Explain the "The Distributor" pattern
/search [pnl|winrate]   Find top wallets by PnL or win rate
/autodiscover           Auto-find NEW dev wallets from your watchlist
```

### Settings
```
/settings               View current settings
/set interval <sec>    Poll interval (default 30s)
/set buys on|off        Toggle buy alerts
/set sells on|off       Toggle sell alerts
/set minusd <amount>    Min USD to trigger alert (default $5)
/set autolist on|off    Auto-forward to SnipeTrenchBot
```

### Info
```
/stats                  Bot stats (wallets, alerts, polling)
/recent                 Recent alerts history
/feed                   Trigger poll cycle manually
/help                   Show this help
```

---

## Setup

### 1. Install dependencies
```bash
cd walletfeeder
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Edit .env with your credentials
```

**Required in `.env`:**
```env
BOT_TOKEN=           # From @BotFather
GMGN_API_KEY=       # From https://openapi.gmgn.ai
AUTHORIZED_USER_ID= # Your Telegram user ID
DEFAULT_POLL_INTERVAL=30
MIN_USD_THRESHOLD=5
```

### 3. Run
```bash
node index.js
# or with PM2:
pm2 start index.js --name walletfeeder
pm2 save
pm2 logs walletfeeder
```

---

## Autodiscover — Finding New Dev Wallets

The `/autodiscover` command implements a rule-based discovery loop:

```
1. For each wallet in watchlist → get recent SELL events
2. For each unique token → fetch /token/traders
3. Filter: maker_token_tags includes "creator" or "dev_team"
4. Rank by: appearances × tokens × PnL
5. Output: suggested wallets to add
```

**Confidence levels:**
- 🔥 HIGH CONFIDENCE (≥3 appearances) → direct `/add`
- ⚡ MEDIUM (2 appearances) → verify with `/wallet` first
- 🟡 LOW (1 appearance) → needs manual verification

### Finding "The Distributor" Pattern Manually

1. Open gmgn.ai → find a trending pump.fun token
2. Go to "Holders" → sort by "Token Age" (youngest = newest = likely dev)
3. Click the youngest holder → check "Txs" tab
4. If pattern = `LAUNCH → BUY → SELL` in seconds → found one
5. `/add <address>` to watchlist

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      WalletFeeder                            │
│                  Node.js + Telegraf                         │
│                                                             │
│  Telegram ──► commands.js ──► db.js ──► SQLite             │
│                    │                                         │
│                    ▼                                         │
│              monitor.js                                      │
│                    │                                         │
│                    ▼                                         │
│               gmgn.js ──────► GMGN API (openapi.gmgn.ai)    │
│                                                             │
│  Poll (30s) ──► detect SELL ──► pendingAlerts ──► Telegram  │
└─────────────────────────────────────────────────────────────┘
```

### File Structure
```
walletfeeder/
├── index.js              # Bot init, polling, alert dispatcher
├── package.json
├── .env                  # Credentials (not committed)
├── data/wallets.db       # SQLite DB (auto-created)
├── src/
│   ├── db.js             # Schema + CRUD helpers
│   ├── gmgn.js           # GMGN API wrapper (rate-limited)
│   ├── monitor.js        # Poll loop + SELL detection
│   ├── commands.js       # Telegram command handlers
│   └── format.js         # Alert message formatter
└── README.md
```

### Database Schema
```sql
watchlist (id, wallet, label, added_by, added_at, active, last_tx)
alerts    (id, wallet, token, token_name, token_ticker, side, amount, amount_usd, price, tx_sig, timestamp, sent)
user_settings (user_id, poll_interval, auto_forward, alert_buys, alert_sells, min_amount_usd)
```

---

## Reverse Copy Trade Flow

```
1. WalletFeeder polls GMGN every 30s
2. Dev wallet SELL detected
3. Alert sent: "🚀 DEV SOLD [TICKER] @ $X — BUY NOW"
4. You BUY (manually or via SnipeTrenchBot)
5. Price distributes up (momentum from dev's sell)
6. You scalp SELL (1-30 seconds later)
7. Profit
```

---

## GMGN API Reference

Used endpoints:
| Endpoint | Purpose |
|---|---|
| `GET /v1/wallet/txs` | Recent transactions for wallet |
| `GET /v1/wallet/portfolio` | Current holdings |
| `GET /v1/wallet/stats` | P&L, win rate, trades |
| `GET /v1/token/traders` | Traders for a token (with sniper/dev tags) |
| `GET /v1/wallets/ranking` | Top wallets by PnL/win rate |
| `GET /v1/trending/pump` | New pump.fun tokens |

---

## License

MIT
