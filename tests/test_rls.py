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

print('\nAlle Tests grün' if not fails else f'\n{fails} Fehler')
sys.exit(1 if fails else 0)
