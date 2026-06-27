# Hicarus

**Smart Money Wallet Discovery** — Solana dev wallet finder via GMGN API.

No real-time alerts. No copy trade. Just find the best dev wallets, every hour.

---

## What It Does

```
Seed wallets → GMGN API → new dev wallets discovered → pushed to Telegram
```

Hicarus runs every hour, analyzes tokens traded by known dev wallets, finds new high-confidence dev wallets via GMGN `maker_token_tags`, and pushes results to your Telegram.

---

## Commands

```
/seed      Add 2 seed dev wallets (starting point)
/discover  Find new dev wallets right now
/add       Add a wallet to watchlist
/list      Show watchlist
/wallet    GMGN stats for any address
/guide     Explain the pattern
/help      Show this
```

---

## The Pattern: "The Distributor"

Dev wallets that repeatedly:
1. Create a token (`launch` event)
2. Buy at launch price (0.5–3.5 SOL)
3. Sell in 1–3 transactions within seconds
4. Profit every time

**Real examples from seed wallets:**

| Wallet | Tokens Created | Realized P&L | Win Rate |
|--------|---------------|--------------|---------|
| `8inTY66...Eeh` | 1,935 | +$1,358 | 66.9% |
| `6WM3V5...3cR` | 658 | +$1,485 | 87.5% |

These are the seed wallets. Hicarus finds wallets with the same pattern.

---

## Setup

```bash
cd hicarus
npm install
cp .env.example .env
# Edit .env with BOT_TOKEN and GMGN_API_KEY
pm2 start index.js --name hicarus
pm2 save
```

---

## Architecture

```
Hourly Cron (OpenClaw)
       │
       ▼
hourly_discover.py
       │
       ├──► gmgn-cli portfolio activity (seed wallets)
       ├──► gmgn-cli token traders (per token)
       ├──► filter: maker_token_tags = creator/dev_team
       ├──► rank: appearances × PnL
       │
       ▼
Telegram Push (results)
```

No real-time polling. No trade alerts. Just wallet discovery every hour.

---

## Files

```
hicarus/
├── index.js              # Telegram bot (commands only)
├── hourly_discover.py    # Hourly discovery + Telegram push
├── package.json
├── .env
├── data/wallets.db       # SQLite (watchlist)
└── src/
    ├── db.js             # SQLite helpers
    ├── gmgn.js           # GMGN API wrapper
    ├── commands.js       # Telegram command handlers
    └── monitor.js        # (disabled — no polling)
```

---

## GMGN API Reference

| Endpoint | Used For |
|---|---|
| `GET /v1/wallet/txs` | Recent transactions |
| `GET /v1/wallet/stats` | P&L, win rate |
| `GET /v1/token/traders` | Traders with `maker_token_tags` |

Key field: `maker_token_tags: ['creator', 'dev_team', 'sniper', 'bundler', 'paper_hands']`

---

## License

MIT
