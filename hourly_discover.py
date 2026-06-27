#!/usr/bin/env python3
"""
Hicarus — Hourly Discover
Run by cron every hour.
Uses GMGN CLI to find new dev wallets from seed wallets,
formats results, and sends to Telegram.
"""
import subprocess, json, sys, urllib.request, urllib.parse

# ── Config ─────────────────────────────────────────────────────
TELEGRAM_TOKEN = open('/home/ubuntu/hicarus/.env').read().split('BOT_TOKEN=')[1].split('\n')[0].strip()
CHAT_ID = '6170215817'
SEED_WALLETS = [
    '8inTY66csRNgKNtGhqGhd4odAV2VeJBDcRVuF7UE3Eeh',
    '6WM3V5hPSbbb7WNsLmo2QbbAc7vwJ6dumg1ypPXdv3cR',
]

def gmgn(cmd):
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=20)
    try:
        with open('/tmp/gmgn_out.txt') as f:
            raw = f.read()
        start = raw.find('[')
        end = raw.rfind(']') + 1
        return json.loads(raw[start:end]) if start >= 0 else []
    except:
        return []

def send_telegram(text):
    data = urllib.parse.urlencode({'chat_id': CHAT_ID, 'text': text, 'parse_mode': 'Markdown'}).encode()
    req = urllib.request.Request(
        f'https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage',
        data=data, method='POST'
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())

def main():
    print('[Hicarus Discover] Starting...')
    send_telegram('⏰ *Hicarus Hourly Discover*\nMenganalisis token dari seed wallets...')

    # Step 1: Collect unique tokens from seed wallet sell events
    token_map = {}
    for wallet in SEED_WALLETS:
        cmd = f'gmgn-cli portfolio activity --chain sol --wallet {wallet} --limit 30 2>/dev/null > /tmp/gmgn_out.txt'
        subprocess.run(cmd, shell=True)
        acts = gmgn([])
        for a in acts:
            if a.get('event_type') == 'sell' and a.get('token', {}).get('address'):
                tok = a['token']['address']
                if tok not in token_map:
                    token_map[tok] = {
                        'symbol': a['token'].get('symbol', tok[:8]),
                        'dev': wallet[:12],
                    }

    token_list = list(token_map.items())
    print(f'[Hicarus] {len(token_list)} tokens found from seeds')
    send_telegram(f'📊 {len(token_list)} token ditemukan. Mengecek trader data...')

    # Step 2: For each token, find dev wallets
    dev_wallets = {}
    for token_addr, info in token_list[:20]:  # limit to 20 tokens
        cmd = f'gmgn-cli token traders --chain sol --address {token_addr} --limit 30 --raw 2>/dev/null > /tmp/gmgn_out.txt'
        subprocess.run(cmd, shell=True)
        traders = gmgn([])
        for t in traders:
            tags = t.get('maker_token_tags', []) + t.get('tags', [])
            is_dev = 'dev_team' in tags or 'creator' in tags
            is_seed = t.get('address', '') in SEED_WALLETS
            if is_dev and not is_seed:
                addr = t['address']
                profit = float(t.get('profit', 0) or 0)
                if addr not in dev_wallets:
                    dev_wallets[addr] = {'count': 0, 'pnl': 0, 'tokens': [], 'tags': list(set(tags))}
                dev_wallets[addr]['count'] += 1
                dev_wallets[addr]['pnl'] += profit
                sym = token_map[token_addr]['symbol']
                if sym not in dev_wallets[addr]['tokens']:
                    dev_wallets[addr]['tokens'].append(sym)

    # Step 3: Sort by count desc, then pnl desc
    sorted_devs = sorted(dev_wallets.items(), key=lambda x: (x[1]['count'], x[1]['pnl']), reverse=True)
    print(f'[Hicarus] {len(sorted_devs)} dev wallets found')

    if not sorted_devs:
        send_telegram('❌ Tidak ada dev wallet baru ditemukan kali ini.')
        return

    # Step 4: Format and send
    now = __import__('datetime').datetime.now().strftime('%H:%M')
    text = f'🎯 *Hicarus Discover — {now}*\n'
    text += f'Dari {len(token_list)} token · {len(sorted_devs)} dev wallet ditemukan\n\n'
    text += '━━━━━━━━━━━━━━━━━━━━\n\n'

    high = [(a, d) for a, d in sorted_devs if d['count'] >= 3]
    medium = [(a, d) for a, d in sorted_devs if d['count'] == 2]

    if high:
        text += f'🔥 *HIGH CONFIDENCE* (≥3x)\n'
        for i, (addr, info) in enumerate(high[:8]):
            short = addr[:8] + '...' + addr[-6:]
            pnl_str = f'+{info["pnl"]:.2f}' if info['pnl'] >= 0 else f'{info["pnl"]:.2f}'
            text += f'\n{i+1}. `{short}`\n'
            text += f'   📈 {info["count"]}x · PnL: {pnl_str} SOL\n'
            text += f'   🐸 {", ".join(info["tokens"][:4])}\n'
            text += f'   /add {addr}\n'

    if medium:
        text += f'\n⚡ *MEDIUM* (2x)\n'
        for addr, info in medium[:5]:
            short = addr[:8] + '...' + addr[-6:]
            pnl_str = f'+{info["pnl"]:.2f}' if info['pnl'] >= 0 else f'{info["pnl"]:.2f}'
            text += f'• `{short}` · {info["count"]}x · PnL: {pnl_str}\n'

    text += '\n━━━━━━━━━━━━━━━━━━━━\n'
    text += '*Confidence: appearances × PnL*\n'
    text += 'Gunakan /add <address> untuk add ke watchlist.\n'
    text += 'Next run: 1 jam lagi ⏰'

    send_telegram(text)
    print('[Hicarus Discover] Done — results sent to Telegram')

if __name__ == '__main__':
    main()
