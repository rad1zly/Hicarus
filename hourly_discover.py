#!/usr/bin/env python3
"""
Hicarus — Hourly Discover (v2.3)
Run by cron every hour.

Flow:
  1. Fetch recent KOL & SmartMoney BUY trades → get tokens + creators
  2. For each UNIQUE creator (non-seed):
     - Fetch their FULL trading activity
     - For EACH token they trade (up to 10):
       Pattern: BUY launch → DUMP ≥1.5x bought in SOL within 60s → pump confirmed
       OR creator-only SELL (no buy) with ≥$500 mcap → pump confirmed
  3. Auto-add if ≥2 appearances

v2.3 fix: Ratio check (total sold / total bought ≥ 1.5x) replaces per-tx pct check.
  Creator dumps 17% then 20% then 10% → total sells 3x bought → PASSES.
"""

import subprocess, json, urllib.request, urllib.parse, sqlite3, os
from datetime import datetime

# ── Config ─────────────────────────────────────────────────────
DB_FILE          = '/home/ubuntu/hicarus/data/wallets.db'
CHAT_ID          = '6170215817'
MIN_CONF         = 2
KOL_LIMIT        = 200
SMART_LIMIT      = 200
SELL_GAP_MAX     = 60         # seconds between first buy and first sell
PUMP_LOOKBACK    = 120        # seconds after sell to check kline
SELL_BUY_RATIO_MIN = 1.4      # total sold (SOL) / total bought (SOL) must be ≥ 1.4x (float tolerance)
MCAP_MIN_USD     = 500        # mcap at sell must be ≥$500 (creator-only check)
SOL_PRICE_USD    = 1700
CREATOR_ACTIVITY_PAGES = 5
CREATOR_TOKEN_CHECK_LIMIT = 10

# ── Helpers ─────────────────────────────────────────────────────

def get_env(key):
    with open('/home/ubuntu/hicarus/.env') as f:
        for line in f:
            if line.startswith(key):
                return line.split('=', 1)[1].strip()
    return ''

def gmgn_activity_full(wallet_addr, max_pages=CREATOR_ACTIVITY_PAGES):
    """Fetch wallet activity across pages (7 days back)."""
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

        for a in page_activities:
            if a.get('timestamp', 0) >= seven_days_ago:
                all_activities.append(a)
            else:
                return all_activities

        cursor = data.get('next', '')
        if not cursor:
            break

    return all_activities

def gmgn_token_info(token_addr):
    subprocess.run(
        'gmgn-cli token info --chain sol --address ' + token_addr + ' --raw 2>/dev/null > /tmp/gmgn_out.txt',
        shell=True, timeout=30
    )
    try:
        with open('/tmp/gmgn_out.txt') as f:
            return json.load(f)
    except:
        return {}

def get_token_supply(token_addr):
    info = gmgn_token_info(token_addr)
    return float(info.get('total_supply') or info.get('circulating_supply') or 0)

def gmgn_kol_trades(side='buy', limit=KOL_LIMIT):
    cmd = f'gmgn-cli track kol --chain sol --limit {limit} --side {side} --raw'
    subprocess.run(cmd + ' 2>/dev/null > /tmp/gmgn_out.txt', shell=True, timeout=60)
    try:
        with open('/tmp/gmgn_out.txt') as f:
            return json.load(f).get('list', [])
    except:
        return []

def gmgn_smartmoney_trades(side='buy', limit=SMART_LIMIT):
    cmd = f'gmgn-cli track smartmoney --chain sol --limit {limit} --side {side} --raw'
    subprocess.run(cmd + ' 2>/dev/null > /tmp/gmgn_out.txt', shell=True, timeout=60)
    try:
        with open('/tmp/gmgn_out.txt') as f:
            return json.load(f).get('list', [])
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
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            wallet TEXT NOT NULL UNIQUE,
            label TEXT,
            added_by INTEGER NOT NULL,
            added_at INTEGER NOT NULL,
            active INTEGER DEFAULT 1,
            last_tx TEXT,
            confidence INTEGER DEFAULT 0,
            total_pnl REAL DEFAULT 0
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

def check_pump(token_addr, sell_timestamp):
    """Check kline after sell for green candle = price pump."""
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
        return None

    if not klines:
        return None

    for k in klines:
        if not isinstance(k, dict):
            continue
        t      = k.get('time', 0) // 1000
        open_p = float(k.get('open', 0))
        close_p= float(k.get('close', 0))
        if t < sell_timestamp:
            continue
        if close_p > open_p:
            return True
    return False

def check_one_shot(activities, token_addr, total_supply):
    """
    Check if wallet does the Distributor pattern on a specific token.

    Pattern A — Creator dump (most common):
      Creator creates token → BUY small amount at launch → then DUMPS.
      Criteria:
        - Has BUY (mimics organic launch interest)
        - First SELL within 60s of first BUY
        - Total sold (SOL) ≥ 1.5x × total bought (SOL)
        - Pump confirmed after sell

    Pattern B — Pure creator sell (no launch buy):
      Creator only SELLS their allocation at launch.
      Criteria:
        - No BUY txs for this token
        - Pump confirmed after sell

    Returns (is_dist, sell_pnl, sell_timestamp)
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

    first_sell_ts = sell_txs[0].get('timestamp', 0)

    # ── Pattern B: Pure creator sell (no buy) ──
    if not buy_txs:
        sell_total = sum(float(t.get('quote_amount', 0)) for t in sell_txs)
        sell_pnl   = sell_total
        pump = check_pump(token_addr, first_sell_ts)
        if pump is False:
            return False, 0.0, 0
        return True, sell_pnl, first_sell_ts

    # ── Pattern A: BUY then SELL dump ──
    total_bought_quote = sum(float(t.get('quote_amount', 0)) for t in buy_txs)
    total_sold_quote   = sum(float(t.get('quote_amount', 0)) for t in sell_txs)

    first_buy_ts = buy_txs[0].get('timestamp', 0)
    gap = first_sell_ts - first_buy_ts

    # All sells must start within SELL_GAP_MAX of first buy
    if gap < 0 or gap > SELL_GAP_MAX:
        return False, 0.0, 0

    # Total sold must be ≥ SELL_BUY_RATIO_MIN × total bought (in SOL)
    # Allow tiny float epsilon so 1.5000001 doesn't fail >= 1.4 check
    sell_buy_ratio = total_sold_quote / total_bought_quote if total_bought_quote > 0 else 0
    if sell_buy_ratio < SELL_BUY_RATIO_MIN - 1e-9:
        return False, 0.0, 0

    sell_pnl = total_sold_quote - total_bought_quote

    pump = check_pump(token_addr, first_sell_ts)
    if pump is False:
        return False, 0.0, 0
    return True, sell_pnl, first_sell_ts

# ── Discover ────────────────────────────────────────────────────

def discover():
    conn = init_db()
    seeds = db_get_active(conn)
    conn.close()

    print(f'[Hicarus v2.3] Seeds: {seeds}')
    tg_send('🔍 *Hicarus Discover v2.3*\nKOL & SmartMoney → finding Distributors...\n(creator = on-chain token creator)')

    # ── Step 1: Collect tokens from KOL + SmartMoney BUY trades ──
    kol_trades = gmgn_kol_trades('buy', KOL_LIMIT)
    sm_trades  = gmgn_smartmoney_trades('buy', SMART_LIMIT)
    print(f'[Hicarus v2.3] KOL: {len(kol_trades)}, SmartMoney: {len(sm_trades)}')

    token_map = {}
    for t in kol_trades + sm_trades:
        base = t.get('base_address', '')
        sym  = t.get('base_token', {}).get('symbol', '')
        maker= t.get('maker', '')
        src  = 'kol' if t in kol_trades else 'sm'
        if base:
            if base not in token_map:
                token_map[base] = {'symbol': sym, 'kol_wallets': set(), 'sm_wallets': set()}
            token_map[base][src + '_wallets'].add(maker)

    tokens = list(token_map.items())
    tg_send('📊 ' + str(len(tokens)) + ' token from KOL/SM. Looking up creators...')
    print(f'[Hicarus v2.3] {len(tokens)} unique tokens')

    # ── Step 2: Get creator address for each token ──
    creator_tokens = {}

    for token_addr, info in tokens:
        token_info = gmgn_token_info(token_addr)
        dev_info   = token_info.get('dev', {}) or {}
        creator    = dev_info.get('creator_address', '')
        if not creator:
            continue
        if creator not in creator_tokens:
            creator_tokens[creator] = []
        creator_tokens[creator].append((token_addr, info['symbol']))
        print(f'[Hicarus v2.3] {info["symbol"]}: creator={creator[:16]}...')

    print(f'[Hicarus v2.3] {len(creator_tokens)} unique creators')
    tg_send('📊 ' + str(len(creator_tokens)) + ' creators. Checking patterns...')

    # ── Step 3: For each creator, fetch full activity + check ALL tokens they trade ──
    dev_map = {}

    for creator, kol_token_list in creator_tokens.items():
        if creator in seeds:
            print(f'[Hicarus v2.3] SKIP seed: {creator[:16]}...')
            continue

        activities = gmgn_activity_full(creator)
        print(f'[Hicarus v2.3] {creator[:16]}... → {len(activities)} activities')

        if len(activities) < 3:
            print(f'[Hicarus v2.3]   Too few activities, skip')
            continue

        # Build set of ALL tokens this creator has traded
        creator_traded_tokens = {}
        for a in activities:
            tok = a.get('token', {}).get('address', '')
            sym = a.get('token', {}).get('symbol', '')
            if tok and tok not in creator_traded_tokens:
                creator_traded_tokens[tok] = sym

        # Collect KOL/SM followers for this creator
        # kol_token_list = [(token_addr, symbol), ...] from creator_tokens
        # Look up following wallets from token_map
        following_wallets = set()
        for t_addr, sym in kol_token_list:
            if t_addr in token_map:
                following_wallets.update(token_map[t_addr]['kol_wallets'])
                following_wallets.update(token_map[t_addr]['sm_wallets'])

        tokens_checked = 0
        for token_addr, sym in creator_traded_tokens.items():
            if tokens_checked >= CREATOR_TOKEN_CHECK_LIMIT:
                break
            tokens_checked += 1

            total_supply = get_token_supply(token_addr)
            is_dist, pnl, sell_ts = check_one_shot(activities, token_addr, total_supply)
            if not is_dist:
                continue

            if creator not in dev_map:
                dev_map[creator] = {
                    'count': 0, 'pnl': 0.0, 'tokens': [],
                    'source_wallets': following_wallets
                }
            dev_map[creator]['count'] += 1
            dev_map[creator]['pnl'] += pnl
            if sym not in dev_map[creator]['tokens']:
                dev_map[creator]['tokens'].append(sym)
            print(f'[Hicarus v2.3]   ✅ DIST: {sym} (PnL {round(pnl,2)}, creator={creator[:12]}...)')

    sorted_devs = sorted(dev_map.items(), key=lambda x: (x[1]['count'], x[1]['pnl']), reverse=True)
    print(f'[Hicarus v2.3] {len(sorted_devs)} Distributors found')

    # ── Step 4: Auto-add ──
    conn2 = init_db()
    added = []
    for addr, info in sorted_devs:
        if info['count'] >= MIN_CONF and not db_has(conn2, addr):
            label = 'Distributor #' + str(info['count']) + 'x ' + ', '.join(info['tokens'][:3])
            db_add(conn2, addr, label, info['count'], info['pnl'])
            added.append((addr, info))
            print(f'[Hicarus v2.3] AUTO-ADDED: {addr[:16]}...')
    conn2.close()

    # ── Step 5: Report ──
    now_str = datetime.now().strftime('%H:%M')
    lines = []
    lines.append('🎯 *Hicarus Discover v2.3 — ' + now_str + '*')
    lines.append('Source: KOL + SmartMoney BUY → get creators → check their ALL trades')
    lines.append('Filter: BUY launch → dump ≥1.5x bought SOL ≤60s → pump')
    lines.append(str(len(seeds)) + ' seeds · ' + str(len(tokens)) + ' KOL/SM token · '
                 + str(len(creator_tokens)) + ' creator → ' + str(len(sorted_devs)) + ' Distributor')
    lines.append('')

    if added:
        lines.append('✅ *' + str(len(added)) + ' Distributor AUTO-ADDED*')
        for addr, info in added[:8]:
            pnl_str = '+' + str(round(info['pnl'], 2)) if info['pnl'] >= 0 else str(round(info['pnl'], 2))
            sources = ', '.join(w[:10]+'...' for w in list(info['source_wallets'])[:3])
            lines.append('`' + addr + '`')
            lines.append('   📈 ' + str(info['count']) + 'x · PnL ' + pnl_str
                         + ' SOL · ' + ', '.join(info['tokens'][:3]))
            lines.append('   👥 Followed by: ' + sources)
        lines.append('')
        lines.append('━━━━━━━━━━━━━━━━━━━━')
        lines.append('')

    high   = [(a, d) for a, d in sorted_devs if d['count'] >= MIN_CONF]
    medium = [(a, d) for a, d in sorted_devs if d['count'] == 1]

    if high:
        lines.append('🔥 *HIGH* (≥' + str(MIN_CONF) + 'x)')
        for i, (addr, info) in enumerate(high[:8]):
            pnl_str = '+' + str(round(info['pnl'], 2)) if info['pnl'] >= 0 else str(round(info['pnl'], 2))
            sources = ', '.join(w[:10]+'...' for w in list(info['source_wallets'])[:3])
            lines.append(str(i + 1) + '. `' + addr + '`')
            lines.append('   📈 ' + str(info['count']) + 'x · PnL: ' + pnl_str + ' SOL')
            lines.append('   🐸 ' + ', '.join(info['tokens'][:4]))
            lines.append('   👥 ' + sources)
        lines.append('')

    if medium:
        lines.append('⚡ *MEDIUM* (1x)')
        for addr, info in medium[:5]:
            pnl_str = '+' + str(round(info['pnl'], 2)) if info['pnl'] >= 0 else str(round(info['pnl'], 2))
            sources = ', '.join(w[:10]+'...' for w in list(info['source_wallets'])[:2])
            lines.append('• `' + addr + '` · ' + str(info['count']) + 'x · PnL: ' + pnl_str
                         + ' SOL · ' + ', '.join(info['tokens'][:2]))
            lines.append('  👥 ' + sources)
        lines.append('')

    lines.append('━━━━━━━━━━━━━━━━━━━━')
    lines.append('Next run: 1 jam lagi ⏰')

    tg_send('\n'.join(lines))
    print(f'[Hicarus v2.3] Done — {len(added)} added, {len(sorted_devs)} total')

if __name__ == '__main__':
    discover()