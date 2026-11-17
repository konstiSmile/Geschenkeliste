// Prüft die Benachrichtigungs-Teile von sw.js in Node (nachgestellter Service Worker).
// Aufruf: node tests/test_sw.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let fails = 0;
const check = (name, cond) => { console.log((cond ? 'ok   ' : 'FAIL ') + name); if (!cond) fails++; };
const SCOPE = 'https://konstismile.github.io/Geschenkeliste/';

function worker(wins = []) {
  const on = {}, store = new Map(), shown = [], opened = [];
  let badge = null;
  const caches = {
    open: async name => ({
      match: async k => store.has(name + k) ? new Response(store.get(name + k)) : undefined,
      put: async (k, r) => store.set(name + k, await r.text()),
      addAll: async () => {}
    }),
    keys: async () => [], delete: async () => true, match: async () => undefined
  };
  const self = {
    addEventListener: (t, f) => { on[t] = f; },
    navigator: { setAppBadge: async n => { badge = n; }, clearAppBadge: async () => { badge = 0; } },
    registration: { scope: SCOPE, showNotification: async (t, o) => shown.push([t, o]) },
    clients: { matchAll: async () => wins, openWindow: async u => opened.push(u), claim: async () => {} },
    skipWaiting: () => {}
  };
  vm.runInNewContext(readFileSync(new URL('../sw.js', import.meta.url), 'utf8'),
    { self, caches, Response, URL, location: new URL(SCOPE), fetch: () => Promise.reject(new Error('offline')), Number, console });
  const fire = async (t, extra) => {
    let p = Promise.resolve();
    on[t](Object.assign({ waitUntil: x => { p = x; } }, extra));
    await p;
  };
  return { fire, shown, opened, get badge() { return badge; } };
}
const pushData = m => ({ data: { json: () => m } });

const w = worker();
await w.fire('message', { data: { type: 'badge', n: 3 } });
await w.fire('push', pushData({ title: 'Neuer Wunsch von Lena', body: 'Kochbuch', url: '#/g/abc/p/def', tag: 'wish-x', badge: 2 }));
check('Push: Benachrichtigung mit Text, Tag und Symbol', w.shown.length === 1 && w.shown[0][0] === 'Neuer Wunsch von Lena'
  && w.shown[0][1].body === 'Kochbuch' && w.shown[0][1].tag === 'wish-x' && w.shown[0][1].renotify === true
  && w.shown[0][1].badge === 'icons/badge-96.png');
check('Push: Zahl am Symbol zählt vom Stand der App weiter', w.badge === 5);
await w.fire('push', pushData({ title: 'Noch 7 Tage bis Heiligabend', body: 'x', url: '#/', tag: 'remind', badge: 0 }));
check('Push: Erinnerung ändert die Zahl nicht', w.badge === 5);
await w.fire('push', { data: { json: () => { throw new Error('kaputt'); } } });
check('Push: kaputte Daten zeigen trotzdem etwas an (Pflicht auf dem iPhone)', w.shown[2][0] === 'Geschenkeliste');
await w.fire('push', pushData({ title: 'x', url: 'javascript:alert(1)' }));
check('Push: fremde Adressen werden nicht übernommen', w.shown[3][1].data.url === '#/');

// Antippen ohne offene App: öffnet die Seite
const notif = url => ({ notification: { data: { url }, close() { this.closed = true; } } });
let n = notif('#/g/abc/wichteln');
await w.fire('notificationclick', n);
check('Antippen: App wird an der richtigen Stelle geöffnet', n.notification.closed && w.opened[0] === SCOPE + '#/g/abc/wichteln');
await w.fire('notificationclick', notif('https://evil.example/'));
check('Antippen: nur eigene Seiten', w.opened[1] === SCOPE + '#/');

// Antippen mit offener App: dorthin wechseln
const msgs = [];
const win = { url: SCOPE + '#/', postMessage: m => msgs.push(m), focus: async () => { win.focused = true; } };
const w2 = worker([win]);
await w2.fire('push', pushData({ title: 'x', badge: 1, url: '#/' }));
check('Push: offene App wird zum Neuladen aufgefordert', msgs[0].type === 'sync' && w2.badge === 1);
await w2.fire('notificationclick', notif('#/g/abc'));
check('Antippen: offene App springt zur Seite', win.focused && msgs[1].type === 'nav' && msgs[1].url === '#/g/abc' && w2.opened.length === 0);

console.log(fails ? `\n${fails} Fehler` : '\nAlle Tests grün');
process.exit(fails ? 1 : 0);
