"""Erzeugt die Bilder für den Installieren-Dialog unter Android (manifest.webmanifest → screenshots).

Braucht keine Datenbank: Supabase wird mit festen Beispieldaten nachgestellt.
Vorher: python3 -m http.server 8766 im Repo-Ordner.
Aufruf: python3 tests/make_screenshots.py
"""
import json, os
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

BASE = 'http://localhost:8766/'
OUT = os.path.join(os.path.dirname(__file__), '..', 'screenshots')
NOW = datetime.now(timezone.utc)
ago = lambda h: (NOW - timedelta(hours=h)).isoformat()

ME, PAUL, GERDA, MAX, SOPHIE = (f'00000000-0000-4000-8000-00000000000{i}' for i in range(1, 6))
G = '10000000-0000-4000-8000-000000000001'
people = {ME: 'Lena', PAUL: 'Paul', GERDA: 'Oma Gerda', MAX: 'Max', SOPHIE: 'Sophie'}
n = 0


def wish(owner, title, price=None, cat=None, prio=2, url=None, note=None, h=24):
    global n
    n += 1
    return {'id': f'20000000-0000-4000-8000-{n:012d}', 'owner': owner, 'title': title, 'url': url, 'note': note,
            'all_groups': True, 'created_at': ago(h), 'price': price, 'category': cat, 'priority': prio, 'have_at': None}


wishes = [
    wish(PAUL, 'Kopfhörer mit Geräuschunterdrückung', 129, 'technik', 3, 'https://www.example.de/kopfhoerer', h=3),
    wish(PAUL, 'Kochbuch Levante', 34, 'buch', 3, 'https://www.example.de/kochbuch', 'Gern die gebundene Ausgabe', h=20),
    wish(PAUL, 'Wanderrucksack 30 Liter', 89, 'sport', 2, h=40),
    wish(PAUL, 'Brettspiel Azul', 39, 'spiel', 2, h=60),
    wish(PAUL, 'Gutschein Kletterhalle', 25, 'erlebnis', 1, h=80),
    wish(PAUL, 'Espressotassen', 28, 'haushalt', 1, h=90),
    wish(SOPHIE, 'Aquarellkasten', 45, 'sonstiges', 3, h=5),
    wish(SOPHIE, 'Roman von Juli Zeh', 24, 'buch', 2, h=30),
    wish(GERDA, 'Fotokalender mit Enkeln', 30, 'wohnen', 3, h=8),
    wish(MAX, 'Fußballtrikot', 90, 'sport', 2, h=12),
    wish(ME, 'Pflanzenlampe', 49, 'wohnen', 3, h=50),
    wish(ME, 'Thermoskanne', 32, 'haushalt', 2, h=70),
]
W = {w['title']: w['id'] for w in wishes}
data = {
    'profiles': [{'id': k, 'name': v} for k, v in people.items()],
    'groups': [{'id': G, 'name': 'Familie', 'code': 'KXP4-27QM', 'created_by': ME, 'created_at': ago(400)}],
    'members': [{'group_id': G, 'user_id': u, 'joined_at': ago(400 - i)} for i, u in enumerate(people)],
    'wishes': wishes,
    'wish_groups': [],
    'reservations': [
        {'wish_id': W['Kochbuch Levante'], 'user_id': ME, 'status': 'gekauft'},
        {'wish_id': W['Aquarellkasten'], 'user_id': ME, 'status': 'reserviert'},
        {'wish_id': W['Fotokalender mit Enkeln'], 'user_id': ME, 'status': 'reserviert'},
        {'wish_id': W['Wanderrucksack 30 Liter'], 'user_id': GERDA, 'status': 'reserviert'},
    ],
    'accounts': [{'username': 'lena', 'reset_at': None, 'reset_notice': False}],
    'wichtel_draws': [{'group_id': G, 'drawn_at': ago(30), 'participants': list(people)}],
    'wichtel_pairs': [{'group_id': G, 'receiver': SOPHIE}],
    'wichtel_exclusions': [],
    'wichtel_out': [],
}


def handle(route):
    path = urlparse(route.request.url).path
    if path.endswith('/rpc/is_app_admin'):
        body = False
    else:
        body = data.get(path.rsplit('/', 1)[-1], [])
    route.fulfill(status=200, content_type='application/json', body=json.dumps(body),
                  headers={'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*'})


session = {'session': {'access_token': 'x', 'refresh_token': 'y', 'expires_at': 4102444800,
                       'user': {'id': ME, 'email': 'lena@nutzer.geschenkeliste.invalid', 'anon': False}}}

os.makedirs(OUT, exist_ok=True)
with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, service_workers='block',
                              color_scheme='light', locale='de-DE', reduced_motion='reduce')
    ctx.route('https://qbdpzamygonpruaafcrt.supabase.co/**', handle)
    ctx.add_init_script('localStorage.setItem("geschenkeliste-v1", ' + json.dumps(json.dumps(session)) + ')')
    ctx.add_init_script("localStorage.setItem('geschenkeliste-theme', 'jahr')")   # neutral, nicht nur Weihnachten
    p = ctx.new_page()
    for name, h, sel in [('start', '#/', 'h1:has-text("Hallo Lena")'),
                         ('person', f'#/g/{G}/p/{PAUL}', '.chips'),
                         ('wichteln', f'#/g/{G}/wichteln', 'text=Du beschenkst')]:
        p.goto(BASE + h)
        p.wait_for_selector(sel)
        p.wait_for_timeout(300)
        p.screenshot(path=os.path.join(OUT, name + '.png'))
        print('Bild', name)
    browser.close()
