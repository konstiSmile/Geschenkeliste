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
run('truncate auth.users cascade;')
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

print('\nAlle Tests grün' if not fails else f'\n{fails} Fehler')
sys.exit(1 if fails else 0)
