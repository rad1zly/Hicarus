#!/usr/bin/env python3
"""
Hicarus — Hourly Discover
Run by cron every hour.
Self-sustaining: uses ALL active watchlist wallets as seeds each run.
Only finds "The Distributor" — dev that BUY at launch and SELL ALL in ONE tx <=60s.
"""
import subprocess, json, urllib.request, urllib.parse, sqlite3, os
from datetime import datetime

# Config
DB_FILE        = '/home/ubuntu/hicarus/data/wallets.db'
CHAT_ID        = '6170215817'
MIN_CONF       = 2    # auto-add wallets with >=2 appearances (strict filter = lower volume)
MAX_TOKENS     = 20   # tokens to check per wallet
MAX_TRADERS    = 20   # traders to check per token
ONE_SHOT_MIN   = 0.88 # ≥88% of buy amount in ONE sell tx
SELL_GAP_MAX   = 60   # seconds between buy and sell

# ── Helpers ─────────────────────────────────────────────────────

def get_env(key):
    with open('/home/ubuntu/hicarus/.env') as f:
        for line in f:
            if line.startswith(key):
                return line.split('=', 1)[1].strip()
    return ''

def gmgn():
    try:
        with open('/tmp/gmgn_out.txt') as f:
            raw = f.read()
    except:
        return []
    try:
        s = raw.find('[')
        e = raw.rfind(']') + 1
        return json.loads(raw[s:e]) if s >= 0 else []
    except:
        return []

def tg_send(text):
    payload = {'chat_id': CHAT_ID, 'text': text, 'parse_mode': 'Markdown'}
    data = urllib.parse.urlencode(payload).encode()
    req = urllib.request.Request(
        'https://api.telegram.org/bot' + get_env('BOT_TOKEN') + '/sendMessage',
        data=data, method='POST'
    )
    with urllib.request.urlopen(req) as r:
        res = json.loads(r.read())
        assert res.get('ok'), str(res)
        return res['result']['message_id']

def init_db():
    os.makedirs(os.path.dirname(DB_FILE), exist_ok=True)
    conn = sqlite3.connect(DB_FILE)
    conn.execute('''
        CREATE TABLE IF NOT EXISTS watchlist (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            wallet     TEXT    NOT NULL UNIQUE,
            label      TEXT,
            added_by   INTEGER NOT NULL,
            added_at   INTEGER NOT NULL,
            active     INTEGER DEFAULT 1,
            last_tx    TEXT,
            confidence INTEGER DEFAULT 0,
            total_pnl  REAL    DEFAULT 0
        )
    ''')
    conn.commit()
    return conn

def db_has(conn, addr):
    return conn.execute('SELECT 1 FROM watchlist WHERE wallet=?', (addr,)).fetchone() is not None

def db_add(conn, addr, label, conf, pnl):
    now = int(datetime.now().timestamp())
    conn.execute('''
        INSERT OR IGNORE INTO watchlist (wallet,label,added_by,added_at,active,confidence,total_pnl)
        VALUES (?,?,?,?,1,?,?)
    ''', (addr, label, int(CHAT_ID), now, conf, pnl))
    conn.commit()

def db_get_active(conn):
    return [row[0] for row in conn.execute('SELECT wallet FROM watchlist WHERE active=1').fetchall()]

# ── Check if a trader does ONE-SHOT sell on a token ────────────
# Returns (bool, float) = (is_one_shot, sell_pnl)

def check_one_shot(wallet_addr, token_addr):
    """
    Fetch wallet's txs for this token.
    Returns True if wallet BUYs and then SELLs ALL (>88% of buy amt) in ONE tx within 60s.
    """
    subprocess.run(
        'gmgn-cli portfolio activity --chain sol --wallet ' + wallet_addr + ' --limit 30 2>/dev/null > /tmp/gmgn_out.txt',
        shell=True, timeout=30
    )
    activities = gmgn()

    # Filter to this token only
    txs = [a for a in activities
           if a.get('event_type') in ('buy', 'sell')
           and a.get('token', {}).get('address') == token_addr]

    if not txs:
        return False, 0.0

    # Sort by timestamp
    txs.sort(key=lambda x: x.get('timestamp', 0))

    buy_txs  = [t for t in txs if t.get('event_type') == 'buy']
    sell_txs = [t for t in txs if t.get('event_type') == 'sell']

    if not buy_txs or not sell_txs:
        return False, 0.0

    # Total bought amount
    total_bought = sum(float(t.get('token_amount', 0)) for t in buy_txs)
    first_sell = sell_txs[0]
    first_sell_amt = float(first_sell.get('token_amount', 0))
    first_buy = buy_txs[0]

    # Check: first sell is within 60s of first buy
    gap = first_sell.get('timestamp', 0) - first_buy.get('timestamp', 0)
    if gap < 0 or gap > SELL_GAP_MAX:
        return False, 0.0

    # Check: first sell amount >= 88% of total bought (one-shot)
    pct = first_sell_amt / total_bought if total_bought > 0 else 0
    if pct < ONE_SHOT_MIN:
        return False, 0.0

    # One-shot confirmed
    sell_pnl = sum(float(t.get('profit', 0)) for t in sell_txs)
    return True, sell_pnl

# ── Discover ────────────────────────────────────────────────────

def discover():
    conn = init_db()
    seeds = db_get_active(conn)
    conn.close()

    if not seeds:
        tg_send('📭 *Hicarus*\n\nNo wallets in watchlist. Run `/discover` to seed manually.')
        return

    print('[Hicarus] Seeds: ' + str(len(seeds)))
    tg_send('🔍 *Hicarus Discover*\n' + str(len(seeds)) + ' wallets — analyzing one-shot pattern...')

    token_map = {}  # token_addr -> symbol
    dev_map   = {}  # dev_addr -> {count, pnl, tokens}

    # 1. Collect tokens from all watchlist wallets
    for wallet in seeds:
        subprocess.run(
            'gmgn-cli portfolio activity --chain sol --wallet ' + wallet + ' --limit ' + str(MAX_TOKENS) + ' 2>/dev/null > /tmp/gmgn_out.txt',
            shell=True, timeout=30
        )
        for a in gmgn():
            if a.get('event_type') == 'sell' and a.get('token', {}).get('address'):
                tok = a['token']['address']
                if tok not in token_map:
                    token_map[tok] = a['token'].get('symbol', tok[:8])

    tokens = list(token_map.items())
    tg_send('📊 ' + str(len(tokens)) + ' token. Checking traders for one-shot pattern...')
    print('[Hicarus] ' + str(len(tokens)) + ' tokens collected')

    # 2. For each token, find traders with dev_team/creator tag
    #    Then verify if they do ONE-SHOT pattern
    for token_addr, symbol in tokens[:25]:
        subprocess.run(
            'gmgn-cli token traders --chain sol --address ' + token_addr + ' --limit ' + str(MAX_TRADERS) + ' --raw 2>/dev/null > /tmp/gmgn_out.txt',
            shell=True, timeout=30
        )
        try:
            traders_raw = json.loads(open('/tmp/gmgn_out.txt').read())
            traders = traders_raw.get('list', traders_raw) if isinstance(traders_raw, dict) else traders_raw
        except:
            continue

        seen_per_token = set()  # dedup: one entry per (wallet, token)
        for t in traders:
            if not isinstance(t, dict):
                continue
            tags = t.get('maker_token_tags', []) + t.get('tags', [])
            if ('dev_team' not in tags and 'creator' not in tags):
                continue
            addr = t.get('address', '')
            if addr in seeds:
                continue
            if addr in seen_per_token:
                continue
            seen_per_token.add(addr)

            # Verify one-shot pattern
            is_os, pnl = check_one_shot(addr, token_addr)
            if not is_os:
                continue  # Skip — not a true Distributor

            if addr not in dev_map:
                dev_map[addr] = {'count': 0, 'pnl': 0.0, 'tokens': []}
            dev_map[addr]['count'] += 1
            dev_map[addr]['pnl'] += pnl
            if symbol not in dev_map[addr]['tokens']:
                dev_map[addr]['tokens'].append(symbol)
            print('[Hicarus] ONE-SHOT: ' + addr[:12] + '... on ' + symbol + ' (PnL ' + str(round(pnl, 2)) + ')')

    sorted_devs = sorted(dev_map.items(), key=lambda x: (x[1]['count'], x[1]['pnl']), reverse=True)
    print('[Hicarus] ' + str(len(sorted_devs)) + ' Distributors found')

    # 3. Auto-add to DB
    conn2 = init_db()
    added = []
    for addr, info in sorted_devs:
        if info['count'] >= MIN_CONF and not db_has(conn2, addr):
            label = 'Distributor #' + str(info['count']) + 'x ' + ', '.join(info['tokens'][:3])
            db_add(conn2, addr, label, info['count'], info['pnl'])
            added.append((addr, info))
            print('[Hicarus] AUTO-ADDED: ' + addr[:12] + '... (' + str(info['count']) + 'x)')
    conn2.close()

    # 4. Format results
    now_str = datetime.now().strftime('%H:%M')
    lines = []
    lines.append('🎯 *Hicarus Discover — ' + now_str + '*')
    lines.append('Filter: BUY launch → SELL ALL in ONE tx ≤60s')
    lines.append(str(len(seeds)) + ' watchlist · ' + str(len(tokens)) + ' token · ' + str(len(sorted_devs)) + ' Distributor')
    lines.append('')

    if added:
        lines.append('✅ *' + str(len(added)) + ' Distributor AUTO-ADDED*')
        for addr, info in added[:8]:
            pnl_str = '+' + str(round(info['pnl'], 2)) if info['pnl'] >= 0 else str(round(info['pnl'], 2))
            lines.append('`' + addr + '`')
            lines.append('   📈 ' + str(info['count']) + 'x · PnL ' + pnl_str + ' SOL · ' + ', '.join(info['tokens'][:3]))
        lines.append('')
        lines.append('━━━━━━━━━━━━━━━━━━━━')
        lines.append('')

    high   = [(a, d) for a, d in sorted_devs if d['count'] >= MIN_CONF]
    medium = [(a, d) for a, d in sorted_devs if d['count'] == 2]

    if high:
        lines.append('🔥 *HIGH* (≥' + str(MIN_CONF) + 'x)')
        for i, (addr, info) in enumerate(high[:8]):
            pnl_str = '+' + str(round(info['pnl'], 2)) if info['pnl'] >= 0 else str(round(info['pnl'], 2))
            lines.append(str(i + 1) + '. `' + addr + '`')
            lines.append('   📈 ' + str(info['count']) + 'x · PnL: ' + pnl_str + ' SOL')
            lines.append('   🐸 ' + ', '.join(info['tokens'][:4]))
        lines.append('')

    if medium:
        lines.append('⚡ *MEDIUM* (2x)')
        for addr, info in medium[:5]:
            pnl_str = '+' + str(round(info['pnl'], 2)) if info['pnl'] >= 0 else str(round(info['pnl'], 2))
            lines.append('• `' + addr + '` · ' + str(info['count']) + 'x · PnL: ' + pnl_str)
        lines.append('')

    lines.append('━━━━━━━━━━━━━━━━━━━━')
    lines.append('One-shot = SELL ≥88% of buy in ONE tx ≤60s')
    lines.append('Next run: 1 jam lagi ⏰')

    tg_send('\n'.join(lines))
    print('[Hicarus Discover] Done — ' + str(len(added)) + ' added, ' + str(len(sorted_devs)) + ' total')

if __name__ == '__main__':
    discover()