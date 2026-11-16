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


def start_anon(p, name, url=BASE):
    p.goto(url)
    p.fill('form[data-form=start] input[name=name]', name)
    p.click('form[data-form=start] button')


def login(p, email, name, url=BASE):
    p.goto(url)
    p.fill('input[name=email]', email)
    p.click('text=Anmelde-Link schicken')
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
    start_anon(a, 'Anna')
    a.wait_for_selector('h1:has-text("Hallo Anna")')
    check('Anna ohne Mail gestartet, kein Namens-Bildschirm', a.locator('text=Wie heißt du?').count() == 0)
    check('Anna angemeldet, Start-Karte ohne Gruppe', a.locator('text=Starte mit deiner Familie').count() == 1)

    # Gruppen anlegen
    a.click('.tabs >> text=Gruppen')
    a.fill('form[data-form=newgroup] input', 'Familie')
    a.click('button:has-text("Anlegen")')
    a.wait_for_selector('h1:has-text("Familie")')
    code = a.inner_text('#gcode').strip()
    check('Code angezeigt', len(code) == 9 and code[4] == '-')
    shot(a, '3-gruppe')
    a.click('.tabs >> text=Gruppen')
    a.fill('form[data-form=newgroup] input', 'Freunde')
    a.click('button:has-text("Anlegen")')
    a.wait_for_selector('h1:has-text("Freunde")')

    # Wünsche anlegen
    a.click('.tabs >> text=Wunschliste')
    a.click('text=Wunsch hinzufügen')
    a.fill('input[name=title]', 'Kochbuch')
    a.fill('input[name=url]', 'www.example.org/buch')
    a.fill('textarea[name=note]', 'Gern die neue Auflage')
    a.click('button:has-text("Speichern")')
    a.wait_for_selector('.wish:has-text("Kochbuch")')
    check('Domain in der Liste', 'example.org' in a.inner_text('.wish:has-text("Kochbuch") .row-meta'))
    a.click('text=Wunsch hinzufügen')
    a.fill('input[name=title]', 'Konzertkarte')
    a.check('input[value=some]')
    a.click('button:has-text("Speichern")')
    expect(a.locator('#toast')).to_contain_text('mindestens eine Gruppe')
    a.check('label:has-text("Freunde") input')
    a.click('button:has-text("Speichern")')
    a.wait_for_selector('.wish:has-text("Konzertkarte")')
    check('Freigabe „Freunde“ angezeigt', 'Freunde' in a.inner_text('.wish:has-text("Konzertkarte") .row-meta'))
    a.click('text=Wunsch hinzufügen')
    a.fill('input[name=title]', 'Falscher Link')
    a.fill('input[name=url]', 'kein link')
    a.click('button:has-text("Speichern")')
    expect(a.locator('#toast')).to_contain_text('Link sieht nicht richtig aus')
    a.click('.tabs >> text=Wunschliste')
    a.wait_for_selector('h1:has-text("Meine Wunschliste")')
    shot(a, '2-meine')
    check('Kein Überlauf (Anna)', overflow(a))

    # Ben tritt per Einladungslink bei
    b = newpage(browser, errs)
    login(b, 'ben@x.de', 'Ben', BASE + '#/join/' + code)
    b.wait_for_selector('h1:has-text("Familie")')
    check('Ben ist per Link beigetreten', b.locator('a.person:has-text("Anna")').count() == 1)
    b.click('a.person:has-text("Anna")')
    b.wait_for_selector('.profile')
    check('Link ergänzt https', b.get_attribute('.wish a.link-out', 'href') == 'https://www.example.org/buch')
    check('Ben sieht nur Kochbuch', b.locator('.wish').count() == 1 and b.locator('text=Konzertkarte').count() == 0)
    b.click('button:has-text("Reservieren")')
    b.wait_for_selector('text=Von dir reserviert')
    b.click('button:has-text("Als gekauft markieren")')
    b.wait_for_selector('text=Von dir gekauft')
    shot(b, '4-liste-ben')
    b.goto(BASE + '#/')
    b.wait_for_selector('text=Deine Besorgungen')
    check('Besorgung auf der Startseite', b.locator('.row-item.done:has-text("Kochbuch")').count() == 1)
    shot(b, '1b-start-ben')
    b.click('.row-item:has-text("Kochbuch") .tick')
    b.wait_for_selector('.row-item:not(.done):has-text("Kochbuch")')
    check('Abhaken auf der Startseite', True)
    b.click('.row-item:has-text("Kochbuch") .tick')
    b.wait_for_selector('.row-item.done:has-text("Kochbuch")')
    b.click('.row-item:has-text("Kochbuch") a.row-main')
    b.wait_for_selector('text=Von dir gekauft')
    check('Kein Überlauf (Ben)', overflow(b))

    # Anna sieht nichts davon
    a.reload()
    a.wait_for_selector('.wish:has-text("Kochbuch")')
    txt = a.inner_text('main')
    check('Anna sieht keinen Status', 'gekauft' not in txt.lower() and 'von ben' not in txt.lower())
    a.goto(BASE + '#/gruppen')
    a.click('a.group:has-text("Familie")')
    a.wait_for_selector('.person:has-text("Ben")')
    shot(a, '3-gruppe')
    a.goto(BASE + '#/')
    a.wait_for_selector('h1:has-text("Hallo Anna")')
    check('Startseite: Neu in deinen Gruppen leer bzw. vorhanden', a.locator('text=Neu in deinen Gruppen').count() == 1)
    check('Anna sieht Ben in Familie', True)

    # Dritte Person mit Code-Eingabe sieht Bens Reservierung
    c = newpage(browser, errs)
    c.goto(BASE)
    c.fill('input[name=email]', 'clara@x.de')
    c.fill('form[data-form=start] input[name=name]', 'Clara')
    c.click('text=Anmelde-Link schicken')
    c.fill('input[name=code]', 'https://qbdpzamygonpruaafcrt.supabase.co/auth/v1/verify?token=hash-123456&type=magiclink&redirect_to=https://konstismile.github.io/Geschenkeliste/')
    c.click('button:has-text("Anmelden")')
    c.wait_for_selector('h1:has-text("Hallo Clara")')
    check('Anmeldung mit eingefügtem Link, Name von der Startseite übernommen', True)
    c.click('.tabs >> text=Gruppen')
    c.fill('input[name=code]', code.lower())
    c.click('button:has-text("Beitreten")')
    c.wait_for_selector('h1:has-text("Familie")')
    c.click('a.person:has-text("Anna")')
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
    a.goto(BASE + '#/liste')
    a.click('a.wish:has-text("Konzertkarte")')
    a.fill('input[name=title]', 'Konzertkarte Jazz')
    a.check('input[value=all]')
    a.click('button:has-text("Speichern")')
    a.wait_for_selector('.wish:has-text("Konzertkarte Jazz")')
    b.goto(BASE + '#/gruppen')
    b.click('.top [data-act=sync]')
    b.click('a.group:has-text("Familie")')
    b.click('a.person:has-text("Anna")')
    b.wait_for_selector('text=Konzertkarte Jazz')
    check('Nach Umstellen auf „alle“ sieht Ben die Karte', True)
    a.click('a.wish:has-text("Konzertkarte Jazz")')
    a.click('button:has-text("Wunsch löschen")')
    a.click('button:has-text("Wirklich löschen")')
    a.wait_for_selector('h1:has-text("Meine Wunschliste")')
    check('Gelöscht', a.locator('text=Konzertkarte Jazz').count() == 0)

    # Anna sichert ihr Konto
    a.goto(BASE + '#/')
    a.wait_for_selector('h1:has-text("Hallo Anna")')
    check('Hinweis „Konto sichern“ auf der Startseite', a.locator('.banner:has-text("Konto sichern")').count() == 1)
    a.goto(BASE + '#/mehr')
    a.fill('form[data-form=secure] input[name=email]', 'anna@x.de')
    a.click('button:has-text("Sichern")')
    a.wait_for_selector('text=Bestätigung ausstehend')
    a.click('button:has-text("Prüfen")')
    expect(a.locator('#toast')).to_contain_text('Noch nicht bestätigt')
    uid = a.evaluate("JSON.parse(localStorage.getItem('geschenkeliste-v1')).session.user.id")
    mock.confirmed[uid] = 'anna@x.de'
    a.click('button:has-text("Prüfen")')
    a.wait_for_selector('text=Angemeldet als anna@x.de')
    check('Anna hat ihr Konto gesichert', a.locator('text=Konto sichern').count() == 0)

    # Name ändern, Gruppe verlassen, abmelden
    b.goto(BASE + '#/mehr')
    b.fill('input[name=name]', 'Benni')
    b.click('button:has-text("Name ändern")')
    expect(b.locator('#toast')).to_contain_text('Gespeichert')
    shot(b, '5-mehr')
    c.goto(BASE + '#/gruppen')
    c.click('a.group:has-text("Familie")')
    c.click('text=Gruppe verlassen')
    c.click('text=Wirklich verlassen')
    c.wait_for_selector('text=Noch in keiner Gruppe')
    check('Clara hat Familie verlassen', True)
    c.goto(BASE + '#/mehr')
    c.click('text=Abmelden')
    c.wait_for_selector('text=Wünsche teilen')
    check('Abgemeldet, kein Cache mehr', 'cache' not in c.evaluate("localStorage.getItem('geschenkeliste-v1') || ''"))

    # Login-Bildschirm fürs Bild
    d = newpage(browser, errs)
    d.goto(BASE)
    d.wait_for_selector('text=Wünsche teilen')
    shot(d, '1-login')
    start_anon(d, 'Dora')
    d.wait_for_selector('h1:has-text("Hallo Dora")')
    shot(d, '0-start-leer')
    d.goto(BASE + '#/mehr')
    d.click('button:has-text("Abmelden")')
    d.wait_for_selector('text=Trotzdem abmelden')
    check('Warnung beim Abmelden ohne Mail', True)
    shot(d, '6-mehr-anon')

    # Start aus Cache ohne Netz: Daten bleiben sichtbar
    a.context.unroute('https://qbdpzamygonpruaafcrt.supabase.co/**')
    a.context.route('https://qbdpzamygonpruaafcrt.supabase.co/**', lambda r, q: r.abort())
    a.goto(BASE + '#/liste')
    a.reload()
    a.wait_for_selector('.wish:has-text("Kochbuch")')
    check('Offline: Liste aus Zwischenspeicher', True)

    real = [e for e in errs if 'Failed to load resource' not in e and 'net::ERR_FAILED' not in e]
    check('Keine JS-Fehler ' + ('; '.join(real)[:300] if real else ''), not real)
    browser.close()

print('\nAlle Tests grün' if not fails else f'\n{fails} Fehler')
sys.exit(1 if fails else 0)
