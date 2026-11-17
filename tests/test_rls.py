"""Prüft die Zugriffsregeln aus supabase/schema.sql gegen ein lokales Postgres.

Aufruf: python3 tests/test_rls.py   (Postgres auf Socket /tmp, Port 5544, Datenbank gl)
"""
import json, subprocess, sys, uuid

PSQL = ['psql', '-h', '/tmp', '-p', '5544', '-U', 'postgres', '-d', 'gl', '-tAq', '-v', 'ON_ERROR_STOP=1']
fails = 0


def run(sql):
    p = subprocess.run(PSQL, input=sql, capture_output=True, text=True)
    return p.returncode, p.stdout.strip(), p.stderr.strip()


def as_user(uid, sql, role='authenticated'):
    """Führt sql als Nutzer aus und liefert (ok, json-ergebnis | fehlertext)."""
    pre = f"begin; set local role {role}; set local request.jwt.claim.sub = '{uid or ''}';\n"
    code, out, err = run(pre + f"with t as ({sql}) select coalesce(json_agg(t), '[]') from t;\ncommit;")
    if code:
        return False, err
    return True, json.loads(out)


def as_exec(uid, sql):
    pre = f"begin; set local role authenticated; set local request.jwt.claim.sub = '{uid}';\n"
    code, out, err = run(pre + sql + ";\ncommit;")
    return code == 0, (err or out)


def check(name, cond):
    global fails
    print(('ok   ' if cond else 'FAIL ') + name)
    if not cond:
        fails += 1


A, B, C, D = (str(uuid.uuid4()) for _ in range(4))
run('truncate auth.users, public.login_attempts cascade;')
for u, n in ((A, 'Anna'), (B, 'Ben'), (C, 'Clara'), (D, 'Dora')):
    run(f"insert into auth.users values ('{u}', '{n.lower()}@x.de');")
    ok, _ = as_exec(u, f"insert into public.profiles (id, name) values ('{u}', '{n}')")
    check(f'Profil {n} anlegen', ok)

ok, r = as_user(A, "select * from public.create_group('Familie')")
fam = r[0]; check('Gruppe anlegen', ok and len(fam['code']) == 8)
code = fam['code'].lower()
ok, r = as_user(B, f"select public.join_group('{code[:4]}-{code[4:]}') as g")
check('Beitreten mit Kleinbuchstaben und Strich', ok and r[0]['g'] == fam['id'])
ok, r = as_user(C, "select * from public.create_group('Freunde')")
fr = r[0]
ok, _ = as_user(A, f"select public.join_group('{fr['code']}') as g")
check('Anna tritt Freunde bei', ok)
ok, r = as_user(D, "select * from public.create_group('Doras')")
dg = r[0]

ok, r = as_user(A, "insert into public.wishes (title, url) values ('Buch', 'https://example.org') returning id")
w1 = r[0]['id']
ok, r = as_user(A, "insert into public.wishes (title, all_groups) values ('Konzertkarte', false) returning id")
w2 = r[0]['id']
ok, _ = as_exec(A, f"insert into public.wish_groups values ('{w2}', '{fr['id']}')")
check('Freigabe nur für Freunde', ok)
ok, _ = as_exec(A, f"insert into public.wish_groups values ('{w2}', '{dg['id']}')")
check('Freigabe für fremde Gruppe verboten', not ok)
ok, _ = as_user(A, "insert into public.wishes (title, owner) values ('X', gen_random_uuid()) returning id")
check('Wunsch für andere anlegen verboten', not ok)
ok, _ = as_user(A, "insert into public.wishes (title, url) values ('X', 'javascript:alert(1)') returning id")
check('Nur http(s)-Links', not ok)


def seen(u):
    ok, r = as_user(u, 'select id from public.wishes')
    return {x['id'] for x in r}


check('Ben sieht nur Buch', seen(B) == {w1})
check('Clara sieht Buch und Konzertkarte', seen(C) == {w1, w2})
check('Dora sieht nichts', seen(D) == set())
check('Anna sieht beide eigenen', seen(A) == {w1, w2})

ok, _ = as_exec(B, f"insert into public.reservations (wish_id) values ('{w1}')")
check('Ben reserviert Buch', ok)
ok, r = as_user(A, 'select * from public.reservations')
check('Anna sieht keine Reservierung', ok and r == [])
ok, r = as_user(C, 'select * from public.reservations')
check('Clara sieht Bens Reservierung', ok and len(r) == 1 and r[0]['user_id'] == B)
ok, _ = as_exec(A, f"insert into public.reservations (wish_id) values ('{w2}')")
check('Anna kann eigenen Wunsch nicht reservieren', not ok)
ok, _ = as_exec(B, f"insert into public.reservations (wish_id) values ('{w2}')")
check('Ben kann unsichtbaren Wunsch nicht reservieren', not ok)
ok, _ = as_exec(C, f"insert into public.reservations (wish_id) values ('{w1}')")
check('Doppelt reservieren geht nicht', not ok)
ok, _ = as_exec(C, f"update public.reservations set status = 'gekauft' where wish_id = '{w1}'")
ok2, r = as_user(B, 'select status from public.reservations')
check('Clara kann Bens Reservierung nicht ändern', r[0]['status'] == 'reserviert')
ok, _ = as_exec(B, f"update public.reservations set status = 'gekauft' where wish_id = '{w1}'")
ok2, r = as_user(B, 'select status from public.reservations')
check('Ben markiert gekauft', r[0]['status'] == 'gekauft')
ok, _ = as_exec(B, f"update public.reservations set user_id = '{C}' where wish_id = '{w1}'")
check('Ben kann Reservierung nicht auf Clara umschreiben', not ok)
ok, r = as_user(A, f"select count(*) as n from public.reservations where wish_id = '{w1}'")
check('Anna zählt 0 Reservierungen', r[0]['n'] == 0)

ok, _ = as_exec(B, f"update public.wishes set title = 'gehackt' where id = '{w1}'")
ok2, r = as_user(A, f"select title from public.wishes where id = '{w1}'")
check('Ben kann Annas Wunsch nicht ändern', r[0]['title'] == 'Buch')
ok, _ = as_exec(B, f"delete from public.wishes where id = '{w1}'")
check('Ben kann Annas Wunsch nicht löschen', w1 in seen(A))
ok, _ = as_exec(B, f"insert into public.wish_groups values ('{w2}', '{fam['id']}')")
check('Ben kann Annas Freigabe nicht ändern', not ok)

# ---------- Mehr am Wunsch (1.7) ----------
ok, r = as_user(A, "insert into public.wishes (title, price, category, priority) values ('Rad', 249.9, 'sport', 3) returning id, price, category, priority")
w3 = r[0]['id'] if ok else None
check('1.7: Preis, Kategorie, Wichtigkeit speichern', ok and float(r[0]['price']) == 249.9 and r[0]['priority'] == 3)
ok, r = as_user(A, "insert into public.wishes (title) values ('Schal') returning priority, price, category, have_at")
check('1.7: Standard Wichtigkeit 2, Rest leer', ok and r[0] == {'priority': 2, 'price': None, 'category': None, 'have_at': None})
for bad, what in (("price", "-1"), ("price", "2000000"), ("priority", "0"), ("priority", "4"), ("category", "'Bücher'"), ("category", "'x'")):
    ok, _ = as_user(A, f"insert into public.wishes (title, {bad}) values ('X', {what}) returning id")
    check(f'1.7: ungültig abgelehnt ({bad} = {what})', not ok)
ok, r = as_user(B, f"select price, category, priority, have_at from public.wishes where id = '{w3}'")
check('1.7: Ben sieht Preis und Kategorie', ok and len(r) == 1 and r[0]['category'] == 'sport')
ok, _ = as_exec(B, f"update public.wishes set have_at = now() where id = '{w3}'")
ok2, r = as_user(A, f"select have_at from public.wishes where id = '{w3}'")
check('1.7: Ben kann „Hab ich schon“ nicht setzen', r[0]['have_at'] is None)
ok, _ = as_exec(C, f"insert into public.reservations (wish_id) values ('{w3}')")
check('1.7: Clara reserviert Rad', ok)
ok, _ = as_exec(A, f"update public.wishes set have_at = now() where id = '{w3}'")
ok2, r = as_user(B, f"select have_at from public.wishes where id = '{w3}'")
check('1.7: Anna setzt „Hab ich schon“, Ben sieht es', ok and r[0]['have_at'] is not None)
ok, r = as_user(C, f"select user_id from public.reservations where wish_id = '{w3}'")
check('1.7: Claras Reservierung bleibt bestehen', ok and len(r) == 1)
ok, _ = as_exec(C, f"update public.reservations set status = 'gekauft' where wish_id = '{w3}'")
check('1.7: Clara kann Status trotzdem ändern', ok)
ok, _ = as_exec(C, f"delete from public.reservations where wish_id = '{w3}'")
check('1.7: Clara kann freigeben', ok)
ok, _ = as_exec(C, f"insert into public.reservations (wish_id) values ('{w3}')")
check('1.7: „Hab ich schon“ kann nicht neu reserviert werden', not ok)
ok, _ = as_exec(A, f"update public.wishes set have_at = null where id = '{w3}'")
ok2, _ = as_exec(C, f"insert into public.reservations (wish_id) values ('{w3}')")
check('1.7: wieder gewünscht, wieder reservierbar', ok and ok2)
ok, r = as_user(A, f"select count(*) as n from public.reservations where wish_id = '{w3}'")
check('1.7: Anna sieht weiter keine Reservierung', r[0]['n'] == 0)
ok, _ = as_user(None, "select public.wish_open(gen_random_uuid()) as x", role='anon')
check('1.7: wish_open ohne Anmeldung nicht aufrufbar', not ok)

ok, r = as_user(B, 'select name from public.profiles order by name')
check('Ben sieht Namen Anna und Ben', [x['name'] for x in r] == ['Anna', 'Ben'])
ok, r = as_user(D, 'select * from public.groups')
check('Dora sieht nur eigene Gruppe', [x['id'] for x in r] == [dg['id']])
ok, r = as_user(D, 'select * from public.members')
check('Dora sieht nur eigene Mitglieder', {x['user_id'] for x in r} == {D})
ok, _ = as_user(D, "select public.join_group('FALSCH12') as g")
check('Falscher Code', not ok)
ok, _ = as_exec(B, "insert into public.groups (name, code) values ('x', 'ABCDEFGH')")
check('Gruppe direkt anlegen verboten', not ok)
ok, _ = as_exec(B, f"insert into public.members values ('{fr['id']}', '{B}')")
check('Mitglied direkt eintragen verboten', not ok)
ok, _ = as_user(None, 'select * from public.wishes', role='anon')
check('Ohne Anmeldung kein Zugriff', not ok)
ok, _ = as_user(None, "select public.join_group('x') as g", role='anon')
check('Ohne Anmeldung kein Beitreten', not ok)

ok, _ = as_user(A, f"select public.leave_group('{fr['id']}') as x")
check('Anna verlässt Freunde', ok)
check('Clara sieht danach nichts mehr von Anna', seen(C) == set())
ok, r = as_user(A, 'select * from public.wish_groups')
check('Freigabe für Freunde entfernt', r == [])
ok, _ = as_user(D, f"select public.leave_group('{dg['id']}') as x")
code_, out, _ = run(f"select count(*) from public.groups where id = '{dg['id']}'")
check('Leere Gruppe wird gelöscht', out == '0')

# ---------- Konto ohne Mail (1.5) ----------
MAIL = '@nutzer.geschenkeliste.invalid'


def rpc(uid, sql, role='authenticated'):
    ok, r = as_user(uid, f'select {sql} as r', role=role)
    return ok, (r[0]['r'] if ok else r)


def pw_ok(uid, pw):
    _, out, _ = run(f"select encrypted_password = extensions.crypt('{pw}', encrypted_password) from auth.users where id = '{uid}'")
    return out == 't'


def recover(user, code, pw, uid=None):
    return rpc(uid, f"public.recover_account('{user}', '{code}', '{pw}')", role='authenticated' if uid else 'anon')[1]


ok, code_a = rpc(A, "public.secure_account(' Anna ', 'geheim123')")
check('Anna sichert Konto, Code 16 Zeichen ohne 0 O 1 I L', ok and len(code_a) == 16 and not set(code_a) & set('0O1IL'))
_, out, _ = run(f"select email || '|' || (email_confirmed_at is not null) || '|' || is_anonymous from auth.users where id = '{A}'")
check('Platzhalter-Mail bestätigt, nicht anonym', out == f'anna{MAIL}|true|false')
check('Passwort als bcrypt gespeichert', pw_ok(A, 'geheim123'))
_, out, _ = run(f"select count(*) from auth.identities where user_id = '{A}' and provider = 'email'")
check('Identität für Anmeldung angelegt', out == '1')
ok, _ = rpc(A, "public.secure_account('anna2', 'geheim123')")
check('Zweites Sichern verboten', not ok)
ok, err = rpc(B, "public.secure_account('ANNA', 'geheim123')")
check('Benutzername vergeben (Groß/klein egal)', not ok and 'vergeben' in err)
ok, err = rpc(B, "public.secure_account('b', 'geheim123')")
check('Benutzername zu kurz', not ok and 'ungültig' in err)
ok, err = rpc(B, "public.secure_account('ben mit leer', 'geheim123')")
check('Benutzername mit Leerzeichen', not ok and 'ungültig' in err)
ok, err = rpc(B, "public.secure_account('ben', 'kurz')")
check('Passwort zu kurz', not ok and 'zu kurz' in err)
ok, code_b = rpc(B, "public.secure_account('ben', 'bengeheim1')")
check('Ben sichert Konto', ok)

ok, r = as_user(A, 'select username from public.accounts')
check('Anna sieht nur eigenes Konto', ok and [x['username'] for x in r] == ['anna'])
ok, _ = as_exec(A, "update public.accounts set username = 'x' where user_id = auth.uid()")
check('Benutzername nicht direkt änderbar', not ok)
for t in ('recovery_codes', 'reset_codes', 'login_attempts', 'app_admins'):
    ok, _ = as_user(A, f'select * from public.{t}')
    check(f'{t} nicht lesbar', not ok)
ok, _ = as_exec(A, f"insert into public.app_admins values ('{A}')")
check('app_admins nicht beschreibbar', not ok)
ok, _ = as_user(None, 'select * from public.accounts', role='anon')
check('accounts ohne Anmeldung nicht lesbar', not ok)
ok, _ = rpc(None, "public.secure_account('x1x', 'geheim123')", role='anon')
check('Sichern ohne Anmeldung verboten', not ok)
ok, _ = rpc(None, "public.set_password('" + A + "', 'gehackt123')", role='anon')
ok2, _ = rpc(A, "public.set_password('" + B + "', 'gehackt123')")
check('Interne Funktionen nicht aufrufbar', not ok and not ok2 and pw_ok(B, 'bengeheim1'))

# Passwort vergessen
r = recover('anna', 'FALSCHFALSCHFALS', 'neuespw123')
check('Falscher Code: noch 4 Versuche', r == {'ok': False, 'error': 'falsch', 'left': 4})
r = recover('niemand', code_a, 'neuespw123')
check('Unbekannter Name: gleiche Antwort', r['error'] == 'falsch')
r = recover('anna', code_a, 'kurz')
check('Neues Passwort zu kurz', r['error'] == 'passwort')
for _ in range(3):
    r = recover('anna', 'FALSCHFALSCHFALS', 'neuespw123')
check('Vierter Fehler: noch 1 Versuch', r.get('left') == 1)
r = recover('anna', 'FALSCHFALSCHFALS', 'neuespw123')
check('Fünfter Fehler: gesperrt', r['error'] == 'gesperrt' and r.get('until'))
r = recover('anna', code_a, 'neuespw123')
check('Richtiger Code während Sperre abgelehnt', r['error'] == 'gesperrt' and pw_ok(A, 'geheim123'))
run("update public.login_attempts set locked_until = now() - interval '1 minute' where username = 'anna'")
fmt = '-'.join(code_a[i:i + 4] for i in range(0, 16, 4)).lower()
r = recover('Anna', fmt, 'neuespw123')
check('Nach der Sperre: Code mit Strichen und klein klappt', r['ok'] and len(r['code']) == 16 and r['code'] != code_a)
check('Neues Passwort gesetzt', pw_ok(A, 'neuespw123'))
code_a2 = r['code']
r = recover('anna', code_a, 'nochmal1234')
check('Alter Code danach ungültig', r['error'] == 'falsch')
ok, r = as_user(A, 'select reset_notice from public.accounts')
check('Kein Rücksetz-Hinweis bei eigenem Code', r[0]['reset_notice'] is False)
ok, code_a3 = rpc(A, 'public.new_recovery_code()')
r = recover('anna', code_a2, 'nochmal1234')
check('Neuer Code erzeugt, vorheriger ungültig', ok and r['error'] == 'falsch')
ok, _ = rpc(C, 'public.new_recovery_code()')
check('Neuer Code ohne gesichertes Konto verboten', not ok)

# Admin
ok, r = rpc(A, 'public.is_app_admin()')
check('Anna ist kein Admin', ok and r is False)
ok, _ = rpc(A, "public.admin_find_users('ben')")
ok2, _ = rpc(A, f"public.admin_reset('{B}')")
check('Nicht-Admin kann nicht suchen und nicht zurücksetzen', not ok and not ok2)
run(f"insert into public.app_admins values ('{D}')")
ok, r = rpc(D, 'public.is_app_admin()')
check('Dora ist Admin', ok and r is True)
ok, hits = rpc(D, "public.admin_find_users('BE')")
check('Admin findet Ben', ok and [h['username'] for h in hits] == ['ben'] and hits[0]['name'] == 'Ben')
ok, hits = rpc(D, "public.admin_find_users('%')")
check('Prozentzeichen wird wörtlich gesucht', ok and hits == [])
for _ in range(5):
    recover('ben', 'FALSCHFALSCHFALS', 'xxxxxxxx1')
ok, rs = rpc(D, f"public.admin_reset('{B}')")
check('Admin erzeugt Rücksetz-Code', ok and len(rs['code']) == 16 and rs['username'] == 'ben')
ok, hits = rpc(D, "public.admin_find_users('ben')")
check('Suche zeigt offenen Rücksetz-Code', hits[0]['reset_open'] is True)
ok, _ = rpc(D, f"public.admin_reset('{C}')")
check('Konto ohne Benutzername nicht zurücksetzbar', not ok)
r = recover('ben', rs['code'], 'benneu12345')
check('Rücksetz-Code hebt Sperre auf und setzt Passwort', r['ok'] and pw_ok(B, 'benneu12345'))
ok, r2 = as_user(B, 'select reset_notice, reset_at from public.accounts')
check('Ben bekommt Rücksetz-Hinweis', r2[0]['reset_notice'] is True and r2[0]['reset_at'])
r = recover('ben', rs['code'], 'benneu99999')
check('Rücksetz-Code nur einmal gültig', r['error'] == 'falsch')
ok, _ = rpc(B, 'public.dismiss_reset_notice()')
ok, r2 = as_user(B, 'select reset_notice from public.accounts')
check('Hinweis weggeklickt', r2[0]['reset_notice'] is False)
ok, rs = rpc(D, f"public.admin_reset('{B}')")
run(f"update public.reset_codes set expires_at = now() - interval '1 minute' where user_id = '{B}'")
r = recover('ben', rs['code'], 'benneu99999')
check('Abgelaufener Rücksetz-Code abgelehnt', r['error'] == 'falsch' and pw_ok(B, 'benneu12345'))

# ---------- Wichteln (1.6) ----------
E, F, G = (str(uuid.uuid4()) for _ in range(3))
for u, n in ((E, 'Emil'), (F, 'Finn'), (G, 'Gina')):
    run(f"insert into auth.users (id, email) values ('{u}', '{n.lower()}@x.de');")
    as_exec(u, f"insert into public.profiles (id, name) values ('{u}', '{n}')")
ok, r = as_user(A, "select * from public.create_group('Wichtel')")
wg = r[0]['id']
for u in (B, C, D, E):
    as_user(u, f"select public.join_group('{r[0]['code']}') as g")


def pairs_of(u):
    ok, r = as_user(u, f"select giver, receiver from public.wichtel_pairs where group_id = '{wg}'")
    return r


def all_pairs():
    _, out, _ = run(f"select giver || '>' || receiver from public.wichtel_pairs where group_id = '{wg}'")
    return dict(x.split('>') for x in out.splitlines())


ok, _ = rpc(B, f"public.wichtel_draw('{wg}')")
check('Wichteln: nur der Gründer lost aus', not ok)
ok, _ = rpc(B, f"public.wichtel_set_exclusion('{wg}', '{A}', '{C}', true)")
check('Wichteln: nur der Gründer trägt Ausschlüsse ein', not ok)
ok, _ = rpc(B, f"public.wichtel_set_participant('{wg}', '{C}', false)")
check('Wichteln: nur der Gründer ändert Teilnahme', not ok)
ok, _ = as_exec(A, f"insert into public.wichtel_pairs values ('{wg}', '{A}', '{B}')")
ok2, _ = as_exec(A, f"insert into public.wichtel_exclusions (group_id, a, b) values ('{wg}', '{min(A, B)}', '{max(A, B)}')")
ok3, _ = as_exec(A, f"insert into public.wichtel_draws (group_id, participants) values ('{wg}', '{{}}')")
check('Wichteln: Tabellen nicht direkt beschreibbar', not ok and not ok2 and not ok3)
ok, _ = rpc(A, f"public.wichtel_set_exclusion('{wg}', '{A}', '{A}', true)")
check('Wichteln: Ausschluss mit sich selbst abgelehnt', not ok)
ok, _ = rpc(A, f"public.wichtel_set_exclusion('{wg}', '{A}', '{F}', true)")
check('Wichteln: Ausschluss mit Nicht-Mitglied abgelehnt', not ok)
ok, _ = rpc(A, f"public.wichtel_set_exclusion('{wg}', '{C}', '{B}', true)")
ok2, _ = rpc(A, f"public.wichtel_set_exclusion('{wg}', '{B}', '{C}', true)")
ok3, _ = rpc(A, f"public.wichtel_set_exclusion('{wg}', '{D}', '{E}', true)")
ok4, r = as_user(A, f"select a, b from public.wichtel_exclusions where group_id = '{wg}'")
check('Wichteln: Ausschlüsse gespeichert, doppelt zählt einmal', ok and ok2 and ok3 and len(r) == 2)
ok, r = as_user(B, f"select * from public.wichtel_exclusions where group_id = '{wg}'")
check('Wichteln: Mitglieder sehen Ausschlüsse nicht', ok and r == [])

for i in range(25):
    ok, res = rpc(A, f"public.wichtel_draw('{wg}')")
    if not ok:
        break
    m = all_pairs()
    good = (set(m) == {A, B, C, D, E} and set(m.values()) == {A, B, C, D, E}
            and all(g != r for g, r in m.items())
            and m[B] != C and m[C] != B and m[D] != E and m[E] != D)
    if not good:
        break
check('Wichteln: 25 Auslosungen, alle ziehen genau einmal, nie sich selbst, Ausschlüsse beachtet', ok and good and res['count'] == 5)
m = all_pairs()
for u, n in ((A, 'Anna'), (B, 'Ben'), (E, 'Emil')):
    r = pairs_of(u)
    check(f'Wichteln: {n} sieht nur die eigene Zuteilung', len(r) == 1 and r[0]['giver'] == u and r[0]['receiver'] == m[u])
ok, r = as_user(F, f"select * from public.wichtel_pairs where group_id = '{wg}'")
check('Wichteln: Fremde sehen nichts', ok and r == [])
ok, r = as_user(B, f"select participants from public.wichtel_draws where group_id = '{wg}'")
check('Wichteln: Mitglieder sehen, dass ausgelost wurde', len(r) == 1 and len(r[0]['participants']) == 5)
ok, r = as_user(F, f"select * from public.wichtel_draws where group_id = '{wg}'")
check('Wichteln: Fremde sehen keine Auslosung', r == [])

seen_pairs = set()
for i in range(15):
    rpc(A, f"public.wichtel_draw('{wg}')")
    seen_pairs.add(tuple(sorted(all_pairs().items())))
check('Wichteln: neu auslosen ergibt verschiedene Zuteilungen', len(seen_pairs) > 3)

ok, _ = rpc(A, f"public.wichtel_set_participant('{wg}', '{E}', false)")
ok2, r = as_user(B, f"select user_id from public.wichtel_out where group_id = '{wg}'")
check('Wichteln: Emil macht nicht mit (für Mitglieder sichtbar)', ok and [x['user_id'] for x in r] == [E])
ok, res = rpc(A, f"public.wichtel_draw('{wg}')")
m = all_pairs()
check('Wichteln: ohne Emil ausgelost', ok and res['count'] == 4 and E not in m and E not in m.values())
check('Wichteln: Emil sieht keine Zuteilung', pairs_of(E) == [])

ok, _ = rpc(A, f"public.wichtel_set_exclusion('{wg}', '{A}', '{D}', true)")
ok, _ = rpc(A, f"public.wichtel_set_exclusion('{wg}', '{A}', '{B}', true)")
ok, _ = rpc(A, f"public.wichtel_set_exclusion('{wg}', '{A}', '{C}', true)")
before = all_pairs()
ok, err = rpc(A, f"public.wichtel_draw('{wg}')")
check('Wichteln: unmögliche Auslosung meldet Fehler', not ok and 'Keine Auslosung möglich' in err)
check('Wichteln: alte Zuteilung bleibt bei Fehler', all_pairs() == before)
rpc(A, f"public.wichtel_set_exclusion('{wg}', '{A}', '{B}', false)")
rpc(A, f"public.wichtel_set_exclusion('{wg}', '{A}', '{C}', false)")
rpc(A, f"public.wichtel_set_participant('{wg}', '{B}', false)")
rpc(A, f"public.wichtel_set_participant('{wg}', '{C}', false)")
ok, err = rpc(A, f"public.wichtel_draw('{wg}')")
check('Wichteln: weniger als 3 Teilnehmer abgelehnt', not ok and 'Zu wenige' in err)
for u in (B, C, E):
    rpc(A, f"public.wichtel_set_participant('{wg}', '{u}', true)")
rpc(A, f"public.wichtel_set_exclusion('{wg}', '{A}', '{D}', false)")
ok, _ = rpc(A, f"public.wichtel_draw('{wg}')")
m = all_pairs()
giver_of_c = next(g for g, r in m.items() if r == C)
ok, _ = as_user(C, f"select public.leave_group('{wg}') as x")
m2 = all_pairs()
check('Wichteln: wer austritt, verschwindet aus den Zuteilungen', C not in m2 and C not in m2.values() and giver_of_c not in m2)
_, out, _ = run(f"select count(*) from public.wichtel_exclusions where group_id = '{wg}' and '{C}' in (a, b)")
check('Wichteln: Ausschlüsse der Person entfernt', out == '0')
ok, _ = rpc(A, f"public.wichtel_cancel('{wg}')")
ok2, r = as_user(B, f"select * from public.wichtel_draws where group_id = '{wg}'")
check('Wichteln: Auslosung aufheben', ok and r == [] and all_pairs() == {})
ok, _ = as_user(A, f"select public.leave_group('{wg}') as x")
_, out, _ = run(f"select created_by from public.groups where id = '{wg}'")
check('Gründer tritt aus: am längsten dabei gebliebenes Mitglied übernimmt', out == B)
ok, _ = rpc(B, f"public.wichtel_set_participant('{wg}', '{D}', false)")
ok2, _ = rpc(A, f"public.wichtel_draw('{wg}')")
check('Neuer Gründer darf verwalten, alter nicht mehr', ok and not ok2)

print('\nAlle Tests grün' if not fails else f'\n{fails} Fehler')
sys.exit(1 if fails else 0)
