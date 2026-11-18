'use strict';
/* Geschenkeliste – Wunschlisten für Familie und Freunde.
   Ohne Bibliotheken: spricht direkt mit Supabase (Auth + REST). */

const VERSION = '1.10.1';
const SB_URL = 'https://qbdpzamygonpruaafcrt.supabase.co';
const SB_KEY = 'sb_publishable_A7zukzk82Suux8jteQvLGA_WmXnZb14';
const LS_KEY = 'geschenkeliste-v1';
const MAIL_DOMAIN = '@nutzer.geschenkeliste.invalid'; // nur intern, es wird nie eine Mail verschickt
const USER_RE = /^[a-z0-9][a-z0-9._-]{2,23}$/;
const APP_URL = 'https://konstismile.github.io/Geschenkeliste/'; // Absender der Benachrichtigungen (VAPID)

/* ---------- Speicher ---------- */
let S = loadState();      // {session, pendingJoin, pendingName, cache}
let D = emptyData();      // Daten vom Server
let busy = false;
let ui = {};              // flüchtiger Zustand der Ansicht (offene Formulare, Löschbestätigung)
let fresh = null;         // neu erzeugter Wiederherstellungscode {code, username, reason}, nur im Speicher

function emptyData() {
  return { profiles: [], groups: [], members: [], wishes: [], wg: [], res: [], account: null, admin: false, wd: [], wp: [], wx: [], wo: [], pp: null, ps: null, at: 0, loaded: false };
}
function loadState() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (e) { return {}; }
}
function saveState() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch (e) { /* voll oder gesperrt */ }
}

/* ---------- Hilfen ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 2600);
}
function go(hash) {
  if (location.hash === hash) render(); else location.hash = hash;
}
function me() { return S.session && S.session.user ? S.session.user.id : null; }
function nameOf(uid) {
  if (uid === me()) return 'Du';
  const p = D.profiles.find(x => x.id === uid);
  return p && p.name ? p.name : 'Jemand';
}
function genitive(name) {
  return /[sßxz]$/i.test(name) ? name + '’' : name + 's';
}
function domain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}
function normUrl(u) {
  u = (u || '').trim();
  if (!u) return null;
  if (/\s/.test(u)) { const f = findUrl(u); if (f) u = f; }
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try { const x = new URL(u); if (!/^https?:$/.test(x.protocol) || !x.hostname.includes('.')) return false; } catch (e) { return false; }
  return u;
}
function inviteLink(code) {
  return location.origin + location.pathname + '#/join/' + code;
}
function fmtCode(c) { return c ? c.slice(0, 4) + '-' + c.slice(4) : ''; }
function fmtRecovery(c) { return String(c || '').replace(/(.{4})(?=.)/g, '$1-'); }
function normUser(u) { return String(u || '').trim().toLowerCase().replace(/^@/, ''); }
function checkUser(u) {
  if (!USER_RE.test(u)) throw new Error('Benutzername: 3 bis 24 Zeichen, nur Kleinbuchstaben, Ziffern, Punkt, Bindestrich und Unterstrich.');
}
function checkPw(pw) {
  if (pw.length < 8) throw new Error('Das Passwort braucht mindestens 8 Zeichen.');
}
function fmtTime(ts) { return new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' }).format(new Date(ts)); }
function fmtDay(ts) { return new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'long' }).format(new Date(ts)); }
/* Mehr am Wunsch (1.7) */
const CATS = [['buch', 'Bücher'], ['kleidung', 'Kleidung'], ['technik', 'Technik'], ['spiel', 'Spiele und Spielzeug'],
  ['haushalt', 'Haushalt und Küche'], ['wohnen', 'Wohnen und Deko'], ['sport', 'Sport und Freizeit'], ['pflege', 'Pflege und Schönheit'],
  ['schmuck', 'Schmuck und Accessoires'], ['medien', 'Musik und Filme'], ['erlebnis', 'Erlebnisse'], ['gutschein', 'Gutscheine'], ['sonstiges', 'Sonstiges']];
function catName(k) { const c = CATS.find(x => x[0] === k); return c ? c[1] : 'Sonstiges'; }
const PRIOS = [[3, 'Sehr gern'], [2, 'Normal'], [1, 'Nur eine Idee']];
const PRICES = [['p1', 'bis 25 €', 0, 25], ['p2', '25 bis 50 €', 25, 50], ['p3', '50 bis 100 €', 50, 100], ['p4', 'über 100 €', 100, Infinity]];
function priceBucket(p) {
  if (p == null) return null;
  const b = PRICES.find(x => Number(p) <= x[3] && (x[2] === 0 || Number(p) > x[2]));
  return b ? b[0] : null;
}
function fmtPrice(p) {
  if (p == null || p === '') return '';
  const n = Number(p);
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }).format(n);
}
function priceInput(p) { return p == null ? '' : String(Number(p)).replace('.', ','); }
function parsePrice(t) {
  t = String(t || '').replace(/€|eur|euro/ig, '').replace(/\s/g, '');
  if (!t) return null;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return false;
  const n = Number(t);
  return n > 1000000 ? false : n;
}
const prio = w => w.priority || 2;
const byPrio = (a, b) => prio(b) - prio(a);
/* Ersten Link aus geteiltem oder kopiertem Text holen */
function findUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s<>"'„“]+/i);
  if (m) return m[0].replace(/[).,;:!?]+$/, '');
  const t = String(text || '').trim();
  if (t && !/\s/.test(t) && /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(t)) return 'https://' + t;
  return null;
}
/* Titelvorschlag: geteilter Titel, sonst Text ohne Link, sonst aus dem Link-Pfad */
function guessTitle(text, url, title) {
  const clean = x => String(x || '').replace(/https?:\/\/\S+/gi, '').replace(/\s+/g, ' ').trim();
  const d = url ? domain(url) : '';
  const t = clean(title);
  if (t.length >= 3 && t.toLowerCase() !== d) return t.slice(0, 120);
  const r = clean(text).split(/[\n|]/)[0].trim();
  if (r.length >= 3 && r.toLowerCase() !== d) return r.slice(0, 120);
  try {
    const segs = new URL(url).pathname.split('/').map(x => { try { return decodeURIComponent(x); } catch (e) { return x; } })
      .map(x => x.replace(/\.(html?|php|aspx?)$/i, ''))
      .filter(x => /[-_+]/.test(x) && (x.match(/[a-zäöüß]{3,}/gi) || []).length >= 2);
    if (!segs.length) return '';
    const best = segs.sort((a, b) => b.length - a.length)[0].replace(/[-_+]+/g, ' ').replace(/\s+/g, ' ').trim();
    return (best[0].toUpperCase() + best.slice(1)).slice(0, 120);
  } catch (e) { return ''; }
}
const SHARE_MAX_AGE = 3600e3;
function sharedPrefill() {
  const x = S.share;
  if (!x || Date.now() - x.at > SHARE_MAX_AGE) return null;
  const url = findUrl(x.url) || findUrl(x.text) || '';
  return { url, title: guessTitle(x.text, url, x.title) };
}
function needsSecure() { return D.loaded ? !D.account : !!(S.session && S.session.user.anon); }

/* ---------- Supabase ---------- */
function errText(j, status) {
  const m = j ? (j.message || j.msg || j.error_description || j.error || '') : '';
  const code = j && (j.code || j.error_code);
  if (status === 429 || /rate limit/i.test(m + code)) return 'Zu viele Versuche. Bitte ein paar Minuten warten.';
  if (code === 'invalid_credentials' || /invalid login credentials/i.test(m)) return 'Benutzername oder Passwort falsch.';
  if (/Benutzername vergeben|accounts_username_key/.test(m)) return 'Diesen Benutzernamen gibt es schon.';
  if (/Benutzername ungültig/.test(m)) return 'Benutzername: 3 bis 24 Zeichen, nur Kleinbuchstaben, Ziffern, Punkt, Bindestrich und Unterstrich.';
  if (/Passwort zu kurz/.test(m)) return 'Das Passwort braucht mindestens 8 Zeichen.';
  if (/Passwort zu lang/.test(m)) return 'Das Passwort ist zu lang.';
  if (/Konto schon gesichert/.test(m)) return 'Dein Konto ist schon gesichert.';
  if (/Keine Berechtigung/.test(m)) return 'Das darfst du leider nicht.';
  if (/Kein gesichertes Konto/.test(m)) return 'Diese Person hat noch keinen Benutzernamen.';
  if (/email logins are disabled/i.test(m)) return 'In Supabase ist der Anbieter „Email“ ausgeschaltet.';
  if (/email not confirmed/i.test(m)) return 'Dieses Konto ist noch nicht freigeschaltet.';
  if (/Could not find the function|PGRST202|PGRST204|42883|42703|Could not find the '.*' column/.test(m + code)) return 'Die Datenbank ist noch nicht aktualisiert (schema.sql ausführen).';
  if (code === '23505' || /duplicate key/i.test(m)) return 'Das hat gerade schon jemand anderes reserviert.';
  if (code === '42501' || /row-level security/i.test(m)) return 'Das darfst du leider nicht.';
  if (/Nur der Gründer/.test(m)) return 'Das darf nur, wer die Gruppe gegründet hat.';
  if (/Keine Auslosung möglich/.test(m)) return 'Mit diesen Ausschlüssen geht die Auslosung nicht auf. Entferne einen Ausschluss und versuch es nochmal.';
  if (/Zu wenige Teilnehmer/.test(m)) return 'Zum Auslosen braucht es mindestens 3 Personen.';
  if (/Zu viele Teilnehmer/.test(m)) return 'Mehr als 60 Personen gehen nicht.';
  if (/Zu viele Ausschlüsse/.test(m)) return 'Mehr als 200 Ausschlüsse gehen nicht.';
  if (/Zwei verschiedene Personen/.test(m)) return 'Wähle zwei verschiedene Personen.';
  if (/Kein Mitglied/.test(m)) return 'Diese Person ist nicht mehr in der Gruppe.';
  if (/Kein Gerät angemeldet/.test(m)) return 'Schalte die Benachrichtigungen zuerst auf diesem Gerät ein.';
  if (/Push nicht eingerichtet/.test(m)) return 'Die Benachrichtigungen sind noch nicht eingerichtet.';
  if (/Push-Adresse ungültig/.test(m)) return 'Dieser Browser wird für Benachrichtigungen nicht unterstützt.';
  if (/Schlüssel ungültig|Adresse ungültig|Absender ungültig/.test(m)) return 'Die Schlüssel ließen sich nicht speichern.';
  if (/Code nicht gefunden/.test(m)) return 'Diesen Gruppen-Code gibt es nicht.';
  if (/Zu viele Gruppen/.test(m)) return 'Du hast schon 20 Gruppen angelegt.';
  if (/anonymous/i.test(m) && /disabled/i.test(m)) return 'Start ohne Mail ist in Supabase noch nicht eingeschaltet.';
  return m ? 'Fehler: ' + m : 'Fehler (' + status + ')';
}

async function sb(path, opt = {}) {
  const { method = 'GET', body, prefer, auth = true } = opt;
  if (auth) await ensureFresh();
  const h = { apikey: SB_KEY };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (auth && S.session) h.Authorization = 'Bearer ' + S.session.access_token;
  if (prefer) h.Prefer = prefer;
  let r;
  try {
    r = await fetch(SB_URL + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'omit', referrerPolicy: 'no-referrer' });
  } catch (e) {
    throw new Error('Keine Verbindung. Bitte später nochmal versuchen.');
  }
  const txt = await r.text();
  let j = null;
  try { j = txt ? JSON.parse(txt) : null; } catch (e) { j = null; }
  if (!r.ok) {
    if (r.status === 401 && auth && !opt.retried) {
      const ok = await refresh(true);
      if (ok) return sb(path, Object.assign({}, opt, { retried: true }));
      logout('Bitte melde dich neu an.');
    }
    throw new Error(errText(j, r.status));
  }
  return j;
}

function setSession(j) {
  const exp = j.expires_at || Math.floor(Date.now() / 1000) + (j.expires_in || 3600);
  S.session = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: exp, user: { id: j.user.id, email: j.user.email || '', anon: !!j.user.is_anonymous && !j.user.email } };
  delete S.loginSent;
  saveState();
}

let refreshing = null;
async function ensureFresh() {
  if (!S.session) return;
  if (S.session.expires_at * 1000 - Date.now() > 60000) return;
  await refresh(false);
}
function refresh(force) {
  if (!S.session) return Promise.resolve(false);
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const r = await fetch(SB_URL + '/auth/v1/token?grant_type=refresh_token', {
        method: 'POST', headers: { apikey: SB_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: S.session.refresh_token }), credentials: 'omit'
      });
      if (!r.ok) {
        if (r.status >= 400 && r.status < 500) { logout('Bitte melde dich neu an.'); }
        return false;
      }
      setSession(await r.json());
      return true;
    } catch (e) {
      return false; // offline: alten Token behalten
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

function logout(msg) {
  const keep = S.pendingJoin;
  S = {};
  if (keep) S.pendingJoin = keep;
  D = emptyData();
  fresh = null;
  ui = {};
  seen = null;
  flash = new Set();
  push.sub = null;
  push.done = '';
  push.auto = false;
  appBadge(0);
  saveState();
  if (msg) toast(msg);
  go('#/');
}

/* Alte Anmelde-Links (bis 1.4) hinterlassen Tokens im Adress-Hash: wegräumen */
function cleanAuthHash() {
  if (/access_token=|error_description=/.test(location.hash)) history.replaceState(null, '', location.pathname);
}

async function passwordLogin(username, password) {
  const j = await sb('/auth/v1/token?grant_type=password', { method: 'POST', auth: false, body: { email: username + MAIL_DOMAIN, password } });
  setSession(j);
}

/* ---------- Daten laden ---------- */
async function sync(quiet) {
  if (!S.session) return;
  try {
    const [profiles, groups, members, wishes, wg, res, acc, admin, wd, wp, wx, wo, pp] = await Promise.all([
      sb('/rest/v1/profiles?select=id,name'),
      sb('/rest/v1/groups?select=id,name,code,created_by,created_at&order=created_at'),
      sb('/rest/v1/members?select=group_id,user_id,joined_at&order=joined_at'),
      // Preis, Kategorie, Wichtigkeit, „Hab ich schon“ ab 1.7; vorher ohne diese Spalten
      sb('/rest/v1/wishes?select=id,owner,title,url,note,all_groups,created_at,price,category,priority,have_at&order=created_at.desc')
        .catch(() => sb('/rest/v1/wishes?select=id,owner,title,url,note,all_groups,created_at&order=created_at.desc')),
      sb('/rest/v1/wish_groups?select=wish_id,group_id'),
      sb('/rest/v1/reservations?select=wish_id,user_id,status'),
      // ab 1.5; vor dem Ausführen der neuen schema.sql fehlen sie, die App läuft trotzdem
      sb('/rest/v1/accounts?select=username,reset_at,reset_notice').catch(() => null),
      sb('/rest/v1/rpc/is_app_admin', { method: 'POST', body: {} }).catch(() => false),
      // Wichteln ab 1.6, ebenfalls tolerant
      sb('/rest/v1/wichtel_draws?select=group_id,drawn_at,participants').catch(() => []),
      sb('/rest/v1/wichtel_pairs?select=group_id,receiver').catch(() => []),
      sb('/rest/v1/wichtel_exclusions?select=group_id,a,b,created_at&order=created_at').catch(() => []),
      sb('/rest/v1/wichtel_out?select=group_id,user_id').catch(() => []),
      // Benachrichtigungen ab 1.9
      sb('/rest/v1/push_prefs?select=wish,member,draw,remind,have').catch(() => null)
    ]);
    const ps = admin === true ? await sb('/rest/v1/rpc/push_status', { method: 'POST', body: {} }).catch(() => null) : null;
    if (!S.session) return;
    D = { profiles, groups, members, wishes, wg, res, account: acc && acc[0] ? acc[0] : null, admin: admin === true,
      wd: wd || [], wp: wp || [], wx: wx || [], wo: wo || [], pp: pp && pp[0] ? pp[0] : null, ps, at: Date.now(), loaded: true };
    S.cache = { uid: me(), D };
    saveState();
    seenSync();
    render();
  } catch (e) {
    if (!quiet) toast(e.message);
  }
}

/* ---------- Abgeleitete Daten ---------- */
const myGroups = () => D.groups.filter(g => D.members.some(m => m.group_id === g.id && m.user_id === me()));
const membersOf = gid => D.members.filter(m => m.group_id === gid);
const groupIdsOf = wid => D.wg.filter(x => x.wish_id === wid).map(x => x.group_id);
const resOf = wid => D.res.find(r => r.wish_id === wid);
function visibleIn(w, gid) {
  return w.all_groups || groupIdsOf(w.id).includes(gid);
}
function wishesOf(uid, gid) {
  return D.wishes.filter(w => w.owner === uid && (gid ? visibleIn(w, gid) : true));
}
/* nur Wünsche, die noch offen sind (nicht „Hab ich schon“) */
function openWishes(uid, gid) {
  return wishesOf(uid, gid).filter(w => !w.have_at);
}

/* Wichteln */
const isFounder = g => g && g.created_by === me();
const drawOf = gid => (D.wd || []).find(x => x.group_id === gid);
const pairOf = gid => (D.wp || []).find(x => x.group_id === gid);
const takesPart = (gid, uid) => !(D.wo || []).some(x => x.group_id === gid && x.user_id === uid);
const exclOf = gid => (D.wx || []).filter(x => x.group_id === gid);
function wichtelState(gid) {
  const d = drawOf(gid);
  if (!d) return { drawn: false };
  const now = membersOf(gid).map(m => m.user_id).filter(u => takesPart(gid, u));
  const was = d.participants || [];
  const stale = now.length !== was.length || now.some(u => !was.includes(u));
  const inDraw = was.includes(me());
  const pair = pairOf(gid);
  return { drawn: true, at: d.drawn_at, stale, inDraw, receiver: pair ? pair.receiver : null, missing: inDraw && !pair };
}

/* ---------- Neu seit letztem Besuch (1.8) ----------
   Nur auf diesem Gerät: welche Wünsche, Mitglieder und Auslosungen schon gesehen wurden.
   Eigener Speicher, damit es das Abmelden übersteht (pro Konto). Beim ersten Mal und für
   frisch beigetretene Gruppen gilt alles Vorhandene als gesehen. */
const SEEN_KEY = 'geschenkeliste-seen';
let seen = null;            // {uid, w:{id:1}, m:{'gid:uid':1}, g:{gid:1}, d:{gid:drawn_at}}
let flash = new Set();      // in dieser Ansicht gerade gesehen: Markierung bleibt bis zum Seitenwechsel
let marks = [];             // während des Zeichnens gesammelt, danach gespeichert
const mkey = (gid, uid) => gid + ':' + uid;
function seenLoad() {
  if (seen && seen.uid === me()) return seen;
  let all = {};
  try { all = JSON.parse(localStorage.getItem(SEEN_KEY)) || {}; } catch (e) { /* kaputt: neu anfangen */ }
  const s = all[me()];
  seen = s && s.w ? Object.assign({ m: {}, g: {}, d: {} }, s, { uid: me() }) : null;
  return seen;
}
function seenSave() {
  if (!seen) return;
  let all = {};
  try { all = JSON.parse(localStorage.getItem(SEEN_KEY)) || {}; } catch (e) { /* neu */ }
  const { uid, ...rest } = seen;
  all[uid] = rest;
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(all)); } catch (e) { /* voll oder gesperrt */ }
}
const othersWishes = () => D.wishes.filter(w => w.owner !== me() && !w.have_at);
function othersMembers() {
  const gs = myGroups().map(g => g.id);
  return D.members.filter(m => m.user_id !== me() && gs.includes(m.group_id));
}
function myDraws() {
  return myGroups().map(g => ({ gid: g.id, st: wichtelState(g.id) })).filter(x => x.st.receiver).map(x => ({ gid: x.gid, at: x.st.at }));
}
/* nach jedem Laden: neue Gruppen und den allerersten Start still als gesehen übernehmen, Altes aufräumen */
function seenSync() {
  if (!D.loaded || !me()) return;
  const gs = myGroups().map(g => g.id);
  let s = seenLoad();
  const first = !s;
  if (first) s = seen = { uid: me(), w: {}, m: {}, g: {}, d: {} };
  for (const gid of gs) {
    if (!first && s.g[gid]) continue;
    s.g[gid] = 1;
    D.wishes.filter(w => w.owner !== me() && visibleIn(w, gid) && membersOf(gid).some(m => m.user_id === w.owner)).forEach(w => { s.w[w.id] = 1; });
    membersOf(gid).forEach(m => { s.m[mkey(gid, m.user_id)] = 1; });
    const st = wichtelState(gid);
    if (st.receiver) s.d[gid] = st.at;
  }
  // wer auslost, hat es selbst gesehen
  myGroups().filter(isFounder).forEach(g => { const st = wichtelState(g.id); if (st.receiver) s.d[g.id] = st.at; });
  const keepW = new Set(D.wishes.map(w => w.id));
  const keepM = new Set(D.members.map(m => mkey(m.group_id, m.user_id)));
  s.w = Object.fromEntries(Object.keys(s.w).filter(k => keepW.has(k)).map(k => [k, 1]));
  s.m = Object.fromEntries(Object.keys(s.m).filter(k => keepM.has(k)).map(k => [k, 1]));
  s.g = Object.fromEntries(Object.keys(s.g).filter(k => gs.includes(k)).map(k => [k, 1]));
  s.d = Object.fromEntries(Object.entries(s.d).filter(([k]) => gs.includes(k)));
  seenSave();
}
function isNewWish(w) {
  if (w.owner === me() || w.have_at) return false;
  const s = seenLoad();
  return !!s && (!s.w[w.id] || flash.has('w' + w.id));
}
function isNewMember(gid, uid) {
  if (uid === me()) return false;
  const s = seenLoad();
  return !!s && (!s.m[mkey(gid, uid)] || flash.has('m' + mkey(gid, uid)));
}
function isNewDraw(gid) {
  const s = seenLoad();
  const st = wichtelState(gid);
  return !!s && !!st.receiver && (s.d[gid] !== st.at || flash.has('d' + gid));
}
const newWishes = () => othersWishes().filter(w => { const s = seenLoad(); return s && !s.w[w.id]; });
const newMembers = () => othersMembers().filter(m => { const s = seenLoad(); return s && !s.m[mkey(m.group_id, m.user_id)]; });
const newDraws = () => myDraws().filter(x => { const s = seenLoad(); return s && s.d[x.gid] !== x.at; });
/* Wünsche, die in dieser Gruppe neu sind (für Zähler in Gruppenliste und Gruppe) */
function newIn(gid, uid) {
  return newWishes().filter(w => visibleIn(w, gid) && (uid ? w.owner === uid : membersOf(gid).some(m => m.user_id === w.owner)));
}
function newCount() {
  if (!D.loaded || !seenLoad()) return 0;
  return newWishes().length + newMembers().length + newDraws().length;
}
/* aus den Ansichten heraus: als gesehen vormerken, die Markierung bleibt in dieser Ansicht stehen */
function markSeen(kind, key, val = 1) { marks.push([kind, key, val]); }
function applyMarks() {
  const s = seenLoad();
  if (!s || !marks.length) { marks = []; return; }
  for (const [kind, key, val] of marks) {
    const cur = s[kind][key];
    if (cur === val) continue;
    s[kind][key] = val;
    flash.add(kind + key);
  }
  marks = [];
  seenSave();
}
function seenAll() {
  const s = seenLoad();
  if (!s) return;
  othersWishes().forEach(w => { s.w[w.id] = 1; });
  othersMembers().forEach(m => { s.m[mkey(m.group_id, m.user_id)] = 1; });
  myDraws().forEach(x => { s.d[x.gid] = x.at; });
  seenSave();
}
const countBadge = (n, cls = '') => n ? `<span class="count ${cls}" aria-label="${plural(n, 'neuer Eintrag', 'neue Einträge')}">${n > 99 ? '99+' : n}</span>` : '';
const newTag = (label = 'Neu') => `<span class="tag new">${label}</span>`;
/* Tab „Gruppen“ und Zähler am App-Symbol */
function paintBadges() {
  const n = newCount();
  const tab = document.querySelector('.tabs a[href="#/gruppen"]');
  if (tab) {
    const old = tab.querySelector('.count');
    if (old) old.remove();
    if (n) tab.insertAdjacentHTML('beforeend', countBadge(n, 'tabcount'));
  }
  appBadge(n);
}
function appBadge(n) {
  if (appBadge.last === n) return;
  appBadge.last = n;
  // der Service Worker zählt bei Benachrichtigungen von hier aus weiter (1.9)
  try { const c = navigator.serviceWorker && navigator.serviceWorker.controller; if (c) c.postMessage({ type: 'badge', n }); } catch (e) { /* egal */ }
  if (!('setAppBadge' in navigator)) return;
  (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
}
/* Zähler am App-Symbol: iPhone und Mac zeigen ihn nur mit erlaubten Mitteilungen */
function badgeState() {
  if (!('setAppBadge' in navigator)) return 'none';
  const ua = navigator.userAgent;
  const apple = platform() === 'ios' || (/Safari\//.test(ua) && !/Chrome|Chromium|Edg|OPR|Firefox/.test(ua));
  if (!apple || !('Notification' in window)) return 'ok';
  return Notification.permission === 'granted' ? 'ok' : Notification.permission; // default | denied
}


/* ---------- Bausteine der Oberfläche ---------- */
const I = {
  home: '<path d="M3.5 10.5 12 4l8.5 6.5V20a1 1 0 0 1-1 1h-5v-6h-5v6h-5a1 1 0 0 1-1-1z"/>',
  gift: '<path d="M4 11h16v9H4zM3 7.5h18V11H3zM12 7.5V20M12 7.5C10 4 6.5 3.5 6.5 5.6S10 7.5 12 7.5zm0 0c2-3.5 5.5-4 5.5-1.9S14 7.5 12 7.5z"/>',
  people: '<circle cx="9" cy="8" r="3.4"/><path d="M2.6 20c.8-3.9 3.3-6 6.4-6s5.6 2.1 6.4 6"/><circle cx="17" cy="9" r="2.5"/><path d="M16.3 14c2.7 0 4.6 1.8 5.3 5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4.4 4.2-7 8-7s7 2.6 8 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chev: '<path d="m9 6 6 6-6 6"/>',
  back: '<path d="m15 6-6 6 6 6"/>',
  share: '<path d="M12 3v12M7.5 7.5 12 3l4.5 4.5M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  sync: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  eyeoff: '<path d="M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 8.5 4.2 9.5 6-.4.8-1.3 2.1-2.6 3.3M6.6 7.6C4.6 8.9 3.2 10.8 2.5 12c1 1.8 4.5 6 9.5 6 1.4 0 2.7-.3 3.8-.9M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  shield: '<path d="M12 3 5 6v5c0 4.5 3 8.4 7 10 4-1.6 7-5.5 7-10V6z"/>',
  heart: '<path d="M12 20s-7.5-4.6-7.5-10A4.5 4.5 0 0 1 12 7a4.5 4.5 0 0 1 7.5 3c0 5.4-7.5 10-7.5 10z"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M16 7l3 3M14 9l2 2"/>',
  paste: '<rect x="6" y="4.5" width="12" height="16" rx="2"/><path d="M9.5 4.5V3.5h5v1M9 11h6M9 15h4"/>',
  phone: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 18.5h3"/>',
  addsq: '<rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="M12 8.5v7M8.5 12h7"/>',
  more: '<circle cx="12" cy="5.5" r="1.1"/><circle cx="12" cy="12" r="1.1"/><circle cx="12" cy="18.5" r="1.1"/>',
  download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/>',
  bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0"/>',
  shuffle: '<path d="M4 7h3.2c1.9 0 3 .9 4.2 2.8l1.2 2c1.2 1.9 2.4 3.2 4.3 3.2H20M4 17h3.2c1.3 0 2.2-.5 3-1.4M13.6 8.4c.8-.9 1.8-1.4 3.1-1.4H20M17.5 4.5 20 7l-2.5 2.5M17.5 12.5 20 15l-2.5 2.5"/>',
  // Pop-Design (1.10)
  star: '<path d="m12 3.5 2.6 5.3 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.7 1-5.8-4.3-4.1 5.9-.8z"/>',
  snow: '<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9M9.5 4.5 12 7l2.5-2.5M9.5 19.5 12 17l2.5 2.5"/>',
  calendar: '<rect x="4" y="5.5" width="16" height="15" rx="2.5"/><path d="M4 10.5h16M8.5 3.5v4M15.5 3.5v4"/>',
  sparkle: '<path d="M12 4c.8 4.2 3.8 7.2 8 8-4.2.8-7.2 3.8-8 8-.8-4.2-3.8-7.2-8-8 4.2-.8 7.2-3.8 8-8z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  moon: '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>',
  palette: '<path d="M12 3.5a8.5 8.5 0 0 0 0 17c1.4 0 2-.9 2-1.8 0-1.3-1.2-1.6-1.2-2.8 0-1 .8-1.6 1.8-1.6h2.1c2.2 0 3.8-1.6 3.8-3.8 0-3.9-3.8-7-8.5-7z"/><circle cx="7.8" cy="11.5" r="1"/><circle cx="10" cy="7.6" r="1"/><circle cx="14.5" cy="7.6" r="1"/>',
  book: '<path d="M5 17V6.5a3 3 0 0 1 3-3h10.5V17"/><path d="M5 17.5a3 3 0 0 0 3 3h10.5V14H8a3 3 0 0 0-3 3.5z"/>',
  shirt: '<path d="M8.5 3.5 4 6l1.8 4.2L8 9.4v11.1h8V9.4l2.2.8L20 6l-4.5-2.5a3.5 3.5 0 0 1-7 0z"/>',
  headphones: '<path d="M4 15.5V12a8 8 0 0 1 16 0v3.5"/><rect x="3.5" y="14" width="4.5" height="6.5" rx="2"/><rect x="16" y="14" width="4.5" height="6.5" rx="2"/>',
  gamepad: '<path d="M7 7.5h10a4.5 4.5 0 0 1 4.4 5.5l-.9 4a2.6 2.6 0 0 1-4.5 1.2L14.3 16H9.7L8 18.2a2.6 2.6 0 0 1-4.5-1.2l-.9-4A4.5 4.5 0 0 1 7 7.5z"/><path d="M8 10.5v3M6.5 12h3M15.5 11h.01M17 13h.01"/>',
  cup: '<path d="M4.5 9.5h11.5v5a5 5 0 0 1-5 5h-1.5a5 5 0 0 1-5-5z"/><path d="M16 11h1.5a2.5 2.5 0 0 1 0 5H16M8 3.5v2.5M11 3.5v2.5M14 3.5v2.5"/>',
  leaf: '<path d="M5 19.5C5 11 10 5 20 4.5c0 10-5.5 15-13.5 15z"/><path d="M5 19.5c3-4.3 6-7 9.5-8.8"/>',
  ball: '<circle cx="12" cy="12" r="8.5"/><path d="M3.8 9.6c3.2 1.4 5.4 4.6 5.9 10.4M14.4 3.8c-.7 3.6 1.5 7.4 6 8.6"/>',
  drop: '<path d="M12 3.5c3 3.8 6 7.2 6 10.5a6 6 0 0 1-12 0c0-3.3 3-6.7 6-10.5z"/><path d="M9 14.5a3 3 0 0 0 2.5 2.8"/>',
  gem: '<path d="M7 4.5h10l4 4.8-9 10.7-9-10.7z"/><path d="M3 9.3h18M9.5 4.5 8 9.3l4 10.7 4-10.7-1.5-4.8"/>',
  note: '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
  ticket: '<path d="M3.5 8a1 1 0 0 1 1-1h15a1 1 0 0 1 1 1v2a2 2 0 0 0 0 4v2a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-2a2 2 0 0 0 0-4z"/><path d="M14.5 7.5v1.5M14.5 11.2v1.6M14.5 15v1.5"/>',
  label: '<path d="M3.5 12.3V4.5a1 1 0 0 1 1-1h7.8l8.2 8.2a1.5 1.5 0 0 1 0 2.1l-6.7 6.7a1.5 1.5 0 0 1-2.1 0z"/><circle cx="8" cy="8" r="1.4"/>'
};
const icon = (n, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${I[n]}</svg>`;


function hueIdx(id) {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 6;
}
function initials(name) {
  const p = String(name || '?').trim().split(/\s+/);
  return ((p[0] || '?')[0] + (p[1] ? p[1][0] : '')).toUpperCase();
}
function myName() { return (D.profiles.find(x => x.id === me()) || {}).name || ''; }
function avatar(uid, size = '') {
  const n = uid === me() ? myName() : nameOf(uid);
  return `<span class="av ${size} c${hueIdx(uid)}">${esc(initials(n))}</span>`;
}
function avStack(uids, max = 4) {
  const shown = uids.slice(0, max).map(u => avatar(u, 'xs')).join('');
  const more = uids.length > max ? `<span class="av xs more">+${uids.length - max}</span>` : '';
  return `<span class="avs">${shown}${more}</span>`;
}
// Kachel am Wunsch: Kategorie-Icon in Pastell (Pop-Design 1.10)
const CAT_ICONS = { buch: 'book', kleidung: 'shirt', technik: 'headphones', spiel: 'gamepad', haushalt: 'cup', wohnen: 'leaf',
  sport: 'ball', pflege: 'drop', schmuck: 'gem', medien: 'note', erlebnis: 'ticket', gutschein: 'label', sonstiges: 'gift' };
function tile(w) {
  const i = Math.max(0, CATS.findIndex(c => c[0] === w.category));
  return `<span class="tile t${w.category ? i % 3 : 0}">${icon(CAT_ICONS[w.category] || 'gift')}</span>`;
}
function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }
function ago(ts) {
  const d0 = new Date(ts), now = new Date();
  const a = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate());
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const n = Math.round((b - a) / 864e5);
  if (n <= 0) return 'heute';
  if (n === 1) return 'gestern';
  if (n < 7) return `vor ${n} Tagen`;
  return new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'short' }).format(d0);
}
function daysToXmas() {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let x = new Date(now.getFullYear(), 11, 24);
  if (today > x) x = new Date(now.getFullYear() + 1, 11, 24);
  return Math.round((x - today) / 864e5);
}
function groupFor(w) {
  const g = myGroups().find(g => membersOf(g.id).some(m => m.user_id === w.owner) && visibleIn(w, g.id));
  return g ? g.id : null;
}
function emptyState(ic, title, text, action = '') {
  return `<div class="emptystate"><span class="emptyicon">${icon(ic)}</span><h3>${title}</h3><p>${text}</p>${action}</div>`;
}
function visLabel(w) {
  if (w.all_groups) return 'Alle Gruppen';
  const names = groupIdsOf(w.id).map(g => (D.groups.find(x => x.id === g) || {}).name).filter(Boolean);
  return names.length ? names.join(', ') : 'Nicht freigegeben';
}

/* ---------- Ansichten ---------- */
function shell(title, body, opt = {}) {
  const tab = opt.tab || '';
  const back = opt.back ? `<a class="back" href="${opt.back[0]}">${icon('back')}<span>${esc(opt.back[1])}</span></a>` : '<span></span>';
  const T = (h, t, n, label) => `<a href="${h}" class="${tab === t ? 'on' : ''}">${icon(n)}<span>${label}</span></a>`;
  return `
  <header class="top">
    ${opt.back ? `<div class="topbar">${back}</div>` : ''}
    <div class="titlerow"><div class="titletext">${opt.eyebrow ? `<p class="eyebrow">${esc(opt.eyebrow)}</p>` : ''}
    <h1 class="title">${esc(title)}</h1></div><button class="iconbtn" data-act="sync" aria-label="Aktualisieren">${icon('sync')}</button></div>
    ${opt.sub ? `<p class="subtitle">${opt.sub}</p>` : ''}
  </header>
  <main>${body}</main>
  <nav class="tabs">${T('#/', 'home', 'home', 'Start')}${T('#/liste', 'list', 'gift', 'Wunschliste')}${T('#/gruppen', 'groups', 'people', 'Gruppen')}${T('#/konto', 'acc', 'user', 'Konto')}</nav>`;
}

function brand() {
  return `<div class="brand"><img class="brandmark" src="icons/icon-192.png" alt=""><span>Geschenkeliste</span></div>`;
}

/* ---------- Als App installieren (1.7.1) ---------- */
let installEvt = null;    // aufgehobenes beforeinstallprompt (Chrome, Edge, Samsung Internet)
let justInstalled = false;
function platform() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'other';
}
function isStandalone() {
  if (navigator.standalone === true) return true;
  return !!(window.matchMedia && matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches);
}
const step = (n, html) => `<li><span class="stepnum">${n}</span><span>${html}</span></li>`;
function iosSteps() {
  return `<ol class="steps">
    ${step(1, `In Safari auf ${icon('share', 'inl')}<b>Teilen</b> tippen<small>Nicht zu sehen? Erst auf „…“ tippen.</small>`)}
    ${step(2, `${icon('addsq', 'inl')}<b>Zum Home-Bildschirm</b> wählen<small>Steht eventuell weiter unten in der Liste.</small>`)}
    ${step(3, 'Oben rechts auf <b>Hinzufügen</b> tippen')}
  </ol>`;
}
function androidSteps() {
  return `<ol class="steps">
    ${step(1, `In Chrome oben rechts auf ${icon('more', 'inl')}<b>Menü</b> tippen`)}
    ${step(2, '<b>App installieren</b> oder <b>Zum Startbildschirm hinzufügen</b> wählen')}
    ${step(3, 'Mit <b>Installieren</b> bestätigen')}
  </ol>`;
}
const otherSteps = (label, html) => `<details><summary>${icon('chev')}${label}</summary>${html}</details>`;
function installCard(ctx) {
  if (isStandalone()) return '';
  const head = (n, t) => `${ctx === 'konto' ? '<h2>App</h2>' : ''}<section class="card install"><div class="cardhead">${icon(n)}<b>${t}</b></div>`;
  if (justInstalled) {
    return `${head('check', 'Installiert')}<p class="small muted">Die Geschenkeliste liegt jetzt auf deinem Startbildschirm. Öffne sie am besten von dort.</p></section>`;
  }
  const p = platform();
  const ua = navigator.userAgent;
  const button = `<p class="small muted">Öffnet sich wie jede andere App, ohne Adressleiste.</p>
    <button class="primary withicon" data-act="install">${icon('download')}Installieren</button>`;
  if (p === 'ios') {
    const notSafari = /CriOS|FxiOS|EdgiOS|OPiOS|GSA\/|FBAN|FBAV|Instagram|Line\//.test(ua);
    const note = ctx === 'konto'
      ? (D.account ? 'Melde dich in der App mit deinem Benutzernamen an. Safari und App speichern getrennt.' : 'Sichere vorher dein Konto. Safari und App speichern getrennt, in der App meldest du dich mit Benutzername an.')
      : 'Danach die Geschenkeliste vom Home-Bildschirm aus öffnen und dort starten.';
    const code = ctx === 'login' && S.pendingJoin
      ? `<div class="invcode">Dein Einladungscode für die App<b class="code">${esc(String(S.pendingJoin).toUpperCase())}</b><small>In der App unter Gruppen eingeben.</small></div>` : '';
    return `${head('phone', 'Als App auf den Home-Bildschirm')}
      ${notSafari ? '<p class="small hint">Das geht am zuverlässigsten in Safari. Öffne diese Seite dort.</p>' : ''}
      ${iosSteps()}<p class="small muted note">${note}</p>${code}
      ${otherSteps('Anleitung für Android', androidSteps())}</section>`;
  }
  if (p === 'android') {
    const webview = /; wv\)/.test(ua);
    return `${head('phone', 'Als App installieren')}
      ${installEvt ? button : `${webview ? '<p class="small hint">Öffne diese Seite zuerst in Chrome.</p>' : ''}${androidSteps()}`}
      ${otherSteps('Anleitung für iPhone', iosSteps())}</section>`;
  }
  return `${head('phone', installEvt ? 'Als App installieren' : 'Auf dem Handy als App')}
    ${installEvt ? button : ''}
    ${otherSteps('Anleitung für iPhone', iosSteps())}${otherSteps('Anleitung für Android', androidSteps())}</section>`;
}
function paintInstall() {
  const el = $('#install');
  if (el) el.innerHTML = installCard(el.dataset.ctx);
}
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installEvt = e;
  paintInstall();
});
window.addEventListener('appinstalled', () => {
  installEvt = null;
  justInstalled = true;
  paintInstall();
});

/* Zähler am App-Symbol (1.8): Hinweis auf der Startseite und unter Konto */
function badgeCard(ctx) {
  const st = badgeState();
  if (st === 'none' || st === 'ok') return '';
  if (ctx === 'home' && (st === 'denied' || S.badgeAsked)) return '';
  if (st === 'denied') {
    return `<section class="card install"><div class="cardhead">${icon('bell')}<b>Zähler am App-Symbol</b></div>
      <p class="small muted">Ist ausgeschaltet. Du kannst ihn in den Einstellungen unter Mitteilungen bei Geschenkeliste erlauben.</p></section>`;
  }
  const text = 'Zeigt am Symbol auf dem Home-Bildschirm, wie viel neu ist. Dafür fragt das Gerät nach Mitteilungen. Nachrichten schickt die App noch keine.';
  if (ctx === 'home') {
    return `<div class="banner">${icon('bell')}<span><b>Zähler am App-Symbol</b><small>Zeigt am Symbol, wie viel neu ist.</small></span>
      <span class="bannerbtns"><button class="link" data-act="badgeperm">Einschalten</button><button class="link muted" data-act="badgelater">Später</button></span></div>`;
  }
  return `<section class="card install"><div class="cardhead">${icon('bell')}<b>Zähler am App-Symbol</b></div>
    <p class="small muted">${text}</p><button class="secondary withicon" data-act="badgeperm">${icon('bell')}Einschalten</button></section>`;
}

/* ---------- Benachrichtigungen (1.9) ----------
   Das Gerät meldet ein Push-Abo bei der Datenbank an. Was verschickt wird, entscheidet die Datenbank,
   die Edge Function „push“ verschickt. Der Schlüssel kommt vom Server (Verwaltung → Schlüssel erzeugen). */
const PREFS = [
  ['wish', 'Neue Wünsche', 'Aus deinen Gruppen'],
  ['member', 'Neue Mitglieder', 'Wenn jemand beitritt'],
  ['draw', 'Wichteln', 'Wenn ausgelost wurde'],
  ['have', 'Schon vorhanden', 'Bei etwas, das du reserviert hast'],
  ['remind', 'Erinnerung vor Heiligabend', '14, 7 und 1 Tag vorher']
];
const PUSH_OFF = 'geschenkeliste-push-aus';   // auf diesem Gerät bewusst ausgeschaltet
let push = { key: undefined, reg: null, sub: null, done: '', auto: false };
function b64u(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64u(str) {
  const s = atob(String(str).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
  return Uint8Array.from(s, c => c.charCodeAt(0));
}
function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}
function pushOffHere() { try { return localStorage.getItem(PUSH_OFF) === '1'; } catch (e) { return false; } }
function setPushOff(on) { try { on ? localStorage.setItem(PUSH_OFF, '1') : localStorage.removeItem(PUSH_OFF); } catch (e) { /* egal */ } }
/* none | install (iPhone ohne Home-Bildschirm) | off (Server nicht eingerichtet) | denied | ask | on */
function pushState() {
  if (!pushSupported()) return platform() === 'ios' && !isStandalone() && push.key ? 'install' : 'none';
  if (!push.key) return 'off';
  if (Notification.permission === 'denied') return 'denied';
  return Notification.permission === 'granted' && push.sub ? 'on' : 'ask';
}
function sameKey(sub, key) {
  const k = sub && sub.options && sub.options.applicationServerKey;
  if (!k) return true;
  const a = k instanceof ArrayBuffer ? new Uint8Array(k) : new Uint8Array(k.buffer, k.byteOffset, k.byteLength);
  return b64u(a) === key;
}
async function swReg() {
  if (push.reg) return push.reg;
  try { push.reg = (await navigator.serviceWorker.getRegistration()) || (await navigator.serviceWorker.register('sw.js')); } catch (e) { push.reg = null; }
  return push.reg;
}
async function pushRegister(sub) {
  const j = sub.toJSON();
  const id = me() + ' ' + j.endpoint;
  if (push.done === id) return;
  await sb('/rest/v1/rpc/push_subscribe', { method: 'POST', body: { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth } });
  push.done = id;
}
/* beim Start und beim Zurückkehren: Schlüssel holen, Abo prüfen und anmelden. Mit erlaubten Mitteilungen
   (z. B. für den Zähler aus 1.8) wird das Gerät ohne Nachfrage angemeldet. */
async function pushInit() {
  if (!S.session) return;
  try {
    if (push.key === undefined) push.key = await sb('/rest/v1/rpc/push_public_key', { method: 'POST', body: {} });
  } catch (e) { push.key = /Datenbank/.test(e.message) ? null : undefined; }
  if (!push.key || !pushSupported()) { paintPush(); return; }
  const reg = await swReg();
  if (!reg || !reg.pushManager) return;
  try {
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub, push.key)) { await sub.unsubscribe().catch(() => {}); sub = null; }
    if (!sub && Notification.permission === 'granted' && !pushOffHere()) {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: unb64u(push.key) });
      push.auto = true;
    }
    push.sub = sub;
    if (sub) await pushRegister(sub);
  } catch (e) { /* nächstes Mal */ }
  paintPush();
}
/* im Klick aufrufen: iPhone fragt nur nach einer Geste */
async function pushEnable() {
  if (!push.key) throw new Error('Die Benachrichtigungen sind noch nicht eingerichtet.');
  const reg = push.reg;
  const opt = { userVisibleOnly: true, applicationServerKey: unb64u(push.key) };
  let sub;
  try {
    sub = reg && reg.pushManager ? await reg.pushManager.subscribe(opt) : null;
    if (!sub) {
      await Notification.requestPermission();
      const r = await swReg();
      if (Notification.permission === 'granted' && r) sub = await r.pushManager.subscribe(opt);
    }
  } catch (e) { sub = null; }
  if (!sub) {
    if (Notification.permission === 'denied') throw new Error('Benachrichtigungen sind auf diesem Gerät abgelehnt.');
    throw new Error('Benachrichtigungen ließen sich nicht einschalten.');
  }
  setPushOff(false);
  push.sub = sub;
  push.done = '';
  await pushRegister(sub);
}
/* vor dem Abmelden: Gerät nicht mehr für dieses Konto benachrichtigen */
async function pushDetach() {
  if (!push.sub) return;
  try { await sb('/rest/v1/rpc/push_unsubscribe', { method: 'POST', body: { p_endpoint: push.sub.endpoint } }); } catch (e) { /* egal */ }
  push.done = '';
}
const prefOn = k => !D.pp || D.pp[k] !== false;
function notifyBody(st, ctx) {
  if (st === 'install') return `<p class="small muted">Auf dem iPhone kommen Benachrichtigungen nur in der App vom Home-Bildschirm.${ctx === 'konto' && !isStandalone() ? ' Wie das geht, steht oben unter App.' : ''}</p>`;
  if (st === 'denied') return '<p class="small muted">Sind auf diesem Gerät ausgeschaltet. Du kannst sie in den Einstellungen unter Mitteilungen bei Geschenkeliste erlauben.</p>';
  return `<p class="small muted">Bei neuen Wünschen, neuen Mitgliedern und wenn beim Wichteln ausgelost wurde. Was du bekommst, stellst du danach ein.</p>
    <button class="primary withicon" data-act="pushon">${icon('bell')}Benachrichtigungen erlauben</button>`;
}
function notifySection() {
  const st = pushState();
  if (st === 'none' || st === 'off') {
    const b = badgeCard('konto');
    return b ? (isStandalone() ? '<h2>App</h2>' : '') + b : '';
  }
  if (st !== 'on') {
    return `<h2>Benachrichtigungen</h2><section class="card install"><div class="cardhead">${icon('bell')}<b>${st === 'denied' ? 'Ausgeschaltet' : 'Benachrichtigungen'}</b></div>${notifyBody(st, 'konto')}</section>`;
  }
  const rows = PREFS.map(([k, t, d]) => {
    const on = prefOn(k);
    return `<li class="row-item"><span class="row-main"><span class="row-title">${t}</span><span class="row-meta">${d}</span></span>
      <button class="switch ${on ? 'on' : ''}" role="switch" aria-checked="${on}" aria-label="${t}" data-act="pref" data-k="${k}" data-on="${on ? '0' : '1'}"></button></li>`;
  }).join('');
  return `<h2>Benachrichtigungen</h2>
    <ul class="rows plain">${rows}</ul>
    <p class="foot">${icon('eyeoff')}<span>Was du dir wünschst, wer etwas reserviert und wen jemand beim Wichteln gezogen hat, verrät keine Nachricht.</span></p>
    <div class="card stack">
      <button class="secondary withicon" data-act="pushtest">${icon('bell')}Testnachricht senden</button>
      <button class="ghost danger-text" data-act="pushoff">Auf diesem Gerät ausschalten</button>
    </div>`;
}
/* Startseite: einmal fragen, sonst wie 1.8 der Hinweis zum Zähler */
function notifyBanner() {
  const st = pushState();
  if (st === 'on' && push.auto && !S.pushNotice) {
    return `<div class="banner">${icon('bell')}<span><b>Benachrichtigungen sind an</b><small>Was du bekommst, stellst du unter Konto ein.</small></span><button class="link" data-act="pushnotice">OK</button></div>`;
  }
  if (st === 'ask' && !S.pushAsked) {
    return `<div class="banner">${icon('bell')}<span><b>Benachrichtigungen</b><small>Bei Neuem in deinen Gruppen.</small></span>
      <span class="bannerbtns"><button class="link" data-act="pushon">Erlauben</button><button class="link muted" data-act="pushlater">Später</button></span></div>`;
  }
  return st === 'none' || st === 'off' ? badgeCard('home') : '';
}
/* nur den Bereich neu zeichnen, wenn sich am Stand etwas geändert hat */
function paintPush() {
  const st = pushState() + (push.auto ? '+' : '');
  if (paintPush.last === st) return;
  paintPush.last = st;
  const v = route()[0];
  if (S.session && D.loaded && !busy && !fresh && (!v || v === 'konto' || v === 'mehr')) render();
}
function pushAdmin() {
  const ps = D.ps;
  if (!ps) return '';
  const when = ts => ts ? `${ago(ts)}, ${fmtTime(ts)} Uhr` : 'noch nie';
  let body;
  if (!ps.configured) {
    body = `<p class="small muted">Erst die Edge Function „push“ in Supabase anlegen, wie in der Anleitung beschrieben. Dann hier die Schlüssel erzeugen. Sie werden in der Datenbank gespeichert.</p>
      <button class="primary withicon" data-act="pushsetup">${icon('key')}Schlüssel erzeugen</button>`;
  } else {
    const warn = [
      !ps.net ? 'pg_net fehlt, die Edge Function wird nicht geweckt. schema.sql erneut ausführen.' : '',
      !ps.cron ? 'pg_cron fehlt, Erinnerungen und gebündelte Nachrichten kommen nicht.' : '',
      ps.last_error ? 'Letzter Fehler: ' + ps.last_error : ''
    ].filter(Boolean).map(t => `<p class="small hint">${esc(t)}</p>`).join('');
    body = `<ul class="facts">
        <li><span>Eingerichtet</span><b>${esc(fmtDay(ps.since))}</b></li>
        <li><span>Geräte</span><b>${ps.devices} von ${plural(ps.people, 'Person', 'Personen')}</b></li>
        <li><span>Zuletzt verschickt</span><b>${esc(when(ps.last_run_at))}</b></li>
        <li><span>Letzte 24 Stunden</span><b>${plural(ps.sent_day, 'Nachricht', 'Nachrichten')}${ps.pending ? `, ${ps.pending} warten` : ''}</b></li>
      </ul>${warn}
      ${ui.confirmKeys
        ? `<p class="small">Alle Geräte werden abgemeldet und melden sich beim nächsten Öffnen der App neu an.</p><button class="danger" data-act="pushsetup">Wirklich neue Schlüssel</button>`
        : `<button class="ghost" data-act="askkeys">Neue Schlüssel erzeugen</button>`}`;
  }
  return `<div class="card stack"><div class="cardhead">${icon('bell')}<b>Benachrichtigungen</b></div>${body}</div>`;
}
async function makeVapid() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const j = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const pub = new Uint8Array(65);
  pub[0] = 4;
  pub.set(unb64u(j.x), 1);
  pub.set(unb64u(j.y), 33);
  return { pub: b64u(pub), priv: j.d };
}

function viewLogin() {
  const invited = S.pendingJoin ? `<div class="banner">${icon('people')}<span><b>Du wurdest eingeladen</b><small>Nach der Anmeldung bist du automatisch in der Gruppe.</small></span></div>` : '';
  return `<main class="login">
    ${brand()}
    <h1 class="title xl">Wünsche teilen, ohne die Überraschung zu verderben.</h1>
    <ul class="features">
      <li>${icon('people')}<span><b>Für Familie und Freunde</b>Eine Wunschliste, beliebig viele Gruppen.</span></li>
      <li>${icon('eyeoff')}<span><b>Reservierungen bleiben geheim</b>Wer sich etwas wünscht, sieht nicht, was schon vergeben ist.</span></li>
    </ul>
    ${invited}
    <div id="install" data-ctx="login">${installCard('login')}</div>
    <form data-form="start" class="card stack">
      <label>Neu hier? Wie heißt du?<input name="name" maxlength="40" placeholder="Vorname" required autocomplete="given-name" value="${esc(S.pendingName || '')}"></label>
      <button class="primary" type="submit">Weiter</button>
    </form>
    <div class="card stack">
      <div class="cardhead">${icon('key')}<b>Mit Benutzername anmelden</b></div>
      <form data-form="signin" class="stack">
        <input name="username" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" maxlength="24" placeholder="Benutzername" required>
        <input name="password" type="password" autocomplete="current-password" placeholder="Passwort" required>
        <button type="submit" class="secondary">Anmelden</button>
      </form>
      <a class="link center" href="#/vergessen">Passwort vergessen?</a>
    </div>
  </main>`;
}

function viewForgot() {
  return `<main class="login">
    <a class="back" href="#/">${icon('back')}<span>Anmelden</span></a>
    <h1 class="title xl">Passwort vergessen</h1>
    <p class="lead">Mit deinem Wiederherstellungscode wählst du ein neues Passwort. Hast du den Code nicht mehr, bekommst du einen Rücksetz-Code von der Person, die die App verwaltet.</p>
    <form data-form="recover" class="card stack">
      <label>Benutzername<input name="username" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" maxlength="24" required></label>
      <label>Code<input name="code" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" maxlength="24" placeholder="XXXX-XXXX-XXXX-XXXX" required></label>
      <label>Neues Passwort<input name="password" type="password" autocomplete="new-password" minlength="8" placeholder="Mindestens 8 Zeichen" required></label>
      <button class="primary" type="submit">Passwort ändern</button>
    </form>
  </main>`;
}

function viewCode() {
  const recovered = fresh.reason === 'recovered';
  return `<main class="login">
    ${brand()}
    <h1 class="title xl">${recovered ? 'Neues Passwort gespeichert' : 'Dein Wiederherstellungs&shy;code'}</h1>
    <p class="lead">${recovered ? 'Dein alter Code gilt nicht mehr. Hier ist dein neuer. ' : ''}Mit diesem Code kommst du wieder in dein Konto, falls du dein Passwort vergisst. Er wird nur jetzt angezeigt.</p>
    <div class="card codecard">
      <p class="eyebrow">Benutzername ${esc(fresh.username || '')}</p>
      <p class="code big" id="rcode">${esc(fmtRecovery(fresh.code))}</p>
      <div class="btnrow">
        <button class="secondary withicon" data-act="copycode">${icon('copy')}Kopieren</button>
        <button class="secondary withicon" data-act="sharecode">${icon('share')}Teilen</button>
      </div>
      <p class="small muted">Am besten über Teilen in den Notizen sichern.</p>
    </div>
    <form data-form="confirmcode" class="card stack">
      <label>Zur Bestätigung die letzten 4 Zeichen<input name="last4" maxlength="4" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" required></label>
      <button class="primary" type="submit">Weiter</button>
    </form>
  </main>`;
}

function viewName() {
  return `<main class="login">
    ${brand()}
    <h1 class="title xl">Wie heißt du?</h1>
    <p class="lead">So sehen dich die anderen in deinen Gruppen.</p>
    <form data-form="name" class="card stack">
      <input name="name" maxlength="40" placeholder="Vorname" required autofocus autocomplete="given-name">
      <button class="primary" type="submit">Weiter</button>
    </form>
  </main>`;
}

function viewHome() {
  const gs = myGroups();
  const mine = openWishes(me());
  const errands = D.res.filter(r => r.user_id === me())
    .map(r => ({ r, w: D.wishes.find(w => w.id === r.wish_id) })).filter(x => x.w);
  const bought = errands.filter(x => x.r.status === 'gekauft').length;
  const days = daysToXmas();
  const today = new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());

  const acc = D.account;
  const secure = needsSecure() ? `<a class="banner tap" href="#/konto">${icon('lock')}<span><b>Konto sichern</b><small>Mit Benutzername und Passwort kommst du auf jedem Gerät an deine Liste.</small></span>${icon('chev', 'chev')}</a>`
    : (acc && acc.reset_notice ? `<div class="banner notice">${icon('shield')}<span><b>Dein Zugang wurde am ${esc(fmtDay(acc.reset_at))} zurückgesetzt</b><small>Du hast jetzt ein neues Passwort und einen neuen Wiederherstellungscode.</small></span><button class="link" data-act="dismissreset">OK</button></div>` : '');
  const hero = heroCard(days, errands.length, bought);
  const stats = `<div class="stats">
      <a href="#/liste"><b>${mine.length}</b><span>${mine.length === 1 ? 'Wunsch' : 'Wünsche'}</span></a>
      <div><b>${errands.length ? `${bought}<small>/${errands.length}</small>` : '0'}</b><span>besorgt</span></div>
      <a href="#/gruppen"><b>${gs.length}</b><span>${gs.length === 1 ? 'Gruppe' : 'Gruppen'}</span></a>
    </div>`;

  if (!gs.length) {
    return shell('Hallo ' + myName(), `${secure}${notifyBanner()}${hero}${stats}
      <div class="card cta">
        <h3>Starte mit deiner Familie</h3>
        <p>Lege eine Gruppe an und teile den Einladungscode. Alle in der Gruppe sehen gegenseitig ihre Wunschlisten.</p>
        <div class="btnrow"><a class="primary" href="#/gruppen">Gruppe anlegen</a><a class="secondary" href="#/gruppen">Code eingeben</a></div>
      </div>`, { tab: 'home', eyebrow: today });
  }

  const wRows = gs.map(g => ({ g, st: wichtelState(g.id) })).filter(x => x.st.receiver || x.st.missing).map(({ g, st }) => {
    if (!st.receiver) {
      return `<li><a class="row-item" href="#/g/${g.id}/wichteln"><span class="tile plain">${icon('shuffle')}</span>
        <span class="row-main"><span class="row-title">Wichteln in ${esc(g.name)}</span><span class="row-meta">Deine Zuteilung fehlt, es muss neu ausgelost werden</span></span>${icon('chev', 'chev')}</a></li>`;
    }
    const n = openWishes(st.receiver, g.id).length;
    const drawNew = isNewDraw(g.id);
    if (drawNew) markSeen('d', g.id, st.at);
    return `<li><a class="row-item" href="#/g/${g.id}/p/${st.receiver}">${avatar(st.receiver)}
      <span class="row-main"><span class="row-title">Du beschenkst ${esc(nameOf(st.receiver))}</span><span class="row-meta">${drawNew ? newTag('Neu ausgelost') : ''}${esc(g.name)} · ${n ? plural(n, 'Wunsch', 'Wünsche') : 'noch keine Wünsche'}</span></span>${icon('chev', 'chev')}</a></li>`;
  }).join('');
  const wichtelHtml = wRows ? `<h2>Wichteln</h2><ul class="rows">${wRows}</ul>` : '';

  // „Hab ich schon“: Hinweis an alle, die das noch nicht gekauft haben
  const haveWarn = errands.filter(x => x.w.have_at && x.r.status !== 'gekauft').map(({ w }) =>
    `<div class="banner warn">${icon('gift')}<span><b>${esc(nameOf(w.owner))} hat „${esc(w.title)}“ schon</b><small>Gib die Reservierung frei, falls du es noch nicht gekauft hast.</small></span><button class="link" data-act="unreserve" data-id="${w.id}">Freigeben</button></div>`).join('');
  const errHtml = errands.length ? `${haveWarn}<ul class="rows">${errands.map(({ r, w }) => {
    const g = groupFor(w);
    const done = r.status === 'gekauft';
    return `<li class="row-item ${done ? 'done' : ''}">
        <button class="tick ${done ? 'on' : ''}" data-act="resstatus" data-id="${w.id}" data-s="${done ? 'reserviert' : 'gekauft'}" aria-label="${done ? 'Doch nicht gekauft' : 'Als gekauft markieren'}">${icon('check')}</button>
        <a class="row-main" href="${g ? `#/g/${g}/p/${w.owner}` : '#/'}"><span class="row-title">${esc(w.title)}</span><span class="row-meta ${w.have_at ? 'warn' : ''}">für ${esc(nameOf(w.owner))} · ${w.have_at ? `hat ${esc(nameOf(w.owner))} schon` : (done ? 'gekauft' : 'reserviert')}</span></a>
        ${avatar(w.owner, 'sm')}
      </li>`;
  }).join('')}</ul>`
    : `<p class="empty-line">Noch nichts reserviert. Öffne eine Liste in deinen Gruppen und tippe auf „Reservieren“.</p>`;

  // Neu seit dem letzten Besuch: erst neue Mitglieder, dann neue Wünsche (sonst die letzten 6)
  const nw = newWishes(), nm = newMembers();
  const FEED_MAX = 8;
  const wishRow = w => {
    const g = groupFor(w);
    const r = resOf(w.id);
    const isNew = nw.includes(w);
    return `<li><a class="row-item ${isNew ? 'isnew' : ''}" href="${g ? `#/g/${g}/p/${w.owner}` : '#/'}">${avatar(w.owner)}
        <span class="row-main"><span class="row-title">${esc(w.title)}</span><span class="row-meta">${esc(nameOf(w.owner))} · ${ago(w.created_at)}${r ? ' · vergeben' : ''}</span></span>${isNew ? '<span class="newdot" aria-label="neu"></span>' : ''}${icon('chev', 'chev')}</a></li>`;
  };
  const memberRow = m => {
    const g = D.groups.find(x => x.id === m.group_id);
    const n = openWishes(m.user_id, m.group_id).length;
    return `<li><a class="row-item isnew" href="#/g/${m.group_id}/p/${m.user_id}">${avatar(m.user_id)}
        <span class="row-main"><span class="row-title">${esc(nameOf(m.user_id))} ist dabei</span><span class="row-meta">${esc(g ? g.name : '')} · ${ago(m.joined_at)}${n ? ' · ' + plural(n, 'Wunsch', 'Wünsche') : ''}</span></span><span class="newdot" aria-label="neu"></span>${icon('chev', 'chev')}</a></li>`;
  };
  let feedHtml, feedHead;
  if (nw.length || nm.length) {
    // Wünsche neuer Mitglieder stehen schon in deren Zeile
    const own = nw.filter(w => !nm.some(m => m.user_id === w.owner));
    const ws = own.slice(0, Math.max(0, FEED_MAX - nm.length));
    const rest = own.length - ws.length;
    feedHead = `<div class="sechead"><h2>Neu seit deinem letzten Besuch</h2><button class="link" data-act="seenall">Alles gesehen</button></div>`;
    feedHtml = `<ul class="rows">${nm.map(memberRow).join('')}${ws.map(wishRow).join('')}</ul>`
      + (rest > 0 ? `<p class="empty-line">Und ${plural(rest, 'weiterer Wunsch', 'weitere Wünsche')}. <a href="#/gruppen">Zu den Gruppen</a></p>` : '');
  } else {
    const feed = othersWishes().slice(0, 6);
    feedHead = '<h2>Neu in deinen Gruppen</h2>';
    feedHtml = feed.length ? `<ul class="rows">${feed.map(wishRow).join('')}</ul>`
      : `<p class="empty-line">Sobald jemand aus deinen Gruppen etwas einträgt, erscheint es hier.</p>`;
  }

  return shell('Hallo ' + myName(), `${secure}${notifyBanner()}${hero}${stats}${wichtelHtml}
    <h2>Deine Besorgungen</h2>${errHtml}
    ${feedHead}${feedHtml}`, { tab: 'home', eyebrow: today });
}

/* ---------- Design (1.10) ---------- */
function theme() { return window.GLTheme ? GLTheme.resolve() : 'jahr'; }
function xmasYear() { const d = new Date(); return d.getMonth() === 0 ? d.getFullYear() - 1 : d.getFullYear(); }
function heroCard(days, nErr, nDone) {
  const when = days === 0 ? 'heute' : (days === 1 ? 'morgen' : `in ${days} Tagen`);
  if (theme() !== 'weihnachten') {
    return `<section class="hero hero-jahr"><span class="hero-ic">${icon('calendar')}</span>
      <div class="hero-main"><p class="hero-label">Nächster Anlass · ${when}</p><p class="hero-title">Heiligabend · 24.12.</p></div></section>`;
  }
  const sub = nErr ? `${nDone} von ${plural(nErr, 'Besorgung', 'Besorgungen')} erledigt` : 'Noch nichts reserviert';
  return `<section class="hero hero-xmas"><p class="hero-num">${days === 0 ? 'Heute' : days}</p>
      <div class="hero-main"><p class="hero-title">${days === 0 ? 'ist Heiligabend' : (days === 1 ? 'Tag bis Heiligabend' : 'Tage bis Heiligabend')}</p><p class="hero-label">${sub}</p></div>
      <span class="hero-deco">${icon('star')}${icon('snow')}</span></section>`;
}
const THEMES = [
  ['auto', 'Automatisch', 'Weihnachten vom 1. November bis 6. Januar, sonst Ganzjährig'],
  ['jahr', 'Ganzjährig', 'Violett, Koralle und Sonnengelb'],
  ['weihnachten', 'Weihnachten', 'Zuckerstange, Minze und Vanille']];
function themeSection() {
  const p = window.GLTheme ? GLTheme.pref() : 'auto';
  const opts = THEMES.map(([k, n, d]) => `<button class="themeopt ${p === k ? 'on' : ''}" role="radio" aria-checked="${p === k}" data-act="theme" data-v="${k}">
      <span class="swatches sw-${k}"><i></i><i></i><i></i></span><span class="themetext"><b>${n}</b><small>${d}</small></span>${icon('check', 'themecheck')}</button>`).join('');
  const m = window.GLTheme ? GLTheme.modePref() : 'auto';
  const modes = [['light', 'Hell', 'sun'], ['auto', 'Automatisch', ''], ['dark', 'Dunkel', 'moon']].map(([k, n, ic]) =>
    `<label><input type="radio" name="mode" value="${k}" data-act="mode" data-v="${k}" ${m === k ? 'checked' : ''}><span>${ic ? icon(ic) : ''}${n}</span></label>`).join('');
  return `<h2>Design</h2><div class="themes" role="radiogroup" aria-label="Design">${opts}</div>
    <div class="seg modeseg" role="radiogroup" aria-label="Hell oder dunkel">${modes}</div>`;
}

function wishMeta(w, extra = []) {
  return [w.price != null ? fmtPrice(w.price) : '', w.category ? catName(w.category) : '', ...extra].filter(Boolean).join(' · ');
}
function prioMark(w) {
  return prio(w) === 3 && !w.have_at ? `<span class="prio" title="Sehr gern">${icon('heart')}</span>` : '';
}
function viewList() {
  const all = wishesOf(me());
  const list = all.filter(w => !w.have_at).sort(byPrio);
  const have = all.filter(w => w.have_at);
  const row = w => `<li><a class="card row-item wish ${w.have_at ? 'had' : ''}" href="#/w/${w.id}">${tile(w)}
      <span class="row-main"><span class="row-title">${prioMark(w)}${esc(w.title)}</span>
      <span class="row-meta">${esc(w.have_at ? 'seit ' + fmtDay(w.have_at) : wishMeta(w, [prio(w) === 1 ? 'Idee' : '', w.url ? domain(w.url) : '', visLabel(w)]))}</span></span>${icon('chev', 'chev')}</a></li>`;
  const add = `<a class="primary withicon" href="#/w/neu">${icon('plus')}Wunsch hinzufügen</a>`;
  const haveHtml = have.length ? `<h2>Hab ich schon</h2><ul class="cards">${have.map(row).join('')}</ul>` : '';
  const body = all.length
    ? `${add}${list.length ? `<ul class="cards">${list.map(row).join('')}</ul>` : '<p class="empty-line">Alles auf deiner Liste hast du schon.</p>'}${haveHtml}<p class="foot">${icon('eyeoff')}<span>Ob etwas reserviert ist, siehst du nicht. So bleibt es eine Überraschung.</span></p>`
    : emptyState('gift', 'Deine Liste ist noch leer', 'Trag ein, worüber du dich freuen würdest. Ein Link hilft den anderen, genau das Richtige zu finden.', add);
  return shell('Meine Wunschliste', body, { tab: 'list', eyebrow: theme() === 'weihnachten' ? 'Weihnachten ' + xmasYear() : 'Alle Anlässe', sub: plural(list.length, 'Wunsch', 'Wünsche') });
}

function viewWishForm(id) {
  const pre = id === 'neu' ? sharedPrefill() : null;
  const w = id === 'neu' ? { title: pre ? pre.title : '', url: pre ? pre.url : '', note: '', all_groups: true, priority: 2 } : D.wishes.find(x => x.id === id && x.owner === me());
  if (!w) return shell('Wunsch', emptyState('gift', 'Nicht gefunden', 'Diesen Wunsch gibt es nicht mehr.'), { tab: 'list', back: ['#/liste', 'Wunschliste'] });
  const gs = myGroups();
  const sel = id === 'neu' ? [] : groupIdsOf(id);
  const boxes = gs.map(g => `<label class="check"><input type="checkbox" name="g" value="${g.id}" ${sel.includes(g.id) ? 'checked' : ''}><span>${esc(g.name)}</span></label>`).join('');
  const vis = gs.length ? `
    <h2>Sichtbar für</h2>
    <div class="card options">
      <label class="check"><input type="radio" name="vis" value="all" ${w.all_groups ? 'checked' : ''}><span>Alle meine Gruppen</span></label>
      <label class="check"><input type="radio" name="vis" value="some" ${w.all_groups ? '' : 'checked'}><span>Nur ausgewählte Gruppen</span></label>
      <div class="sub ${w.all_groups ? 'hide' : ''}" id="gsel">${boxes}</div>
    </div>` : `<p class="foot">${icon('people')}<span>Sichtbar für alle Gruppen, denen du später beitrittst.</span></p>`;
  const cats = '<option value="">Keine</option>' + CATS.map(([k, n]) => `<option value="${k}" ${w.category === k ? 'selected' : ''}>${esc(n)}</option>`).join('');
  const prios = PRIOS.map(([v, n]) => `<label><input type="radio" name="prio" value="${v}" ${prio(w) === v ? 'checked' : ''}><span>${n}</span></label>`).join('');
  const have = id === 'neu' ? '' : (w.have_at
    ? `<button type="button" class="secondary" data-act="unhave" data-id="${id}">Doch wieder wünschen</button>`
    : `<button type="button" class="secondary withicon" data-act="have" data-id="${id}">${icon('check')}Hab ich schon</button>`);
  const haveNote = w.have_at ? `<div class="banner">${icon('check')}<span><b>Hast du schon seit ${esc(fmtDay(w.have_at))}</b><small>Die anderen sehen das und können es nicht mehr reservieren.</small></span></div>` : '';
  const del = id === 'neu' ? '' : (ui.confirmDel === id
    ? `<button type="button" class="danger" data-act="delwish" data-id="${id}">Wirklich löschen</button>`
    : `<button type="button" class="ghost danger-text" data-act="askdel" data-id="${id}">Wunsch löschen</button>`);
  return shell(id === 'neu' ? 'Neuer Wunsch' : 'Wunsch bearbeiten', `
    ${haveNote}
    <form data-form="wish" data-id="${id}" class="stack">
      <div class="card fields">
        <label>Was wünschst du dir?<input name="title" maxlength="120" required value="${esc(w.title)}" placeholder="z. B. Kochbuch „Simple“"></label>
        <div class="field"><div class="fieldhead"><label for="f-url">Link</label><button type="button" class="link withicon" data-act="pasteurl">${icon('paste')}Einfügen</button></div>
          <input id="f-url" name="url" inputmode="url" autocomplete="off" value="${esc(w.url || '')}" placeholder="https://"></div>
        <div class="two">
          <label>Preis<span class="money"><input name="price" inputmode="decimal" autocomplete="off" maxlength="12" value="${esc(priceInput(w.price))}" placeholder="ca."><span>€</span></span></label>
          <label>Kategorie<select name="category">${cats}</select></label>
        </div>
        <div class="field"><span class="flabel">Wie sehr wünschst du es dir?</span><div class="seg">${prios}</div></div>
        <label>Notiz<textarea name="note" maxlength="1000" rows="3" placeholder="Größe, Farbe, Alternativen">${esc(w.note || '')}</textarea></label>
      </div>
      ${vis}
      <button class="primary" type="submit">Speichern</button>
      ${have}
      ${del}
    </form>`, { tab: 'list', back: ['#/liste', 'Wunschliste'] });
}

function viewGroups() {
  const gs = myGroups();
  const rows = gs.map(g => {
    const ms = membersOf(g.id).map(m => m.user_id);
    const n = D.wishes.filter(w => ms.includes(w.owner) && w.owner !== me() && !w.have_at && visibleIn(w, g.id)).length;
    const nnew = newIn(g.id).length + newMembers().filter(m => m.group_id === g.id).length + (newDraws().some(x => x.gid === g.id) ? 1 : 0);
    return `<li><a class="row-item group" href="#/g/${g.id}"><span class="tile c${hueIdx(g.id)}">${esc(initials(g.name))}</span>
      <span class="row-main"><span class="row-title">${esc(g.name)}</span><span class="row-meta">${plural(ms.length, 'Mitglied', 'Mitglieder')} · ${plural(n, 'Wunsch', 'Wünsche')}${nnew ? ` · <b class="newtxt">${nnew} neu</b>` : ''}</span></span>
      ${nnew ? countBadge(nnew) : avStack(ms)}${icon('chev', 'chev')}</a></li>`;
  }).join('');
  const forms = `
    <h2>Neue Gruppe</h2>
    <div class="card"><form data-form="newgroup" class="inline"><input name="name" maxlength="40" placeholder="Name, z. B. Familie" required><button class="primary" type="submit">Anlegen</button></form></div>
    <h2>Mit Code beitreten</h2>
    <div class="card"><form data-form="join" class="inline"><input name="code" maxlength="12" placeholder="ABCD-1234" autocapitalize="characters" autocomplete="off" required><button class="secondary" type="submit">Beitreten</button></form></div>`;
  const body = gs.length
    ? `<ul class="rows">${rows}</ul>${forms}`
    : emptyState('people', 'Noch in keiner Gruppe', 'Lege eine Gruppe an und lade andere mit dem Code ein, oder tritt einer bestehenden Gruppe bei.') + forms;
  return shell('Gruppen', body, { tab: 'groups', sub: gs.length ? plural(gs.length, 'Gruppe', 'Gruppen') : '' });
}

function viewGroup(gid) {
  const g = myGroups().find(x => x.id === gid);
  if (!g) return shell('Gruppe', emptyState('people', 'Nicht gefunden', 'Diese Gruppe gibt es nicht mehr.'), { tab: 'groups', back: ['#/gruppen', 'Gruppen'] });
  const ms = membersOf(gid).slice().sort((a, b) => (a.user_id === me()) - (b.user_id === me()) || nameOf(a.user_id).localeCompare(nameOf(b.user_id), 'de'));
  const rows = ms.map(m => {
    const ws = openWishes(m.user_id, gid);
    if (m.user_id === me()) {
      return `<li><a class="row-item person self" href="#/liste">${avatar(m.user_id)}
        <span class="row-main"><span class="row-title">Du</span><span class="row-meta">${plural(ws.length, 'Wunsch', 'Wünsche')} für diese Gruppe sichtbar</span></span>${icon('chev', 'chev')}</a></li>`;
    }
    const taken = ws.filter(w => resOf(w.id)).length;
    const meta = ws.length ? `${plural(ws.length, 'Wunsch', 'Wünsche')} · ${ws.length - taken} frei` : 'Noch keine Wünsche';
    const joined = isNewMember(gid, m.user_id);
    if (joined) markSeen('m', mkey(gid, m.user_id));
    const nn = newIn(gid, m.user_id).length;
    return `<li><a class="row-item person" href="#/g/${gid}/p/${m.user_id}">${avatar(m.user_id)}
      <span class="row-main"><span class="row-title">${esc(nameOf(m.user_id))}</span><span class="row-meta">${joined ? newTag('Neu dabei') : ''}${meta}${nn ? ` · <b class="newtxt">${nn} neu</b>` : ''}</span></span>${countBadge(nn)}${icon('chev', 'chev')}</a></li>`;
  }).join('');
  const leave = ui.confirmLeave === gid
    ? `<button class="danger" data-act="leave" data-id="${gid}">Wirklich verlassen</button>`
    : `<button class="ghost danger-text" data-act="askleave" data-id="${gid}">Gruppe verlassen</button>`;
  const st = wichtelState(gid);
  let wMeta = '';
  if (st.drawn) {
    if (st.receiver) wMeta = `Du beschenkst ${esc(nameOf(st.receiver))}`;
    if (isNewDraw(gid)) { wMeta = newTag('Neu ausgelost') + wMeta; markSeen('d', gid, st.at); }
    else if (st.missing) wMeta = 'Deine Zuteilung fehlt, neu auslosen';
    else wMeta = `Ausgelost am ${esc(fmtDay(st.at))}`;
  } else if (isFounder(g)) wMeta = 'Noch nicht ausgelost';
  const wichtel = wMeta ? `<h2>Wichteln</h2><ul class="rows"><li><a class="row-item" href="#/g/${gid}/wichteln"><span class="tile plain">${icon('shuffle')}</span>
      <span class="row-main"><span class="row-title">Wichteln</span><span class="row-meta">${wMeta}</span></span>${icon('chev', 'chev')}</a></li></ul>` : '';
  return shell(g.name, `
    <div class="card invite">
      <div><p class="eyebrow">Einladungscode</p><p class="code" id="gcode">${esc(fmtCode(g.code))}</p></div>
      <button class="primary withicon" data-act="invite" data-id="${gid}">${icon('share')}Einladen</button>
    </div>
    <h2>Mitglieder</h2>
    <ul class="rows">${rows}</ul>
    ${wichtel}
    <h2>Verwalten</h2>
    <div class="card stack">
      <form data-form="rename" data-id="${gid}" class="inline"><input name="name" maxlength="40" value="${esc(g.name)}" required><button class="secondary" type="submit">Umbenennen</button></form>
      ${leave}
    </div>`, { tab: 'groups', back: ['#/gruppen', 'Gruppen'], sub: `${plural(ms.length, 'Mitglied', 'Mitglieder')}` });
}

function viewPerson(gid, uid) {
  const g = myGroups().find(x => x.id === gid);
  if (!g || !membersOf(gid).some(m => m.user_id === uid) || uid === me()) {
    return shell('Liste', emptyState('gift', 'Nicht verfügbar', 'Diese Liste kannst du nicht sehen.'), { tab: 'groups', back: ['#/g/' + gid, 'Gruppe'] });
  }
  const name = nameOf(uid);
  const all = wishesOf(uid, gid);
  const ws = all.filter(w => !w.have_at).sort(byPrio);
  const had = all.filter(w => w.have_at);
  const taken = ws.filter(w => resOf(w.id)).length;
  // Beim Ansehen der Liste gilt alles darauf als gesehen; die Markierung bleibt, bis du die Seite verlässt
  if (isNewMember(gid, uid)) markSeen('m', mkey(gid, uid));
  ws.filter(isNewWish).forEach(w => markSeen('w', w.id));
  const card = w => {
    const r = resOf(w.id);
    let pill = '', acts = '', warn = '';
    if (w.have_at) {
      pill = `<span class="pill">Hat ${esc(name)} schon</span>`;
      if (r && r.user_id === me()) {
        warn = `<p class="wwarn">${r.status === 'gekauft' ? 'Du hast es schon gekauft. Vielleicht lässt es sich umtauschen.' : 'Du hattest es reserviert. Gib es frei, falls du es noch nicht gekauft hast.'}</p>`;
        acts = `<button class="${r.status === 'gekauft' ? 'ghost' : 'primary'} sm" data-act="unreserve" data-id="${w.id}">Freigeben</button>`;
      }
    } else if (!r) {
      pill = '<span class="pill open">Offen</span>';
      acts = `<button class="primary sm" data-act="reserve" data-id="${w.id}">Reservieren</button>`;
    } else if (r.user_id === me()) {
      pill = `<span class="pill green">${icon(r.status === 'gekauft' ? 'check' : 'lock')}${r.status === 'gekauft' ? 'Von dir gekauft' : 'Von dir reserviert'}</span>`;
      acts = (r.status === 'gekauft'
        ? `<button class="secondary sm" data-act="resstatus" data-id="${w.id}" data-s="reserviert">Doch nicht gekauft</button>`
        : `<button class="primary sm" data-act="resstatus" data-id="${w.id}" data-s="gekauft">Als gekauft markieren</button>`)
        + `<button class="ghost sm" data-act="unreserve" data-id="${w.id}">Freigeben</button>`;
    } else {
      pill = `<span class="pill gold">${icon(r.status === 'gekauft' ? 'check' : 'lock')}${r.status === 'gekauft' ? 'Gekauft' : 'Reserviert'} von ${esc(nameOf(r.user_id))}</span>`;
    }
    const link = w.url ? `<a class="link-out" href="${esc(w.url)}" target="_blank" rel="noopener noreferrer">${icon('link')}${esc(domain(w.url) || 'Link')}</a>` : '';
    const meta = wishMeta(w);
    const tag = (isNewWish(w) ? newTag() : '') + (w.have_at ? '' : prio(w) === 3 ? `<span class="tag hi">${icon('heart')}Sehr gern</span>` : (prio(w) === 1 ? '<span class="tag">Nur eine Idee</span>' : ''));
    return `<li class="card wish ${r || w.have_at ? 'taken' : ''} ${w.have_at ? 'had' : ''} ${isNewWish(w) ? 'isnew' : ''}">
      <div class="wish-head">${tile(w)}<div class="row-main"><h3>${esc(w.title)}</h3>
        ${meta || tag ? `<p class="wmeta">${tag}${meta ? `<span>${esc(meta)}</span>` : ''}</p>` : ''}${link}</div></div>
      ${w.note ? `<p class="wnote">${esc(w.note)}</p>` : ''}
      ${warn}
      ${pill || acts ? `<div class="wish-foot">${pill}${acts ? `<div class="acts">${acts}</div>` : ''}</div>` : ''}
    </li>`;
  };

  // Filter: nur frei, Preisspanne, Kategorie (nur was in der Liste vorkommt)
  const f = ui.filter || {};
  const shown = ws.filter(w => (!f.free || !resOf(w.id)) && (!f.price || priceBucket(w.price) === f.price) && (!f.cat || (w.category || 'sonstiges') === f.cat));
  const buckets = PRICES.filter(b => ws.some(w => priceBucket(w.price) === b[0]));
  const cats = CATS.filter(c => ws.some(w => w.category && w.category === c[0]));
  const chip = (k, v, label, on) => `<button class="chip ${on ? 'on' : ''}" data-act="filt" data-k="${k}" data-v="${v}" aria-pressed="${on}">${esc(label)}</button>`;
  const filterBar = ws.length >= 3 ? `<div class="chips" role="group" aria-label="Filter">
      ${chip('free', '1', 'Noch frei', !!f.free)}${buckets.map(b => chip('price', b[0], b[1], f.price === b[0])).join('')}</div>
      ${cats.length >= 2 ? `<div class="chips">${cats.map(c => chip('cat', c[0], c[1], f.cat === c[0])).join('')}</div>` : ''}` : '';
  const filtered = f.free || f.price || f.cat;
  const list = shown.length ? `<ul class="cards">${shown.map(card).join('')}</ul>`
    : (ws.length ? `<p class="empty-line">Nichts passt zum Filter. <button class="link" data-act="filtreset">Filter aufheben</button></p>` : '');
  const hadHtml = had.length && !filtered ? `<h2>Hat ${esc(name)} schon</h2><ul class="cards">${had.map(card).join('')}</ul>` : '';

  const head = `<section class="profile">${avatar(uid, 'lg')}<div class="profile-main">
      <p class="row-meta">${ws.length ? `${plural(ws.length, 'Wunsch', 'Wünsche')} · ${ws.length - taken} noch frei` : 'Noch keine Wünsche'}</p>
      ${ws.length ? `<progress max="${ws.length}" value="${taken}"></progress>` : ''}</div></section>
    <p class="foot">${icon('eyeoff')}<span>${esc(name)} sieht nicht, was reserviert oder gekauft ist.</span></p>`;
  const body = ws.length || had.length ? filterBar + list + hadHtml : emptyState('gift', 'Noch leer', `${esc(name)} hat für diese Gruppe noch nichts eingetragen.`);
  return shell(name, head + body, { tab: 'groups', back: ['#/g/' + gid, g.name] });
}

function viewWichteln(gid) {
  const g = myGroups().find(x => x.id === gid);
  if (!g) return shell('Wichteln', emptyState('people', 'Nicht gefunden', 'Diese Gruppe gibt es nicht mehr.'), { tab: 'groups', back: ['#/gruppen', 'Gruppen'] });
  const st = wichtelState(gid);
  const founder = isFounder(g);
  const opt = { tab: 'groups', back: ['#/g/' + gid, g.name], sub: esc(g.name) };
  let top = '';
  if (st.receiver) {
    const n = openWishes(st.receiver, gid).length;
    const drawNew = isNewDraw(gid);
    if (drawNew) markSeen('d', gid, st.at);
    top = `<div class="card reveal">
      ${avatar(st.receiver, 'lg')}
      ${drawNew ? newTag('Neu ausgelost') : ''}
      <p class="eyebrow">Du beschenkst</p>
      <p class="reveal-name">${esc(nameOf(st.receiver))}</p>
      <p class="small muted">${n ? plural(n, 'Wunsch', 'Wünsche') + ' auf der Liste' : 'Noch keine Wünsche auf der Liste'}</p>
      <a class="primary" href="#/g/${gid}/p/${st.receiver}">Wunschliste ansehen</a>
    </div>
    <p class="foot">${icon('eyeoff')}<span>Ausgelost am ${esc(fmtDay(st.at))}. Nur du siehst, wen du gezogen hast.</span></p>`;
  } else if (st.missing) {
    top = `<div class="banner">${icon('shuffle')}<span><b>Deine Zuteilung gibt es nicht mehr</b><small>Jemand hat die Gruppe verlassen. ${founder ? 'Lose neu aus, damit alle wieder jemanden haben.' : esc(nameOf(g.created_by)) + ' muss neu auslosen.'}</small></span></div>`;
  } else if (st.drawn) {
    top = `<div class="banner">${icon('shuffle')}<span><b>Du machst nicht mit</b><small>Ausgelost am ${esc(fmtDay(st.at))} ohne dich.</small></span></div>`;
  } else {
    top = emptyState('shuffle', 'Noch nicht ausgelost', founder
      ? 'Leg fest, wer mitmacht und wer wen nicht ziehen darf. Danach sieht jeder nur, wen er beschenkt.'
      : `${esc(nameOf(g.created_by))} startet die Auslosung. Danach siehst du hier, wen du beschenkst.`);
  }
  if (!founder) return shell('Wichteln', top, opt);

  const ms = membersOf(gid).map(m => m.user_id)
    .sort((a, b) => (a !== me()) - (b !== me()) || nameOf(a).localeCompare(nameOf(b), 'de'));
  const who = u => u === me() ? myName() || 'Du' : nameOf(u);
  const count = ms.filter(u => takesPart(gid, u)).length;
  const partRows = ms.map(u => {
    const on = takesPart(gid, u);
    return `<li class="row-item">
      <button class="tick ${on ? 'on' : ''}" data-act="wpart" data-id="${gid}" data-u="${u}" data-on="${on ? '0' : '1'}" aria-label="${on ? 'Macht nicht mit' : 'Macht mit'}">${icon('check')}</button>
      ${avatar(u, 'sm')}<span class="row-main"><span class="row-title">${esc(who(u))}</span></span></li>`;
  }).join('');
  const ex = exclOf(gid);
  const exRows = ex.map(x => {
    const [p, q] = who(x.a).localeCompare(who(x.b), 'de') <= 0 ? [x.a, x.b] : [x.b, x.a];
    return `<li class="row-item"><span class="avs">${avatar(p, 'xs')}${avatar(q, 'xs')}</span>
      <span class="row-main"><span class="row-title">${esc(who(p))} und ${esc(who(q))}</span></span>
      <button class="ghost sm danger-text" data-act="wexdel" data-id="${gid}" data-u="${x.a}" data-v="${x.b}">Entfernen</button></li>`;
  }).join('');
  const opts = '<option value="">Person</option>' + ms.map(u => `<option value="${u}">${esc(who(u))}</option>`).join('');
  const exForm = ms.length >= 2 ? `<form data-form="wex" data-id="${gid}" class="card stack">
      <div class="pair"><select name="a" aria-label="Erste Person" required>${opts}</select><span class="muted">und</span><select name="b" aria-label="Zweite Person" required>${opts}</select></div>
      <button class="secondary" type="submit">Ausschluss hinzufügen</button>
    </form>` : '';
  let action;
  if (!st.drawn) {
    action = `<button class="primary withicon" data-act="wdraw" data-id="${gid}">${icon('shuffle')}Jetzt auslosen</button>`;
  } else if (ui.confirmRedraw === gid) {
    action = `<div class="card stack"><p class="small">Alle Zuteilungen ändern sich. Jeder sieht danach eine neue Person, auch wer schon etwas besorgt hat.</p>
      <button class="danger" data-act="wdraw" data-id="${gid}">Wirklich neu auslosen</button>
      <button class="ghost" data-act="wnoconfirm">Abbrechen</button></div>`;
  } else if (ui.confirmCancel === gid) {
    action = `<div class="card stack"><p class="small">Die Auslosung wird gelöscht. Niemand sieht danach mehr, wen er gezogen hatte.</p>
      <button class="danger" data-act="wcancel" data-id="${gid}">Wirklich aufheben</button>
      <button class="ghost" data-act="wnoconfirm">Abbrechen</button></div>`;
  } else {
    action = `<button class="secondary withicon" data-act="askredraw" data-id="${gid}">${icon('shuffle')}Neu auslosen</button>
      <button class="ghost danger-text" data-act="askwcancel" data-id="${gid}">Auslosung aufheben</button>`;
  }
  const stale = st.drawn && st.stale ? `<div class="banner">${icon('people')}<span><b>Die Gruppe hat sich geändert</b><small>Seit der Auslosung ist jemand dazugekommen, gegangen oder macht nicht mehr mit. Lose neu aus, damit es wieder passt.</small></span></div>` : '';
  return shell('Wichteln', `${top}
    <h2>Wer macht mit</h2>
    <ul class="rows">${partRows}</ul>
    <p class="foot">${icon('people')}<span>${plural(count, 'Person macht', 'Personen machen')} mit.${st.drawn ? ' Änderungen gelten ab der nächsten Auslosung.' : ''}</span></p>
    <h2>Dürfen sich nicht ziehen</h2>
    ${ex.length ? `<ul class="rows">${exRows}</ul>` : `<p class="empty-line">Zum Beispiel Paare oder Geschwister, die sich sowieso beschenken.</p>`}
    ${exForm}
    <h2>Auslosung</h2>
    ${stale}
    <div class="stack">${action}</div>
    <p class="foot">${icon('eyeoff')}<span>Auch du siehst nur, wen du selbst gezogen hast.</span></p>`, opt);
}

function secureCard() {
  return `<div class="card stack">
    <div class="cardhead">${icon('lock')}<b>Konto sichern</b></div>
    <p class="small muted">Gerade hängt dein Konto an diesem Gerät. Mit Benutzername und Passwort meldest du dich überall an, auch in Safari und in der App auf dem Home-Bildschirm.</p>
    <form data-form="secure" class="stack">
      <label>Benutzername<input name="username" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" maxlength="24" placeholder="z. B. ${esc(normUser(myName()).replace(/[^a-z0-9._-]/g, '') || 'anna')}" required></label>
      <label>Passwort<input name="password" type="password" autocomplete="new-password" minlength="8" placeholder="Mindestens 8 Zeichen" required></label>
      <button class="primary" type="submit">Konto sichern</button>
    </form>
  </div>`;
}

function codeCard() {
  return `<div class="card stack">
    <div class="cardhead">${icon('key')}<b>Wiederherstellungscode</b></div>
    <p class="small muted">Damit wählst du unter „Passwort vergessen“ ein neues Passwort. Ein neuer Code macht den alten ungültig.</p>
    ${ui.confirmNewCode
      ? `<button class="primary" data-act="newcode">Jetzt neuen Code erzeugen</button>`
      : `<button class="secondary" data-act="asknewcode">Neuen Code erzeugen</button>`}
  </div>`;
}

function adminSection() {
  if (!D.admin) return '';
  const hits = ui.adminHits;
  const rr = ui.resetResult;
  const result = rr ? `<div class="card stack codecard">
      <p class="eyebrow">Rücksetz-Code für ${esc(rr.name || rr.username)}</p>
      <p class="code big" id="resetcode">${esc(fmtRecovery(rr.code))}</p>
      <button class="secondary withicon" data-act="copyreset">${icon('copy')}Kopieren</button>
      <p class="small muted">Gültig bis ${esc(fmtDay(rr.expires_at))}, ${esc(fmtTime(rr.expires_at))} Uhr und nur einmal. Gib ihn persönlich weiter. Die Person tippt auf der Anmeldeseite auf „Passwort vergessen“ und wählt selbst ein neues Passwort.</p>
    </div>` : '';
  const list = !hits ? '' : (hits.length ? `<ul class="rows">${hits.map(h => {
    const confirm = ui.confirmReset === h.user_id;
    return `<li class="row-item"><span class="av c${hueIdx(h.user_id)}">${esc(initials(h.name || h.username))}</span>
      <span class="row-main"><span class="row-title">${esc(h.name || h.username)}</span><span class="row-meta">${esc(h.username)}${h.reset_open ? ' · Code offen' : ''}</span></span>
      <button class="${confirm ? 'primary' : 'secondary'} sm" data-act="${confirm ? 'adminreset' : 'askreset'}" data-id="${h.user_id}">${confirm ? 'Wirklich' : 'Zurücksetzen'}</button></li>`;
  }).join('')}</ul>` : `<p class="empty-line">Niemand gefunden.</p>`);
  return `<h2>Verwaltung</h2>
    <div class="card stack">
      <p class="small muted">Wer Passwort und Code verloren hat, bekommt hier einen Rücksetz-Code.</p>
      <form data-form="adminsearch" class="inline"><input name="q" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="Name oder Benutzername" value="${esc(ui.adminQuery || '')}" required><button class="secondary" type="submit">Suchen</button></form>
    </div>
    ${result}${list}
    ${pushAdmin()}`;
}

function viewAccount() {
  const acc = D.account;
  const unsafe = needsSecure();
  return shell('Konto', `
    <section class="profile">${avatar(me(), 'lg')}<div class="profile-main">
      <p class="row-title big">${esc(myName())}</p>
      <p class="row-meta">${acc ? `Benutzername ${esc(acc.username)}` : 'Nur auf diesem Gerät angemeldet'}</p></div></section>
    ${unsafe ? secureCard() : ''}
    <h2>Profil</h2>
    <div class="card"><form data-form="name" class="inline"><input name="name" maxlength="40" value="${esc(myName())}" required><button class="secondary" type="submit">Name ändern</button></form></div>
    ${themeSection()}
    ${acc ? `<h2>Anmeldung</h2>${codeCard()}` : ''}
    ${adminSection()}
    <div id="install" data-ctx="konto">${installCard('konto')}</div>
    ${notifySection()}
    <h2>Datenschutz</h2>
    <div class="card prose">
      <p>Name, Benutzername, Gruppen, Wünsche und Reservierungen liegen in einer Datenbank bei Supabase in der EU. Passwort und Wiederherstellungscode werden nur verschlüsselt gespeichert.</p>
      <p>Andere sehen deinen Namen und die Wünsche, die du für ihre Gruppe freigibst. Reservierungen sieht der Beschenkte nie.</p>
      <p>Für Benachrichtigungen wird eine Adresse des Push-Dienstes deines Geräts gespeichert (Apple, Google oder Mozilla). Die Nachrichten sind verschlüsselt.</p>
      <p>Auf dem Gerät bleiben nur die Anmeldung und eine Kopie der Listen, damit die App schnell startet.</p>
    </div>
    <div class="card stack">
      ${unsafe && ui.confirmLogout
        ? `<p class="small">Ohne Benutzername und Passwort kommst du danach nicht mehr in dieses Konto zurück. Deine Liste wäre verloren.</p><button class="danger" data-act="logout">Trotzdem abmelden</button>`
        : `<button class="ghost danger-text" data-act="${unsafe ? 'asklogout' : 'logout'}">Abmelden</button>`}
    </div>
    <p class="version">Geschenkeliste ${VERSION}</p>`, { tab: 'acc' });
}

/* ---------- Router ---------- */
function route() {
  const h = location.hash.replace(/^#/, '') || '/';
  return h.split('?')[0].split('/').filter(Boolean);
}

function render() {
  const app = $('#app');
  let parts = route();
  if (parts[0] === 'join' && parts[1]) {
    S.pendingJoin = parts[1];
    saveState();
    history.replaceState(null, '', location.pathname + '#/');
    parts = [];
    if (S.session && D.loaded) doPendingJoin();
  }
  if (!S.session) { app.innerHTML = parts[0] === 'vergessen' ? viewForgot() : viewLogin(); return; }
  if (fresh) { app.innerHTML = viewCode(); window.scrollTo(0, 0); return; }
  const prof = D.profiles.find(x => x.id === me());
  if (D.loaded && (!prof || !prof.name)) { app.innerHTML = S.pendingName ? '<p class="boot">Lädt …</p>' : viewName(); return; }
  if (!D.loaded) { app.innerHTML = '<p class="boot">Lädt …</p>'; return; }
  let html;
  if (parts[0] === 'w' && parts[1]) html = viewWishForm(parts[1]);
  else if (parts[0] === 'gruppen') html = viewGroups();
  else if (parts[0] === 'g' && parts[1] && parts[2] === 'p' && parts[3]) html = viewPerson(parts[1], parts[3]);
  else if (parts[0] === 'g' && parts[1] && parts[2] === 'wichteln') html = viewWichteln(parts[1]);
  else if (parts[0] === 'g' && parts[1]) html = viewGroup(parts[1]);
  else if (parts[0] === 'liste') html = viewList();
  else if (parts[0] === 'konto' || parts[0] === 'mehr') html = viewAccount();
  else html = viewHome();
  const y = render.lastKey === location.hash ? window.scrollY : 0;
  app.innerHTML = html;
  applyMarks();
  paintBadges();
  if (render.lastKey === location.hash) window.scrollTo(0, y); else window.scrollTo(0, 0);
  render.lastKey = location.hash;
}

async function doPendingJoin() {
  const code = S.pendingJoin;
  if (!code || !S.session) return;
  if (D.loaded && !(D.profiles.find(x => x.id === me()) || {}).name) return; // erst Namen setzen
  delete S.pendingJoin;
  saveState();
  try {
    const gid = await sb('/rest/v1/rpc/join_group', { method: 'POST', body: { p_code: code } });
    await sync(true);
    toast('Du bist der Gruppe beigetreten.');
    go('#/g/' + gid);
  } catch (e) {
    toast(e.message);
    render();
  }
}

/* ---------- Aktionen ---------- */
async function run(fn) {
  if (busy) return;
  busy = true;
  document.body.classList.add('busy');
  try { await fn(); } catch (e) { toast(e.message); } finally {
    busy = false;
    document.body.classList.remove('busy');
  }
}

const forms = {
  async start(f) {
    const name = f.name.value.trim();
    if (!name) return;
    const j = await sb('/auth/v1/signup', { method: 'POST', auth: false, body: { data: {} } });
    setSession(j);
    S.pendingName = name;
    saveState();
    await afterLogin();
  },
  async signin(f) {
    const username = normUser(f.username.value);
    const pw = f.password.value;
    if (!username || !pw) return;
    await passwordLogin(username, pw);
    delete S.pendingName;
    saveState();
    await afterLogin();
  },
  async secure(f) {
    const username = normUser(f.username.value);
    const pw = f.password.value;
    checkUser(username);
    checkPw(pw);
    const code = await sb('/rest/v1/rpc/secure_account', { method: 'POST', body: { p_username: username, p_password: pw } });
    fresh = { code, username, reason: 'secured' };
    try { await passwordLogin(username, pw); } catch (e) { toast(e.message); }
    render();
    sync(true);
  },
  async recover(f) {
    const username = normUser(f.username.value);
    const pw = f.password.value;
    checkPw(pw);
    const r = await sb('/rest/v1/rpc/recover_account', { method: 'POST', auth: false, body: { p_username: username, p_code: f.code.value, p_password: pw } });
    if (!r || !r.ok) {
      const e = r && r.error;
      if (e === 'gesperrt') throw new Error(`Zu viele Fehlversuche. Versuch es ab ${fmtTime(r.until)} Uhr nochmal.`);
      if (e === 'passwort') throw new Error('Das Passwort braucht mindestens 8 Zeichen.');
      if (e === 'passwort_lang') throw new Error('Das Passwort ist zu lang.');
      throw new Error(`Benutzername oder Code falsch. Noch ${plural(r ? r.left : 0, 'Versuch', 'Versuche')}.`);
    }
    await passwordLogin(username, pw);
    fresh = { code: r.code, username, reason: 'recovered' };
    delete S.pendingName;
    saveState();
    history.replaceState(null, '', location.pathname + '#/');
    await afterLogin();
  },
  async confirmcode(f) {
    const last = f.last4.value.trim().toUpperCase();
    if (!fresh || last !== fresh.code.slice(-4)) throw new Error('Die letzten 4 Zeichen stimmen nicht.');
    const reason = fresh.reason;
    fresh = null;
    toast(reason === 'secured' ? 'Konto gesichert.' : 'Neuer Code gespeichert.');
    if (S.pendingJoin) await doPendingJoin(); else render();
  },
  async adminsearch(f) {
    ui.adminQuery = f.q.value.trim();
    ui.adminHits = await sb('/rest/v1/rpc/admin_find_users', { method: 'POST', body: { p_query: ui.adminQuery } });
    delete ui.confirmReset;
    delete ui.resetResult;
    render();
  },
  async name(f) {
    const name = f.name.value.trim();
    if (!name) return;
    await sb('/rest/v1/profiles?on_conflict=id', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: { id: me(), name } });
    await sync(true);
    if (S.pendingJoin) { await doPendingJoin(); return; }
    toast('Gespeichert.');
    render();
  },
  async wish(f) {
    const id = f.dataset.id;
    const title = f.title.value.trim();
    const url = normUrl(f.url.value);
    if (url === false) throw new Error('Der Link sieht nicht richtig aus.');
    const note = f.note.value.trim() || null;
    const price = parsePrice(f.price.value);
    if (price === false) throw new Error('Der Preis sieht nicht richtig aus, z. B. 24,99.');
    const category = f.category.value || null;
    const pr = f.querySelector('input[name=prio]:checked');
    const priority = pr ? Number(pr.value) : 2;
    const visEl = f.querySelector('input[name=vis]:checked');
    const all = !visEl || visEl.value === 'all';
    const sel = [...f.querySelectorAll('input[name=g]:checked')].map(x => x.value);
    if (!all && !sel.length) throw new Error('Wähle mindestens eine Gruppe aus.');
    const row = { title, url, note, all_groups: all, price, category, priority };
    let wid = id;
    if (id === 'neu') {
      const r = await sb('/rest/v1/wishes', { method: 'POST', prefer: 'return=representation', body: row });
      wid = r[0].id;
    } else {
      await sb('/rest/v1/wishes?id=eq.' + id, { method: 'PATCH', prefer: 'return=minimal', body: row });
      await sb('/rest/v1/wish_groups?wish_id=eq.' + id, { method: 'DELETE' });
    }
    if (!all) await sb('/rest/v1/wish_groups', { method: 'POST', prefer: 'return=minimal', body: sel.map(g => ({ wish_id: wid, group_id: g })) });
    if (id === 'neu' && S.share) { delete S.share; saveState(); }
    await sync(true);
    toast('Gespeichert.');
    go('#/liste');
  },
  async newgroup(f) {
    const g = await sb('/rest/v1/rpc/create_group', { method: 'POST', body: { p_name: f.name.value.trim() } });
    await sync(true);
    go('#/g/' + g.id);
  },
  async join(f) {
    S.pendingJoin = f.code.value.trim();
    await doPendingJoin();
  },
  async wex(f) {
    const a = f.a.value, b = f.b.value;
    if (!a || !b) throw new Error('Wähle zwei Personen aus.');
    if (a === b) throw new Error('Wähle zwei verschiedene Personen.');
    await sb('/rest/v1/rpc/wichtel_set_exclusion', { method: 'POST', body: { p_group: f.dataset.id, p_a: a, p_b: b, p_on: true } });
    await sync(true);
    toast('Ausschluss gespeichert.');
  },
  async rename(f) {
    await sb('/rest/v1/rpc/rename_group', { method: 'POST', body: { p_group: f.dataset.id, p_name: f.name.value.trim() } });
    ui = {};
    await sync(true);
    toast('Umbenannt.');
  }
};

const acts = {
  sync: () => sync(),
  theme: async el => { if (window.GLTheme) GLTheme.set(el.dataset.v); render(); },
  mode: async el => { if (window.GLTheme) GLTheme.setMode(el.dataset.v); render(); },
  badgelater: async () => { S.badgeAsked = 1; saveState(); render(); },
  pushlater: async () => { S.pushAsked = 1; saveState(); render(); },
  pushnotice: async () => { S.pushNotice = 1; saveState(); render(); },
  pushon: async () => {
    S.pushAsked = 1;
    S.pushNotice = 1;
    saveState();
    try { await pushEnable(); } finally { render(); }   // fragt im Klick nach der Erlaubnis
    appBadge.last = null;
    render();
    toast('Benachrichtigungen sind eingeschaltet.');
  },
  pushoff: async () => {
    const sub = push.sub;
    await pushDetach();
    if (sub) await sub.unsubscribe().catch(() => {});
    push.sub = null;
    setPushOff(true);
    render();
    toast('Auf diesem Gerät ausgeschaltet.');
  },
  pushtest: async () => {
    await sb('/rest/v1/rpc/push_test', { method: 'POST', body: {} });
    toast('Testnachricht ist unterwegs.');
  },
  pref: async el => {
    const body = Object.assign({ wish: true, member: true, draw: true, remind: true, have: true }, D.pp || {}, { [el.dataset.k]: el.dataset.on === '1', user_id: me() });
    await sb('/rest/v1/push_prefs?on_conflict=user_id', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body });
    delete body.user_id;
    D.pp = body;
    render();
  },
  askkeys: async () => { ui.confirmKeys = 1; render(); },
  pushsetup: async () => {
    const k = await makeVapid();
    await sb('/rest/v1/rpc/push_setup', { method: 'POST', body: { p_public: k.pub, p_private: k.priv, p_subject: APP_URL, p_url: SB_URL + '/functions/v1/push', p_key: SB_KEY } });
    delete ui.confirmKeys;
    push.key = k.pub;
    push.done = '';
    await sync(true);
    await pushInit();
    toast('Schlüssel gespeichert.');
  },
  seenall: async () => { seenAll(); flash = new Set(); render(); },
  badgeperm: async () => {
    S.badgeAsked = 1;
    saveState();
    try { await Notification.requestPermission(); } catch (e) { /* abgelehnt oder nicht möglich */ }
    appBadge.last = null;
    render();
    if (badgeState() === 'ok') toast('Der Zähler erscheint jetzt am App-Symbol.');
  },
  install: async () => {
    const e = installEvt;
    if (!e) return;
    installEvt = null;
    e.prompt();
    const c = await e.userChoice.catch(() => null);
    if (c && c.outcome === 'accepted') justInstalled = true;
    paintInstall();
  },
  asklogout: async () => { ui.confirmLogout = 1; render(); },
  copycode: async () => copyText(fmtRecovery(fresh.code), 'Code kopiert.'),
  sharecode: async () => {
    const text = `Geschenkeliste\nBenutzername: ${fresh.username}\nWiederherstellungscode: ${fmtRecovery(fresh.code)}`;
    if (navigator.share) {
      try { await navigator.share({ title: 'Geschenkeliste Wiederherstellungscode', text }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    await copyText(text, 'Code kopiert.');
  },
  asknewcode: async () => { ui.confirmNewCode = 1; render(); },
  newcode: async () => {
    const code = await sb('/rest/v1/rpc/new_recovery_code', { method: 'POST', body: {} });
    ui = {};
    fresh = { code, username: D.account ? D.account.username : '', reason: 'newcode' };
    render();
  },
  dismissreset: async () => {
    await sb('/rest/v1/rpc/dismiss_reset_notice', { method: 'POST', body: {} });
    await sync(true);
  },
  askreset: async el => { ui.confirmReset = el.dataset.id; render(); },
  adminreset: async el => {
    const h = (ui.adminHits || []).find(x => x.user_id === el.dataset.id) || {};
    const r = await sb('/rest/v1/rpc/admin_reset', { method: 'POST', body: { p_user: el.dataset.id } });
    ui.resetResult = Object.assign({ name: h.name }, r);
    delete ui.confirmReset;
    h.reset_open = true;
    render();
  },
  copyreset: async () => copyText(fmtRecovery(ui.resetResult.code), 'Code kopiert.'),
  logout: async () => {
    await pushDetach();
    try { await sb('/auth/v1/logout', { method: 'POST' }); } catch (e) { /* egal */ }
    logout('Abgemeldet.');
  },
  askdel: async el => { ui.confirmDel = el.dataset.id; render(); },
  delwish: async el => {
    await sb('/rest/v1/wishes?id=eq.' + el.dataset.id, { method: 'DELETE' });
    ui = {};
    await sync(true);
    toast('Gelöscht.');
    go('#/liste');
  },
  manage: async el => { ui.manage = el.dataset.id; render(); },
  askleave: async el => { ui.confirmLeave = el.dataset.id; render(); },
  leave: async el => {
    await sb('/rest/v1/rpc/leave_group', { method: 'POST', body: { p_group: el.dataset.id } });
    ui = {};
    await sync(true);
    toast('Gruppe verlassen.');
    go('#/gruppen');
  },
  invite: async el => {
    const g = D.groups.find(x => x.id === el.dataset.id);
    const link = inviteLink(g.code);
    const text = `Komm in meine Gruppe „${g.name}“ bei der Geschenkeliste. Code: ${fmtCode(g.code)}`;
    if (navigator.share) {
      try { await navigator.share({ title: 'Geschenkeliste', text, url: link }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    try { await navigator.clipboard.writeText(text + '\n' + link); toast('Einladung kopiert.'); } catch (e) { toast('Code: ' + fmtCode(g.code)); }
  },
  wpart: async el => {
    await sb('/rest/v1/rpc/wichtel_set_participant', { method: 'POST', body: { p_group: el.dataset.id, p_user: el.dataset.u, p_on: el.dataset.on === '1' } });
    await sync(true);
  },
  wexdel: async el => {
    await sb('/rest/v1/rpc/wichtel_set_exclusion', { method: 'POST', body: { p_group: el.dataset.id, p_a: el.dataset.u, p_b: el.dataset.v, p_on: false } });
    await sync(true);
  },
  wdraw: async el => {
    const again = !!drawOf(el.dataset.id);
    await sb('/rest/v1/rpc/wichtel_draw', { method: 'POST', body: { p_group: el.dataset.id } });
    ui = {};
    await sync(true);
    toast(again ? 'Neu ausgelost.' : 'Ausgelost. Jeder sieht jetzt, wen er beschenkt.');
    window.scrollTo(0, 0);
  },
  askredraw: async el => { ui.confirmRedraw = el.dataset.id; render(); },
  askwcancel: async el => { ui.confirmCancel = el.dataset.id; render(); },
  wnoconfirm: async () => { delete ui.confirmRedraw; delete ui.confirmCancel; render(); },
  wcancel: async el => {
    await sb('/rest/v1/rpc/wichtel_cancel', { method: 'POST', body: { p_group: el.dataset.id } });
    ui = {};
    await sync(true);
    toast('Auslosung aufgehoben.');
  },
  filt: async el => {
    const f = ui.filter = ui.filter || {};
    const k = el.dataset.k, v = el.dataset.v;
    f[k] = f[k] === v ? null : v;
    render();
  },
  filtreset: async () => { ui.filter = {}; render(); },
  pasteurl: async el => {
    const f = el.closest('form');
    let t = '';
    try { t = await navigator.clipboard.readText(); } catch (e) {
      throw new Error('Kein Zugriff auf die Zwischenablage. Halte im Feld Link gedrückt und wähle Einfügen.');
    }
    if (!fillLink(f, t)) throw new Error('In der Zwischenablage ist kein Link.');
    toast('Link eingefügt.');
  },
  have: async el => {
    await sb('/rest/v1/wishes?id=eq.' + el.dataset.id, { method: 'PATCH', prefer: 'return=minimal', body: { have_at: new Date().toISOString() } });
    await sync(true);
    toast('Markiert. Wer es reserviert hat, sieht einen Hinweis.');
    go('#/liste');
  },
  unhave: async el => {
    await sb('/rest/v1/wishes?id=eq.' + el.dataset.id, { method: 'PATCH', prefer: 'return=minimal', body: { have_at: null } });
    await sync(true);
    toast('Wieder auf deiner Liste.');
    go('#/liste');
  },
  reserve: async el => {
    await sb('/rest/v1/reservations', { method: 'POST', prefer: 'return=minimal', body: { wish_id: el.dataset.id } });
    await sync(true);
    toast('Reserviert. Nur die anderen sehen das.');
  },
  resstatus: async el => {
    await sb('/rest/v1/reservations?wish_id=eq.' + el.dataset.id, { method: 'PATCH', prefer: 'return=minimal', body: { status: el.dataset.s } });
    await sync(true);
  },
  unreserve: async el => {
    await sb('/rest/v1/reservations?wish_id=eq.' + el.dataset.id, { method: 'DELETE' });
    await sync(true);
    toast('Wieder frei.');
  }
};

/* Link (und wenn leer: Titel) aus Text übernehmen */
function fillLink(f, text) {
  const url = findUrl(text);
  if (!url || !f) return false;
  f.url.value = url;
  if (!f.title.value.trim()) f.title.value = guessTitle(text, url, '');
  return true;
}

async function copyText(t, msg) {
  try { await navigator.clipboard.writeText(t); toast(msg); } catch (e) { toast('Kopieren ging nicht. Bitte abschreiben.'); }
}

async function afterLogin() {
  const c = S.cache;
  if (c && c.uid !== me()) delete S.cache;
  await sync();
  const prof = D.profiles.find(x => x.id === me());
  if (D.loaded && (!prof || !prof.name) && S.pendingName) {
    try {
      await sb('/rest/v1/profiles?on_conflict=id', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: { id: me(), name: S.pendingName } });
      delete S.pendingName;
      saveState();
      await sync(true);
    } catch (e) { toast(e.message); }
  }
  if (S.pendingJoin) await doPendingJoin();
  else render();
  pushInit();
}

/* ---------- Start ---------- */
document.addEventListener('submit', e => {
  const f = e.target.closest('form[data-form]');
  if (!f) return;
  e.preventDefault();
  const fn = forms[f.dataset.form];
  if (fn) run(() => fn(f));
});
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = acts[el.dataset.act];
  if (fn) { e.preventDefault(); run(() => fn(el)); }
});
document.addEventListener('paste', e => {
  const el = e.target;
  if (!el || el.name !== 'url' || !el.form || el.form.dataset.form !== 'wish') return;
  const t = (e.clipboardData || window.clipboardData).getData('text');
  if (/\s/.test(t.trim()) && findUrl(t)) { e.preventDefault(); fillLink(el.form, t); }
});
document.addEventListener('change', e => {
  if (e.target.name === 'vis') {
    const sub = $('#gsel');
    if (sub) sub.classList.toggle('hide', e.target.value === 'all');
  }
});
window.addEventListener('hashchange', () => {
  ui = {};
  flash = new Set();
  if (S.share && S.session && location.hash !== '#/w/neu') { delete S.share; saveState(); }
  render();
  if (S.session && Date.now() - D.at > 20000) sync(true);
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (window.GLTheme && GLTheme.apply()) render();   // Automatisch: Wechsel am 1.11. und 7.1.
  if (!S.session) return;
  if (Date.now() - D.at > 20000) sync(true);
  pushInit();   // Erlaubnis kann sich in den Einstellungen geändert haben
});
/* Nachrichten vom Service Worker: Benachrichtigung angetippt oder eingetroffen */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', e => {
    const d = e.data || {};
    if (d.type === 'nav' && typeof d.url === 'string' && /^#\/[\w/-]*$/.test(d.url) && S.session) go(d.url);
    else if (d.type === 'sync' && S.session) sync(true);
  });
}

/* Android: Teilen aus einer anderen App öffnet ./?title=…&text=…&url=… (share_target im Manifest) */
function takeShare() {
  const q = new URLSearchParams(location.search);
  if (!q.has('url') && !q.has('text') && !q.has('title')) return;
  S.share = { title: q.get('title') || '', text: q.get('text') || '', url: q.get('url') || '', at: Date.now() };
  saveState();
  history.replaceState(null, '', location.pathname + '#/w/neu');
}

(async function start() {
  cleanAuthHash();
  takeShare();
  ['loginEmail', 'loginSent', 'secureSent'].forEach(k => delete S[k]); // Reste der Mail-Anmeldung bis 1.4
  if (S.session && S.cache && S.cache.uid === me()) {
    D = Object.assign(emptyData(), S.cache.D, { at: 0 });
  }
  render();
  if (S.session) await afterLogin();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();

// Gerät wechselt Hell/Dunkel bei offener App (theme.js meldet sich)
window.GLThemeChanged = () => render();
