#!/usr/bin/env python3
"""
Hicarus — Hourly Discover
Run by cron every hour.
Finds new dev wallets via GMGN CLI -> auto-adds HIGH confidence to SQLite -> pushes to Telegram.
"""
import subprocess, json, urllib.request, urllib.parse, sqlite3, os
from datetime import datetime

# Config
DB_FILE   = '/home/ubuntu/hicarus/data/wallets.db'
CHAT_ID   = '6170215817'
MIN_CONF  = 3   # auto-add wallets with >=3 appearances

SEEDS = [
    '8inTY66csRNgKNtGhqGhd4odAV2VeJBDcRVuF7UE3Eeh',
    '6WM3V5hPSbbb7WNsLmo2QbbAc7vwJ6dumg1ypPXdv3cR',
]

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
        s = raw.find('[')
        e = raw.rfind(']') + 1
        return json.loads(raw[s:e]) if s >= 0 else []
    except:
        return []

def tg_send(text, rows=None):
    payload = {
        'chat_id': CHAT_ID,
        'text': text,
        'parse_mode': 'Markdown',
    }
    if rows:
        payload['reply_markup'] = json.dumps({'inline_keyboard': rows})
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
            confidence  INTEGER DEFAULT 0,
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

def discover():
    conn = init_db()
    token_map = {}

    # 1. Collect tokens from seeds
    tg_send('🔍 *Hicarus Discover*\nMenganalisis token dari seed wallets...')
    for wallet in SEEDS:
        subprocess.run(
            'gmgn-cli portfolio activity --chain sol --wallet ' + wallet + ' --limit 30 2>/dev/null > /tmp/gmgn_out.txt',
            shell=True, timeout=25
        )
        for a in gmgn():
            if a.get('event_type') == 'sell' and a.get('token', {}).get('address'):
                tok = a['token']['address']
                if tok not in token_map:
                    token_map[tok] = a['token'].get('symbol', tok[:8])

    tokens = list(token_map.items())
    tg_send('📊 ' + str(len(tokens)) + ' token ditemukan. Mengecek trader data...')
    print('[Hicarus] ' + str(len(tokens)) + ' tokens from seeds')

    # 2. Find dev wallets
    dev_map = {}
    for token_addr, symbol in tokens[:25]:
        subprocess.run(
            'gmgn-cli token traders --chain sol --address ' + token_addr + ' --limit 30 --raw 2>/dev/null > /tmp/gmgn_out.txt',
            shell=True, timeout=25
        )
        for t in gmgn():
            tags = t.get('maker_token_tags', []) + t.get('tags', [])
            if ('dev_team' in tags or 'creator' in tags) and t.get('address') not in SEEDS:
                addr = t['address']
                profit = float(t.get('profit') or 0)
                if addr not in dev_map:
                    dev_map[addr] = {'count': 0, 'pnl': 0, 'tokens': [], 'tags': list(set(tags))}
                dev_map[addr]['count'] += 1
                dev_map[addr]['pnl'] += profit
                sym = token_map.get(token_addr, addr[:8])
                if sym not in dev_map[addr]['tokens']:
                    dev_map[addr]['tokens'].append(sym)

    sorted_devs = sorted(dev_map.items(), key=lambda x: (x[1]['count'], x[1]['pnl']), reverse=True)
    print('[Hicarus] ' + str(len(sorted_devs)) + ' dev wallets found')

    # 3. Auto-add HIGH confidence to DB
    added = []
    for addr, info in sorted_devs:
        if info['count'] >= MIN_CONF and not db_has(conn, addr):
            label = 'Auto #'+str(info['count'])+'x ' + ', '.join(info['tokens'][:3])
            db_add(conn, addr, label, info['count'], info['pnl'])
            added.append((addr, info))
            print('[Hicarus] AUTO-ADDED: ' + addr[:12] + '... (' + str(info['count']) + 'x, PnL ' + str(round(info['pnl'],2)) + ')')

    conn.close()

    # 4. Format results
    now_str = datetime.now().strftime('%H:%M')
    lines = []
    lines.append('🎯 *Hicarus Discover — ' + now_str + '*')
    lines.append('Dari ' + str(len(tokens)) + ' token · ' + str(len(sorted_devs)) + ' dev wallet ditemukan')
    lines.append('_confidence = appearances × PnL_')
    lines.append('')

    if added:
        lines.append('✅ *' + str(len(added)) + ' wallet AUTO-ADDED to watchlist*')
        for addr, info in added[:8]:
            pnl_str = '+' + str(round(info['pnl'],2)) if info['pnl'] >= 0 else str(round(info['pnl'],2))
            lines.append('`' + addr + '`')
            lines.append('   📈 ' + str(info['count']) + 'x · PnL ' + pnl_str + ' SOL · ' + ', '.join(info['tokens'][:3]))
        lines.append('')
        lines.append('━━━━━━━━━━━━━━━━━━━━')
        lines.append('')

    high   = [(a,d) for a,d in sorted_devs if d['count'] >= MIN_CONF]
    medium = [(a,d) for a,d in sorted_devs if d['count'] == 2]
    low    = [(a,d) for a,d in sorted_devs if d['count'] == 1]

    if high:
        lines.append('🔥 *HIGH CONFIDENCE* (≥' + str(MIN_CONF) + 'x)')
        for i, (addr, info) in enumerate(high[:8]):
            pnl_str = '+' + str(round(info['pnl'],2)) if info['pnl'] >= 0 else str(round(info['pnl'],2))
            lines.append(str(i+1) + '. `' + addr + '`')
            lines.append('   📈 ' + str(info['count']) + 'x · PnL: ' + pnl_str + ' SOL')
            lines.append('   🐸 ' + ', '.join(info['tokens'][:4]))
        lines.append('')

    if medium:
        lines.append('⚡ *MEDIUM* (2x)')
        for addr, info in medium[:5]:
            pnl_str = '+' + str(round(info['pnl'],2)) if info['pnl'] >= 0 else str(round(info['pnl'],2))
            lines.append('• `' + addr + '` · ' + str(info['count']) + 'x · PnL: ' + pnl_str)
        lines.append('')

    if low:
        lines.append('🟡 *LOW* (1x) — cek /wallet ' + low[0][0] + ' untuk detail')
        lines.append('')

    lines.append('━━━━━━━━━━━━━━━━━━━━')
    lines.append('Next run: 1 jam lagi ⏰')

    tg_send('\n'.join(lines))
    print('[Hicarus Discover] Done — ' + str(len(added)) + ' auto-added, ' + str(len(sorted_devs)) + ' total found')

if __name__ == '__main__':
    discover()
