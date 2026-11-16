"""Kleine Supabase-Attrappe für Playwright: Auth wird vorgetäuscht (Code 123456),
REST-Anfragen laufen als echtes SQL mit Zugriffsregeln gegen das lokale Postgres (Datenbank gl)."""
import json, subprocess, uuid
from urllib.parse import urlparse, parse_qs

PSQL = ['psql', '-h', '/tmp', '-p', '5544', '-U', 'postgres', '-d', 'gl', '-tAq', '-v', 'ON_ERROR_STOP=1']
CODE = '123456'
log = []
pending = {}    # uid -> neue Mail (wartet auf Bestätigung)
confirmed = {}  # uid -> bestätigte Mail


def lit(v):
    if v is None:
        return 'null'
    if isinstance(v, bool):
        return 'true' if v else 'false'
    if isinstance(v, (int, float)):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def ident(s):
    assert s.replace('_', '').isalnum(), s
    return s


def sql_as(uid, sql):
    pre = f"begin; set local role authenticated; set local request.jwt.claim.sub = '{uid}';\n"
    p = subprocess.run(PSQL, input=pre + f"with t as ({sql}) select coalesce(json_agg(t), '[]') from t;\ncommit;",
                       capture_output=True, text=True)
    if p.returncode:
        return None, p.stderr
    return json.loads(p.stdout), None


def uid_for(email):
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, email))


def session(email):
    u = uid_for(email)
    subprocess.run(PSQL, input=f"insert into auth.users values ('{u}', {lit(email)}) on conflict do nothing;", capture_output=True, text=True)
    return {'access_token': 'tok-' + u, 'refresh_token': 'ref-' + u, 'expires_in': 3600,
            'user': {'id': u, 'email': email}}


def where(q):
    conds = []
    for k, vs in q.items():
        if k in ('select', 'order', 'on_conflict'):
            continue
        op, val = vs[0].split('.', 1)
        assert op == 'eq', op
        conds.append(f'{ident(k)} = {lit(val)}')
    return (' where ' + ' and '.join(conds)) if conds else ''


def handle(route, request):
    u = urlparse(request.url)
    path, q = u.path, parse_qs(u.query)
    body = json.loads(request.post_data) if request.post_data else None
    log.append((request.method, path))

    def reply(status, data):
        route.fulfill(status=status, content_type='application/json',
                      headers={'access-control-allow-origin': '*'}, body=json.dumps(data))

    if request.method == 'OPTIONS':
        return route.fulfill(status=204, headers={'access-control-allow-origin': '*',
                                                  'access-control-allow-headers': '*',
                                                  'access-control-allow-methods': '*'})
    if path == '/auth/v1/otp':
        return reply(200, {})
    if path == '/auth/v1/verify':
        if body.get('token_hash') == 'hash-' + CODE:
            return reply(200, session('clara@x.de'))
        if body.get('token') != CODE:
            return reply(403, {'code': 403, 'error_code': 'otp_expired', 'msg': 'Token has expired or is invalid'})
        return reply(200, session(body['email']))
    if path == '/auth/v1/signup':
        u = str(uuid.uuid4())
        subprocess.run(PSQL, input=f"insert into auth.users values ('{u}', null);", capture_output=True, text=True)
        return reply(200, {'access_token': 'tok-' + u, 'refresh_token': 'ref-' + u, 'expires_in': 3600,
                           'user': {'id': u, 'email': '', 'is_anonymous': True}})
    if path == '/auth/v1/user':
        a = request.headers.get('authorization', '')
        u = a[len('Bearer tok-'):]
        if request.method == 'PUT':
            pending[u] = body['email']
            return reply(200, {'id': u, 'email': '', 'new_email': body['email'], 'is_anonymous': True})
        return reply(200, {'id': u, 'email': confirmed.get(u, ''), 'is_anonymous': u not in confirmed})
    if path == '/auth/v1/logout':
        return reply(204, {})
    auth = request.headers.get('authorization', '')
    if not auth.startswith('Bearer tok-'):
        return reply(401, {'message': 'JWT missing'})
    uid = auth[len('Bearer tok-'):]

    if path.startswith('/rest/v1/rpc/'):
        fn = ident(path.rsplit('/', 1)[1])
        args = ', '.join(f'{ident(k)} => {lit(v)}' for k, v in (body or {}).items())
        rows, err = sql_as(uid, f'select public.{fn}({args}) as r')
    else:
        table = ident(path.rsplit('/', 1)[1])
        w = where(q)
        if request.method == 'GET':
            cols = ', '.join(ident(c) for c in q['select'][0].split(','))
            order = ''
            if 'order' in q:
                c, *d = q['order'][0].split('.')
                order = f' order by {ident(c)} {"desc" if d == ["desc"] else "asc"}'
            rows, err = sql_as(uid, f'select {cols} from public.{table}{w}{order}')
        elif request.method == 'POST':
            items = body if isinstance(body, list) else [body]
            keys = list(items[0].keys())
            vals = ', '.join('(' + ', '.join(lit(it[k]) for k in keys) + ')' for it in items)
            conflict = ''
            if 'on_conflict' in q:
                c = ident(q['on_conflict'][0])
                conflict = f' on conflict ({c}) do update set ' + ', '.join(f'{ident(k)} = excluded.{ident(k)}' for k in keys if k != c)
            rows, err = sql_as(uid, f'insert into public.{table} ({", ".join(map(ident, keys))}) values {vals}{conflict} returning *')
        elif request.method == 'PATCH':
            sets = ', '.join(f'{ident(k)} = {lit(v)}' for k, v in body.items())
            rows, err = sql_as(uid, f'update public.{table} set {sets}{w} returning *')
        elif request.method == 'DELETE':
            rows, err = sql_as(uid, f'delete from public.{table}{w} returning *')
        else:
            return reply(405, {})
    if err:
        code = '23505' if 'duplicate key' in err else ('42501' if 'row-level security' in err else 'P0001')
        msg = err.split('ERROR:', 1)[-1].strip().splitlines()[0]
        return reply(403 if code == '42501' else (409 if code == '23505' else 400), {'code': code, 'message': msg})
    if path.startswith('/rest/v1/rpc/'):
        return reply(200, rows[0]['r'] if rows else None)
    if 'return=minimal' in (request.headers.get('prefer') or ''):
        return route.fulfill(status=201 if request.method == 'POST' else 204, body='',
                             headers={'access-control-allow-origin': '*'})
    return reply(200, rows)
