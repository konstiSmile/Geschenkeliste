// Prüft die Edge Function supabase/functions/push/index.ts mit Node (Web Crypto wie in Deno).
// Aufruf: node tests/test_push_fn.mjs   (Postgres wie bei test_rls.py, schema.sql geladen)
// Entschlüsselt unabhängig in diesem Test und zusätzlich mit Python (cryptography).
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'pushfn-'));
writeFileSync(join(tmp, 'push.mjs'), readFileSync(join(here, '../supabase/functions/push/index.ts')));
const fn = await import(join(tmp, 'push.mjs'));
const { b64u, unb64u } = fn;
const enc = new TextEncoder(), dec = new TextDecoder();
let fails = 0;
const check = (name, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + name); if (!cond) fails++; };
const PSQL = ['-h', '/tmp', '-p', '5544', '-U', 'postgres', '-d', 'gl', '-tAq', '-v', 'ON_ERROR_STOP=1'];
const sql = (s, role) => execFileSync('psql', PSQL, { input: (role ? `begin; set local role ${role};\n${s};\ncommit;` : s), encoding: 'utf8' }).trim();

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}
const cat = (...p) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };

// Gerät nachstellen: Schlüsselpaar + auth secret
async function device() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { kp, pub, auth, p256dh: b64u(pub), authB: b64u(auth) };
}
// Entschlüsseln wie ein Browser (RFC 8291)
async function decrypt(dev, body) {
  const salt = body.slice(0, 16), rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
  const idlen = body[20], asPub = body.slice(21, 21 + idlen), ct = body.slice(21 + idlen);
  const asKey = await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, dev.kp.privateKey, 256));
  const prkKey = await hmac(dev.auth, shared);
  const ikm = await hmac(prkKey, cat(enc.encode('WebPush: info\0'), dev.pub, asPub, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, cat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const k = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const p = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, k, ct));
  let end = p.length - 1; while (end >= 0 && p[end] === 0) end--;
  return { rs, idlen, delim: p[end], text: dec.decode(p.slice(0, end)) };
}
// VAPID-Schlüssel wie in der App (Verwaltung → Schlüssel erzeugen)
async function vapidKeys() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const pub = cat(new Uint8Array([4]), unb64u(jwk.x), unb64u(jwk.y));
  return { public: b64u(pub), private: jwk.d, subject: 'https://konstismile.github.io/Geschenkeliste/', kp };
}

const cfg = await vapidKeys();
const dev = await device();
const ep = 'https://fcm.googleapis.com/fcm/send/abc123';
let captured = null;
const fakeFetch = async (url, opt) => { captured = { url, opt }; return new Response('', { status: 201 }); };
const msg = { title: 'Neuer Wunsch von Lena', body: 'Kochbuch „Simple“', url: '#/', tag: 't', badge: 1 };
const r = await fn.sendOne({ endpoint: ep, p256dh: dev.p256dh, auth: dev.authB }, msg, cfg, fakeFetch);
check('Senden: Status vom Push-Dienst', r.status === 201);
const h = captured.opt.headers;
check('Senden: Kopfzeilen', h['Content-Encoding'] === 'aes128gcm' && h.TTL === '86400' && captured.url === ep);
const d = await decrypt(dev, new Uint8Array(captured.opt.body));
check('Verschlüsselung: Gerät kann entschlüsseln (Umlaute, Anführungszeichen)', d.text === JSON.stringify(msg) && d.delim === 2 && d.rs === 4096 && d.idlen === 65);

// VAPID-Token prüfen
const m = /^vapid t=([^,]+), k=(.+)$/.exec(h.Authorization);
const [jh, jb, js] = m[1].split('.');
const claims = JSON.parse(dec.decode(unb64u(jb)));
const verified = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, cfg.kp.publicKey, unb64u(js), enc.encode(jh + '.' + jb));
check('VAPID: Signatur stimmt mit öffentlichem Schlüssel', verified && m[2] === cfg.public);
check('VAPID: aud, exp, sub', claims.aud === 'https://fcm.googleapis.com' && claims.sub === cfg.subject
  && claims.exp > Date.now() / 1000 + 11 * 3600 && claims.exp <= Date.now() / 1000 + 12 * 3600 + 5
  && JSON.parse(dec.decode(unb64u(jh))).alg === 'ES256');

// Gegenprobe mit Python (andere Krypto-Bibliothek)
const priv = await crypto.subtle.exportKey('jwk', dev.kp.privateKey);
writeFileSync(join(tmp, 'case.json'), JSON.stringify({ d: priv.d, auth: dev.authB, body: b64u(new Uint8Array(captured.opt.body)),
  jwt: m[1], vapid: cfg.public }));
const py = execFileSync('python3', ['-I', join(here, 'push_decrypt.py'), join(tmp, 'case.json')], { encoding: 'utf8' }).trim();
check('Gegenprobe Python: Entschlüsseln und Signatur', py === 'ok ' + JSON.stringify(msg));

const r2 = await fn.sendOne({ endpoint: 'http://localhost:8080/x', p256dh: dev.p256dh, auth: dev.authB }, msg, cfg, fakeFetch);
check('Unbekannter Push-Dienst wird nicht angefragt', r2.status === 410);

// Ende zu Ende: Funktion holt aus der Datenbank, verschickt, meldet zurück
const U = crypto.randomUUID(), V = crypto.randomUUID();
sql(`truncate public.push_config, public.push_outbox, net.calls; delete from public.push_subs;
  insert into auth.users (id, email) values ('${U}', 'u${U.slice(0, 6)}@x.de'), ('${V}', 'v${V.slice(0, 6)}@x.de');
  insert into public.push_config (vapid_public, vapid_private, subject, function_url) values ('${cfg.public}', '${cfg.private}', '${cfg.subject}', 'https://x.supabase.co/functions/v1/push');
  insert into public.push_subs (user_id, endpoint, p256dh, auth) values
    ('${U}', '${ep}', '${dev.p256dh}', '${dev.authB}'),
    ('${U}', 'https://web.push.apple.com/gone', '${dev.p256dh}', '${dev.authB}'),
    ('${V}', 'https://updates.push.services.mozilla.com/wpush/v2/err', '${dev.p256dh}', '${dev.authB}');
  insert into public.push_outbox (user_id, kind, ref, tag) values ('${U}', 'test', 'a', 'test'), ('${V}', 'test', 'a', 'test')`);
const posts = [];
const E = { url: 'https://x.supabase.co', key: 'eyJservice' };
const routed = async (url, opt) => {
  if (url.startsWith(E.url + '/rest/v1/rpc/')) {
    const name = url.split('/').pop();
    if (opt.headers.apikey !== E.key || opt.headers.Authorization !== 'Bearer ' + E.key) return new Response('{}', { status: 401 });
    const args = JSON.parse(opt.body);
    const call = name === 'push_claim' ? `select public.push_claim(${args.p_limit})`
      : `select public.push_report('${JSON.stringify(args.p_results)}'::jsonb, ${args.p_error ? `'${args.p_error.replace(/'/g, "''")}'` : 'null'})`;
    const out = sql(call, 'service_role').split('\n').filter(Boolean).pop() || '';
    return new Response(out, { status: 200 });
  }
  posts.push({ url, body: new Uint8Array(opt.body) });
  if (url.includes('/gone')) return new Response('', { status: 410 });
  if (url.includes('/err')) return new Response('BadJwtToken', { status: 403 });
  return new Response('', { status: 201 });
};
const res = await fn.handler(new Request('https://x.supabase.co/functions/v1/push', { method: 'POST', body: '{}' }), E, routed);
const out = await res.json();
check('Funktion: verschickt an alle Geräte', res.status === 200 && out.ok && out.sent === 1 && out.failed === 2 && posts.length === 3);
const got = await decrypt(dev, posts.find(p => p.url === ep).body);
check('Funktion: Inhalt kommt an', JSON.parse(got.text).title === 'Benachrichtigungen sind eingeschaltet');
const subs = sql(`select string_agg(split_part(endpoint, '/', 3) || ':' || fails || ':' || (last_ok_at is not null), ',' order by endpoint) from public.push_subs`);
check('Funktion: abgelaufenes Abo gelöscht, Fehler gezählt, Erfolg vermerkt',
  subs === 'fcm.googleapis.com:0:true,updates.push.services.mozilla.com:1:false');
const err = sql('select last_error from public.push_config');
check('Funktion: Fehler des Push-Dienstes für die Verwaltung gemerkt', err === 'updates.push.services.mozilla.com: 403 BadJwtToken');
const res2 = await fn.handler(new Request('https://x/', { method: 'POST' }), E, routed);
check('Funktion: nichts zu tun', (await res2.json()).sent === 0 && posts.length === 3);
const res3 = await fn.handler(new Request('https://x/', { method: 'OPTIONS' }), E, routed);
check('Funktion: CORS-Vorabfrage', res3.status === 204);
const res4 = await fn.handler(new Request('https://x/', { method: 'POST' }), { url: E.url, key: 'falsch' }, routed);
check('Funktion: Fehler beim Abholen wird gemeldet', res4.status === 500);
sql(`delete from auth.users where id in ('${U}', '${V}'); truncate public.push_config, public.push_outbox;`);

console.log(fails ? `\n${fails} Fehler` : '\nAlle Tests grün');
process.exit(fails ? 1 : 0);
