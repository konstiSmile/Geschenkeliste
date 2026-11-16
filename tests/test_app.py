"""Ende-zu-Ende-Test der App mit zwei Nutzern (Anna, Ben) gegen die Supabase-Attrappe.

Vorher: Postgres mit Datenbank gl (supabase_stub.sql + supabase/schema.sql) und
        python3 -m http.server 8766 im Repo-Ordner.
Aufruf: python3 tests/test_app.py [bilder-ordner]
"""
import os, subprocess, sys
from playwright.sync_api import sync_playwright, expect

sys.path.insert(0, os.path.dirname(__file__))
import mock_supabase as mock

BASE = 'http://localhost:8766/'
SHOTS = sys.argv[1] if len(sys.argv) > 1 else None
fails = 0
subprocess.run(mock.PSQL, input='truncate auth.users cascade;', capture_output=True, text=True)


def check(name, cond):
    global fails
    print(('ok   ' if cond else 'FAIL ') + name)
    if not cond:
        fails += 1


def newpage(browser, errors):
    ctx = browser.new_context(viewport={'width': 390, 'height': 780}, service_workers='block')
    ctx.route('https://qbdpzamygonpruaafcrt.supabase.co/**', mock.handle)
    p = ctx.new_page()
    p.on('pageerror', lambda e: errors.append(str(e)))
    p.on('console', lambda m: m.type == 'error' and errors.append(m.text))
    return p


def login(p, email, name, url=BASE):
    p.goto(url)
    p.fill('input[name=email]', email)
    p.click('text=Code per Mail schicken')
    p.wait_for_selector('input[name=code]')
    p.fill('input[name=code]', '000000')
    p.click('button:has-text("Anmelden")')
    expect(p.locator('#toast')).to_contain_text('Code falsch')
    p.fill('input[name=code]', '123 456')
    p.click('button:has-text("Anmelden")')
    p.wait_for_selector('text=Wie heißt du?')
    p.fill('input[name=name]', name)
    p.click('text=Weiter')


def overflow(p):
    return p.evaluate('document.documentElement.scrollWidth') <= 390


def shot(p, name):
    if SHOTS:
        p.screenshot(path=os.path.join(SHOTS, name + '.png'))


with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    errs = []
    a = newpage(browser, errs)
    login(a, 'anna@x.de', 'Anna')
    a.wait_for_selector('h1:has-text("Meine Wünsche")')
    check('Anna angemeldet, Hinweis ohne Gruppe', a.locator('text=Du bist noch in keiner Gruppe').count() == 1)

    # Gruppen anlegen
    a.click('.tabs >> text=Gruppen')
    a.fill('input[placeholder^="Neue Gruppe"]', 'Familie')
    a.click('button:has-text("Anlegen")')
    a.wait_for_selector('h1:has-text("Familie")')
    code = a.inner_text('#gcode').strip()
    check('Code angezeigt', len(code) == 9 and code[4] == '-')
    shot(a, '3-gruppe')
    a.click('.tabs >> text=Gruppen')
    a.fill('input[placeholder^="Neue Gruppe"]', 'Freunde')
    a.click('button:has-text("Anlegen")')
    a.wait_for_selector('h1:has-text("Freunde")')

    # Wünsche anlegen
    a.click('.tabs >> text=Meine Wünsche')
    a.click('text=+ Wunsch')
    a.fill('input[name=title]', 'Kochbuch')
    a.fill('input[name=url]', 'www.example.org/buch')
    a.fill('textarea[name=note]', 'Gern die neue Auflage')
    a.click('button:has-text("Speichern")')
    a.wait_for_selector('.wish:has-text("Kochbuch")')
    check('Link ergänzt https', a.get_attribute('.wish a.link-out', 'href') == 'https://www.example.org/buch')
    a.click('text=+ Wunsch')
    a.fill('input[name=title]', 'Konzertkarte')
    a.check('input[value=some]')
    a.click('button:has-text("Speichern")')
    expect(a.locator('#toast')).to_contain_text('mindestens eine Gruppe')
    a.check('label:has-text("Freunde") input')
    a.click('button:has-text("Speichern")')
    a.wait_for_selector('.wish:has-text("Konzertkarte")')
    check('Freigabe-Chip „Freunde“', 'Freunde' in a.inner_text('.wish:has-text("Konzertkarte") .chip'))
    a.click('text=+ Wunsch')
    a.fill('input[name=title]', 'Falscher Link')
    a.fill('input[name=url]', 'kein link')
    a.click('button:has-text("Speichern")')
    expect(a.locator('#toast')).to_contain_text('Link sieht nicht richtig aus')
    a.click('.tabs >> text=Meine Wünsche')
    shot(a, '2-meine')
    check('Kein Überlauf (Anna)', overflow(a))

    # Ben tritt per Einladungslink bei
    b = newpage(browser, errs)
    login(b, 'ben@x.de', 'Ben', BASE + '#/join/' + code)
    b.wait_for_selector('h1:has-text("Familie")')
    check('Ben ist per Link beigetreten', b.locator('.person:has-text("Anna")').count() == 1)
    b.click('.person:has-text("Anna") .cover')
    b.wait_for_selector('h1:has-text("Annas Wünsche")')
    check('Ben sieht nur Kochbuch', b.locator('.wish').count() == 1 and b.locator('text=Konzertkarte').count() == 0)
    b.click('button:has-text("Reservieren")')
    b.wait_for_selector('text=Von dir reserviert')
    b.click('button:has-text("Als gekauft markieren")')
    b.wait_for_selector('text=Von dir gekauft')
    shot(b, '4-liste-ben')
    check('Kein Überlauf (Ben)', overflow(b))

    # Anna sieht nichts davon
    a.reload()
    a.wait_for_selector('.wish:has-text("Kochbuch")')
    txt = a.inner_text('main')
    check('Anna sieht keinen Status', 'gekauft' not in txt.lower() and 'von ben' not in txt.lower())
    a.goto(BASE + '#/gruppen')
    a.click('.card:has-text("Familie") .cover')
    a.wait_for_selector('.person:has-text("Ben")')
    check('Anna sieht Ben in Familie', True)

    # Dritte Person mit Code-Eingabe sieht Bens Reservierung
    c = newpage(browser, errs)
    c.goto(BASE)
    c.fill('input[name=email]', 'clara@x.de')
    c.click('text=Code per Mail schicken')
    c.fill('input[name=code]', 'https://qbdpzamygonpruaafcrt.supabase.co/auth/v1/verify?token=hash-123456&type=magiclink&redirect_to=https://konstismile.github.io/Geschenkeliste/')
    c.click('button:has-text("Anmelden")')
    c.wait_for_selector('text=Wie heißt du?')
    check('Anmeldung mit eingefügtem Link', True)
    c.fill('input[name=name]', 'Clara')
    c.click('text=Weiter')
    c.wait_for_selector('h1:has-text("Meine Wünsche")')
    c.click('.tabs >> text=Gruppen')
    c.fill('input[name=code]', code.lower())
    c.click('button:has-text("Beitreten")')
    c.wait_for_selector('h1:has-text("Familie")')
    c.click('.person:has-text("Anna") .cover')
    c.wait_for_selector('text=Gekauft von Ben')
    check('Clara sieht „Gekauft von Ben“, kein Knopf', c.locator('.wish button').count() == 0)

    # Ben gibt frei, Clara reserviert
    b.click('button:has-text("Freigeben")')
    b.wait_for_selector('button:has-text("Reservieren")')
    c.click('.top [data-act=sync]')
    c.click('button:has-text("Reservieren")')
    c.wait_for_selector('text=Von dir reserviert')
    b.click('.top [data-act=sync]')
    b.wait_for_selector('text=Reserviert von Clara')
    check('Ben sieht Claras Reservierung', True)

    # Wunsch bearbeiten und löschen
    a.goto(BASE + '#/')
    a.click('.wish:has-text("Konzertkarte") .cover')
    a.fill('input[name=title]', 'Konzertkarte Jazz')
    a.check('input[value=all]')
    a.click('button:has-text("Speichern")')
    a.wait_for_selector('.wish:has-text("Konzertkarte Jazz")')
    b.goto(BASE + '#/gruppen')
    b.click('.top [data-act=sync]')
    b.click('.card:has-text("Familie") .cover')
    b.click('.person:has-text("Anna") .cover')
    b.wait_for_selector('text=Konzertkarte Jazz')
    check('Nach Umstellen auf „alle“ sieht Ben die Karte', True)
    a.click('.wish:has-text("Konzertkarte Jazz") .cover')
    a.click('button:has-text("Löschen")')
    a.click('button:has-text("Wirklich löschen")')
    a.wait_for_selector('h1:has-text("Meine Wünsche")')
    check('Gelöscht', a.locator('text=Konzertkarte Jazz').count() == 0)

    # Name ändern, Gruppe verlassen, abmelden
    b.goto(BASE + '#/mehr')
    b.fill('input[name=name]', 'Benni')
    b.click('button:has-text("Name ändern")')
    expect(b.locator('#toast')).to_contain_text('Gespeichert')
    shot(b, '5-mehr')
    c.goto(BASE + '#/gruppen')
    c.click('.card:has-text("Familie") .cover')
    c.click('text=Gruppe verwalten')
    c.click('text=Gruppe verlassen')
    c.click('text=Wirklich verlassen')
    c.wait_for_selector('text=Noch in keiner Gruppe')
    check('Clara hat Familie verlassen', True)
    c.goto(BASE + '#/mehr')
    c.click('text=Abmelden')
    c.wait_for_selector('text=Code per Mail schicken')
    check('Abgemeldet, kein Cache mehr', 'cache' not in c.evaluate("localStorage.getItem('geschenkeliste-v1') || ''"))

    # Login-Bildschirm fürs Bild
    d = newpage(browser, errs)
    d.goto(BASE)
    d.wait_for_selector('text=Code per Mail schicken')
    shot(d, '1-login')

    # Start aus Cache ohne Netz: Daten bleiben sichtbar
    a.context.unroute('https://qbdpzamygonpruaafcrt.supabase.co/**')
    a.context.route('https://qbdpzamygonpruaafcrt.supabase.co/**', lambda r, q: r.abort())
    a.reload()
    a.wait_for_selector('.wish:has-text("Kochbuch")')
    check('Offline: Liste aus Zwischenspeicher', True)

    real = [e for e in errs if 'Failed to load resource' not in e and 'net::ERR_FAILED' not in e]
    check('Keine JS-Fehler ' + ('; '.join(real)[:300] if real else ''), not real)
    browser.close()

print('\nAlle Tests grün' if not fails else f'\n{fails} Fehler')
sys.exit(1 if fails else 0)
