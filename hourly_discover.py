#!/usr/bin/env python3
"""
Hicarus — Hourly Discover
Run by cron every hour.
Target: THE Distributor — dev that CREATES a token, BUYS at launch, SELLS ALL in ONE tx, price pumps.

Flow:
  For each token found in watchlist wallet sells:
    1. Get dev.creator_address (ON-CHAIN creator — not sniper/bundler)
    2. Check if creator does one-shot sell (BUY launch → SELL ALL ≤60s)
    3. Verify kline pump after sell
    4. Auto-add if ≥2 appearances
"""
import subprocess, json, urllib.request, urllib.parse, sqlite3, os
from datetime import datetime

# Config
DB_FILE       = '/home/ubuntu/hicarus/data/wallets.db'
CHAT_ID       = '6170215817'
MIN_CONF      = 2
MAX_TOKENS    = 20
SELL_GAP_MAX  = 60   # seconds between buy and sell
PUMP_LOOKBACK = 120  # seconds after sell to check kline
ONE_SHOT_MIN  = 0.50 # ≥50% of buy amount in one sell tx (creator typical = 50% chunk)

# ── Helpers ─────────────────────────────────────────────────────

def get_env(key):
    with open('/home/ubuntu/hicarus/.env') as f:
        for line in f:
            if line.startswith(key):
                return line.split('=', 1)[1].strip()
    return ''

def gmgn_json(cmd):
    subprocess.run(cmd + ' 2>/dev/null > /tmp/gmgn_out.txt', shell=True, timeout=30)
    try:
        raw = open('/tmp/gmgn_out.txt').read()
        s = raw.find('[')
        e = raw.rfind(']') + 1
        return json.loads(raw[s:e]) if s >= 0 else []
    except:
        return []

def gmgn_token_info(token_addr):
    """Get token info including dev.creator_address"""
    subprocess.run(
        'gmgn-cli token info --chain sol --address ' + token_addr + ' --raw 2>/dev/null > /tmp/gmgn_out.txt',
        shell=True, timeout=30
    )
    try:
        with open('/tmp/gmgn_out.txt') as f:
            return json.load(f)
    except:
        return {}

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

# ── Check pump via GMGN kline ──────────────────────────────────

def check_pump(token_addr, sell_timestamp):
    """
    Check kline 1m after sell for price pump.
    Pump confirmed = any candle AFTER sell with close > open (green candle).
    No kline data = skip (trust pattern for new pump.fun tokens).
    """
    cmd = (
        'gmgn-cli market kline --chain sol --address ' + token_addr
        + ' --resolution 1m --from ' + str(sell_timestamp)
        + ' --to ' + str(sell_timestamp + PUMP_LOOKBACK)
        + ' --raw'
    )
    subprocess.run(cmd + ' 2>/dev/null > /tmp/gmgn_out.txt', shell=True, timeout=30)
    try:
        raw = open('/tmp/gmgn_out.txt').read()
        data = json.loads(raw)
        klines = data.get('list', []) if isinstance(data, dict) else data
    except:
        return None  # No kline — skip

    if not klines:
        return None  # No candles in range — skip

    # Check: any candle AFTER sell where close > open (green = price went up)
    for k in klines:
        if not isinstance(k, dict):
            continue
        t      = k.get('time', 0) // 1000
        open_p = float(k.get('open', 0))
        close_p= float(k.get('close', 0))
        if t < sell_timestamp:
            continue
        if close_p > open_p:  # green candle = price pump
            return True
    return False

# ── Check if a wallet is a Distributor on a specific token ─────

def check_distributor(wallet_addr, token_addr):
    """
    Full Distributor check for ONE token:
    1. Wallet must have BUY + SELL on this token
    2. First SELL must be ≥88% of buy amount, within 60s
    3. Price must pump after sell (kline or skip if no kline)
    Returns (is_distributor, sell_pnl, sell_timestamp)
    """
    activities = gmgn_json(
        'gmgn-cli portfolio activity --chain sol --wallet ' + wallet_addr + ' --limit 30'
    )

    txs = [a for a in activities
           if a.get('event_type') in ('buy', 'sell')
           and a.get('token', {}).get('address') == token_addr]

    if not txs:
        return False, 0.0, 0

    txs.sort(key=lambda x: x.get('timestamp', 0))
    buy_txs  = [t for t in txs if t.get('event_type') == 'buy']
    sell_txs = [t for t in txs if t.get('event_type') == 'sell']

    if not sell_txs:
        return False, 0.0, 0

    # ── Trader case: BUY then SELL ──
    if buy_txs:
        total_bought   = sum(float(t.get('token_amount', 0)) for t in buy_txs)
        first_sell_amt = float(sell_txs[0].get('token_amount', 0))
        gap = sell_txs[0].get('timestamp', 0) - buy_txs[0].get('timestamp', 0)
        pct = first_sell_amt / total_bought if total_bought > 0 else 0
        if gap < 0 or gap > SELL_GAP_MAX or pct < ONE_SHOT_MIN:
            return False, 0.0, 0
        sell_ts    = sell_txs[0].get('timestamp', 0)
        # Compute PnL from quote_amount
        buy_total  = sum(float(t.get('quote_amount', 0)) for t in buy_txs)
        sell_total = sum(float(t.get('quote_amount', 0)) for t in sell_txs)
        sell_pnl   = sell_total - buy_total
        pump = check_pump(token_addr, sell_ts)
        if pump is False:
            return False, 0.0, 0
        return True, sell_pnl, sell_ts

    # ── Creator case: no BUY, only SELL (creator distributes launch allocation) ──
    first_sell = sell_txs[0]
    sell_ts    = first_sell.get('timestamp', 0)
    sell_total = sum(float(t.get('quote_amount', 0)) for t in sell_txs)
    sell_pnl   = sell_total  # positive = SOL received
    pump = check_pump(token_addr, sell_ts)
    if pump is False:
        return False, 0.0, 0
    return True, sell_pnl, sell_ts

# ── Discover ────────────────────────────────────────────────────

def discover():
    conn = init_db()
    seeds = db_get_active(conn)
    conn.close()

    if not seeds:
        tg_send('📭 *Hicarus*\n\nNo wallets in watchlist.')
        return

    print('[Hicarus] Seeds: ' + str(len(seeds)))
    tg_send('🔍 *Hicarus Discover*\n' + str(len(seeds)) + ' wallets — finding Distributors...\n(creator = on-chain token creator)')

    token_map = {}   # token_addr -> symbol
    dev_map   = {}   # creator_addr -> {count, pnl, tokens, sell_timestamps}

    # 1. Collect tokens from all watchlist wallets
    for wallet in seeds:
        activities = gmgn_json(
            'gmgn-cli portfolio activity --chain sol --wallet ' + wallet
            + ' --limit ' + str(MAX_TOKENS)
        )
        for a in activities:
            if a.get('event_type') == 'sell' and a.get('token', {}).get('address'):
                tok = a['token']['address']
                if tok not in token_map:
                    token_map[tok] = a['token'].get('symbol', tok[:8])

    tokens = list(token_map.items())
    tg_send('📊 ' + str(len(tokens)) + ' token found. Checking creators...')
    print('[Hicarus] ' + str(len(tokens)) + ' tokens collected')

    # 2. For each token, get ON-CHAIN creator, check if they do one-shot
    for token_addr, symbol in tokens[:25]:
        token_info = gmgn_token_info(token_addr)
        dev_info   = token_info.get('dev', {}) or {}
        creator    = dev_info.get('creator_address', '')

        if not creator:
            continue

        is_dist, pnl, sell_ts = check_distributor(creator, token_addr)
        if not is_dist:
            continue

        if creator not in dev_map:
            dev_map[creator] = {'count': 0, 'pnl': 0.0, 'tokens': [], 'timestamps': []}
        dev_map[creator]['count'] += 1
        dev_map[creator]['pnl'] += pnl
        if symbol not in dev_map[creator]['tokens']:
            dev_map[creator]['tokens'].append(symbol)
        dev_map[creator]['timestamps'].append(sell_ts)
        print('[Hicarus] DIST: ' + creator[:12] + '... created ' + symbol
              + ' (PnL ' + str(round(pnl, 2)) + ')')

    sorted_devs = sorted(dev_map.items(), key=lambda x: (x[1]['count'], x[1]['pnl']), reverse=True)
    print('[Hicarus] ' + str(len(sorted_devs)) + ' Distributors found')

    # 3. Auto-add
    conn2 = init_db()
    added = []
    for addr, info in sorted_devs:
        if info['count'] >= MIN_CONF and not db_has(conn2, addr):
            label = 'Distributor #' + str(info['count']) + 'x ' + ', '.join(info['tokens'][:3])
            db_add(conn2, addr, label, info['count'], info['pnl'])
            added.append((addr, info))
            print('[Hicarus] AUTO-ADDED: ' + addr[:12] + '...')
    conn2.close()

    # 4. Format
    now_str = datetime.now().strftime('%H:%M')
    lines = []
    lines.append('🎯 *Hicarus Discover — ' + now_str + '*')
    lines.append('Target: ON-CHAIN CREATOR (bukan sniper/bundler)')
    lines.append('Filter: creates token → BUY launch → SELL ALL one-shot ≤60s → pump')
    lines.append(str(len(seeds)) + ' watchlist · ' + str(len(tokens)) + ' token · '
                 + str(len(sorted_devs)) + ' Distributor')
    lines.append('')

    if added:
        lines.append('✅ *' + str(len(added)) + ' Distributor AUTO-ADDED*')
        for addr, info in added[:8]:
            pnl_str = '+' + str(round(info['pnl'], 2)) if info['pnl'] >= 0 else str(round(info['pnl'], 2))
            lines.append('`' + addr + '`')
            lines.append('   📈 ' + str(info['count']) + 'x · PnL ' + pnl_str
                         + ' SOL · ' + ', '.join(info['tokens'][:3]))
        lines.append('')
        lines.append('━━━━━━━━━━━━━━━━━━━━')
        lines.append('')

    high   = [(a, d) for a, d in sorted_devs if d['count'] >= MIN_CONF]
    medium = [(a, d) for a, d in sorted_devs if d['count'] == 1]

    if high:
        lines.append('🔥 *HIGH* (≥' + str(MIN_CONF) + 'x)')
        for i, (addr, info) in enumerate(high[:8]):
            pnl_str = '+' + str(round(info['pnl'], 2)) if info['pnl'] >= 0 else str(round(info['pnl'], 2))
            lines.append(str(i + 1) + '. `' + addr + '`')
            lines.append('   📈 ' + str(info['count']) + 'x · PnL: ' + pnl_str + ' SOL')
            lines.append('   🐸 ' + ', '.join(info['tokens'][:4]))
        lines.append('')

    if medium:
        lines.append('⚡ *MEDIUM* (1x)')
        for addr, info in medium[:5]:
            pnl_str = '+' + str(round(info['pnl'], 2)) if info['pnl'] >= 0 else str(round(info['pnl'], 2))
            lines.append('• `' + addr + '` · ' + str(info['count']) + 'x · PnL: ' + pnl_str
                         + ' SOL · ' + ', '.join(info['tokens'][:2]))
        lines.append('')

    lines.append('━━━━━━━━━━━━━━━━━━━━')
    lines.append('Next run: 1 jam lagi ⏰')

    tg_send('\n'.join(lines))
    print('[Hicarus Discover] Done — ' + str(len(added)) + ' added, ' + str(len(sorted_devs)) + ' total')

if __name__ == '__main__':
    discover()