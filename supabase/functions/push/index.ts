// @ts-nocheck  (reines JavaScript, ohne Typprüfung)
// Geschenkeliste – Edge Function „push“ (Version 1.9)
// Verschickt die Nachrichten aus dem Ausgang der Datenbank (push_outbox) als Web Push.
// Ohne Bibliotheken, nur Web Crypto: VAPID (RFC 8292) und Verschlüsselung aes128gcm (RFC 8291).
// Die Datenbank weckt die Funktion nach jedem neuen Eintrag (pg_net) und alle 5 Minuten (pg_cron).
// Wer was bekommt, steht schon in der Datenbank fest. Aufrufer müssen nichts mitschicken.
//
// Einrichten: Supabase → Edge Functions → Deploy a new function → Via Editor, Name „push“,
// diesen Text einfügen, Deploy. Danach unter Details „Verify JWT“ ausschalten.

const ALLOWED = /^https:\/\/(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|push\.services\.mozilla\.com|[a-z0-9.-]+\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)\//;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type' };
const enc = new TextEncoder();

export function b64u(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unb64u(str) {
  const s = atob(String(str).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
  return Uint8Array.from(s, c => c.charCodeAt(0));
}
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
}
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

// VAPID: signiertes Token (ES256), damit der Push-Dienst weiß, dass die Nachricht von uns kommt
export async function vapidAuth(endpoint, cfg, now = Date.now()) {
  const pub = unb64u(cfg.public);
  const key = await crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256', x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), d: cfg.private, ext: true
  }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: cfg.subject
  })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(head + '.' + body));
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${cfg.public}`;
}

// Verschlüsselung für genau ein Gerät (aes128gcm, ein Datensatz)
export async function encrypt(p256dh, auth, plain, opt = {}) {
  const uaPub = unb64u(p256dh);
  const secret = unb64u(auth);
  const eph = opt.keys || await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256));
  const prkKey = await hmac(secret, shared);
  const ikm = await hmac(prkKey, concat(enc.encode('WebPush: info\0'), uaPub, asPub, new Uint8Array([1])));
  const salt = opt.salt || crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(plain, new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]); // Datensatzgröße 4096
  return concat(salt, rs, new Uint8Array([asPub.length]), asPub, data);
}

export async function sendOne(sub, message, cfg, fetchFn = fetch) {
  if (!ALLOWED.test(sub.endpoint)) return { status: 410, text: '' }; // unbekannter Dienst: Abo verwerfen
  const body = await encrypt(sub.p256dh, sub.auth, enc.encode(JSON.stringify(message)));
  const r = await fetchFn(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuth(sub.endpoint, cfg),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: 'normal'
    },
    body
  });
  const text = r.ok ? '' : await r.text().catch(() => '');
  return { status: r.status, text: text.slice(0, 200) };
}

function env() {
  const g = name => (typeof Deno !== 'undefined' ? Deno.env.get(name) : undefined);
  return { url: g('SUPABASE_URL'), key: g('SUPABASE_SERVICE_ROLE_KEY') || g('SUPABASE_SECRET_KEY') };
}

async function rpc(e, name, args, fetchFn) {
  const h = { apikey: e.key, 'Content-Type': 'application/json' };
  if (/^eyJ/.test(e.key)) h.Authorization = 'Bearer ' + e.key;
  const r = await fetchFn(`${e.url}/rest/v1/rpc/${name}`, { method: 'POST', headers: h, body: JSON.stringify(args) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${name}: ${r.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

export async function handler(req, e = env(), fetchFn = fetch) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (!e.url || !e.key) return json({ ok: false, error: 'SUPABASE_URL oder Schlüssel fehlt' }, 500);
  let sent = 0, failed = 0;
  try {
    for (let round = 0; round < 5; round++) {
      const batch = await rpc(e, 'push_claim', { p_limit: 100 }, fetchFn);
      if (!batch || !batch.config || !batch.items || !batch.items.length) break;
      const jobs = [];
      for (const it of batch.items) for (const s of it.subs) jobs.push([it.message, s]);
      const results = [];
      let error = null;
      // höchstens 8 gleichzeitig
      const work = async () => {
        for (let job = jobs.shift(); job; job = jobs.shift()) {
          const [m, s] = job;
          let r;
          try { r = await sendOne(s, m, batch.config, fetchFn); } catch (x) { r = { status: 0, text: String(x && x.message || x) }; }
          if (r.status >= 200 && r.status < 300) sent++;
          else {
            failed++;
            if (r.status !== 404 && r.status !== 410 && !error) error = `${new URL(s.endpoint).hostname}: ${r.status} ${r.text}`.trim();
          }
          results.push({ id: s.id, status: r.status });
        }
      };
      await Promise.all(Array.from({ length: 8 }, work));
      await rpc(e, 'push_report', { p_results: results, p_error: error }, fetchFn);
    }
  } catch (x) {
    return json({ ok: false, error: String(x && x.message || x) }, 500);
  }
  return json({ ok: true, sent, failed });
}

if (typeof Deno !== 'undefined') Deno.serve(req => handler(req));
