// Geschenkeliste – Service Worker
// Bei jeder Änderung CACHE erhöhen.
const CACHE = 'geschenkeliste-v30';
const SHELL = ['./', 'index.html', 'app.js?v=30', 'app.css?v=30', 'theme.js?v=30', 'fonts/fredoka.woff', 'fonts/nunito.woff', 'manifest.webmanifest',
  'icons/icon-192.png?v=24', 'icons/icon-512.png?v=24', 'icons/apple-touch-icon.png?v=24', 'icons/badge-96.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('geschenkeliste-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Eigene Dateien: erst Netz (immer aktuell), offline aus dem Cache.
// Supabase-Anfragen laufen nie über den Cache.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: false }).then(r => r || caches.match('index.html')))
  );
});

// ---------- Benachrichtigungen (1.9) ----------
// Die Zahl am App-Symbol: die App meldet den genauen Stand, bei jeder Benachrichtigung wird weitergezählt.
const BADGE = 'gl-badge';   // eigener Speicher, bleibt bei neuen Versionen erhalten
const SAFE = /^#\/[\w/-]*$/;
async function badgeGet() {
  const r = await (await caches.open(BADGE)).match('n');
  return r ? Number(await r.text()) || 0 : 0;
}
async function badgeSave(n) {
  await (await caches.open(BADGE)).put('n', new Response(String(n)));
}
async function badgeShow(n) {
  if (!('setAppBadge' in self.navigator)) return;
  try { await (n ? self.navigator.setAppBadge(n) : self.navigator.clearAppBadge()); } catch (e) { /* ohne Erlaubnis */ }
}

self.addEventListener('message', e => {
  const d = e.data || {};
  if (d.type === 'badge' && Number.isInteger(d.n) && d.n >= 0) e.waitUntil(badgeSave(d.n));
});

self.addEventListener('push', e => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch (x) { m = {}; }
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    wins.forEach(w => w.postMessage({ type: 'sync' }));   // offene App lädt neu
    if (m.badge > 0) {
      const n = (await badgeGet().catch(() => 0)) + m.badge;
      await badgeSave(n).catch(() => {});
      await badgeShow(n);
    }
    await self.registration.showNotification(m.title || 'Geschenkeliste', {
      body: m.body || '',
      tag: m.tag || undefined,
      renotify: !!m.tag,
      icon: 'icons/icon-192.png',
      badge: 'icons/badge-96.png',
      lang: 'de',
      data: { url: SAFE.test(m.url || '') ? m.url : '#/' }
    });
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const hash = SAFE.test((e.notification.data || {}).url || '') ? e.notification.data.url : '#/';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const w = wins.find(x => x.url.startsWith(self.registration.scope)) || wins[0];
    if (w) {
      w.postMessage({ type: 'nav', url: hash });
      return w.focus();
    }
    return self.clients.openWindow(new URL('./' + hash, self.registration.scope).href);
  })());
});
