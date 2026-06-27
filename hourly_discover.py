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
MAX_ACTIVITY_PAGES = 5    # ~4-5 days back (30 trades/page × 5 = 150 trades)
SELL_GAP_MAX  = 60   # seconds between buy and sell
PUMP_LOOKBACK = 120  # seconds after sell to check kline
ONE_SHOT_MIN  = 0.50 # ≥50% of buy amount in one sell tx (creator typical = 50% chunk)
MCAP_MIN_USD  = 2000 # mcap at sell must be ≥$2k
MCAP_MAX_USD  = 10000 # mcap at sell must be ≤$10k
SOL_PRICE_USD = 1700 # approximate SOL price in USD (for mcap conversion)

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

def gmgn_activity(wallet_addr, max_pages=MAX_ACTIVITY_PAGES):
    """
    Fetch wallet activity across multiple pages (7 days back).
    Returns list of activity dicts.
    """
    seven_days_ago = int(datetime.now().timestamp()) - 7 * 24 * 3600
    all_activities = []
    cursor = ''

    for _ in range(max_pages):
        cmd = (
            'gmgn-cli portfolio activity --chain sol --wallet ' + wallet_addr
            + ' --limit 30' + (' --cursor ' + cursor if cursor else '') + ' --raw'
        )
        subprocess.run(cmd + ' 2>/dev/null > /tmp/gmgn_out.txt', shell=True, timeout=30)
        try:
            with open('/tmp/gmgn_out.txt') as f:
                data = json.load(f)
        except:
            break

        page_activities = data.get('activities', [])
        if not page_activities:
            break

        # Filter: only keep activities from last 7 days
        for a in page_activities:
            if a.get('timestamp', 0) >= seven_days_ago:
                all_activities.append(a)
            else:
                # Past 7 days — stop paging, don't add
                return all_activities

        cursor = data.get('next', '')
        if not cursor:
            break

    return all_activities

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

def check_distributor_from_activities(activities, token_addr, total_supply):
    """
    Full Distributor check for ONE token using pre-fetched activities.
    mcap check: sell mcap must be between $2k-$10k (filters out low-liquidity junk).
    Returns (is_distributor, sell_pnl, sell_timestamp)
    """

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

    first_sell     = sell_txs[0]
    sell_ts        = first_sell.get('timestamp', 0)
    sell_token_amt = float(first_sell.get('token_amount', 0))
    sell_quote_amt = float(first_sell.get('quote_amount', 0))

    # ── mcap at sell time check ──
    if total_supply and sell_token_amt > 0:
        sell_price = sell_quote_amt / sell_token_amt  # SOL per token
        mcap_sol   = sell_price * total_supply
        mcap_usd   = mcap_sol * SOL_PRICE_USD
        if not (MCAP_MIN_USD <= mcap_usd <= MCAP_MAX_USD):
            return False, 0.0, 0

    # ── Trader case: BUY then SELL ──
    if buy_txs:
        total_bought   = sum(float(t.get('token_amount', 0)) for t in buy_txs)
        first_sell_amt = float(sell_txs[0].get('token_amount', 0))
        gap = sell_txs[0].get('timestamp', 0) - buy_txs[0].get('timestamp', 0)
        pct = first_sell_amt / total_bought if total_bought > 0 else 0
        if gap < 0 or gap > SELL_GAP_MAX or pct < ONE_SHOT_MIN:
            return False, 0.0, 0
        buy_total  = sum(float(t.get('quote_amount', 0)) for t in buy_txs)
        sell_total = sum(float(t.get('quote_amount', 0)) for t in sell_txs)
        sell_pnl   = sell_total - buy_total
        pump = check_pump(token_addr, sell_ts)
        if pump is False:
            return False, 0.0, 0
        return True, sell_pnl, sell_ts

    # ── Creator case: no BUY, only SELL (creator distributes launch allocation) ──
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
    creator_set = set()  # unique creator addresses

    # 1. Collect tokens from all watchlist wallets (also collect seed activities)
    all_seed_activities = []
    for wallet in seeds:
        activities = gmgn_activity(wallet)
        all_seed_activities.extend(activities)
        for a in activities:
            if a.get('event_type') == 'sell' and a.get('token', {}).get('address'):
                tok = a['token']['address']
                if tok not in token_map:
                    token_map[tok] = a['token'].get('symbol', tok[:8])

    tokens = list(token_map.items())
    tg_send('📊 ' + str(len(tokens)) + ' token found. Checking creators...')
    print('[Hicarus] ' + str(len(tokens)) + ' tokens collected')

    # 2. Get all unique creators + supply (fetch token info in batch)
    creator_tokens = {}   # creator -> list of (token_addr, symbol)
    token_supply   = {}   # token_addr -> total_supply
    for token_addr, symbol in tokens:
        token_info   = gmgn_token_info(token_addr)
        dev_info     = token_info.get('dev', {}) or {}
        creator      = dev_info.get('creator_address', '')
        total_supply = float(token_info.get('total_supply') or token_info.get('circulating_supply') or 0)
        if not creator:
            continue
        creator_set.add(creator)
        token_supply[token_addr] = total_supply
        if creator not in creator_tokens:
            creator_tokens[creator] = []
        creator_tokens[creator].append((token_addr, symbol))

    print('[Hicarus] ' + str(len(creator_set)) + ' unique creators')

    # 3. Pre-fetch activities for ALL creators ONCE (cache)
    creator_activity_cache = {}
    for creator in creator_set:
        creator_activity_cache[creator] = gmgn_activity(creator)
        print('[Hicarus] Fetched ' + str(len(creator_activity_cache[creator]))
              + ' activities for ' + creator[:12] + '...')

    # 4. For each token, check if creator is a Distributor using cached activities
    #    Seeds are already tracked — skip them. Find NEW creators only.
    dev_map = {}  # creator_addr -> {count, pnl, tokens, sell_timestamps}
    new_wallets = {}  # creator_addr -> list of (token_addr, symbol) for NEW wallets only

    for creator, token_list in creator_tokens.items():
        if creator in seeds:
            # Seed = already in watchlist, skip from discovery
            print('[Hicarus] SKIP seed: ' + creator[:12] + '...')
            continue

        # NEW creator — not in seeds, check their pattern
        cached_activities = creator_activity_cache.get(creator, [])
        creator_passed = False  # did this creator pass the one-shot filter?

        for token_addr, symbol in token_list:
            total_supply = token_supply.get(token_addr, 0)
            is_dist, pnl, sell_ts = check_distributor_from_activities(cached_activities, token_addr, total_supply)
            if not is_dist:
                continue

            creator_passed = True
            if creator not in dev_map:
                dev_map[creator] = {'count': 0, 'pnl': 0.0, 'tokens': [], 'timestamps': []}
            dev_map[creator]['count'] += 1
            dev_map[creator]['pnl'] += pnl
            if symbol not in dev_map[creator]['tokens']:
                dev_map[creator]['tokens'].append(symbol)
            dev_map[creator]['timestamps'].append(sell_ts)
            print('[Hicarus] DIST: ' + creator[:12] + '... created ' + symbol
                  + ' (PnL ' + str(round(pnl, 2)) + ')')

        # Track new wallets regardless of whether they passed (for info)
        if creator not in new_wallets:
            new_wallets[creator] = token_list

    # Report new wallets found (passed or not)
    non_dist_wallets = {c: t for c, t in new_wallets.items() if c not in dev_map}
    if non_dist_wallets:
        print('[Hicarus] ' + str(len(non_dist_wallets)) + ' new creators checked — no one-shot pattern: '
              + ', '.join(c[:12] + '...' for c in non_dist_wallets))

    sorted_devs = sorted(dev_map.items(), key=lambda x: (x[1]['count'], x[1]['pnl']), reverse=True)
    new_checked = len(new_wallets)
    print('[Hicarus] ' + str(len(sorted_devs)) + ' NEW Distributors found (checked ' + str(new_checked) + ' new creators)')

    # 5. Auto-add (new wallets only)
    conn2 = init_db()
    added = []
    for addr, info in sorted_devs:
        if info['count'] >= MIN_CONF and not db_has(conn2, addr):
            label = 'Distributor #' + str(info['count']) + 'x ' + ', '.join(info['tokens'][:3])
            db_add(conn2, addr, label, info['count'], info['pnl'])
            added.append((addr, info))
            print('[Hicarus] AUTO-ADDED: ' + addr[:12] + '...')
    conn2.close()

    # 6. Format
    now_str = datetime.now().strftime('%H:%M')
    lines = []
    lines.append('🎯 *Hicarus Discover — ' + now_str + '*')
    lines.append('Target: ON-CHAIN CREATOR (bukan sniper/bundler)')
    lines.append('Filter: creates token → BUY launch → SELL ALL one-shot ≤60s → pump')
    lines.append(str(len(seeds)) + ' seeds · ' + str(len(tokens)) + ' token · '
                 + str(new_checked) + ' creator checked → ' + str(len(sorted_devs)) + ' Distributor')
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