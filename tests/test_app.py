"""Ende-zu-Ende-Test der App mit mehreren Nutzern gegen die Supabase-Attrappe.

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
subprocess.run(mock.PSQL, input='truncate auth.users, public.login_attempts cascade;', capture_output=True, text=True)


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


def toast(p, text):
    expect(p.locator('#toast')).to_contain_text(text)


def confirm_code(p):
    code = p.inner_text('#rcode').replace('-', '').strip()
    p.fill('input[name=last4]', code[-4:].lower())
    p.click('form[data-form=confirmcode] button')
    return code


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
    start_anon(b, 'Ben', BASE + '#/join/' + code)
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
    start_anon(c, 'Clara')
    c.wait_for_selector('h1:has-text("Hallo Clara")')
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

    # Anna sichert ihr Konto mit Benutzername und Passwort
    a.goto(BASE + '#/')
    a.wait_for_selector('h1:has-text("Hallo Anna")')
    check('Hinweis „Konto sichern“ auf der Startseite', a.locator('.banner:has-text("Konto sichern")').count() == 1)
    a.goto(BASE + '#/konto')
    check('Schlüsselbund-Felder beim Sichern',
          a.get_attribute('form[data-form=secure] input[name=username]', 'autocomplete') == 'username'
          and a.get_attribute('form[data-form=secure] input[name=password]', 'autocomplete') == 'new-password')
    a.fill('form[data-form=secure] input[name=username]', 'A')
    a.fill('form[data-form=secure] input[name=password]', 'geheim123')
    a.click('form[data-form=secure] button')
    toast(a, '3 bis 24 Zeichen')
    a.fill('form[data-form=secure] input[name=username]', ' Anna ')
    check('Passwortfeld verlangt 8 Zeichen', a.get_attribute('form[data-form=secure] input[name=password]', 'minlength') == '8')
    a.fill('form[data-form=secure] input[name=password]', 'geheim123')
    a.click('form[data-form=secure] button')
    a.wait_for_selector('#rcode')
    code_a = a.inner_text('#rcode').replace('-', '').strip()
    check('Wiederherstellungscode angezeigt (16 Zeichen, 4er-Gruppen)', len(code_a) == 16 and a.inner_text('#rcode').count('-') == 3)
    shot(a, '7-code')
    a.fill('input[name=last4]', 'XXXX')
    a.click('form[data-form=confirmcode] button')
    toast(a, 'stimmen nicht')
    confirm_code(a)
    toast(a, 'Konto gesichert')
    a.wait_for_selector('text=Benutzername anna')
    check('Konto zeigt Benutzername, kein Sichern mehr', a.locator('form[data-form=secure]').count() == 0)
    check('Konto zeigt Wiederherstellungscode-Karte', a.locator('text=Neuen Code erzeugen').count() == 1)
    uid_a = a.evaluate("JSON.parse(localStorage.getItem('geschenkeliste-v1')).session.user.id")
    a.goto(BASE + '#/')
    a.wait_for_selector('h1:has-text("Hallo Anna")')
    check('Kein „Konto sichern“ mehr auf der Startseite', a.locator('.banner:has-text("Konto sichern")').count() == 0)

    # Anna meldet sich auf einem zweiten Gerät an
    e = newpage(browser, errs)
    e.goto(BASE)
    e.wait_for_selector('text=Mit Benutzername anmelden')
    check('Schlüsselbund-Felder bei der Anmeldung',
          e.get_attribute('form[data-form=signin] input[name=password]', 'autocomplete') == 'current-password')
    e.fill('form[data-form=signin] input[name=username]', 'anna')
    e.fill('form[data-form=signin] input[name=password]', 'falsch123')
    e.click('form[data-form=signin] button')
    toast(e, 'Benutzername oder Passwort falsch')
    e.fill('form[data-form=signin] input[name=username]', '@Anna ')
    e.fill('form[data-form=signin] input[name=password]', 'geheim123')
    e.click('form[data-form=signin] button')
    e.wait_for_selector('h1:has-text("Hallo Anna")')
    uid_e = e.evaluate("JSON.parse(localStorage.getItem('geschenkeliste-v1')).session.user.id")
    e.goto(BASE + '#/liste')
    e.wait_for_selector('.wish:has-text("Kochbuch")')
    check('Zweites Gerät: gleiches Konto, gleiche Liste', uid_e == uid_a)

    # Passwort vergessen mit dem Wiederherstellungscode
    f = newpage(browser, errs)
    f.goto(BASE)
    f.click('text=Passwort vergessen?')
    f.wait_for_selector('h1:has-text("Passwort vergessen")')
    shot(f, '9-vergessen')
    f.fill('form[data-form=recover] input[name=username]', 'anna')
    f.fill('form[data-form=recover] input[name=code]', 'AAAA-BBBB-CCCC-DDDD')
    f.fill('form[data-form=recover] input[name=password]', 'neuespw123')
    f.click('form[data-form=recover] button')
    toast(f, 'Noch 4 Versuche')
    f.fill('form[data-form=recover] input[name=code]', '-'.join(code_a[i:i + 4] for i in range(0, 16, 4)).lower())
    f.click('form[data-form=recover] button')
    f.wait_for_selector('h1:has-text("Neues Passwort gespeichert")')
    code_a2 = confirm_code(f)
    f.wait_for_selector('h1:has-text("Hallo Anna")')
    check('Passwort vergessen: neuer Code, angemeldet', code_a2 != code_a)
    check('Kein Rücksetz-Hinweis bei eigenem Code', f.locator('text=zurückgesetzt').count() == 0)
    f.goto(BASE + '#/konto')
    f.click('button:has-text("Abmelden")')
    f.wait_for_selector('text=Mit Benutzername anmelden')
    check('Gesichertes Konto: Abmelden ohne Warnung', f.locator('text=Trotzdem abmelden').count() == 0)
    f.fill('form[data-form=signin] input[name=username]', 'anna')
    f.fill('form[data-form=signin] input[name=password]', 'geheim123')
    f.click('form[data-form=signin] button')
    toast(f, 'Benutzername oder Passwort falsch')
    f.fill('form[data-form=signin] input[name=password]', 'neuespw123')
    f.click('form[data-form=signin] button')
    f.wait_for_selector('h1:has-text("Hallo Anna")')
    check('Altes Passwort ungültig, neues klappt', True)

    # Neuer Wiederherstellungscode unter Konto
    f.goto(BASE + '#/konto')
    f.click('button:has-text("Neuen Code erzeugen")')
    f.click('button:has-text("Jetzt neuen Code erzeugen")')
    f.wait_for_selector('#rcode')
    confirm_code(f)
    toast(f, 'Neuer Code gespeichert')
    f.wait_for_selector('text=Benutzername anna')
    check('Neuer Code unter Konto', True)

    # Ben sichert sein Konto, Anna wird Admin und setzt Ben zurück
    b.goto(BASE + '#/konto')
    b.fill('form[data-form=secure] input[name=username]', 'anna')
    b.fill('form[data-form=secure] input[name=password]', 'bengeheim1')
    b.click('form[data-form=secure] button')
    toast(b, 'gibt es schon')
    b.fill('form[data-form=secure] input[name=username]', 'ben')
    b.click('form[data-form=secure] button')
    b.wait_for_selector('#rcode')
    confirm_code(b)
    b.wait_for_selector('text=Benutzername ben')
    check('Ben sieht keine Verwaltung', b.locator('h2:has-text("Verwaltung")').count() == 0)
    subprocess.run(mock.PSQL, input="insert into public.app_admins select user_id from public.accounts where username = 'anna';", capture_output=True, text=True)
    a.goto(BASE + '#/konto')
    a.reload()
    a.wait_for_selector('h2:has-text("Verwaltung")')
    a.fill('form[data-form=adminsearch] input', 'BE')
    a.click('form[data-form=adminsearch] button')
    a.wait_for_selector('.row-item:has-text("ben")')
    a.click('.row-item:has-text("ben") button:has-text("Zurücksetzen")')
    a.click('.row-item:has-text("ben") button:has-text("Wirklich")')
    a.wait_for_selector('#resetcode')
    reset = a.inner_text('#resetcode').strip()
    check('Admin bekommt Rücksetz-Code, Liste zeigt „Code offen“', len(reset) == 19 and a.locator('text=Code offen').count() == 1)
    shot(a, '8-verwaltung')
    g = newpage(browser, errs)
    g.goto(BASE + '#/vergessen')
    g.fill('form[data-form=recover] input[name=username]', 'ben')
    g.fill('form[data-form=recover] input[name=code]', reset)
    g.fill('form[data-form=recover] input[name=password]', 'benneu12345')
    g.click('form[data-form=recover] button')
    g.wait_for_selector('#rcode')
    confirm_code(g)
    g.wait_for_selector('.banner:has-text("zurückgesetzt")')
    check('Ben sieht Hinweis „Zugang zurückgesetzt“', True)
    shot(g, '10-hinweis')
    g.click('[data-act=dismissreset]')
    g.wait_for_selector('.banner:has-text("zurückgesetzt")', state='detached')
    check('Hinweis weggeklickt', True)
    g.close()

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
    c.click('button:has-text("Abmelden")')
    c.click('text=Trotzdem abmelden')
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
    check('Warnung beim Abmelden ohne Benutzername', True)
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
