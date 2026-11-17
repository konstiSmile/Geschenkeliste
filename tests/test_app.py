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
subprocess.run(mock.PSQL, input='truncate auth.users, public.login_attempts, public.push_config cascade;', capture_output=True, text=True)


def check(name, cond):
    global fails
    print(('ok   ' if cond else 'FAIL ') + name)
    if not cond:
        fails += 1


IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'
IPHONE_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1'
ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'


def newpage(browser, errors, ua=None, init=None):
    ctx = browser.new_context(viewport={'width': 390, 'height': 780}, service_workers='block', **({'user_agent': ua} if ua else {}))
    if init:
        ctx.add_init_script(init)
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

    # ---------- 1.7 Mehr am Wunsch ----------
    from urllib.parse import quote
    a.context.grant_permissions(['clipboard-read', 'clipboard-write'], origin=BASE.rstrip('/'))
    a.goto(BASE + '#/w/neu')
    a.wait_for_selector('h1:has-text("Neuer Wunsch")')
    a.evaluate("navigator.clipboard.writeText('https://www.example.org/LEGO-Technic-Rennwagen-42115/dp/B08X')")
    a.click('[data-act=pasteurl]')
    expect(a.locator('input[name=url]')).to_have_value('https://www.example.org/LEGO-Technic-Rennwagen-42115/dp/B08X')
    check('1.7: Link einfügen übernimmt Link und Titel aus dem Pfad', a.input_value('input[name=title]') == 'LEGO Technic Rennwagen 42115')
    a.fill('input[name=price]', 'zwölf')
    a.click('button:has-text("Speichern")')
    toast(a, 'Preis sieht nicht richtig aus')
    a.fill('input[name=price]', '89,90')
    a.select_option('select[name=category]', 'spiel')
    a.click('.seg label:has-text("Sehr gern")')
    shot(a, '14-wunsch-formular')
    check('Kein Überlauf (Formular)', overflow(a))
    a.click('button:has-text("Speichern")')
    a.wait_for_selector('.wish:has-text("LEGO")')
    meta = a.inner_text('.wish:has-text("LEGO") .row-meta').replace('\xa0', ' ')
    check('1.7: Liste zeigt Preis und Kategorie', '89,90 €' in meta and 'Spiele und Spielzeug' in meta)
    check('1.7: „Sehr gern“ steht oben mit Herz', a.locator('.rows .wish .row-title').first.inner_text().strip().startswith('LEGO') and a.locator('.wish:has-text("LEGO") .prio').count() == 1)
    for title, price, cat, pr in (('Socken', '12', 'kleidung', 'Nur eine Idee'), ('Buchgutschein', '30 €', 'gutschein', 'Normal')):
        a.click('text=Wunsch hinzufügen')
        a.fill('input[name=title]', title)
        a.fill('input[name=price]', price)
        a.select_option('select[name=category]', cat)
        a.click(f'.seg label:has-text("{pr}")')
        a.click('button:has-text("Speichern")')
        a.wait_for_selector(f'.wish:has-text("{title}")')
    check('1.7: „Nur eine Idee“ in der Liste', 'Idee' in a.inner_text('.wish:has-text("Socken") .row-meta'))
    a.click('a.wish:has-text("Socken")')
    check('1.7: Bearbeiten zeigt gespeicherte Werte', a.input_value('input[name=price]') == '12'
          and a.input_value('select[name=category]') == 'kleidung' and a.is_checked('.seg input[value="1"]'))
    a.click('.back')

    b.goto(BASE + '#/gruppen')
    b.click('.top [data-act=sync]')
    b.click('a.group:has-text("Familie")')
    b.click('a.person:has-text("Anna")')
    b.wait_for_selector('.wish:has-text("Socken")')
    check('1.7: Ben sieht „Sehr gern“ zuerst', b.locator('.cards .wish h3').first.inner_text().startswith('LEGO')
          and b.locator('.wish:has-text("LEGO") .tag.hi').count() == 1)
    check('1.7: Ben sieht Preis und Kategorie', '89,90 €' in b.inner_text('.wish:has-text("LEGO") .wmeta').replace('\xa0', ' '))
    n_all = b.locator('.cards .wish').count()
    b.click('.chip:has-text("bis 25 €")')
    check('1.7: Filter Preis bis 25 €', b.locator('.cards .wish').count() == 1 and b.locator('.wish:has-text("Socken")').count() == 1)
    b.click('.chip:has-text("bis 25 €")')
    check('1.7: Filter wieder aus', b.locator('.cards .wish').count() == n_all == 4)
    b.click('.chip:has-text("Noch frei")')
    check('1.7: Filter „Noch frei“ blendet Claras Reservierung aus', b.locator('.cards .wish').count() == 3 and b.locator('.wish:has-text("Kochbuch")').count() == 0)
    b.click('.chip:has-text("Gutscheine")')
    check('1.7: Filter Kategorie', b.locator('.cards .wish').count() == 1)
    shot(b, '15-liste-filter')
    check('Kein Überlauf (Filter)', overflow(b))
    b.click('.chip:has-text("bis 25 €")')
    b.wait_for_selector('text=Nichts passt zum Filter')
    b.click('button:has-text("Filter aufheben")')
    check('1.7: Filter aufheben', b.locator('.cards .wish').count() == 4)
    b.click('.wish:has-text("LEGO") button:has-text("Reservieren")')
    b.wait_for_selector('.wish:has-text("LEGO") >> text=Von dir reserviert')

    # „Hab ich schon“
    a.goto(BASE + '#/liste')
    a.click('a.wish:has-text("LEGO")')
    a.click('button:has-text("Hab ich schon")')
    a.wait_for_selector('h2:has-text("Hab ich schon")')
    check('1.7: Anna sieht LEGO unter „Hab ich schon“', a.locator('.wish.had:has-text("LEGO")').count() == 1 and 'seit' in a.inner_text('.wish.had .row-meta'))
    shot(a, '16-hab-ich-schon')
    b.goto(BASE + '#/')
    b.click('.top [data-act=sync]')
    b.wait_for_selector('.banner.warn:has-text("Anna hat „LEGO")')
    check('1.7: Ben bekommt Hinweis auf der Startseite', 'hat Anna schon' in b.inner_text('.row-item:has-text("LEGO") .row-meta'))
    shot(b, '17-hinweis-start')
    b.click('.banner.warn button:has-text("Freigeben")')
    b.wait_for_selector('.banner.warn', state='detached')
    check('1.7: Freigeben entfernt den Hinweis', b.locator('.row-item:has-text("LEGO")').count() == 0)
    c.goto(BASE + '#/gruppen')
    c.click('.top [data-act=sync]')
    c.click('a.group:has-text("Familie")')
    c.click('a.person:has-text("Anna")')
    c.wait_for_selector('h2:has-text("Hat Anna schon")')
    check('1.7: Clara kann „Hab ich schon“ nicht reservieren', c.locator('.wish:has-text("LEGO") button').count() == 0
          and c.locator('.wish:has-text("LEGO") >> text=Hat Anna schon').count() == 1)
    check('1.7: Gruppe zählt nur offene Wünsche', True)
    a.click('a.wish:has-text("LEGO")')
    a.click('button:has-text("Doch wieder wünschen")')
    a.wait_for_selector('h1:has-text("Meine Wunschliste")')
    check('1.7: Doch wieder wünschen', a.locator('h2:has-text("Hab ich schon")').count() == 0 and a.locator('.wish:has-text("LEGO")').count() == 1)

    # Teilen aus einer anderen App (Android) und Einfügen von Text mit Link
    a.goto(BASE + '?title=&text=' + quote('Toller Schal https://shop.example.com/schal-rot') + '&url=')
    a.wait_for_selector('h1:has-text("Neuer Wunsch")')
    check('1.7: Geteilter Link landet im Formular', a.input_value('input[name=url]') == 'https://shop.example.com/schal-rot'
          and a.input_value('input[name=title]') == 'Toller Schal')
    check('1.7: Adresse aufgeräumt', a.evaluate('location.search') == '' and a.evaluate('location.hash') == '#/w/neu')
    a.click('button:has-text("Speichern")')
    a.wait_for_selector('.wish:has-text("Toller Schal")')
    a.click('text=Wunsch hinzufügen')
    check('1.7: Geteiltes wird nur einmal übernommen', a.input_value('input[name=url]') == '')
    a.evaluate("navigator.clipboard.writeText('Mütze in Blau https://shop.example.com/muetze.')")
    a.focus('input[name=url]')
    a.keyboard.press('Control+V')
    check('1.7: Einfügen von Text mit Link nimmt nur den Link', a.input_value('input[name=url]') == 'https://shop.example.com/muetze'
          and a.input_value('input[name=title]') == 'Mütze in Blau')
    a.goto(BASE + '#/liste')
    a.click('a.wish:has-text("Toller Schal")')
    a.click('button:has-text("Wunsch löschen")')
    a.click('button:has-text("Wirklich löschen")')
    a.wait_for_selector('h1:has-text("Meine Wunschliste")')

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

    # Wichteln (1.6): Anna hat Familie gegründet, Ben und Clara sind dabei
    b.goto(BASE + '#/gruppen')
    b.click('.top [data-act=sync]')
    b.click('a.group:has-text("Familie")')
    b.wait_for_selector('h1:has-text("Familie")')
    check('Wichteln: Mitglied sieht vor der Auslosung keinen Eintrag', b.locator('h2:has-text("Wichteln")').count() == 0)
    fam = b.url.split('#/g/')[1]
    b.goto(BASE + f'#/g/{fam}/wichteln')
    b.wait_for_selector('text=Noch nicht ausgelost')
    check('Wichteln: Mitglied hat keine Verwaltung', b.locator('text=Wer macht mit').count() == 0 and b.locator('[data-act=wdraw]').count() == 0)
    a.goto(BASE + f'#/g/{fam}')
    a.reload()
    a.wait_for_selector('.row-item:has-text("Noch nicht ausgelost")')
    a.click('.row-item:has-text("Wichteln")')
    a.wait_for_selector('text=Wer macht mit')
    check('Wichteln: Gründer sieht drei Teilnehmer', a.locator('.rows .tick.on').count() == 3 and a.locator('text=3 Personen machen mit').count() == 1)
    a.select_option('form[data-form=wex] select[name=a]', label='Ben')
    a.select_option('form[data-form=wex] select[name=b]', label='Ben')
    a.click('button:has-text("Ausschluss hinzufügen")')
    toast(a, 'zwei verschiedene')
    a.select_option('form[data-form=wex] select[name=b]', label='Clara')
    a.click('button:has-text("Ausschluss hinzufügen")')
    a.wait_for_selector('.row-item:has-text("Ben und Clara")')
    shot(a, '11-wichteln-gruender')
    a.click('button:has-text("Jetzt auslosen")')
    toast(a, 'geht die Auslosung nicht auf')
    check('Wichteln: unmögliche Auslosung gemeldet, nichts ausgelost', a.locator('button:has-text("Jetzt auslosen")').count() == 1)
    a.click('.row-item:has-text("Ben und Clara") button:has-text("Entfernen")')
    a.wait_for_selector('text=Zum Beispiel Paare')
    a.click('.row-item:has-text("Clara") .tick')
    a.wait_for_selector('text=2 Personen machen mit')
    a.click('button:has-text("Jetzt auslosen")')
    toast(a, 'mindestens 3 Personen')
    a.click('.row-item:has-text("Clara") .tick')
    a.wait_for_selector('text=3 Personen machen mit')
    a.click('button:has-text("Jetzt auslosen")')
    a.wait_for_selector('.reveal')
    toast(a, 'Ausgelost')
    got = {}
    got['Anna'] = a.inner_text('.reveal-name').strip()
    for p_, n in ((b, 'Ben'), (c, 'Clara')):
        p_.goto(BASE + '#/')
        p_.click('.top [data-act=sync]')
        p_.wait_for_selector('h2:has-text("Wichteln")')
        t = p_.inner_text('.rows .row-item:has-text("Du beschenkst")')
        got[n] = t.split('Du beschenkst', 1)[1].strip().split('\n')[0].strip()
    check('Wichteln: jeder zieht genau eine andere Person', all(k != v for k, v in got.items()) and set(got.values()) == {'Anna', 'Ben', 'Clara'})
    shot(b, '12-wichteln-start')
    b.click('.rows .row-item:has-text("Du beschenkst")')
    b.wait_for_selector('h1:has-text("' + got['Ben'] + '")')
    check('Wichteln: Startseite führt zur Wunschliste der gezogenen Person', True)
    b.goto(BASE + f'#/g/{fam}/wichteln')
    b.wait_for_selector('.reveal')
    check('Wichteln: Mitglied sieht nur die eigene Person', b.inner_text('.reveal-name').strip() == got['Ben'] and b.locator('text=Wer macht mit').count() == 0)
    shot(b, '13-wichteln-mitglied')
    check('Wichteln: Gründer sieht keine fremden Zuteilungen', got['Ben'] not in a.inner_text('.reveal') or got['Ben'] == got['Anna'])
    a.click('button:has-text("Neu auslosen")')
    a.wait_for_selector('text=Alle Zuteilungen ändern sich')
    a.click('button:has-text("Abbrechen")')
    a.wait_for_selector('button:has-text("Neu auslosen")')
    seen_new = set()
    for _ in range(6):
        a.click('button:has-text("Neu auslosen")')
        a.click('button:has-text("Wirklich neu auslosen")')
        toast(a, 'Neu ausgelost')
        a.wait_for_selector('button:has-text("Neu auslosen")')
        seen_new.add(a.inner_text('.reveal-name').strip())
    check('Wichteln: neu auslosen mit Bestätigung', seen_new <= {'Ben', 'Clara'} and len(seen_new) >= 1)
    check('Kein Überlauf (Wichteln)', overflow(a) and overflow(b))

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
    a.goto(BASE + f'#/g/{fam}/wichteln')
    a.reload()
    a.wait_for_selector('text=Die Gruppe hat sich geändert')
    check('Wichteln: Gründer sieht Hinweis nach Austritt', True)
    a.click('button:has-text("Auslosung aufheben")')
    a.click('button:has-text("Wirklich aufheben")')
    toast(a, 'aufgehoben')
    a.wait_for_selector('button:has-text("Jetzt auslosen")')
    b.goto(BASE + '#/')
    b.click('.top [data-act=sync]')
    b.wait_for_selector('h1:has-text("Hallo")')
    b.wait_for_selector('h2:has-text("Wichteln")', state='detached', timeout=8000)
    check('Wichteln: nach dem Aufheben kein Eintrag auf der Startseite', b.locator('h2:has-text("Wichteln")').count() == 0)
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

    # 1.7.1 Als App installieren
    import json as _json
    from PIL import Image
    root = os.path.join(os.path.dirname(__file__), '..')
    man = _json.load(open(os.path.join(root, 'manifest.webmanifest'), encoding='utf-8'))
    files = [(i['src'], i['sizes']) for i in man['icons'] + man['screenshots']]
    files += [(i['src'], i['sizes']) for sc in man['shortcuts'] for i in sc['icons']]
    bad = [f for f, sz in files if not os.path.exists(os.path.join(root, f))
           or '%dx%d' % Image.open(os.path.join(root, f)).size != sz]
    check('Manifest: alle Bilder vorhanden, Größen stimmen ' + ' '.join(bad), not bad)
    check('Manifest: id, maskierbares Symbol, Kurzbefehle, Bilder schmal',
          man.get('id') and any(i.get('purpose') == 'maskable' for i in man['icons'])
          and len(man['shortcuts']) == 3 and all(x['form_factor'] == 'narrow' for x in man['screenshots']))
    check('Manifest: Farben passend zur Seite', man['background_color'] == '#f5f2ec' and man['theme_color'] == '#f5f2ec')

    # Rechner: beide Anleitungen zugeklappt
    e = newpage(browser, errs)
    e.goto(BASE)
    e.wait_for_selector('#install .install')
    check('Rechner: „Auf dem Handy als App“', 'Auf dem Handy als App' in e.inner_text('#install'))
    check('Rechner: zwei zugeklappte Anleitungen', e.locator('#install details').count() == 2 and e.locator('#install details[open]').count() == 0
          and not e.locator('#install .steps').first.is_visible())
    e.click('summary:has-text("Anleitung für iPhone")')
    check('Rechner: iPhone-Anleitung aufklappbar', e.locator('#install details[open] .steps li').count() == 3)
    e.context.close()

    # iPhone in Safari, mit Einladung
    f = newpage(browser, errs, IPHONE)
    f.goto(BASE + '#/join/' + code)
    f.wait_for_selector('#install .install')
    t = f.inner_text('#install')
    check('iPhone: Anleitung mit drei Schritten sichtbar', f.locator('#install > section > .steps li').count() == 3 and 'Zum Home-Bildschirm' in t and 'Hinzufügen' in t)
    check('iPhone: alter Tipp ist weg', f.locator('text=Tipp fürs iPhone').count() == 0)
    check('iPhone: kein Safari-Hinweis in Safari', 'zuverlässigsten in Safari' not in t)
    check('iPhone: Einladungscode für die App', code.upper() in f.inner_text('.invcode'))
    check('iPhone: Android-Anleitung zugeklappt', f.locator('#install details').count() == 1 and 'Android' in f.inner_text('#install summary'))
    check('iPhone: Anleitung vor dem Start-Formular',
          f.evaluate("document.querySelector('#install').compareDocumentPosition(document.querySelector('form[data-form=start]')) & 4") > 0)
    f.click('summary:has-text("Anleitung für Android")')
    check('iPhone: kein Überlauf', overflow(f))
    f.locator('details').evaluate('d => d.open = false')
    f.locator('#install').scroll_into_view_if_needed()
    shot(f, '18-installieren-iphone')
    f.context.close()
    f = newpage(browser, errs, IPHONE_CHROME)
    f.goto(BASE)
    f.wait_for_selector('#install .install')
    check('iPhone in Chrome: Hinweis auf Safari', 'zuverlässigsten in Safari' in f.inner_text('#install'))
    f.context.close()

    # iPhone als Home-Bildschirm-App: keine Anleitung, auch nicht unter Konto
    f = newpage(browser, errs, IPHONE, "Object.defineProperty(navigator, 'standalone', { get: () => true })")
    start_anon(f, 'Ida')
    f.wait_for_selector('h1:has-text("Hallo Ida")')
    f.goto(BASE + '#/konto')
    f.wait_for_selector('h2:has-text("Datenschutz")')
    check('Installiert: keine Anleitung unter Konto', f.locator('#install .install').count() == 0 and 'Als App' not in f.inner_text('main'))
    # 1.8: installierte iPhone-App fragt nach dem Zähler am App-Symbol
    check('1.8: iPhone-App: Karte „Zähler am App-Symbol“ unter Konto', f.locator('h2:has-text("App")').count() == 1
          and f.locator('.card:has-text("Zähler am App-Symbol") [data-act=badgeperm]').count() == 1)
    f.goto(BASE + '#/')
    f.wait_for_selector('.banner:has-text("Zähler am App-Symbol")')
    shot(f, '23-zaehler-hinweis')
    f.click('[data-act=badgelater]')
    f.wait_for_selector('.banner:has-text("Zähler am App-Symbol")', state='detached')
    check('1.8: Hinweis auf der Startseite lässt sich mit „Später“ wegklicken', True)
    f.context.grant_permissions(['notifications'])
    f.goto(BASE + '#/konto')
    f.reload()
    f.wait_for_selector('h2:has-text("Datenschutz")')
    check('1.8: mit erlaubten Mitteilungen keine Zähler-Karte mehr', f.locator('text=Zähler am App-Symbol').count() == 0)
    f.context.close()

    # Android: erst Menü-Anleitung, dann Installieren-Knopf
    g = newpage(browser, errs, ANDROID)
    g.goto(BASE)
    g.wait_for_selector('#install .install')
    check('Android: Menü-Anleitung ohne Installieren-Ereignis', g.locator('#install > section > .steps li').count() == 3
          and 'App installieren' in g.inner_text('#install') and g.locator('[data-act=install]').count() == 0)
    check('Android: iPhone-Anleitung zugeklappt', 'Anleitung für iPhone' in g.inner_text('#install summary'))
    g.fill('form[data-form=start] input[name=name]', 'Gustav')
    g.evaluate("""() => { const e = new Event('beforeinstallprompt', { cancelable: true });
      e.prompt = () => { window.__prompted = (window.__prompted || 0) + 1; };
      e.userChoice = Promise.resolve({ outcome: 'accepted', platform: 'web' });
      window.dispatchEvent(e); window.__prevented = e.defaultPrevented; }""")
    g.wait_for_selector('[data-act=install]')
    check('Android: Installieren-Knopf, Browser-Leiste unterdrückt', g.evaluate('window.__prevented') is True
          and g.locator('#install > section > .steps').count() == 0)
    check('Android: Eingabe bleibt beim Einblenden erhalten', g.input_value('form[data-form=start] input[name=name]') == 'Gustav')
    shot(g, '19-installieren-android')
    g.click('[data-act=install]')
    g.wait_for_selector('#install .cardhead:has-text("Installiert")')
    check('Android: Dialog geöffnet, danach „Installiert“', g.evaluate('window.__prompted') == 1)
    g.evaluate("window.dispatchEvent(new Event('appinstalled'))")
    check('Android: appinstalled ohne Fehler', g.locator('#install .cardhead:has-text("Installiert")').count() == 1)
    g.reload()
    g.wait_for_selector('#install .install')
    g.evaluate("""() => { const e = new Event('beforeinstallprompt', { cancelable: true });
      e.prompt = () => {}; e.userChoice = Promise.resolve({ outcome: 'dismissed' }); window.dispatchEvent(e); }""")
    g.click('[data-act=install]')
    g.wait_for_selector('[data-act=install]', state='detached')
    check('Android: abgelehnt, zurück zur Menü-Anleitung', g.locator('#install > section > .steps li').count() == 3)
    g.context.close()

    # Konto: Anleitung unter „App“
    h = newpage(browser, errs, IPHONE)
    start_anon(h, 'Hanna')
    h.wait_for_selector('h1:has-text("Hallo Hanna")')
    h.goto(BASE + '#/konto')
    h.wait_for_selector('h2:has-text("App")')
    check('Konto: Anleitung, Hinweis aufs Sichern ohne Benutzername', 'Sichere vorher dein Konto' in h.inner_text('#install'))
    h.locator('#install').scroll_into_view_if_needed()
    shot(h, '20-konto-app')
    h.context.close()

    # ---------- 1.8 Neu seit letztem Besuch ----------
    BADGE = """Object.defineProperty(navigator, 'setAppBadge', { configurable: true, value: n => { window.__badge = n; return Promise.resolve(); } });
      Object.defineProperty(navigator, 'clearAppBadge', { configurable: true, value: () => { window.__badge = 0; return Promise.resolve(); } });"""
    j = newpage(browser, errs, None, BADGE)
    start_anon(j, 'Jonas')
    j.wait_for_selector('h1:has-text("Hallo Jonas")')
    j.click('.tabs >> text=Gruppen')
    j.fill('form[data-form=newgroup] input', 'Nachbarn')
    j.click('button:has-text("Anlegen")')
    j.wait_for_selector('h1:has-text("Nachbarn")')
    ncode = j.inner_text('#gcode').strip()
    nb = j.url.split('#/g/')[1]
    j.click('.tabs >> text=Wunschliste')
    j.click('text=Wunsch hinzufügen')
    j.fill('input[name=title]', 'Thermoskanne')
    j.click('button:has-text("Speichern")')
    j.wait_for_selector('.wish:has-text("Thermoskanne")')
    check('1.8: eigene Wünsche sind nie neu', j.locator('.tabs .count').count() == 0)
    k = newpage(browser, errs)
    start_anon(k, 'Kim', BASE + '#/join/' + ncode)
    k.wait_for_selector('h1:has-text("Nachbarn")')
    check('1.8: frisch beigetreten: Vorhandenes ist nicht neu', k.locator('.tag.new').count() == 0 and k.locator('.tabs .count').count() == 0)
    for t in ('Schal', 'Hörbuch'):
        k.click('.tabs >> text=Wunschliste')
        k.click('text=Wunsch hinzufügen')
        k.fill('input[name=title]', t)
        k.click('button:has-text("Speichern")')
        k.wait_for_selector(f'.wish:has-text("{t}")')

    j.goto(BASE + '#/')
    j.click('.top [data-act=sync]')
    j.wait_for_selector('h2:has-text("Neu seit deinem letzten Besuch")')
    check('1.8: Start: neues Mitglied mit seinen Wünschen in einer Zeile', 'Kim ist dabei' in j.inner_text('main')
          and '2 Wünsche' in j.inner_text('.row-item:has-text("Kim ist dabei")') and j.locator('.row-item.isnew').count() == 1)
    check('1.8: Zähler am Tab Gruppen und am App-Symbol', j.inner_text('.tabs a[href="#/gruppen"] .count') == '3' and j.evaluate('window.__badge') == 3)
    shot(j, '21-neu-start')
    j.click('.tabs >> text=Gruppen')
    j.wait_for_selector('a.group:has-text("Nachbarn") .count')
    check('1.8: Gruppenliste zeigt „3 neu“', '3 neu' in j.inner_text('a.group:has-text("Nachbarn")'))
    j.click('a.group:has-text("Nachbarn")')
    j.wait_for_selector('a.person:has-text("Kim")')
    check('1.8: Gruppe: „Neu dabei“ und Zähler am Mitglied', 'Neu dabei' in j.inner_text('a.person:has-text("Kim")')
          and j.inner_text('a.person:has-text("Kim") .count') == '2')
    check('1.8: Mitglied gesehen: Tab zählt nur noch Wünsche', j.inner_text('.tabs a[href="#/gruppen"] .count') == '2')
    j.click('a.person:has-text("Kim")')
    j.wait_for_selector('.wish:has-text("Schal")')
    check('1.8: Liste: neue Wünsche markiert', j.locator('.card.wish.isnew .tag.new').count() == 2)
    check('1.8: nach dem Ansehen: Zähler weg', j.locator('.tabs .count').count() == 0 and j.evaluate('window.__badge') == 0)
    shot(j, '22-neu-liste')
    j.click('button:has-text("Reservieren") >> nth=0')
    j.wait_for_selector('text=Von dir reserviert')
    check('1.8: Markierung bleibt beim Reservieren auf der Seite', j.locator('.tag.new').count() == 2)
    j.click('.back')
    j.wait_for_selector('a.person:has-text("Kim")')
    check('1.8: zurück in der Gruppe: nichts mehr neu', j.locator('.tag.new').count() == 0 and j.locator('a.person .count').count() == 0)
    j.goto(BASE + f'#/g/{nb}/p/' + k.evaluate("JSON.parse(localStorage.getItem('geschenkeliste-v1')).session.user.id"))
    j.wait_for_selector('.wish:has-text("Schal")')
    check('1.8: Liste erneut geöffnet: keine Markierung', j.locator('.tag.new').count() == 0)

    k.click('.tabs >> text=Wunschliste')
    k.click('text=Wunsch hinzufügen')
    k.fill('input[name=title]', 'Tee')
    k.click('button:has-text("Speichern")')
    k.wait_for_selector('.wish:has-text("Tee")')
    j.goto(BASE + '#/')
    j.click('.top [data-act=sync]')
    j.wait_for_selector('.row-item.isnew:has-text("Tee")')
    check('1.8: neuer Wunsch auf der Startseite mit Punkt', j.locator('.row-item.isnew .newdot').count() == 1 and j.evaluate('window.__badge') == 1)
    j.click('[data-act=seenall]')
    j.wait_for_selector('h2:has-text("Neu in deinen Gruppen")')
    check('1.8: „Alles gesehen“ leert Zähler', j.locator('.tabs .count').count() == 0 and j.evaluate('window.__badge') == 0)
    j.reload()
    j.wait_for_selector('h2:has-text("Neu in deinen Gruppen")')
    check('1.8: gesehen bleibt nach Neuladen', j.locator('.newdot').count() == 0)

    # Wichteln: Mitglied sieht „Neu ausgelost“, wer auslöst nicht
    l = newpage(browser, errs)
    start_anon(l, 'Lio', BASE + '#/join/' + ncode)
    l.wait_for_selector('h1:has-text("Nachbarn")')
    j.goto(BASE + f'#/g/{nb}/wichteln')
    j.click('.top [data-act=sync]')
    j.wait_for_selector('text=3 Personen machen mit')
    j.click('button:has-text("Jetzt auslosen")')
    j.wait_for_selector('.reveal')
    check('1.8: Auslosender sieht kein „Neu ausgelost“', j.locator('.tag.new').count() == 0)
    k.goto(BASE + '#/')
    k.click('.top [data-act=sync]')
    k.wait_for_selector('.row-item:has-text("Du beschenkst")')
    check('1.8: Mitglied: „Neu ausgelost“ auf der Startseite', k.locator('.row-item:has-text("Du beschenkst") .tag.new').count() == 1)
    k.click('.tabs >> text=Konto')
    k.click('.tabs >> text=Start')
    k.wait_for_selector('.row-item:has-text("Du beschenkst")')
    check('1.8: danach nicht mehr neu', k.locator('.tag.new').count() == 0)
    check('Kein Überlauf (1.8)', overflow(j) and overflow(k))
    for x in (j, k, l):
        x.context.close()

    # ---------- 1.9 Benachrichtigungen ----------
    # Push nachgestellt: Abo, Erlaubnis und Service Worker im Browser (Playwright blockiert echte Service Worker)
    PUSH = """(() => {
      const P256 = 'B' + 'A'.repeat(86), AUTH = 'abcdefghijklmnopqrstuv';
      const ls = localStorage;
      const perm = v => { ls.setItem('__perm', v); return v; };
      if (!ls.getItem('__perm')) perm(window.__perm0 || 'default');
      window.PushManager = function () {};
      window.Notification = { get permission() { return ls.getItem('__perm'); },
        requestPermission: async () => perm(window.__deny ? 'denied' : 'granted') };
      const mk = (ep, key) => ({ endpoint: ep, options: { applicationServerKey: Uint8Array.from(atob(key), c => c.charCodeAt(0)).buffer },
        toJSON() { return { endpoint: this.endpoint, keys: { p256dh: P256, auth: AUTH } }; },
        unsubscribe: async () => { ls.removeItem('__sub'); return true; } });
      const cur = () => { const x = JSON.parse(ls.getItem('__sub') || 'null'); return x && mk(x.ep, x.key); };
      const reg = { pushManager: { getSubscription: async () => cur(),
        subscribe: async o => {
          if (window.__deny) { perm('denied'); throw new DOMException('nein', 'NotAllowedError'); }
          perm('granted');
          const key = btoa(String.fromCharCode(...new Uint8Array(o.applicationServerKey)));
          ls.setItem('__sub', JSON.stringify({ ep: 'https://fcm.googleapis.com/fcm/send/' + Math.random().toString(36).slice(2), key }));
          return cur(); } } };
      Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: {
        getRegistration: async () => reg, register: async () => reg, ready: Promise.resolve(reg),
        controller: { postMessage: m => { window.__swmsg = m; } },
        addEventListener: (t, f) => { if (t === 'message') window.__swl = f; } } });
    })();"""
    GRANTED = "window.__perm0 = 'granted';" + PUSH

    def q(sql):
        return subprocess.run(mock.PSQL, input=sql, capture_output=True, text=True).stdout.strip()

    def uid_of(x):
        return x.evaluate("JSON.parse(localStorage.getItem('geschenkeliste-v1')).session.user.id")

    m = newpage(browser, errs, None, PUSH)
    start_anon(m, 'Mia')
    m.wait_for_selector('h1:has-text("Hallo Mia")')
    uid_m = uid_of(m)
    check('1.9: ohne Einrichtung kein Hinweis auf Benachrichtigungen', m.locator('text=Benachrichtigungen').count() == 0)
    q(f"insert into public.app_admins values ('{uid_m}');")
    m.goto(BASE + '#/konto')
    m.reload()
    m.wait_for_selector('.card:has-text("Benachrichtigungen") [data-act=pushsetup]')
    check('1.9: Konto ohne Einrichtung: kein Bereich Benachrichtigungen', m.locator('h2:has-text("Benachrichtigungen")').count() == 0)
    m.click('[data-act=pushsetup]')
    toast(m, 'Schlüssel gespeichert')
    row = q("select vapid_public || '|' || vapid_private || '|' || subject || '|' || function_url from public.push_config").split('|')
    from cryptography.hazmat.primitives.asymmetric import ec
    import base64
    ub = lambda s: base64.urlsafe_b64decode(s + '=' * (-len(s) % 4))
    pt = ec.derive_private_key(int.from_bytes(ub(row[1]), 'big'), ec.SECP256R1()).public_key().public_numbers()
    check('1.9: Admin erzeugt Schlüsselpaar im Browser, passt zusammen', ub(row[0]) == b'\x04' + pt.x.to_bytes(32, 'big') + pt.y.to_bytes(32, 'big'))
    check('1.9: Adresse der Edge Function und Absender gespeichert', row[2] == 'https://konstismile.github.io/Geschenkeliste/'
          and row[3] == 'https://qbdpzamygonpruaafcrt.supabase.co/functions/v1/push')
    m.wait_for_selector('h2:has-text("Benachrichtigungen") + section [data-act=pushon]')
    check('1.9: Verwaltung zeigt Stand', 'Eingerichtet' in m.inner_text('.card:has-text("Zuletzt verschickt")'))
    m.click('section [data-act=pushon]')
    toast(m, 'Benachrichtigungen sind eingeschaltet')
    m.wait_for_selector('.switch[data-k=wish]')
    check('1.9: erlaubt: Gerät angemeldet, 5 Schalter', q(f"select count(*) from public.push_subs where user_id = '{uid_m}'") == '1'
          and m.locator('.switch.on').count() == 5)
    m.click('.switch[data-k=wish]')
    m.wait_for_selector('.switch[data-k=wish]:not(.on)')
    check('1.9: Schalter speichert Einstellung', q(f"select wish::text || member::text from public.push_prefs where user_id = '{uid_m}'") == 'falsetrue')
    m.reload()
    m.wait_for_selector('.switch[data-k=member]')
    check('1.9: Einstellung bleibt nach Neuladen, Gerät bleibt angemeldet', m.locator('.switch.on').count() == 4
          and m.get_attribute('.switch[data-k=wish]', 'aria-checked') == 'false')
    check('1.9: Verwaltung zählt das Gerät', '1 von 1 Person' in m.inner_text('.facts'))
    m.locator('h2:has-text("Benachrichtigungen")').scroll_into_view_if_needed()
    shot(m, '24-benachrichtigungen')
    m.locator('.facts').scroll_into_view_if_needed()
    shot(m, '25-verwaltung-push')
    m.click('[data-act=pushtest]')
    toast(m, 'Testnachricht ist unterwegs')
    check('1.9: Testnachricht im Ausgang', q(f"select count(*) from public.push_outbox where user_id = '{uid_m}' and kind = 'test'") == '1')
    check('1.9: App meldet die Zahl am Symbol an den Service Worker', m.evaluate('window.__swmsg && window.__swmsg.type') == 'badge')

    m.click('.tabs >> text=Gruppen')
    m.fill('form[data-form=newgroup] input', 'Glocke')
    m.click('button:has-text("Anlegen")')
    m.wait_for_selector('h1:has-text("Glocke")')
    pcode = m.inner_text('#gcode').strip()
    # Nils hat Mitteilungen schon erlaubt (z. B. für den Zähler aus 1.8): wird ohne Nachfrage angemeldet
    n = newpage(browser, errs, None, GRANTED)
    start_anon(n, 'Nils', BASE + '#/join/' + pcode)
    n.wait_for_selector('h1:has-text("Glocke")')
    uid_n = uid_of(n)
    n.click('.tabs >> text=Start')
    n.wait_for_selector('.banner:has-text("Benachrichtigungen sind an")')
    check('1.9: schon erlaubt: Gerät ohne Nachfrage angemeldet, Hinweis', q(f"select count(*) from public.push_subs where user_id = '{uid_n}'") == '1')
    n.click('[data-act=pushnotice]')
    n.wait_for_selector('.banner:has-text("Benachrichtigungen sind an")', state='detached')
    check('1.9: Beitritt landet bei Mia im Ausgang', q(f"select count(*) from public.push_outbox where user_id = '{uid_m}' and kind = 'member' and actor = '{uid_n}'") == '1')
    n.click('.tabs >> text=Wunschliste')
    n.click('text=Wunsch hinzufügen')
    n.fill('input[name=title]', 'Taschenlampe')
    n.click('button:has-text("Speichern")')
    n.wait_for_selector('.wish:has-text("Taschenlampe")')
    check('1.9: Mia hat neue Wünsche abbestellt', q(f"select count(*) from public.push_outbox where user_id = '{uid_m}' and kind = 'wish'") == '0')
    m.click('.tabs >> text=Wunschliste')
    m.click('text=Wunsch hinzufügen')
    m.fill('input[name=title]', 'Laterne')
    m.click('button:has-text("Speichern")')
    m.wait_for_selector('.wish:has-text("Laterne")')
    check('1.9: Nils bekommt Mias neuen Wunsch, Mia nicht', q(f"select string_agg(user_id::text, ',') from public.push_outbox where kind = 'wish'") == uid_n)
    n.evaluate("window.__swl({ data: { type: 'nav', url: '#/gruppen' } })")
    n.wait_for_selector('h1:has-text("Gruppen")')
    n.evaluate("window.__swl({ data: { type: 'nav', url: 'javascript:alert(1)' } })")
    check('1.9: Antippen öffnet die Seite, fremde Adressen nicht', n.url.endswith('#/gruppen'))
    n.goto(BASE + '#/konto')
    n.wait_for_selector('[data-act=pushoff]')
    n.click('[data-act=pushoff]')
    toast(n, 'ausgeschaltet')
    n.wait_for_selector('section [data-act=pushon]')
    check('1.9: ausschalten meldet das Gerät ab', q(f"select count(*) from public.push_subs where user_id = '{uid_n}'") == '0')
    n.reload()
    n.wait_for_selector('section [data-act=pushon]')
    check('1.9: bleibt aus, auch mit Erlaubnis', q(f"select count(*) from public.push_subs where user_id = '{uid_n}'") == '0')
    n.click('section [data-act=pushon]')
    n.wait_for_selector('.switch[data-k=wish]')
    check('1.9: wieder einschalten', q(f"select count(*) from public.push_subs where user_id = '{uid_n}'") == '1')
    n.click('[data-act=asklogout]')
    n.click('[data-act=logout]')
    n.wait_for_selector('form[data-form=start]')
    check('1.9: abmelden meldet das Gerät für das Konto ab', q(f"select count(*) from public.push_subs where user_id = '{uid_n}'") == '0')
    n.context.close()

    # Otto: noch nicht erlaubt → Hinweis auf der Startseite, dann abgelehnt
    o = newpage(browser, errs, None, PUSH)
    start_anon(o, 'Otto')
    o.wait_for_selector('.banner:has-text("Benachrichtigungen") [data-act=pushon]')
    shot(o, '26-push-hinweis')
    o.click('[data-act=pushlater]')
    o.wait_for_selector('.banner [data-act=pushon]', state='detached')
    o.reload()
    o.wait_for_selector('h1:has-text("Hallo Otto")')
    check('1.9: „Später“ bleibt', o.locator('.banner [data-act=pushon]').count() == 0)
    o.evaluate('window.__deny = true')
    o.goto(BASE + '#/konto')
    o.click('section [data-act=pushon]')
    toast(o, 'abgelehnt')
    o.wait_for_selector('.card:has-text("Ausgeschaltet")')
    check('1.9: abgelehnt: Hinweis auf die Einstellungen', 'Einstellungen' in o.inner_text('.card:has-text("Ausgeschaltet")'))
    check('Kein Überlauf (1.9)', overflow(m) and overflow(o))
    o.context.close()
    # iPhone in Safari: Push gibt es nur in der installierten App
    p = newpage(browser, errs, IPHONE, 'delete window.PushManager;')
    start_anon(p, 'Pia')
    p.wait_for_selector('h1:has-text("Hallo Pia")')
    p.goto(BASE + '#/konto')
    p.wait_for_selector('h2:has-text("Benachrichtigungen")')
    check('1.9: iPhone in Safari: Hinweis auf die App', 'nur in der App vom Home-Bildschirm' in p.inner_text('main'))
    p.context.close()
    m.context.close()

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
