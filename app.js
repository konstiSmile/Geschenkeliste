'use strict';
/* Geschenkeliste – Wunschlisten für Familie und Freunde.
   Ohne Bibliotheken: spricht direkt mit Supabase (Auth + REST). */

const VERSION = '1.17.1';
const SB_URL = 'https://qbdpzamygonpruaafcrt.supabase.co';
const SB_KEY = 'sb_publishable_A7zukzk82Suux8jteQvLGA_WmXnZb14';
const LS_KEY = 'geschenkeliste-v1';
const MAIL_DOMAIN = '@nutzer.geschenkeliste.invalid'; // nur intern, es wird nie eine Mail verschickt
const USER_RE = /^[a-z0-9][a-z0-9._-]{2,23}$/;
const APP_URL = 'https://konstismile.github.io/Geschenkeliste/'; // Absender der Benachrichtigungen (VAPID)

/* ---------- Speicher ---------- */
let S = loadState();      // {session, pendingJoin, pendingFriend, pendingName, cache}
let D = emptyData();      // Daten vom Server
let busy = false;
let ui = {};              // flüchtiger Zustand der Ansicht (offene Formulare, Löschbestätigung)
let sbPending = 0;         // laufende Speichervorgänge im Steckbrief
let fresh = null;         // neu erzeugter Wiederherstellungscode {code, username, reason}, nur im Speicher

function emptyData() {
  return { profiles: [], groups: [], members: [], wishes: [], wg: [], res: [], account: null, admin: false, wd: [], wp: [], wx: [], wo: [], pp: null, ps: null, ip: [], ideas: [], card: null, cardVis: [], cards: {}, pools: [], shares: [], fr: [], wf: [], fq: { in: [], out: [] }, nick: [], bd: [], gl: [], glp: [], fcode: null, at: 0, loaded: false };
}
function loadState() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (e) { return {}; }
}
function saveState() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch (e) { /* voll oder gesperrt */ }
}

/* ---------- Hilfen ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('withundo');
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 2600);
}
// Meldung mit „Rückgängig“ (1.17)
function toastUndo(msg, ms) {
  const t = $('#toast');
  t.textContent = '';
  const span = document.createElement('span');
  span.textContent = msg;
  const b = document.createElement('button');
  b.className = 'undo';
  b.dataset.act = 'undo';
  b.textContent = 'Rückgängig';
  t.append(span, b);
  t.classList.add('show', 'withundo');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show', 'withundo'), ms);
}
function go(hash) {
  if (location.hash === hash) render(); else location.hash = hash;
}
function me() { return S.session && S.session.user ? S.session.user.id : null; }
/* Namen (1.14): eigener Spitzname vor dem Anzeigenamen; gleiche Namen bekommen einen Zusatz,
   z. B. „Lena (Familie)“ (Gruppe, die nur diese Lena mit mir teilt), „(befreundet)“ oder „(2)“. */
function realName(uid) {
  const p = D.profiles.find(x => x.id === uid);
  return p && p.name ? p.name : '';
}
const nickOf = uid => ((D.nick || []).find(x => x.user_id === uid) || {}).nick || '';
function baseName(uid) { return nickOf(uid) || realName(uid) || 'Jemand'; }
let dupCache = { key: null, map: new Map() };
function dupMap() {
  const key = D.at + '|' + (D.nick || []).map(x => x.user_id + x.nick).join(',') + '|' + D.profiles.length;
  if (dupCache.key === key) return dupCache.map;
  const map = new Map(), by = new Map();
  D.profiles.filter(p => p.id !== me()).forEach(p => {
    const b = baseName(p.id).trim().toLowerCase();
    if (!by.has(b)) by.set(b, []);
    by.get(b).push(p.id);
  });
  by.forEach(ids => {
    if (ids.length < 2) return;
    const sorted = ids.slice().sort();
    ids.forEach(u => {
      const others = ids.filter(x => x !== u);
      const g = sharedGroups(u).find(g => !others.some(o => membersOf(g.id).some(m => m.user_id === o)));
      let x = g ? g.name : '';
      if (!x && isFriend(u) && !others.some(isFriend)) x = 'befreundet';
      map.set(u, x || String(sorted.indexOf(u) + 1));
    });
  });
  dupCache = { key, map };
  return map;
}
const isDup = uid => dupMap().has(uid);
function nameOf(uid) {
  if (uid === me()) return 'Du';
  const x = dupMap().get(uid);
  return x ? `${baseName(uid)} (${x})` : baseName(uid);
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
  if (/Freundes-Code nicht gefunden/.test(m)) return 'Diesen Freundes-Link gibt es nicht (mehr).';
  if (/Code nicht gefunden/.test(m)) return 'Diesen Gruppen-Code gibt es nicht.';
  if (/Das bist du/.test(m)) return 'Das bist du selbst.';
  if (/Zu viele Anfragen/.test(m)) return 'Zu viele Anfragen. Versuch es morgen wieder.';
  if (/Zu viele Freunde/.test(m)) return 'Mehr als 500 Freunde gehen nicht.';
  if (/Anfrage nicht gefunden/.test(m)) return 'Diese Anfrage gibt es nicht mehr.';
  if (/Diese Person kennst du nicht/.test(m)) return 'Diese Person kennst du hier nicht.';
  if (/Höchstens 500 Spitznamen/.test(m)) return 'Mehr als 500 Spitznamen gehen nicht.';
  if (/Frist abgelaufen/.test(m)) return 'Die Frist zum Mitmachen ist abgelaufen.';
  if (/Frist ungültig/.test(m)) return 'Die Frist muss heute oder später sein, höchstens ein Jahr.';
  if (/Niemand ausgewählt/.test(m)) return 'Wähle mindestens eine Person aus.';
  if (/Person sieht den Wunsch nicht/.test(m)) return 'Eine ausgewählte Person sieht diesen Wunsch nicht.';
  if (/Käufer kann nicht austreten/.test(m)) return 'Wer kauft, kann nicht austreten. Gib das Kaufen vorher ab oder sag ab.';
  if (/Macht nicht mit/.test(m)) return 'Diese Person macht nicht mit.';
  if (/Gemeinsam voll/.test(m)) return 'Mehr als 30 Leute gehen nicht.';
  if (/Zu viele Eingeladene/.test(m)) return 'Höchstens 60 Personen.';
  if (/Zu viele gemeinsame/.test(m)) return 'Du kaufst schon 50 gemeinsame Geschenke.';
  if (/Hat die Person schon/.test(m)) return 'Das hat die Person schon.';
  if (/Aufteilung ungültig|Mindestzahl ungültig/.test(m)) return 'Bitte die Angaben prüfen.';
  if (/Zu viele Gruppen/.test(m)) return 'Du hast schon 20 Gruppen angelegt.';
  if (/Das übernimmt schon jemand/.test(m)) return 'Das übernimmt schon jemand anderes.';
  if (/Gruppe ist archiviert/.test(m)) return 'Die Gruppe ist archiviert.';
  if (/Geburtstagsgruppen bleiben Geburtstag/.test(m)) return 'Eine Geburtstagsgruppe bleibt beim Geburtstag.';
  if (/Bitte ein Datum angeben/.test(m)) return 'Wähle Tag und Monat.';
  if (/Bitte einen Namen angeben/.test(m)) return 'Gib einen Namen ein.';
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
    r = await fetch(SB_URL + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'omit', referrerPolicy: 'no-referrer', keepalive: !!opt.keepalive });
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
  const keep = S.pendingJoin, keepF = S.pendingFriend;
  S = {};
  if (keep) S.pendingJoin = keep;
  if (keepF) S.pendingFriend = keepF;
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
    const [profiles, groups, members, wishes, wg, res, acc, admin, wd, wp, wx, wo, pp, ip, ideas, card, cardVis, cards, pools, shares, fr, wf, fq, nick, bd, gl, glp, gi, bdo] = await Promise.all([
      sb('/rest/v1/profiles?select=id,name'),
      // Anlass pro Gruppe ab 1.15, Geburtstagsgruppen ab 1.16
      sb('/rest/v1/groups?select=id,name,code,created_by,created_at,occ_kind,occ_name,occ_date,bday_user,bday_name,bday_person,archived_at,bday_recap&order=created_at')
        .catch(() => sb('/rest/v1/groups?select=id,name,code,created_by,created_at,occ_kind,occ_name,occ_date&order=created_at'))
        .catch(() => sb('/rest/v1/groups?select=id,name,code,created_by,created_at&order=created_at')),
      sb('/rest/v1/members?select=group_id,user_id,joined_at&order=joined_at'),
      // Preis, Kategorie, Wichtigkeit, „Hab ich schon“ ab 1.7; vorher ohne diese Spalten
      // ab 1.14 mit all_friends
      sb('/rest/v1/wishes?select=id,owner,title,url,note,all_groups,all_friends,created_at,price,category,priority,have_at&order=created_at.desc')
        .catch(() => sb('/rest/v1/wishes?select=id,owner,title,url,note,all_groups,created_at,price,category,priority,have_at&order=created_at.desc'))
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
      sb('/rest/v1/push_prefs?select=wish,member,draw,remind,have,pool,friend')
        .catch(() => sb('/rest/v1/push_prefs?select=wish,member,draw,remind,have,pool'))
        .catch(() => sb('/rest/v1/push_prefs?select=wish,member,draw,remind,have')).catch(() => null),
      // Private Ideenliste ab 1.11 (nur eigene Zeilen)
      sb('/rest/v1/idea_people?select=id,name,linked_user,created_at&order=created_at').catch(() => null),
      sb('/rest/v1/ideas?select=id,person,title,url,note,price,category,done_at,created_at&order=created_at.desc').catch(() => null),
      // Steckbrief ab 1.12: eigener (Tabelle), Sichtbarkeit, die der anderen (gefiltert über card_list)
      sb('/rest/v1/profile_cards?select=data,stamps').catch(() => null),
      sb('/rest/v1/profile_card_vis?select=item,mode,users,groups').catch(() => null),
      sb('/rest/v1/rpc/card_list', { method: 'POST', body: {} }).catch(() => null),
      // Gemeinsam schenken ab 1.13 (nur was ich sehen darf)
      sb('/rest/v1/gift_pools?select=wish_id,buyer,created_by,total,split,open,invited,min_people,deadline,note,created_at').catch(() => null),
      sb('/rest/v1/gift_shares?select=wish_id,user_id,amount,paid_at,joined_at&order=joined_at').catch(() => null),
      // Direkte Freundschaft ab 1.14
      sb('/rest/v1/friendships?select=a,b,created_at').catch(() => null),
      sb('/rest/v1/wish_friends?select=wish_id,user_id').catch(() => null),
      sb('/rest/v1/rpc/friend_requests_list', { method: 'POST', body: {} }).catch(() => null),
      sb('/rest/v1/nicknames?select=user_id,nick').catch(() => null),
      // Anlässe und Geburtstage ab 1.15
      sb('/rest/v1/birthdays?select=user_id,month,day,year').catch(() => null),
      sb('/rest/v1/gift_lists?select=id,name,occ_date,created_at&order=created_at').catch(() => null),
      sb('/rest/v1/gift_list_people?select=list_id,person,done_at,added_at&order=added_at').catch(() => null),
      // Geburtstagsgruppen ab 1.16
      sb('/rest/v1/group_ideas?select=id,group_id,created_by,title,url,note,price,taken_by,status,created_at&order=created_at').catch(() => null),
      sb('/rest/v1/bday_optout?select=user_id').catch(() => null)
    ]);
    const ps = admin === true ? await sb('/rest/v1/rpc/push_status', { method: 'POST', body: {} }).catch(() => null) : null;
    if (!S.session) return;
    D = { profiles, groups, members, wishes, wg, res, account: acc && acc[0] ? acc[0] : null, admin: admin === true,
      wd: wd || [], wp: wp || [], wx: wx || [], wo: wo || [], pp: pp && pp[0] ? pp[0] : null, ps,
      ip: ip || [], ideas: ideas || [], ideasOk: !!(ip && ideas),
      // Während ein Feld gespeichert wird, bleibt der lokale Stand (sonst springt die Auswahl kurz zurück)
      card: sbPending ? D.card : (card && card[0] ? card[0] : null), cardVis: cardVis || [], cardOk: !!(card && cardVis),
      cards: cards && typeof cards === 'object' ? cards : {}, cardsOk: !!cards,
      pools: pools || [], shares: shares || [], poolsOk: !!(pools && shares),
      fr: fr || [], wf: wf || [], fq: fq && fq.in ? fq : { in: [], out: [] }, nick: nick || [], friendsOk: !!(fr && wf && fq && nick),
      occOk: !!(groups[0] ? 'occ_kind' in groups[0] : bd), bd: bd || [], bdOk: !!bd, gl: gl || [], glp: glp || [], glOk: !!(gl && glp),
      gi: gi || [], bdgOk: !!(gi && bdo), bdOff: !!(bdo && bdo.length),
      fcode: D.fcode, at: Date.now(), loaded: true };
    hidePendingDel();
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
/* Geburtstagsgruppen (1.16): verbinden die Mitglieder nicht wie normale Gruppen */
const isBday = g => !!(g && g.bday_name);
const normGroups = () => myGroups().filter(g => !isBday(g));
const bdayGroupsFor = uid => myGroups().filter(g => isBday(g) && !g.archived_at && g.bday_user === uid);
const bdayName = g => (g.bday_user && (realName(g.bday_user) || nickOf(g.bday_user)) ? nameOf(g.bday_user) : g.bday_name);
/* Direkte Freundschaft (1.14) */
const friendIds = () => (D.fr || []).map(f => (f.a === me() ? f.b : f.a));
const isFriend = uid => !!uid && uid !== me() && (D.fr || []).some(f => f.a === uid || f.b === uid);
const known = uid => isFriend(uid) || inMyGroups(uid);
const wishFriendIds = wid => (D.wf || []).filter(x => x.wish_id === wid).map(x => x.user_id);
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
  seen = s && s.w ? Object.assign({ m: {}, g: {}, d: {}, f: {} }, s, { uid: me() }) : null;
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
  if (first) s = seen = { uid: me(), w: {}, m: {}, g: {}, d: {}, f: {} };
  for (const gid of gs) {
    if (!first && s.g[gid]) continue;
    s.g[gid] = 1;
    D.wishes.filter(w => w.owner !== me() && visibleIn(w, gid) && membersOf(gid).some(m => m.user_id === w.owner)).forEach(w => { s.w[w.id] = 1; });
    membersOf(gid).forEach(m => { s.m[mkey(gid, m.user_id)] = 1; });
    const st = wichtelState(gid);
    if (st.receiver) s.d[gid] = st.at;
  }
  // neue direkte Freunde (1.14): ihre bisherigen Wünsche gelten als gesehen
  const fs = friendIds();
  for (const u of fs) {
    if (!first && s.f[u]) continue;
    s.f[u] = 1;
    D.wishes.filter(w => w.owner === u).forEach(w => { s.w[w.id] = 1; });
  }
  s.f = Object.fromEntries(Object.keys(s.f).filter(k => fs.includes(k)).map(k => [k, 1]));
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
  return newWishes().length + newMembers().length + newDraws().length + friendReqsIn().length;
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
  bulb: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.2h5c0-.9.4-1.6 1.1-2.2A6 6 0 0 0 12 3z"/>',
  heart: '<path d="M12 20s-7.5-4.6-7.5-10A4.5 4.5 0 0 1 12 7a4.5 4.5 0 0 1 7.5 3c0 5.4-7.5 10-7.5 10z"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
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
  // Steckbrief (1.12)
  idcard: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="8.5" cy="11" r="2"/><path d="M5.5 16c.5-1.6 1.6-2.5 3-2.5s2.5.9 3 2.5M14 10h4M14 13.5h4"/>',
  eye: '<path d="M2.5 12c1-1.8 4.5-6 9.5-6s8.5 4.2 9.5 6c-1 1.8-4.5 6-9.5 6s-8.5-4.2-9.5-6z"/><circle cx="12" cy="12" r="3"/>',
  split: '<path d="M12 21v-7.5M12 13.5 6 7.5M12 13.5l6-6M6 3.5v4h4M18 3.5v4h-4"/>',
  ban: '<circle cx="12" cy="12" r="8.5"/><path d="m6 6 12 12"/>',
  ruler: '<rect x="2.5" y="8" width="19" height="8" rx="1.5"/><path d="M6.5 8v3M10 8v4.5M13.5 8v3M17 8v4.5"/>',
  play: '<path d="M7.5 5v14l11-7z"/>',
  cake: '<path d="M4 20.5h16M5 20.5v-7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v7M5 15.5c1.2 1 2.3 1 3.5 0s2.3-1 3.5 0 2.3 1 3.5 0 2.3-1 3.5 0M12 11.5V8M12 3.5c.9 1 1.3 1.8 1.3 2.5a1.3 1.3 0 0 1-2.6 0c0-.7.4-1.5 1.3-2.5z"/>',
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
  const n = uid === me() ? myName() : baseName(uid);
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
/* ---------- Anlässe und Geburtstage (1.15) ---------- */
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const OCC_KINDS = [['', 'Kein Anlass'], ['weihnachten', 'Weihnachten'], ['geburtstag', 'Geburtstag'], ['sonstiges', 'Sonstiges']];
function todayDate() { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); }
function parseDay(s) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; }
const leap = y => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
// Nächster Jahrestag ab heute (29.2. in Nicht-Schaltjahren am 28.2.)
function nextYearly(month, day, from = todayDate()) {
  for (let i = 0; i < 2; i++) {
    const y = from.getFullYear() + i;
    const d = new Date(y, month - 1, month === 2 && day === 29 && !leap(y) ? 28 : day);
    if (d >= from) return d;
  }
  return null;
}
const daysUntil = d => Math.round((d - todayDate()) / 864e5);
function fmtDate(d) { return `${d.getDate()}. ${MONTHS[d.getMonth()]}`; }
function whenText(n) { return n === 0 ? 'heute' : (n === 1 ? 'morgen' : `in ${n} Tagen`); }
// Nächster Termin des Anlasses einer Gruppe (null = keiner oder vorbei)
function occNext(g) {
  if (!g || !g.occ_kind) return null;
  if (g.occ_kind === 'weihnachten') return nextYearly(12, 24);
  const d = parseDay(g.occ_date);
  if (!d) return null;
  if (g.occ_kind === 'geburtstag') return nextYearly(d.getMonth() + 1, d.getDate());
  return d >= todayDate() ? d : null;
}
function occTitle(g) {
  if (isBday(g)) return 'Geburtstag von ' + bdayName(g);
  if (g.occ_kind === 'weihnachten') return 'Heiligabend';
  if (g.occ_kind === 'geburtstag') return g.occ_name || 'Geburtstag';
  return g.occ_name || 'Anlass';
}
const bdOf = uid => (D.bd || []).find(b => b.user_id === uid);
function bdNext(b) { return b ? nextYearly(b.month, b.day) : null; }
function bdAge(b, d) { return b && b.year ? d.getFullYear() - b.year : null; }
// Alles, was ansteht: Anlässe meiner Gruppen, Geburtstage von Leuten, die ich kenne, eigene Schenklisten mit Datum
function upcoming() {
  const out = [];
  const xmas = myGroups().find(g => g.occ_kind === 'weihnachten');
  myGroups().forEach(g => {
    if (g.occ_kind === 'weihnachten' && g !== xmas) return;
    if (g.archived_at) return;
    const d = occNext(g);
    if (d) out.push({ d, title: occTitle(g), sub: g.occ_kind === 'weihnachten' || isBday(g) ? '' : g.name, href: g.occ_kind === 'weihnachten' ? '#/gruppen' : '#/g/' + g.id });
  });
  (D.bd || []).forEach(b => {
    if (b.user_id !== me() && !known(b.user_id)) return;
    if (bdayGroupsFor(b.user_id).length) return; // steht schon mit der Geburtstagsgruppe drin
    const d = bdNext(b);
    const age = bdAge(b, d);
    out.push({ d, title: b.user_id === me() ? 'Dein Geburtstag' : `Geburtstag von ${nameOf(b.user_id)}`, sub: age && b.user_id !== me() ? `wird ${age}` : '', href: b.user_id === me() ? '#/konto' : '#/p/' + b.user_id });
  });
  (D.gl || []).forEach(l => {
    const d = parseDay(l.occ_date);
    if (d && d >= todayDate() && !out.some(o => +o.d === +d && o.title === l.name)) out.push({ d, title: l.name, sub: 'Schenkliste', href: '#/schenken/' + l.id });
  });
  return out.sort((a, b) => a.d - b.d);
}

function groupFor(w) {
  const g = normGroups().find(g => membersOf(g.id).some(m => m.user_id === w.owner) && visibleIn(w, g.id));
  return g ? g.id : null;
}
// Wo man einen fremden Wunsch reserviert: Liste in der Gruppe, sonst die Liste der Person (1.14)
function wishHref(w) {
  const g = groupFor(w);
  if (g) return `#/g/${g}/p/${w.owner}`;
  return known(w.owner) ? `#/p/${w.owner}` : '#/';
}
function emptyState(ic, title, text, action = '') {
  return `<div class="emptystate"><span class="emptyicon">${icon(ic)}</span><h3>${title}</h3><p>${text}</p>${action}</div>`;
}
function visLabel(w) {
  const names = groupIdsOf(w.id).map(g => (D.groups.find(x => x.id === g) || {}).name).filter(Boolean);
  const g = w.all_groups ? 'Alle Gruppen' : names.join(', ');
  // Freunde nur erwähnen, wenn es welche gibt (1.14)
  if (!friendIds().length) return g || 'Nicht freigegeben';
  const nf = wishFriendIds(w.id).length;
  const fr = w.all_friends !== false ? 'alle Freunde' : (nf ? plural(nf, 'Freund', 'Freunde') : '');
  const out = [g, fr].filter(Boolean).join(' und ');
  return out ? out[0].toUpperCase() + out.slice(1) : 'Nicht freigegeben';
}

/* ---------- Ansichten ---------- */
// Zurück-Knopf mit Ziel (1.17): aus dem Ziel-Link einen Namen machen
function backName(h) {
  const p = String(h || '').replace(/^#\/?/, '').split('?')[0].split('/');
  const fixed = { '': 'Start', liste: 'Wunschliste', ideen: 'Ideen', gruppen: 'Gruppen', freunde: 'Freunde', konto: 'Konto', mehr: 'Konto', steckbrief: 'Steckbrief' };
  try {
    if (p.length === 1 && p[0] in fixed) return fixed[p[0]];
    if (p[0] === 'steckbrief') return 'Steckbrief';
    if (p[0] === 'g' && p[2] === 'p' && p[3]) return nameOf(p[3]);
    if (p[0] === 'g' && p[2] === 'wichteln') return 'Wichteln';
    if (p[0] === 'g' && p[1]) return (D.groups.find(x => x.id === p[1]) || {}).name || 'Gruppe';
    if (p[0] === 'p' && p[1]) return nameOf(p[1]);
    if (p[0] === 'f' && p[1]) {
      if (p[1].startsWith('u:')) return nameOf(p[1].slice(2));
      const ip = ipById(p[1].slice(2));
      return ip ? ipName(ip) : 'Freunde';
    }
    if (p[0] === 'ideen' && p[1] === 'p' && p[2]) { const ip = ipById(p[2]); return ip ? ipName(ip) : 'Ideen'; }
    if (p[0] === 'schenken') return 'Schenkliste';
    if (p[0] === 'gemeinsam') return 'Gemeinsam schenken';
    if (p[0] === 'w') return 'Wunsch';
  } catch (e) { /* fällt auf Zurück */ }
  return 'Zurück';
}
function shell(title, body, opt = {}) {
  const tab = opt.tab || '';
  const back = opt.back ? `<a class="back" href="${opt.back[0]}">${icon('back')}<span>${esc(opt.back[1] === 'Zurück' ? backName(opt.back[0]) : opt.back[1])}</span></a>` : '<span></span>';
  const T = (h, t, n, label) => `<a href="${h}" class="${tab === t ? 'on' : ''}">${icon(n)}<span>${label}</span></a>`;
  return `
  <header class="top">
    ${opt.back ? `<div class="topbar">${back}</div>` : ''}
    <div class="titlerow"><div class="titletext">${opt.eyebrow ? `<p class="eyebrow">${esc(opt.eyebrow)}</p>` : ''}
    <h1 class="title">${esc(title)}</h1></div><div class="topbtns">${opt.plus ? `<button class="iconbtn" data-act="plus" data-v="${opt.plus}" aria-label="Hinzufügen">${icon('plus')}</button>` : ''}<button class="iconbtn" data-act="sync" aria-label="Aktualisieren">${icon('sync')}</button></div></div>
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
      ? `<div class="invcode">Dein Einladungscode für die App<b class="code">${esc(String(S.pendingJoin).toUpperCase())}</b><small>In der App unter Gruppen eingeben.</small></div>`
      : (ctx === 'login' && S.pendingFriend
        ? `<div class="invcode">Dein Freundes-Code für die App<b class="code">${esc(fmtFriendCode(String(S.pendingFriend).toUpperCase()))}</b><small>In der App unter Gruppen → Freunde eingeben.</small></div>` : '');
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
  ['wish', 'Neue Wünsche', 'Aus deinen Gruppen und von Freunden'],
  ['member', 'Neue Mitglieder', 'Wenn jemand beitritt'],
  ['draw', 'Wichteln', 'Wenn ausgelost wurde'],
  ['have', 'Schon vorhanden', 'Bei etwas, das du reserviert hast'],
  ['pool', 'Gemeinsam schenken', 'Anfragen, wer mitmacht, gekauft'],
  ['friend', 'Freundschaften', 'Anfragen und neue Freunde'],
  ['remind', 'Erinnerungen', 'Vor Anlässen deiner Gruppen und vor Geburtstagen']
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
    const sub = st === 'denied' ? 'Auf diesem Gerät ausgeschaltet' : st === 'install' ? 'Nur in der App vom Home-Bildschirm' : 'Noch nicht erlaubt';
    return fold('notify', 'bell', 't2', 'Benachrichtigungen', sub, `<section class="card install">${notifyBody(st, 'konto')}</section>`);
  }
  const prefs = PREFS.filter(([k]) => k !== 'friend' || D.friendsOk);
  const rows = prefs.map(([k, t, d]) => {
    const on = prefOn(k);
    return `<li class="row-item"><span class="row-main"><span class="row-title">${t}</span><span class="row-meta">${d}</span></span>
      <button class="switch ${on ? 'on' : ''}" role="switch" aria-checked="${on}" aria-label="${t}" data-act="pref" data-k="${k}" data-on="${on ? '0' : '1'}"></button></li>`;
  }).join('');
  const nOn = prefs.filter(([k]) => prefOn(k)).length;
  const sub = nOn === prefs.length ? 'An für alles' : nOn ? `An für ${nOn} von ${prefs.length}` : 'An, aber alles abgewählt';
  return fold('notify', 'bell', 't2', 'Benachrichtigungen', sub, `<ul class="rows plain">${rows}</ul>
    <p class="foot">${icon('eyeoff')}<span>Was du dir wünschst, wer etwas reserviert und wen jemand beim Wichteln gezogen hat, verrät keine Nachricht.</span></p>
    <div class="card stack">
      <button class="secondary withicon" data-act="pushtest">${icon('bell')}Testnachricht senden</button>
      <button class="ghost danger-text" data-act="pushoff">Auf diesem Gerät ausschalten</button>
    </div>`);
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
  const invited = S.pendingJoin ? `<div class="banner">${icon('people')}<span><b>Du wurdest eingeladen</b><small>Nach der Anmeldung bist du automatisch in der Gruppe.</small></span></div>`
    : (S.pendingFriend ? `<div class="banner">${icon('people')}<span><b>Freundschaftseinladung</b><small>Nach der Anmeldung kannst du sie bestätigen.</small></span></div>` : '');
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
  const ideasDone = (D.ideas || []).filter(i => i.done_at);
  const bought = errands.filter(x => x.r.status === 'gekauft').length + ideasDone.length;
  const nErr = errands.length + ideasDone.length;
  const days = daysToXmas();
  const today = new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());

  const acc = D.account;
  const secure = needsSecure() ? `<a class="banner tap" href="#/konto">${icon('lock')}<span><b>Konto sichern</b><small>Mit Benutzername und Passwort kommst du auf jedem Gerät an deine Liste.</small></span>${icon('chev', 'chev')}</a>`
    : (acc && acc.reset_notice ? `<div class="banner notice">${icon('shield')}<span><b>Dein Zugang wurde am ${esc(fmtDay(acc.reset_at))} zurückgesetzt</b><small>Du hast jetzt ein neues Passwort und einen neuen Wiederherstellungscode.</small></span><button class="link" data-act="dismissreset">OK</button></div>` : '');
  const hero = heroCard(days, nErr, bought);
  const stats = `<div class="stats">
      <a href="#/liste"><b>${mine.length}</b><span>${mine.length === 1 ? 'Wunsch' : 'Wünsche'}</span></a>
      <div><b>${nErr ? `${bought}<small>/${nErr}</small>` : '0'}</b><span>besorgt</span></div>
      <a href="#/gruppen"><b>${gs.length}</b><span>${gs.length === 1 ? 'Gruppe' : 'Gruppen'}</span></a>
    </div>`;

  // Freundschaftsanfragen (1.14)
  const fq = friendReqsIn();
  const freq = fq.length ? `<a class="banner tap" href="#/freunde">${icon('people')}<span><b>${fq.length === 1 ? `${esc(nameOf(fq[0].user))} möchte mit dir befreundet sein` : `${fq.length} Freundschaftsanfragen`}</b><small>Annehmen oder ablehnen unter Freunde.</small></span>${icon('chev', 'chev')}</a>` : '';

  if (!gs.length && !friendIds().length) {
    return shell('Hallo ' + myName(), `${secure}${freq}${notifyBanner()}${hero}${stats}
      <div class="card cta">
        <h3>Starte mit deiner Familie</h3>
        <p>Lege eine Gruppe an und teile den Einladungscode. Alle in der Gruppe sehen gegenseitig ihre Wunschlisten.</p>
        <div class="btnrow"><a class="primary" href="#/gruppen">Gruppe anlegen</a><a class="secondary" href="#/gruppen">Code eingeben</a></div>
        <p class="small muted">Oder füge einzelne Freunde hinzu, ganz ohne Gruppe. <a href="#/freunde">Zu den Freunden</a></p>
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
  const ideaDoneRow = i => {
    const p = ipById(i.person);
    return `<li class="row-item done">
        <button class="tick on" data-act="ideadone" data-id="${i.id}" aria-label="Doch nicht besorgt">${icon('check')}</button>
        <a class="row-main" href="#/i/${i.id}?r="><span class="row-title">${esc(i.title)}</span><span class="row-meta">für ${esc(p ? ipName(p) : 'jemanden')} · eigene Idee</span></a>
        ${p ? ipAvatar(p, 'sm') : ''}
      </li>`;
  };
  const errHtml = nErr ? `${haveWarn}<ul class="rows">${errands.map(({ r, w }) => {
    const done = r.status === 'gekauft';
    const pool = poolOf(w.id);
    if (pool) {
      return `<li class="row-item ${done ? 'done' : ''}">
        <button class="tick ${done ? 'on' : ''}" data-act="resstatus" data-id="${w.id}" data-s="${done ? 'reserviert' : 'gekauft'}" aria-label="${done ? 'Doch nicht gekauft' : 'Als gekauft markieren'}">${icon('check')}</button>
        <a class="row-main" href="#/gemeinsam/${w.id}"><span class="row-title">${esc(w.title)}</span><span class="row-meta ${w.have_at ? 'warn' : ''}">für ${esc(nameOf(w.owner))} · ${w.have_at ? `hat ${esc(nameOf(w.owner))} schon` : `gemeinsam, ${sharesOf(w.id).length} dabei${done ? ' · gekauft' : ''}`}</span></a>
        ${avatar(w.owner, 'sm')}
      </li>`;
    }
    return `<li class="row-item ${done ? 'done' : ''}">
        <button class="tick ${done ? 'on' : ''}" data-act="resstatus" data-id="${w.id}" data-s="${done ? 'reserviert' : 'gekauft'}" aria-label="${done ? 'Doch nicht gekauft' : 'Als gekauft markieren'}">${icon('check')}</button>
        <a class="row-main" href="${wishHref(w)}"><span class="row-title">${esc(w.title)}</span><span class="row-meta ${w.have_at ? 'warn' : ''}">für ${esc(nameOf(w.owner))} · ${w.have_at ? `hat ${esc(nameOf(w.owner))} schon` : (done ? 'gekauft' : 'reserviert')}</span></a>
        ${avatar(w.owner, 'sm')}
      </li>`;
  }).join('')}${ideasDone.map(ideaDoneRow).join('')}</ul>`
    : `<p class="empty-line">Noch nichts reserviert. Öffne eine Liste in deinen Gruppen und tippe auf „Reservieren“.</p>`;

  // Neu seit dem letzten Besuch: erst neue Mitglieder, dann neue Wünsche (sonst die letzten 6)
  const nw = newWishes(), nm = newMembers();
  const FEED_MAX = 8;
  const wishRow = w => {
    const r = resOf(w.id);
    const isNew = nw.includes(w);
    return `<li><a class="row-item ${isNew ? 'isnew' : ''}" href="${wishHref(w)}">${avatar(w.owner)}
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
    const fr = friendIds().length;
    feedHead = `<h2>${fr ? 'Neu bei deinen Leuten' : 'Neu in deinen Gruppen'}</h2>`;
    feedHtml = feed.length ? `<ul class="rows">${feed.map(wishRow).join('')}</ul>`
      : `<p class="empty-line">Sobald jemand aus deinen Gruppen${fr ? ' oder ein Freund' : ''} etwas einträgt, erscheint es hier.</p>`;
  }

  return shell('Hallo ' + myName(), `${secure}${freq}${notifyBanner()}${hero}${stats}${wichtelHtml}${poolHome()}
    <h2>Was du schenkst</h2>${errHtml}
    ${feedHead}${feedHtml}`, { tab: 'home', eyebrow: today });
}

/* ---------- Design (1.10) ---------- */
function theme() { return window.GLTheme ? GLTheme.resolve() : 'jahr'; }
function xmasYear() { const d = new Date(); return d.getMonth() === 0 ? d.getFullYear() - 1 : d.getFullYear(); }
function heroCard(days, nErr, nDone) {
  const when = days === 0 ? 'heute' : (days === 1 ? 'morgen' : `in ${days} Tagen`);
  const allDone = nErr > 0 && nDone === nErr;
  const early = allDone && days >= EARLY_DAYS;
  if (theme() !== 'weihnachten') {
    // Seit 1.15: der nächste echte Anlass (Gruppe, Geburtstag, Schenkliste); ohne Anlass-Spalten wie bisher Heiligabend
    const next = D.occOk ? upcoming()[0] : { d: nextYearly(12, 24), title: 'Heiligabend', sub: '' };
    if (!next) {
      return `<a class="hero hero-jahr" href="#/gruppen"><span class="hero-ic">${icon('calendar')}</span>
        <div class="hero-main"><p class="hero-label">Nächster Anlass</p><p class="hero-title">Noch keiner eingetragen</p><p class="hero-label hero-early">In einer Gruppe unter Verwalten festlegen</p></div></a>`;
    }
    const n = daysUntil(next.d);
    const done = allDone && next.title === 'Heiligabend' ? `<p class="hero-label hero-early">${early ? 'Alles besorgt. Früh dran.' : 'Alles besorgt.'}</p>` : '';
    const tag = next.href ? 'a' : 'section';
    return `<${tag} class="hero hero-jahr"${next.href ? ` href="${next.href}"` : ''}><span class="hero-ic">${icon(next.title.startsWith('Geburtstag') || next.title === 'Dein Geburtstag' ? 'cake' : 'calendar')}</span>
      <div class="hero-main"><p class="hero-label">Nächster Anlass · ${whenText(n)}</p><p class="hero-title">${esc(next.title)} · ${next.d.getDate()}.${next.d.getMonth() + 1}.</p>${next.sub ? `<p class="hero-label hero-early">${esc(next.sub)}</p>` : ''}${done}</div></${tag}>`;
  }
  const sub = allDone ? (early ? 'Alles besorgt. Früh dran.' : 'Alles besorgt.') : (nErr ? `${nDone} von ${plural(nErr, 'Besorgung', 'Besorgungen')} erledigt` : 'Noch nichts reserviert');
  return `<section class="hero hero-xmas"><p class="hero-num">${days === 0 ? 'Heute' : days}</p>
      <div class="hero-main"><p class="hero-title">${days === 0 ? 'ist Heiligabend' : (days === 1 ? 'Tag bis Heiligabend' : 'Tage bis Heiligabend')}</p><p class="hero-label">${sub}</p></div>
      <span class="hero-deco">${icon('star')}${icon('snow')}</span></section>`;
}
const THEMES = [
  ['auto', 'Automatisch', 'Weihnachten vom 1. November bis 6. Januar, sonst Ganzjährig'],
  ['jahr', 'Ganzjährig', 'Violett, Koralle und Sonnengelb'],
  ['weihnachten', 'Weihnachten', 'Zuckerstange, Minze und Vanille', 'Tannengrün, Cranberry und Gold']];
const MODES = [['light', 'Hell', 'sun'], ['auto', 'Automatisch', ''], ['dark', 'Dunkel', 'moon']];
// Klappbereiche unter Konto (Design, Datenschutz): anfangs zu, Zustand bleibt beim Neuzeichnen erhalten (1.10.4)
const folds = {};
document.addEventListener('toggle', e => { if (e.target.classList && e.target.classList.contains('fold')) folds[e.target.id] = e.target.open; }, true);
function fold(id, ic, tint, title, sub, inner, def = false) {
  return `<details class="fold" id="${id}" ${(id in folds ? folds[id] : def) ? 'open' : ''}><summary><span class="tile ${tint}">${icon(ic)}</span>
      <span class="foldsum"><b>${title}</b><small>${sub}</small></span>${icon('chev', 'chev')}</summary>${inner}</details>`;
}
function themeSection() {
  const p = window.GLTheme ? GLTheme.pref() : 'auto';
  const dark = window.GLTheme ? GLTheme.mode() === 'dark' : false;
  const opts = THEMES.map(([k, n, d, dd]) => `<button class="themeopt ${p === k ? 'on' : ''}" role="radio" aria-checked="${p === k}" data-act="theme" data-v="${k}">
      <span class="swatches sw-${k}"><i></i><i></i><i></i></span><span class="themetext"><b>${n}</b><small>${dark && dd ? dd : d}</small></span>${icon('check', 'themecheck')}</button>`).join('');
  const m = window.GLTheme ? GLTheme.modePref() : 'auto';
  const modes = MODES.map(([k, n, ic]) =>
    `<label><input type="radio" name="mode" value="${k}" data-act="mode" data-v="${k}" ${m === k ? 'checked' : ''}><span>${ic ? icon(ic) : ''}${n}</span></label>`).join('');
  const tName = THEMES.find(t => t[0] === p)[1];
  const mName = MODES.find(t => t[0] === m)[1];
  const sum = p === 'auto' && m === 'auto' ? 'Automatisch' : `${tName} · ${m === 'auto' ? 'Hell/Dunkel wie Gerät' : mName}`;
  return fold('design', 'palette', 't0', 'Design', sum, `<div class="themes" role="radiogroup" aria-label="Design">${opts}</div>
    <div class="seg modeseg" role="radiogroup" aria-label="Hell oder dunkel">${modes}</div>`);
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
  const haveHtml = have.length ? `<h2>Habe ich schon bekommen</h2><ul class="cards">${have.map(row).join('')}</ul>` : '';
  const body = all.length
    ? `${add}${list.length ? `<ul class="cards">${list.map(row).join('')}</ul>` : '<p class="empty-line">Alles auf deiner Liste hast du schon.</p>'}${haveHtml}${cardLink(true)}<p class="foot">${icon('eyeoff')}<span>Ob etwas reserviert ist, siehst du nicht. So bleibt es eine Überraschung.</span></p>`
    : emptyState('gift', 'Deine Liste ist noch leer', 'Trag ein, worüber du dich freuen würdest. Ein Link hilft den anderen, genau das Richtige zu finden.', add) + cardLink(true);
  return shell('Meine Wunschliste', listSwitch('w') + body, { tab: 'list', eyebrow: theme() === 'weihnachten' ? 'Weihnachten ' + xmasYear() : 'Alle Anlässe', sub: plural(list.length, 'Wunsch', 'Wünsche') });
}

/* ---------- Private Ideenliste (1.11) ----------
   Ideen für andere, nur für mich sichtbar. Person = jemand aus meinen Gruppen (linked_user)
   oder ein frei angelegter Name. Personen-Schlüssel im Formular: u:<uid> bzw. p:<idea_people.id>. */
function listSwitch(on) {
  const n = (D.ideas || []).filter(i => !i.done_at).length;
  return `<nav class="subtabs" aria-label="Wunschliste oder Ideen"><a href="#/liste" class="${on === 'w' ? 'on' : ''}">Meine Wünsche</a>
    <a href="#/ideen" class="${on === 'i' ? 'on' : ''}">Ideen für andere${n ? `<span class="subcount">${n}</span>` : ''}</a></nav>`;
}
const ipById = id => (D.ip || []).find(p => p.id === id);
const ipFor = uid => (D.ip || []).find(p => p.linked_user === uid);
const ideasFor = pid => (D.ideas || []).filter(i => i.person === pid);
// Leute aus meinen Gruppen (ohne mich), nach Namen
function groupPeople() {
  const ids = new Set();
  normGroups().forEach(g => membersOf(g.id).forEach(m => { if (m.user_id !== me()) ids.add(m.user_id); }));
  return [...ids].sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'de'));
}
const inMyGroups = uid => groupPeople().includes(uid);
// Alle, die ich kenne: aus meinen Gruppen und direkte Freunde (1.14)
function knownPeople() {
  const ids = new Set(groupPeople());
  friendIds().forEach(u => ids.add(u));
  return [...ids].sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'de'));
}
function ipName(p) {
  if (p.linked_user && (realName(p.linked_user) || nickOf(p.linked_user))) return baseName(p.linked_user);
  return p.name;
}
function ipAvatar(p, size = '') {
  if (p.linked_user && known(p.linked_user)) return avatar(p.linked_user, size);
  return `<span class="av ${size} c${hueIdx(p.id)}">${esc(initials(p.name))}</span>`;
}
// Wohin „Zurück“ nach dem Speichern führt (?r=… im Hash, nur eigene Pfade)
function backParam() {
  const m = /[?&]r=([\w/:-]*)/.exec(location.hash);
  return m ? '#/' + m[1] : '';
}
const byDone = (a, b) => (a.done_at ? 1 : 0) - (b.done_at ? 1 : 0);
function ideaRow(i, ret) {
  const done = !!i.done_at;
  const meta = [wishMeta(i), i.url ? domain(i.url) : '', done ? 'besorgt' : ''].filter(Boolean).join(' · ');
  return `<li class="row-item ${done ? 'done' : ''}">
      <button class="tick ${done ? 'on' : ''}" data-act="ideadone" data-id="${i.id}" aria-label="${done ? 'Doch nicht besorgt' : 'Als besorgt markieren'}">${icon('check')}</button>
      <a class="row-main" href="#/i/${i.id}${ret ? '?r=' + ret : ''}"><span class="row-title">${esc(i.title)}</span>${meta ? `<span class="row-meta">${esc(meta)}</span>` : ''}</a>
      ${icon('chev', 'chev')}
    </li>`;
}
const privacyFoot = who => `<p class="foot">${icon('eyeoff')}<span>Deine Ideen sieht niemand außer dir${who ? `, auch nicht ${esc(who)}` : ''}.</span></p>`;
// Hinweis, wenn die Datenbank noch nicht aktualisiert wurde (1.15)
function dbHint() {
  return `<div class="banner warn dbhint">${icon('sync')}<span><b>Datenbank aktualisieren</b><small>Diese Funktion braucht die neue schema.sql. Sie wird einmal im Supabase SQL-Editor ausgeführt.</small></span></div>`;
}
function ideasMissing() {
  return emptyState('bulb', 'Noch nicht eingerichtet', 'Für die Ideenliste muss die Datenbank einmal aktualisiert werden (schema.sql ausführen).');
}

function viewIdeas() {
  const opt = { tab: 'list', eyebrow: 'Nur für dich' };
  if (!D.ideasOk) return shell('Ideen für andere', listSwitch('i') + ideasMissing(), opt);
  const all = D.ideas;
  const add = `<a class="primary withicon" href="#/i/neu">${icon('plus')}Idee notieren</a>`;
  if (!all.length && !D.ip.some(p => !p.linked_user)) {
    return shell('Ideen für andere', listSwitch('i') + emptyState('bulb', 'Noch keine Ideen', 'Notiere, was dir für andere einfällt, auch für Leute ohne App. Nur du siehst es.', add) + giftListsSection(), opt);
  }
  // Personen mit offenen Ideen zuerst, dann nach Namen; frei angelegte ohne Ideen bleiben sichtbar
  const people = D.ip.filter(p => ideasFor(p.id).length || !p.linked_user).map(p => {
    const list = ideasFor(p.id).slice().sort(byDone);
    return { p, list, open: list.filter(i => !i.done_at).length };
  }).sort((a, b) => (b.open ? 1 : 0) - (a.open ? 1 : 0) || ipName(a.p).localeCompare(ipName(b.p), 'de'));
  const sec = ({ p, list, open }) => `<div class="sechead ideahead"><a href="#/f/${friendKey(p)}?r=ideen" class="ideaperson">${ipAvatar(p, 'sm')}<h2>${esc(ipName(p))}</h2></a>
      <span class="row-meta">${list.length ? (open ? plural(open, 'Idee', 'Ideen') : 'alles besorgt') : 'noch keine Ideen'}</span></div>
      ${list.length ? `<ul class="rows plain">${list.map(i => ideaRow(i, 'ideen')).join('')}</ul>` : ''}`;
  const open = all.filter(i => !i.done_at).length;
  return shell('Ideen für andere', `${listSwitch('i')}${add}${giftListsSection()}${people.map(sec).join('')}${privacyFoot('die Person selbst')}`,
    Object.assign(opt, { sub: `${plural(open, 'offene Idee', 'offene Ideen')}${all.length - open ? ` · ${all.length - open} besorgt` : ''}` }));
}

/* ---------- Schenklisten (1.15) ----------
   Eigene Liste zu einem Anlass: wem ich etwas schenke, abhaken, wenn erledigt. Personen aus der Ideenliste. */
const glById = id => (D.gl || []).find(l => l.id === id);
const glPeople = id => (D.glp || []).filter(x => x.list_id === id);
function glMeta(l) {
  const ps = glPeople(l.id), done = ps.filter(x => x.done_at).length;
  const d = parseDay(l.occ_date);
  const when = d && d >= todayDate() ? `${fmtDate(d)} · ` : '';
  return when + (ps.length ? `${done} von ${ps.length} erledigt` : 'noch niemand eingetragen');
}
function giftListsSection() {
  if (!D.glOk) return '';
  const rows = D.gl.map(l => `<li><a class="row-item" href="#/schenken/${l.id}"><span class="tile plain">${icon('gift')}</span>
      <span class="row-main"><span class="row-title">${esc(l.name)}</span><span class="row-meta">${esc(glMeta(l))}</span></span>${icon('chev', 'chev')}</a></li>`).join('');
  const form = `<form data-form="newgl" class="inline"><input name="name" maxlength="40" placeholder="z. B. Weihnachten ${xmasYear()}" required aria-label="Name der Schenkliste"><button class="secondary" type="submit">Anlegen</button></form>`;
  return `<h2>Schenklisten</h2>${rows ? `<ul class="rows">${rows}</ul>` : '<p class="small muted">Wem schenkst du etwas? Leg eine Liste an und hak ab, wer erledigt ist.</p>'}
    <div class="card">${form}</div>`;
}
function viewGiftList(id) {
  const back = ['#/ideen', 'Ideen'];
  if (!D.glOk) return shell('Schenkliste', dbHint(), { tab: 'list', back });
  const l = glById(id);
  if (!l) return shell('Schenkliste', emptyState('gift', 'Nicht gefunden', 'Diese Schenkliste gibt es nicht mehr.'), { tab: 'list', back });
  const ps = glPeople(id).map(x => ({ x, p: ipById(x.person) })).filter(o => o.p)
    .sort((a, b) => (a.x.done_at ? 1 : 0) - (b.x.done_at ? 1 : 0) || ipName(a.p).localeCompare(ipName(b.p), 'de'));
  const rows = ps.map(({ x, p }) => {
    const n = ideasFor(p.id).filter(i => !i.done_at).length;
    const meta = [n ? plural(n, 'Idee', 'Ideen') : '', p.linked_user && known(p.linked_user) ? plural(openWishes(p.linked_user).length, 'Wunsch', 'Wünsche') : '', x.done_at ? 'erledigt' : ''].filter(Boolean).join(' · ');
    return `<li class="row-item ${x.done_at ? 'done' : ''}">
      <button class="tick ${x.done_at ? 'on' : ''}" data-act="gldone" data-l="${id}" data-p="${p.id}" aria-label="${x.done_at ? 'Doch nicht erledigt' : 'Als erledigt markieren'}">${icon('check')}</button>
      <a class="row-main" href="#/f/${friendKey(p)}?r=schenken/${id}"><span class="row-title">${esc(ipName(p))}</span>${meta ? `<span class="row-meta">${esc(meta)}</span>` : ''}</a>
      ${ipAvatar(p, 'sm')}
    </li>`;
  }).join('');
  const inList = new Set(ps.map(o => o.p.id));
  const kp = knownPeople().filter(uid => !(ipFor(uid) && inList.has(ipFor(uid).id)));
  const own = (D.ip || []).filter(p => !(p.linked_user && known(p.linked_user)) && !inList.has(p.id));
  const opts = kp.map(uid => `<option value="u:${uid}">${esc(nameOf(uid))}</option>`).join('')
    + (own.length ? `<optgroup label="Ohne App">${own.map(p => `<option value="p:${p.id}">${esc(ipName(p))}</option>`).join('')}</optgroup>` : '')
    + '<option value="new">Neue Person …</option>';
  const done = ps.filter(o => o.x.done_at).length;
  const del = ui.confirmDelGl === id
    ? `<button class="danger" data-act="gldel" data-id="${id}">Wirklich löschen</button>`
    : `<button class="ghost danger-text" data-act="askgldel" data-id="${id}">Schenkliste löschen</button>`;
  return shell(l.name, `
    ${rows ? `<ul class="rows plain">${rows}</ul>` : `<p class="empty-line">Noch niemand auf der Liste.</p>`}
    <h2>Person hinzufügen</h2>
    <div class="card"><form data-form="glAdd" data-id="${id}" class="stack">
      <label>Wer?<select name="person" required><option value="">Person auswählen</option>${opts}</select></label>
      <label id="pnew" class="hide">Name<input name="pname" maxlength="40" placeholder="z. B. Oma Ruth"></label>
      <button class="primary" type="submit">Hinzufügen</button>
    </form></div>
    <h2>Verwalten</h2>
    <div class="card stack">
      <form data-form="glEdit" data-id="${id}" class="stack">
        <label>Name<input name="name" maxlength="40" value="${esc(l.name)}" required></label>
        <label>Datum (freiwillig)<input name="date" type="date" value="${esc(l.occ_date || '')}"></label>
        <button class="secondary" type="submit">Speichern</button>
      </form>
      ${del}
    </div>
    <p class="foot">${icon('eyeoff')}<span>Schenklisten siehst nur du.</span></p>`, { tab: 'list', back, eyebrow: 'Schenkliste', sub: ps.length ? `${done} von ${ps.length} erledigt` : '' });
}

/* ---------- Freunde (1.11.1, direkte Freundschaft seit 1.14) ----------
   Alle Leute aus meinen Gruppen, direkte Freunde und selbst angelegte Personen der Ideenliste an einem Ort.
   Schlüssel wie im Ideen-Formular: u:<uid> (kenne ich) oder p:<idea_people.id>. */
function friendOf(key) {
  let uid = null, p = null;
  if (/^u:[\w-]+$/.test(key || '')) { uid = key.slice(2); p = ipFor(uid) || null; }
  else if (/^p:[\w-]+$/.test(key || '')) { p = ipById(key.slice(2)) || null; if (p && p.linked_user) uid = p.linked_user; }
  if (uid && !known(uid)) uid = null;
  if (!uid && !p) return null;
  return { uid, p, key: uid ? 'u:' + uid : 'p:' + p.id, name: uid ? nameOf(uid) : ipName(p) };
}
const friendKey = p => (p.linked_user && known(p.linked_user) ? 'u:' + p.linked_user : 'p:' + p.id);
const sharedGroups = uid => normGroups().filter(g => membersOf(g.id).some(m => m.user_id === uid));
function friendsList() {
  const kp = knownPeople().map(uid => ({ key: 'u:' + uid, uid, p: ipFor(uid) || null, name: nameOf(uid) }));
  const own = (D.ip || []).filter(p => !(p.linked_user && known(p.linked_user))).map(p => ({ key: 'p:' + p.id, uid: null, p, name: ipName(p) }));
  return kp.concat(own).sort((a, b) => a.name.localeCompare(b.name, 'de'));
}
const friendReqsIn = () => ((D.fq || {}).in || []);
const friendReqsOut = () => ((D.fq || {}).out || []);
const reqFrom = uid => friendReqsIn().find(r => r.user === uid);
const reqTo = uid => friendReqsOut().find(r => r.user === uid);
function groupsSwitch(on) {
  const n = friendsList().length, q = friendReqsIn().length;
  return `<nav class="subtabs" aria-label="Gruppen oder Freunde"><a href="#/gruppen" class="${on === 'g' ? 'on' : ''}">Gruppen</a>
    <a href="#/freunde" class="${on === 'f' ? 'on' : ''}">Freunde${q ? `<span class="subcount new">${q}</span>` : (n ? `<span class="subcount">${n}</span>` : '')}</a></nav>`;
}
function friendLink(code) { return location.origin + location.pathname + '#/freund/' + code; }
function fmtFriendCode(c) { return String(c || '').replace(/(.{4})(?=.)/g, '$1-'); }

// Anfragen an mich: Annehmen / Ablehnen
function friendReqCards() {
  const list = friendReqsIn();
  if (!list.length) return '';
  return `<h2>Anfragen</h2><ul class="rows">${list.map(r => `<li class="row-item freq">${avatar(r.user)}
      <span class="row-main"><span class="row-title">${esc(nameOf(r.user))}</span><span class="row-meta">möchte mit dir befreundet sein · ${esc(ago(r.at))}</span></span>
      <span class="acts"><button class="primary sm" data-act="freqyes" data-id="${r.id}">Annehmen</button><button class="ghost sm" data-act="freqno" data-id="${r.id}">Ablehnen</button></span></li>`).join('')}</ul>`;
}

// Plus oben rechts (1.17): Auswahl als Fenster
function openForm(key, v) {
  const fromMenu = !!ui.plus;
  delete ui.plus;
  ui[key] = !fromMenu && ui[key] === v ? '' : v;   // zweites Tippen klappt wieder zu
  render();
  const f = ui[key] && $('form[data-form="' + ({ new: 'newgroup', join: 'join', ask: 'friendadd', noapp: 'newfriend' })[v] + '"]');
  if (f) { f.scrollIntoView({ block: 'center', behavior: 'smooth' }); f.querySelector('input').focus({ preventScroll: true }); }
}
function plusMenu(kind) {
  if (ui.plus !== kind) return '';
  const it = (act, v, ic, label, sub) => `<li><button class="row-item" data-act="${act}" data-v="${v}"><span class="tile plain">${icon(ic)}</span>
      <span class="row-main"><span class="row-title">${label}</span><span class="row-meta">${sub}</span></span></button></li>`;
  const items = kind === 'g'
    ? it('gform', 'new', 'plus', 'Neue Gruppe', 'Für Familie oder Freunde')
      + it('gform', 'join', 'key', 'Einladungscode eingeben', 'Einer Gruppe beitreten')
      + (D.bdgOk ? `<li><a class="row-item" href="#/geburtstag/neu" data-act="plusclose"><span class="tile plain">${icon('cake')}</span>
      <span class="row-main"><span class="row-title">Geburtstagsgruppe</span><span class="row-meta">Gemeinsam für jemanden schenken</span></span></a></li>` : '')
    : (D.friendsOk ? it('friendshare', '', 'share', 'Freundes-Link teilen', 'Per WhatsApp, Mail oder SMS')
      + it('fform', 'ask', 'user', 'Mit Benutzername anfragen', 'Wenn du den Benutzernamen kennst') : '')
      + (D.ideasOk ? it('fform', 'noapp', 'plus', 'Person ohne App', 'Nur für deine Ideen') : '');
  return `<div class="modalwrap"><div class="modalbg" data-act="plusclose"></div>
    <div class="modal card stack plusmenu" role="dialog" aria-modal="true" aria-labelledby="plust">
      <h2 class="modaltitle" id="plust">Hinzufügen</h2>
      <ul class="rows plain">${items}</ul>
      <button class="ghost" data-act="plusclose">Abbrechen</button>
    </div></div>`;
}

function viewFriends() {
  const list = friendsList();
  const row = f => {
    const nIdeas = f.p ? ideasFor(f.p.id).filter(i => !i.done_at).length : 0;
    const meta = f.uid
      ? [sharedGroups(f.uid).map(g => g.name).join(', '), isFriend(f.uid) ? 'befreundet' : '', plural(openWishes(f.uid).length, 'Wunsch', 'Wünsche')].filter(Boolean)
      : ['Ohne App'];
    if (nIdeas) meta.push(plural(nIdeas, 'Idee', 'Ideen'));
    return `<li><a class="row-item" href="#/f/${f.key}">${f.uid ? avatar(f.uid) : ipAvatar(f.p)}
      <span class="row-main"><span class="row-title">${esc(f.name)}</span><span class="row-meta">${esc(meta.join(' · '))}</span></span>${icon('chev', 'chev')}</a></li>`;
  };
  // 1.17: Knöpfe statt offener Formulare (ohne Personen gleich offen), Liste als Fenster mit 5 Personen
  const open = list.length ? ui.fform : 'all';
  const newCode = ui.confirmNewCode ? `<button class="danger sm" data-act="friendnewcode">Neuen Link erzeugen, alter gilt nicht mehr</button>` : `<button class="link newcode" data-act="asknewcode">Alten Link ungültig machen</button>`;
  const fAsk = `<div class="card stack"><form data-form="friendadd" class="inline"><input name="q" maxlength="80" placeholder="Benutzername oder Freundes-Code" autocapitalize="none" autocomplete="off" autocorrect="off" spellcheck="false" required aria-label="Benutzername oder Freundes-Code"><button class="secondary" type="submit">Anfragen</button></form></div>`;
  const fNoApp = D.ideasOk ? `<div class="card"><form data-form="newfriend" class="inline"><input name="name" maxlength="40" placeholder="Name, z. B. Oma Ruth" aria-label="Name" required><button class="secondary" type="submit">Hinzufügen</button></form></div>` : '';
  let addFriend;
  if (!D.friendsOk) addFriend = `<h2>Freund hinzufügen</h2>${dbHint()}`;
  else if (open === 'all') addFriend = `<h2>Freund hinzufügen</h2>
    <div class="card stack friendadd">
      <p class="small muted">Teile deinen Freundes-Link. Wer ihn öffnet und bestätigt, ist mit dir befreundet, auch ohne gemeinsame Gruppe.</p>
      <button class="primary withicon" data-act="friendshare">${icon('share')}Freundes-Link teilen</button>
      ${newCode}
      <form data-form="friendadd" class="inline"><input name="q" maxlength="80" placeholder="Benutzername oder Freundes-Code" autocapitalize="none" autocomplete="off" autocorrect="off" spellcheck="false" required aria-label="Benutzername oder Freundes-Code"><button class="secondary" type="submit">Anfragen</button></form>
    </div>`;
  else addFriend = `<div class="addbar friendadd"><button class="secondary withicon" data-act="friendshare">${icon('share')}Freundes-Link teilen</button>
      <button class="${open === 'ask' ? 'secondary on' : 'secondary'} withicon" data-act="fform" data-v="ask" aria-expanded="${open === 'ask'}">${icon('user')}Mit Benutzername anfragen</button>
      ${D.ideasOk ? `<button class="${open === 'noapp' ? 'secondary on' : 'secondary'} withicon" data-act="fform" data-v="noapp" aria-expanded="${open === 'noapp'}">${icon('plus')}Person ohne App</button>` : ''}</div>
    ${open === 'ask' ? fAsk : open === 'noapp' ? fNoApp : ''}${newCode}`;
  const out = friendReqsOut();
  const outHtml = out.length ? `<h2>Gesendete Anfragen</h2><ul class="rows plain">${out.map(r => `<li class="row-item">
      <span class="row-main"><span class="row-title">${esc(r.user ? nameOf(r.user) : '@' + r.name)}</span><span class="row-meta">wartet · ${esc(ago(r.at))}</span></span>
      <button class="ghost sm" data-act="freqwithdraw" data-id="${r.id}">Zurückziehen</button></li>`).join('')}</ul>` : '';
  const add = open === 'all' && fNoApp ? `<h2>Person ohne App</h2>${fNoApp}` : '';
  const body = list.length
    ? `${friendReqCards()}<ul class="rows${list.length > 5 ? ' scrollbox' : ''}" data-box="f">${list.map(row).join('')}</ul>${addFriend}${outHtml}${add}<p class="foot">${icon('eyeoff')}<span>Leute ohne App, Spitznamen und deine Ideen siehst nur du.</span></p>`
    : friendReqCards() + emptyState('people', 'Noch niemand hier', 'Hier erscheinen alle aus deinen Gruppen, deine Freunde und Leute ohne App, die du selbst anlegst.') + addFriend + outHtml + add;
  return shell('Freunde', groupsSwitch('f') + body + plusMenu('f'), { tab: 'groups', plus: 'f', sub: list.length ? plural(list.length, 'Person', 'Personen') : '' });
}

// Spitzname vergeben (nur für mich sichtbar); leer = entfernen
function nickForm(uid, cls = '') {
  return `<form data-form="nick" data-u="${uid}" class="inline ${cls}"><input name="nick" maxlength="40" value="${esc(nickOf(uid))}" placeholder="Spitzname" aria-label="Spitzname, nur für dich"><button class="secondary sm" type="submit">${nickOf(uid) ? 'Ändern' : 'Speichern'}</button></form>`;
}

function viewFriend(key) {
  const back = backParam() ? [backParam(), 'Zurück'] : ['#/freunde', 'Freunde'];
  const f = friendOf(key);
  if (!f) return shell('Freunde', emptyState('people', 'Nicht gefunden', 'Diese Person gibt es hier nicht mehr.'), { tab: 'groups', back });
  const { uid, p, name } = f;
  const ret = 'f/' + f.key;
  const shared = uid ? sharedGroups(uid) : [];
  const friend = uid && isFriend(uid);
  const ws = uid ? openWishes(uid).sort(byPrio) : [];
  const nFree = ws.filter(w => !resOf(w.id)).length;
  const ideas = p ? ideasFor(p.id).slice().sort(byDone) : [];
  const nOpen = ideas.filter(i => !i.done_at).length;
  const where = uid ? [shared.map(g => g.name).join(', '), friend ? 'befreundet' : ''].filter(Boolean).join(' · ') : (p.linked_user ? 'Nicht mehr in deinen Gruppen' : 'Ohne App');
  const real = uid && nickOf(uid) && realName(uid) && realName(uid) !== nickOf(uid) ? `<p class="row-meta">Heißt in der App ${esc(realName(uid))}</p>` : '';
  const head = `<section class="profile">${uid ? avatar(uid, 'lg') : ipAvatar(p, 'lg')}<div class="profile-main">
      <p class="row-meta">${esc(where)}</p>${real}${uid ? bdLine(uid) : ''}${bdayLink(f)}
      ${uid && ws.length ? `<progress max="${ws.length}" value="${ws.length - nFree}"></progress>` : ''}</div></section>`;
  // Gleicher Name wie jemand anderes und noch kein Spitzname: Hinweis mit Formular
  const dup = uid && isDup(uid) && !nickOf(uid) && D.friendsOk ? `<div class="banner dupname">${icon('user')}<span><b>Mehrere heißen ${esc(baseName(uid))}</b><small>Gib ${esc(baseName(uid))} einen Spitznamen, den nur du siehst. Bis dahin steht ${esc(nameOf(uid).slice(baseName(uid).length + 1))} dahinter.</small>${nickForm(uid, 'tight')}</span></div>` : '';
  const incoming = uid ? reqFrom(uid) : null;
  const reqBanner = incoming ? `<div class="banner">${icon('people')}<span><b>${esc(name)} möchte mit dir befreundet sein</b><small>Ihr seht dann gegenseitig eure Wünsche, auch ohne gemeinsame Gruppe.</small></span>
      <span class="acts"><button class="primary sm" data-act="freqyes" data-id="${incoming.id}">Annehmen</button></span></div>` : '';

  let html = '';
  if (uid) {
    if (shared.length) {
      const gRows = shared.map(g => `<li><a class="row-item" href="#/g/${g.id}/p/${uid}"><span class="tile c${hueIdx(g.id)}">${esc(initials(g.name))}</span>
          <span class="row-main"><span class="row-title">${esc(g.name)}</span><span class="row-meta">${plural(openWishes(uid, g.id).length, 'Wunsch', 'Wünsche')} in dieser Gruppe</span></span>${icon('chev', 'chev')}</a></li>`).join('');
      html += fold('fr-groups', 'people', 't1', 'Gemeinsame Gruppen', plural(shared.length, 'Gruppe', 'Gruppen'), `<ul class="rows plain">${gRows}</ul>`);
    }
    const status = w => {
      const r = resOf(w.id);
      if (!r) return 'offen';
      if (poolOf(w.id)) return inPool(w.id) ? 'gemeinsam, du bist dabei' : 'gemeinsames Geschenk';
      if (r.user_id === me()) return r.status === 'gekauft' ? 'von dir gekauft' : 'von dir reserviert';
      return 'vergeben';
    };
    const listHref = `#/p/${uid}?r=${ret}`;
    const wRows = ws.map(w => `<li><a class="row-item ${resOf(w.id) ? 'taken' : ''}" href="${listHref}">${tile(w)}
        <span class="row-main"><span class="row-title">${prioMark(w)}${esc(w.title)}</span><span class="row-meta">${esc(wishMeta(w, [status(w)]))}</span></span>${icon('chev', 'chev')}</a></li>`).join('');
    html += fold('fr-wishes', 'gift', 't0', 'Wünsche', ws.length ? `${plural(ws.length, 'Wunsch', 'Wünsche')} · ${nFree} noch frei` : 'Noch keine Wünsche',
      ws.length ? `<ul class="rows plain">${wRows}</ul><a class="secondary withicon" href="${listHref}">${icon('gift')}Liste öffnen und reservieren</a><p class="foot">${icon('eyeoff')}<span>${esc(name)} sieht nicht, was reserviert ist.</span></p>` : `<p class="empty-line">${esc(name)} hat noch nichts eingetragen.</p>`, true);
  }
  if (uid) html += cardFold(uid, name);
  if (D.ideasOk) {
    const iList = ideas.length ? `<ul class="rows plain">${ideas.map(i => ideaRow(i, ret)).join('')}</ul>` : '';
    html += fold('fr-ideas', 'bulb', 't2', 'Deine Ideen', ideas.length ? `${plural(nOpen, 'offene Idee', 'offene Ideen')}${ideas.length - nOpen ? ` · ${ideas.length - nOpen} besorgt` : ''}` : 'Nur du siehst sie',
      `${iList}<a class="secondary withicon addidea" href="#/i/neu/${f.key}?r=${ret}">${icon('plus')}Idee notieren</a>`, true);
  }
  // Verwalten: Spitzname, Freundschaft, Person ohne App
  const parts = [];
  let sub = [];
  if (uid && D.friendsOk) {
    parts.push(`<div class="field"><span class="flabel">Spitzname</span>${nickForm(uid)}<p class="muted fhelp">Nur du siehst ihn. Er steht überall statt ${esc(realName(uid) || 'des Namens')}.</p></div>`);
    sub.push(nickOf(uid) ? 'Spitzname ' + nickOf(uid) : 'Spitzname');
    if (friend) {
      sub.push('befreundet');   // Entfernen seit 1.17.1 unten auf der Seite
    } else if (incoming) {
      parts.push(`<button class="primary sm" data-act="freqyes" data-id="${incoming.id}">Freundschaft annehmen</button>`);
    } else if (reqTo(uid)) {
      parts.push(`<p class="small muted">Freundschaftsanfrage gesendet, wartet.</p>`);
    } else {
      parts.push(`<button class="secondary withicon sm" data-act="friendask" data-id="${uid}">${icon('people')}Als Freund hinzufügen</button><p class="muted fhelp">Dann seht ihr euch auch ohne gemeinsame Gruppe.</p>`);
    }
  }
  let del = '';
  if (p) {
    const linked = !!uid;
    const cands = knownPeople().filter(u => u !== p.linked_user);
    const opts = cands.map(u => `<option value="${u}">${esc(nameOf(u))}</option>`).join('');
    if (!linked) parts.push(`<form data-form="ipname" data-id="${p.id}" class="inline">
        <input name="name" maxlength="40" required value="${esc(p.name)}" aria-label="Name"><button class="secondary sm" type="submit">Umbenennen</button></form>`);
    if (!linked && cands.length) parts.push(`<form data-form="iplink" data-id="${p.id}" class="stack tight">
        <label>Ist ${esc(name)} inzwischen dabei?<select name="u" required><option value="">Person auswählen</option>${opts}</select></label>
        <button class="secondary sm" type="submit">Mit Konto verbinden</button></form>`);
    if (p.linked_user) parts.push(`<button class="ghost sm" data-act="ipunlink" data-id="${p.id}">Verknüpfung mit dem Konto lösen</button>`);
    // Person ohne App: Entfernen unten auf der Seite (1.17.1); verknüpft: nur die Ideen löschen
    if (linked) del = ui.confirmDelIp === p.id
      ? `<button class="danger" data-act="delip" data-id="${p.id}">${ideas.length ? `Mit ${plural(ideas.length, 'Idee', 'Ideen')} löschen` : 'Wirklich löschen'}</button>`
      : `<button class="ghost danger-text" data-act="askdelip" data-id="${p.id}">Ideen für diese Person löschen</button>`;
    if (!uid) sub = ['Umbenennen, verknüpfen'];
  }
  if (parts.length || del) {
    html += fold('fr-manage', 'user', 't0', 'Verwalten', sub.join(' · ') || 'Verknüpft mit dem Konto', `<div class="card stack manage">${parts.join('')}</div>${del}`);
  }
  // Freund bzw. Person ohne App entfernen (1.17.1): klein unten, Bestätigung im Fenster
  const rmKind = uid && friend && D.friendsOk ? 'f' : (!uid && p ? 'p' : '');
  const rm = rmKind ? `<p class="removerow"><button class="link danger-text" data-act="askremove">${rmKind === 'f' ? 'Freund entfernen' : 'Person entfernen'}</button></p>` : '';
  const dlg = rmKind && ui.removeDlg ? `<div class="modalwrap"><div class="modalbg" data-act="removecancel"></div>
    <div class="modal card stack" role="alertdialog" aria-modal="true" aria-labelledby="rmt" aria-describedby="rmd">
      <span class="tile t2 modalicon">${icon('trash')}</span>
      <h2 class="modaltitle" id="rmt">${esc(name)} ${rmKind === 'f' ? 'als Freund entfernen?' : 'entfernen?'}</h2>
      <p id="rmd">${rmKind === 'f'
        ? 'Ihr seht dann gegenseitig keine Wünsche mehr, außer über gemeinsame Gruppen. Reservierungen bleiben.'
        : (ideas.length ? `Deine ${plural(ideas.length, 'Idee', 'Ideen')} für ${esc(name)} werden mit gelöscht.` : `${esc(name)} verschwindet aus deiner Liste.`)}</p>
      <button class="danger" data-act="${rmKind === 'f' ? 'unfriend' : 'delip'}" data-id="${rmKind === 'f' ? uid : p.id}">Entfernen</button>
      <button class="ghost" data-act="removecancel">Abbrechen</button>
    </div></div>` : '';
  return shell(name, bdayLinkAsk(p) + reqBanner + head + dup + html + rm + privacyFoot(name) + dlg, { tab: 'groups', back });
}

// Geburtstagsgruppe anlegen oder öffnen (1.16)
function bdayLink(f) {
  if (!D.bdgOk) return '';
  const ex = f.uid ? bdayGroupsFor(f.uid)[0] : myGroups().find(g => isBday(g) && !g.archived_at && !g.bday_user && f.p && g.bday_person === f.p.id);
  if (ex) return `<a class="link withicon bdaylink" href="#/g/${ex.id}">${icon('cake')}Zur Geburtstagsgruppe</a>`;
  return `<a class="link withicon bdaylink" href="#/geburtstag/neu/${f.key}?r=f/${f.key}">${icon('cake')}Geburtstagsgruppe anlegen</a>`;
}
// Person ohne App wird mit einem Konto verknüpft: gilt das auch für die Geburtstagsgruppe?
function bdayLinkAsk(p) {
  const a = ui.bdLinkAsk;
  if (!a || !p || a.pid !== p.id) return '';
  const gs = a.gids.map(id => myGroups().find(g => g.id === id)).filter(Boolean);
  return `<div class="banner bdlinkask">${icon('cake')}<span><b>Ist ${esc(nameOf(a.uid))} die Person aus „${esc(gs.map(g => g.name).join('“, „'))}“?</b><small>Dann gilt die Verknüpfung für alle in der Gruppe. Sie sehen danach die Wünsche, die ${esc(nameOf(a.uid))} für alle freigegeben hat.</small></span>
    <span class="acts"><button class="primary sm" data-act="bdlinkyes">Ja</button><button class="ghost sm" data-act="bdlinkno">Nein</button></span></div>`;
}

/* Freundes-Link geöffnet: #/freund/<code> (1.14) */
function viewFriendCode(code) {
  const back = ['#/freunde', 'Freunde'];
  ui.peek = ui.peek || {};
  const x = ui.peek[code];
  if (x === undefined) {
    ui.peek[code] = 'laden';
    sb('/rest/v1/rpc/friend_peek', { method: 'POST', body: { p_code: code } })
      .then(r => { (ui.peek = ui.peek || {})[code] = r; }).catch(e => { (ui.peek = ui.peek || {})[code] = { err: e.message }; })
      .then(() => { if (route()[0] === 'freund') render(); });
  }
  if (x === undefined || x === 'laden') return shell('Freundes-Link', '<p class="boot">Lädt …</p>', { tab: 'groups', back });
  let body;
  if (!x) body = emptyState('people', 'Link gilt nicht mehr', 'Diesen Freundes-Link gibt es nicht (mehr). Bitte um einen neuen.');
  else if (x.err) body = emptyState('people', 'Hat nicht geklappt', esc(x.err));
  else if (x.self) body = emptyState('people', 'Das ist dein eigener Link', 'Schick ihn an Leute, mit denen du befreundet sein möchtest.', `<button class="primary withicon" data-act="friendshare">${icon('share')}Freundes-Link teilen</button>`);
  else if (x.friends || isFriend(x.user)) body = emptyState('people', `Ihr seid schon befreundet`, `Du und ${esc(x.name)} seht gegenseitig eure Wünsche.`, `<a class="primary" href="#/f/u:${esc(x.user)}">Zu ${esc(nameOf(x.user) === 'Jemand' ? x.name : nameOf(x.user))}</a>`);
  else {
    body = `<div class="card reveal friendinvite">
      <span class="av lg c${hueIdx(x.user)}">${esc(initials(x.name))}</span>
      <p class="eyebrow">Freundschaft</p>
      <p class="reveal-name">${esc(x.name)}</p>
      <p class="small muted">möchte mit dir befreundet sein. Ihr seht dann gegenseitig eure Wünsche und könnt füreinander reservieren, auch ohne gemeinsame Gruppe.</p>
      <button class="primary" data-act="friendcode" data-id="${esc(code)}">Freund werden</button>
      <a class="ghost" href="#/">Nein danke</a>
    </div>`;
  }
  return shell('Freundes-Link', body, { tab: 'groups', back });
}

function viewIdeaForm(id, key) {
  const ret = backParam();
  const neu = id === 'neu';
  const i = neu ? { title: '', url: '', note: '' } : (D.ideas || []).find(x => x.id === id);
  const back = [ret || '#/ideen', ret ? 'Zurück' : 'Ideen'];
  if (!D.ideasOk) return shell('Idee', ideasMissing(), { tab: 'list', back });
  if (!i) return shell('Idee', emptyState('bulb', 'Nicht gefunden', 'Diese Idee gibt es nicht mehr.'), { tab: 'list', back });
  // Auswahl: Leute aus meinen Gruppen und Freunde, dann frei angelegte (und solche, die ich nicht mehr kenne)
  const gp = knownPeople();
  const own = D.ip.filter(p => !p.linked_user || !gp.includes(p.linked_user));
  let cur = '';
  if (!neu) { const p = ipById(i.person); cur = p && p.linked_user && gp.includes(p.linked_user) ? 'u:' + p.linked_user : 'p:' + i.person; }
  else if (key && /^[up]:[\w-]+$/.test(key)) cur = key.startsWith('p:') && ipById(key.slice(2)) && ipById(key.slice(2)).linked_user && gp.includes(ipById(key.slice(2)).linked_user) ? 'u:' + ipById(key.slice(2)).linked_user : key;
  const o = (v, n) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${esc(n)}</option>`;
  const sel = `<option value="" ${cur ? '' : 'selected'} disabled>Person auswählen</option>`
    + (gp.length ? `<optgroup label="${friendIds().length ? 'Gruppen und Freunde' : 'Aus deinen Gruppen'}">${gp.map(u => o('u:' + u, nameOf(u))).join('')}</optgroup>` : '')
    + (own.length ? `<optgroup label="Ohne App">${own.map(p => o('p:' + p.id, ipName(p))).join('')}</optgroup>` : '')
    + `<option value="new" ${cur === 'new' ? 'selected' : ''}>Neue Person …</option>`;
  const cats = '<option value="">Keine</option>' + CATS.map(([k, n]) => `<option value="${k}" ${i.category === k ? 'selected' : ''}>${esc(n)}</option>`).join('');
  const done = neu ? '' : (i.done_at
    ? `<button type="button" class="secondary" data-act="ideadone" data-id="${id}">Doch nicht besorgt</button>`
    : `<button type="button" class="secondary withicon" data-act="ideadone" data-id="${id}">${icon('check')}Besorgt</button>`);
  const del = neu ? '' : `<button type="button" class="ghost danger-text" data-act="delidea" data-id="${id}">Idee löschen</button>`;
  const doneNote = i.done_at ? `<div class="banner">${icon('check')}<span><b>Besorgt am ${esc(fmtDay(i.done_at))}</b></span></div>` : '';
  return shell(neu ? 'Neue Idee' : 'Idee bearbeiten', `${doneNote}
    <form data-form="idea" data-id="${id}" class="stack">
      <div class="card fields">
        <label>Für wen?<select name="person" required>${sel}</select></label>
        <label class="${cur === 'new' ? '' : 'hide'}" id="pnew">Name<input name="pname" maxlength="40" autocomplete="off" placeholder="z. B. Oma Ruth"></label>
        <label>Was könnte passen?<input name="title" maxlength="120" required value="${esc(i.title)}" placeholder="z. B. Fotobuch vom Urlaub"></label>
      </div>
      ${fold('i-more-' + id, 'more', 't1', 'Mehr Angaben', 'Link, Preis, Kategorie, Notiz', `<div class="card fields">
        <div class="field"><div class="fieldhead"><label for="f-url">Link</label><button type="button" class="link withicon" data-act="pasteurl">${icon('paste')}Einfügen</button></div>
          <input id="f-url" name="url" inputmode="url" autocomplete="off" value="${esc(i.url || '')}" placeholder="https://"></div>
        <div class="two">
          <label>Preis<span class="money"><input name="price" inputmode="decimal" autocomplete="off" maxlength="12" value="${esc(priceInput(i.price))}" placeholder="ca."><span>€</span></span></label>
          <label>Kategorie<select name="category">${cats}</select></label>
        </div>
        <label>Notiz<textarea name="note" maxlength="1000" rows="3" placeholder="Wo gesehen, Größe, Farbe">${esc(i.note || '')}</textarea></label>
      </div>`, !!(i.url || i.price != null || i.category || i.note))}
      <button class="primary" type="submit">Speichern</button>
      ${done}
      ${del}
    </form>${privacyFoot('die Person selbst')}`, { tab: 'list', back });
}

// Abschnitt auf der Seite einer Person in der Gruppe
function personIdeas(gid, uid) {
  if (!D.ideasOk) return '';
  const p = ipFor(uid);
  const list = p ? ideasFor(p.id).slice().sort(byDone) : [];
  const ret = gid ? `g/${gid}/p/${uid}` : `p/${uid}`;
  const key = p ? 'p:' + p.id : 'u:' + uid;
  return `<div class="sechead"><h2>Deine Ideen</h2><a class="link" href="#/f/u:${uid}?r=${ret}">Alles zu ${esc(nameOf(uid))}</a></div>
    ${list.length ? `<ul class="rows plain">${list.map(i => ideaRow(i, ret)).join('')}</ul>` : ''}
    <a class="secondary withicon addidea" href="#/i/neu/${key}?r=${ret}">${icon('bulb')}Idee für ${esc(nameOf(uid))} notieren</a>
    ${privacyFoot(nameOf(uid))}`;
}

/* ---------- Gemeinsam schenken (1.13) ----------
   Wer startet, reserviert den Wunsch, kauft und streckt vor (Rolle lässt sich abgeben).
   Aufteilung gleich, nach Budget (Höchstbetrag) oder individuell; Betrag leer = flexibel.
   Optional Mindestzahl und Frist; danach entscheidet, wer kauft. Die beschenkte Person sieht nichts. */
const SPLITS = [
  ['equal', 'Gleich', 'Alle zahlen gleich viel. Kommt jemand dazu, wird es für alle weniger.'],
  ['budget', 'Budget', 'Jeder nennt, wie viel er höchstens gibt. Die App verteilt so gleichmäßig wie möglich.'],
  ['custom', 'Individuell', 'Jeder trägt seinen Betrag ein. Wer nichts einträgt, teilt sich den Rest.']];
const splitName = k => (SPLITS.find(x => x[0] === k) || SPLITS[0])[1];
const poolOf = wid => D.poolsOk ? (D.pools || []).find(p => p.wish_id === wid) || null : null;
const sharesOf = wid => (D.shares || []).filter(s => s.wish_id === wid);
const inPool = (wid, uid = me()) => sharesOf(wid).some(s => s.user_id === uid);
const pad2 = n => String(n).padStart(2, '0');
const isoDay = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const todayIso = () => isoDay(new Date());
const fmtDl = d => fmtDay(d + 'T12:00:00');
const poolClosed = p => !!(p.deadline && p.deadline < todayIso());
const poolShort = p => !!(p.min_people && sharesOf(p.wish_id).length < p.min_people);
const fmtCents = c => fmtPrice(Math.round(c) / 100);
const cents = v => v == null ? null : Math.round(Number(v) * 100);
const POOL_NO = 'geschenkeliste-gemeinsam-nein';
function poolNo() { try { return JSON.parse(localStorage.getItem(POOL_NO)) || {}; } catch (e) { return {}; } }

/* Anteile in Cent: {per: {uid: cent}, total, missing (positiv = fehlt, negativ = zu viel)} */
function poolCalc(p, ss) {
  const total = cents(p.total);
  const per = {};
  const order = ss.slice().sort((a, b) => (a.user_id === p.buyer ? -1 : (b.user_id === p.buyer ? 1 : 0)));
  // gleichmäßig verteilen, übrige Cent an die ersten (wer kauft, zuerst)
  const spread = (users, sum) => {
    if (!users.length) return;
    const base = Math.floor(sum / users.length);
    let rest = sum - base * users.length;
    users.forEach(u => { per[u] = (per[u] || 0) + base + (rest-- > 0 ? 1 : 0); });
  };
  if (p.split === 'custom') {
    let fixed = 0;
    const flex = [];
    order.forEach(s => { const a = cents(s.amount); if (a == null) flex.push(s.user_id); else { per[s.user_id] = a; fixed += a; } });
    flex.forEach(u => { per[u] = 0; });
    spread(flex, Math.max(0, total - fixed));
  } else if (p.split === 'budget') {
    // Wer wenig geben kann, gibt sein Budget; der Rest verteilt sich gleichmäßig auf die anderen
    const srt = order.map(s => ({ u: s.user_id, cap: cents(s.amount) }))
      .sort((a, b) => (a.cap == null ? Infinity : a.cap) - (b.cap == null ? Infinity : b.cap));
    srt.forEach(x => { per[x.u] = 0; });
    let left = total;
    for (let i = 0; i < srt.length; i++) {
      const n = srt.length - i;
      if (srt[i].cap != null && srt[i].cap * n < left) { per[srt[i].u] = srt[i].cap; left -= srt[i].cap; }
      else { spread(srt.slice(i).map(x => x.u), left); left = 0; break; }
    }
  } else {
    spread(order.map(s => s.user_id), total);
  }
  const sum = Object.values(per).reduce((a, b) => a + b, 0);
  return { per, total, missing: total - sum };
}
/* Was hieße es für mich, wenn ich (mit Betrag a) dazukomme? */
function poolPreview(p, a) {
  const ss = sharesOf(p.wish_id).filter(s => s.user_id !== me()).concat([{ user_id: me(), amount: a }]);
  return poolCalc(p, ss);
}
function poolBack(w) {
  const r = backParam();
  if (r) return [r, 'Zurück'];
  const h = wishHref(w);
  return h !== '#/' ? [h, nameOf(w.owner)] : ['#/', 'Start'];
}
const poolRet = () => (backParam() ? '?r=' + backParam().slice(2) : '');

function poolMissing(w) {
  return shell('Gemeinsam schenken', `<div class="banner warn">${icon('shield')}<span><b>Noch nicht eingerichtet</b><small>Die Datenbank ist noch nicht aktualisiert (schema.sql ausführen).</small></span></div>`,
    { tab: 'groups', back: w ? poolBack(w) : ['#/', 'Start'] });
}

// Kurztext für Listen: „Gemeinsam · 3 dabei“
function poolLabel(p) { return `Gemeinsam · ${sharesOf(p.wish_id).length} dabei`; }

function viewPool(wid) {
  const w = D.wishes.find(x => x.id === wid && x.owner !== me());
  const p = poolOf(wid);
  if (!D.poolsOk) return poolMissing(w);
  if (!w || !p) {
    return shell('Gemeinsam schenken', emptyState('people', 'Nicht verfügbar', 'Dieses gemeinsame Geschenk gibt es nicht mehr oder du bist nicht gefragt.'),
      { tab: 'groups', back: w ? poolBack(w) : ['#/', 'Start'] });
  }
  const r = resOf(wid);
  const ss = sharesOf(wid);
  const c = poolCalc(p, ss);
  const buyer = p.buyer === me();
  const member = inPool(wid);
  const owner = nameOf(w.owner);
  const closed = poolClosed(p);
  const short = poolShort(p);
  const ret = 'gemeinsam/' + wid + poolRet();
  const bought = r && r.status === 'gekauft';

  const link = w.url ? `<a class="link-out" href="${esc(w.url)}" target="_blank" rel="noopener noreferrer">${icon('link')}${esc(domain(w.url) || 'Link')}</a>` : '';
  const head = `<div class="card wish poolwish"><div class="wish-head">${tile(w)}<div class="row-main"><h3>${esc(w.title)}</h3>
      <p class="wmeta"><span>für ${esc(owner)}${w.price != null ? ' · ' + esc(fmtPrice(w.price)) : ''}</span></p>${link}</div></div>
      ${p.note ? `<p class="wnote">${esc(p.note)}</p>` : ''}</div>`;

  // Hinweise
  let notes = '';
  if (w.have_at) notes += `<div class="banner warn">${icon('gift')}<span><b>${esc(owner)} hat es schon</b><small>${buyer ? 'Sag ab, falls du es noch nicht gekauft hast.' : `Sprich dich mit ${esc(nameOf(p.buyer))} ab.`}</small></span></div>`;
  if (closed && short && buyer) {
    notes += `<div class="banner warn pooldue">${icon('calendar')}<span><b>Die Frist ist um</b><small>${ss.length} von ${p.min_people} dabei. Wie soll es weitergehen?</small></span></div>
      <div class="btnrow poolchoice"><button class="primary sm" data-act="pooltrotz" data-id="${wid}">Trotzdem schenken</button><a class="secondary sm" href="#/gemeinsam/${wid}/bearbeiten?r=${ret}">Frist verlängern</a></div>`;
  } else if (closed && !member) {
    notes += `<div class="banner">${icon('calendar')}<span><b>Mitmachen ging bis ${esc(fmtDl(p.deadline))}</b><small>Frag ${esc(nameOf(p.buyer))}, ob noch Platz ist.</small></span></div>`;
  }

  // Überblick
  const each = p.split === 'equal' && ss.length ? fmtCents(c.total / ss.length) : '';
  const sumRows = [
    ['Gesamt', fmtCents(c.total)],
    ['Aufteilung', splitName(p.split) + (each ? ` · je ca. ${each}` : '')],
    ['Kauft und streckt vor', buyer ? 'Du' : nameOf(p.buyer)],
    p.min_people ? ['Mindestens', `${p.min_people} Leute${short ? ` · noch ${p.min_people - ss.length}` : ' · erreicht'}`] : null,
    p.deadline ? ['Mitmachen bis', fmtDl(p.deadline) + (closed ? ' · vorbei' : '')] : null,
    ['Gefragt', p.open ? 'Alle, die die Liste sehen' : (p.invited || []).map(nameOf).join(', ') || 'Niemand'],
    bought ? ['Stand', 'Gekauft'] : null
  ].filter(Boolean);
  const covered = c.total - Math.max(0, c.missing);
  const gap = c.missing > 0 ? `<p class="poolgap warn">${icon('ban')}Es fehlen noch ${esc(fmtCents(c.missing))}</p>`
    : (c.missing < 0 ? `<p class="poolgap">${icon('check')}${esc(fmtCents(-c.missing))} mehr als nötig</p>` : '');
  const summary = `<div class="card poolsum"><div class="poolbig"><b>${ss.length}</b><span>${ss.length === 1 ? 'Person' : 'Personen'} dabei</span></div>
      ${p.split !== 'equal' ? `<progress max="${c.total}" value="${covered}" aria-label="gedeckt"></progress>${gap}` : ''}
      <ul class="facts">${sumRows.map(([k, v]) => `<li><span>${esc(k)}</span><b>${esc(v)}</b></li>`).join('')}</ul></div>`;

  // Teilnehmer
  const paidOthers = ss.filter(s => s.user_id !== p.buyer);
  const owed = paidOthers.reduce((a, s) => a + (c.per[s.user_id] || 0), 0);
  const got = paidOthers.filter(s => s.paid_at).reduce((a, s) => a + (c.per[s.user_id] || 0), 0);
  const row = s => {
    const isBuyer = s.user_id === p.buyer;
    const amt = c.per[s.user_id] || 0;
    const hint = p.split === 'budget' ? (s.amount == null ? 'ohne Grenze' : 'höchstens ' + fmtPrice(s.amount))
      : (p.split === 'custom' ? (s.amount == null ? 'teilt den Rest' : 'fester Betrag') : '');
    const state = isBuyer ? 'streckt vor' : (s.paid_at ? 'bezahlt' : 'noch offen');
    const tick = !isBuyer && buyer
      ? `<button class="tick ${s.paid_at ? 'on' : ''}" data-act="poolpaid" data-id="${wid}" data-u="${s.user_id}" data-on="${s.paid_at ? '0' : '1'}" aria-label="${s.paid_at ? 'Doch nicht bezahlt' : 'Als bezahlt markieren'}">${icon('check')}</button>` : '';
    return `<li class="row-item ${s.paid_at ? 'paid' : ''}">${tick}${avatar(s.user_id)}
        <span class="row-main"><span class="row-title">${esc(nameOf(s.user_id))}</span><span class="row-meta">${isBuyer ? '<span class="tag hi">kauft</span>' : (s.paid_at ? '<span class="tag ok">bezahlt</span>' : '')}${esc([hint, isBuyer || s.paid_at ? '' : state].filter(Boolean).join(' · '))}</span></span>
        <b class="poolamt">${esc(fmtCents(amt))}</b></li>`;
  };
  const waiting = p.open ? [] : (p.invited || []).filter(u => !ss.some(s => s.user_id === u));
  const people = `<div class="sechead"><h2>Wer mitmacht</h2>${owed ? `<span class="muted">${esc(fmtCents(got))} von ${esc(fmtCents(owed))} bezahlt</span>` : ''}</div>
    <ul class="rows plain poolrows">${ss.map(row).join('')}</ul>
    ${waiting.length ? `<p class="empty-line">Gefragt, noch nicht dabei: ${esc(waiting.map(nameOf).join(', '))}</p>` : ''}`;

  // Was ich tun kann
  let mine = '';
  const amtField = (val, label) => `<label>${label}<span class="money"><input name="amount" inputmode="decimal" autocomplete="off" maxlength="12" value="${esc(priceInput(val))}" placeholder="${p.split === 'budget' ? 'ohne Grenze' : 'Rest teilen'}"><span>€</span></span></label>`;
  if (buyer) {
    const others = ss.filter(s => s.user_id !== me());
    const hand = ui.handover === wid
      ? `<div class="card options poolhand"><p class="muted">Wer kauft stattdessen?</p>${others.map(s => `<button class="row-item plainbtn" data-act="poolhandto" data-id="${wid}" data-u="${s.user_id}">${avatar(s.user_id, 'sm')}<span class="row-main"><span class="row-title">${esc(nameOf(s.user_id))}</span></span>${icon('chev', 'chev')}</button>`).join('')}
         <button class="ghost sm" data-act="poolnoconfirm">Abbrechen</button></div>` : '';
    const cancel = ui.confirmPool === wid
      ? `<button class="danger" data-act="poolcancel" data-id="${wid}">Wirklich absagen</button><button class="ghost" data-act="poolnoconfirm">Doch nicht</button>`
      : `<button class="ghost danger-text" data-act="askpoolcancel" data-id="${wid}">Absagen und freigeben</button>`;
    mine = `<h2>Du kaufst</h2>
      <div class="card fields poolme">
        <p class="poolmine"><span>Dein Anteil</span><b>${esc(fmtCents(c.per[me()] || 0))}</b></p>
        ${p.split !== 'equal' ? `<form data-form="pooljoin" data-id="${wid}" class="inline poolamtform">${amtField((ss.find(s => s.user_id === me()) || {}).amount, p.split === 'budget' ? 'Dein Höchstbetrag' : 'Dein Betrag')}<button class="secondary sm" type="submit">Ändern</button></form>` : ''}
      </div>
      <div class="stack poolbtns">
        ${bought ? `<button class="secondary" data-act="resstatus" data-id="${wid}" data-s="reserviert">Doch nicht gekauft</button>`
          : `<button class="primary withicon" data-act="resstatus" data-id="${wid}" data-s="gekauft">${icon('check')}Als gekauft markieren</button>`}
        <a class="secondary" href="#/gemeinsam/${wid}/bearbeiten?r=${ret}">Bearbeiten</a>
        ${others.length && !hand ? `<button class="ghost" data-act="poolhand" data-id="${wid}">Kaufen abgeben</button>` : ''}
        ${hand}
        ${cancel}
      </div>`;
  } else if (member) {
    const me_ = ss.find(s => s.user_id === me());
    const leave = ui.confirmPool === wid
      ? `<button class="danger" data-act="poolleave" data-id="${wid}">Wirklich aussteigen</button><button class="ghost" data-act="poolnoconfirm">Doch nicht</button>`
      : `<button class="ghost danger-text" data-act="askpoolcancel" data-id="${wid}">Nicht mehr mitmachen</button>`;
    mine = `<h2>Du machst mit</h2>
      <div class="card fields poolme">
        <p class="poolmine"><span>Dein Anteil${bought ? '' : ' (Stand jetzt)'}</span><b>${esc(fmtCents(c.per[me()] || 0))}</b></p>
        <p class="muted">${me_.paid_at ? `Bezahlt am ${esc(fmtDay(me_.paid_at))}.` : `Zahl den Betrag an ${esc(nameOf(p.buyer))} und hak es dann ab.`}</p>
        ${p.split !== 'equal' ? `<form data-form="pooljoin" data-id="${wid}" class="inline poolamtform">${amtField(me_.amount, p.split === 'budget' ? 'Dein Höchstbetrag' : 'Dein Betrag')}<button class="secondary sm" type="submit">Ändern</button></form>` : ''}
      </div>
      <div class="stack poolbtns">
        ${me_.paid_at ? `<button class="secondary" data-act="poolpaid" data-id="${wid}" data-u="${me()}" data-on="0">Doch nicht bezahlt</button>`
          : `<button class="primary withicon" data-act="poolpaid" data-id="${wid}" data-u="${me()}" data-on="1">${icon('check')}Ich habe bezahlt</button>`}
        ${leave}
      </div>`;
  } else if (!closed && !w.have_at) {
    const pre = p.split === 'equal' ? poolPreview(p, null).per[me()] : null;
    mine = `<h2>Machst du mit?</h2>
      <form data-form="pooljoin" data-id="${wid}" class="card fields poolme">
        ${p.split === 'equal' ? `<p class="poolmine"><span>Dein Anteil wäre</span><b>${esc(fmtCents(pre))}</b></p>`
          : amtField(null, p.split === 'budget' ? 'Wie viel gibst du höchstens?' : 'Wie viel gibst du?')}
        <p class="muted">${esc(SPLITS.find(x => x[0] === p.split)[2])}</p>
        <button class="primary" type="submit">Ich mache mit</button>
      </form>`;
  }

  return shell('Gemeinsam schenken', `${notes}${head}${summary}${mine}${people}
    <p class="foot">${icon('eyeoff')}<span>${esc(owner)} sieht nichts davon. Gefragt sind nur die Leute oben.</span></p>`,
    { tab: 'groups', back: poolBack(w) });
}

// Leute, die den Wunsch sehen (aus meinen Gruppen), ohne die beschenkte Person und mich.
// Seit 1.14 zusätzlich alle, die ich kenne und die ihn als Freund der Person sehen (fragt die Datenbank, einmal pro Seite).
function poolCandidates(w) {
  const out = [];
  normGroups().filter(g => visibleIn(w, g.id) && membersOf(g.id).some(m => m.user_id === w.owner))
    .forEach(g => membersOf(g.id).forEach(m => { if (m.user_id !== w.owner && m.user_id !== me() && !out.includes(m.user_id)) out.push(m.user_id); }));
  if (D.friendsOk) {
    ui.pc = ui.pc || {};
    if (ui.pc[w.id] === undefined) {
      ui.pc[w.id] = null;
      const h = location.hash;
      sb('/rest/v1/rpc/pool_candidates', { method: 'POST', body: { p_wish: w.id } })
        .then(r => { (ui.pc = ui.pc || {})[w.id] = r || []; if (location.hash === h && (r || []).some(u => !out.includes(u))) render(); })
        .catch(() => { (ui.pc = ui.pc || {})[w.id] = []; });
    }
    (ui.pc[w.id] || []).forEach(u => { if (u !== w.owner && u !== me() && !out.includes(u)) out.push(u); });
  }
  return out.sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'de'));
}

function viewPoolForm(wid, mode) {
  const w = D.wishes.find(x => x.id === wid && x.owner !== me());
  if (!D.poolsOk) return poolMissing(w);
  const edit = mode === 'bearbeiten';
  const p = poolOf(wid);
  const r = resOf(wid);
  const back = w ? (edit ? [backParam() || '#/gemeinsam/' + wid, 'Zurück'] : poolBack(w)) : ['#/', 'Start'];
  if (!w) return shell('Gemeinsam schenken', emptyState('gift', 'Nicht gefunden', 'Diesen Wunsch gibt es nicht mehr.'), { tab: 'groups', back });
  if (edit && (!p || p.buyer !== me())) return shell('Gemeinsam schenken', emptyState('people', 'Nicht verfügbar', 'Ändern kann nur, wer kauft.'), { tab: 'groups', back });
  if (!edit && p) return viewPool(wid);
  if (!edit && (w.have_at || (r && r.user_id !== me()))) {
    return shell('Gemeinsam schenken', emptyState('lock', 'Schon vergeben', 'Diesen Wunsch hat schon jemand reserviert.'), { tab: 'groups', back });
  }
  const x = edit ? p : { total: w.price, split: 'equal', open: true, invited: [], min_people: null, deadline: null, note: '' };
  const cands = poolCandidates(w);
  (x.invited || []).forEach(u => { if (!cands.includes(u)) cands.push(u); });
  const owner = nameOf(w.owner);
  const splits = SPLITS.map(([v, n]) => `<label><input type="radio" name="split" value="${v}" ${x.split === v ? 'checked' : ''}><span>${n}</span></label>`).join('');
  const help = SPLITS.find(s => s[0] === x.split)[2];
  const boxes = cands.map(u => `<label class="check"><input type="checkbox" name="pu" value="${u}" ${(x.invited || []).includes(u) ? 'checked' : ''}><span>${esc(nameOf(u))}</span></label>`).join('');
  const mins = '<option value="">Keine</option>' + [2, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20].map(n => `<option value="${n}" ${x.min_people === n ? 'selected' : ''}>${n}</option>`).join('');
  const minDay = x.deadline && x.deadline < todayIso() ? x.deadline : todayIso();
  const own = edit ? '' : `<label id="myamt" class="${x.split === 'equal' ? 'hide' : ''}"><span id="myamtlabel">${x.split === 'budget' ? 'Dein Höchstbetrag' : 'Dein Betrag'}</span><span class="money"><input name="amount" inputmode="decimal" autocomplete="off" maxlength="12" placeholder="leer = flexibel"><span>€</span></span></label>`;
  return shell(edit ? 'Gemeinsam bearbeiten' : 'Gemeinsam schenken', `
    <div class="card wish poolwish"><div class="wish-head">${tile(w)}<div class="row-main"><h3>${esc(w.title)}</h3><p class="wmeta"><span>für ${esc(owner)}${w.price != null ? ' · ' + esc(fmtPrice(w.price)) : ''}</span></p></div></div></div>
    <form data-form="${edit ? 'pooledit' : 'poolstart'}" data-id="${wid}" class="stack">
      <div class="card fields">
        <label>Was kostet es insgesamt?<span class="money"><input name="total" inputmode="decimal" autocomplete="off" maxlength="12" required value="${esc(priceInput(x.total))}" placeholder="z. B. 120"><span>€</span></span></label>
        <div class="field"><span class="flabel">Wie wird aufgeteilt?</span><div class="seg">${splits}</div><p class="muted fhelp" id="splithelp">${esc(help)}</p></div>
        ${own}
      </div>
      <h2>Wen fragst du?</h2>
      <div class="card options">
        <label class="check"><input type="radio" name="who" value="all" ${x.open ? 'checked' : ''}><span>Alle, die die Liste sehen<small>Jeder kann mitmachen, ${esc(owner)} ausgenommen</small></span></label>
        <label class="check"><input type="radio" name="who" value="some" ${x.open ? '' : 'checked'}><span>Nur bestimmte Leute</span></label>
        <div class="sub ${x.open ? 'hide' : ''}" id="ppick">${boxes || '<p class="muted">Von deinen Leuten sieht sonst niemand diesen Wunsch.</p>'}</div>
      </div>
      <h2>Wenn zu wenige mitmachen</h2>
      <div class="card fields">
        <div class="two"><label>Mindestens dabei<select name="min">${mins}</select></label>
          <label>Mitmachen bis<input type="date" name="deadline" min="${minDay}" value="${esc(x.deadline || '')}"></label></div>
        <p class="muted fhelp">Ist die Frist um und es sind zu wenige, entscheidest du: trotzdem schenken, verlängern oder absagen.</p>
        <label>Notiz für alle<textarea name="note" maxlength="300" rows="2" placeholder="z. B. Ich bestelle am Freitag">${esc(x.note || '')}</textarea></label>
      </div>
      <button class="primary" type="submit">${edit ? 'Speichern' : 'Starten und fragen'}</button>
    </form>
    <p class="foot">${icon('eyeoff')}<span>${edit ? '' : 'Du reservierst den Wunsch, kaufst und streckst das Geld vor. '}${esc(owner)} sieht nichts davon.</span></p>`,
    { tab: 'groups', back });
}

// Formular lesen (Start und Bearbeiten)
function poolFormData(f) {
  const total = parsePrice(f.total.value);
  if (!total) throw new Error('Gib den Gesamtbetrag ein.');
  const split = (f.querySelector('input[name="split"]:checked') || {}).value || 'equal';
  const open = ((f.querySelector('input[name="who"]:checked') || {}).value || 'all') === 'all';
  const invited = open ? [] : [...f.querySelectorAll('input[name="pu"]:checked')].map(x => x.value);
  if (!open && !invited.length) throw new Error('Wähle mindestens eine Person aus.');
  const min = f.min.value ? Number(f.min.value) : null;
  const deadline = f.deadline.value || null;
  return { p_total: total, p_split: split, p_open: open, p_invited: invited, p_min: min, p_deadline: deadline, p_note: f.note.value.trim() || null };
}
function amountOf(f) {
  if (!f.amount) return null;
  const a = parsePrice(f.amount.value);
  if (a === false || a === 0) throw new Error('Den Betrag verstehe ich nicht.');
  return a;
}
// Ändern mit den bisherigen Werten (z. B. „Trotzdem schenken“)
function poolUpdate(p, ch) {
  const body = Object.assign({ p_wish: p.wish_id, p_total: Number(p.total), p_split: p.split, p_open: p.open, p_invited: p.invited || [],
    p_min: p.min_people, p_deadline: p.deadline, p_note: p.note }, ch);
  return sb('/rest/v1/rpc/pool_update', { method: 'POST', body });
}

// Startseite: Anfragen, Beteiligungen und fällige Entscheidungen
function poolHome() {
  if (!D.poolsOk) return '';
  const no = poolNo();
  const rows = [];
  const due = [];
  (D.pools || []).forEach(p => {
    const w = D.wishes.find(x => x.id === p.wish_id);
    if (!w || w.owner === me()) return;
    const href = `#/gemeinsam/${p.wish_id}`;
    if (p.buyer === me()) {
      if (poolClosed(p) && poolShort(p)) due.push(`<a class="banner warn tap" href="${href}">${icon('calendar')}<span><b>Frist für „${esc(w.title)}“ ist um</b><small>${sharesOf(p.wish_id).length} von ${p.min_people} dabei. Entscheide, wie es weitergeht.</small></span>${icon('chev', 'chev')}</a>`);
      return;
    }
    const s = sharesOf(p.wish_id).find(x => x.user_id === me());
    if (s) {
      const c = poolCalc(p, sharesOf(p.wish_id));
      const bought = (resOf(p.wish_id) || {}).status === 'gekauft';
      rows.push(`<li><a class="row-item" href="${href}">${avatar(w.owner)}<span class="row-main"><span class="row-title">${esc(w.title)}</span>
        <span class="row-meta">${s.paid_at ? '<span class="tag ok">bezahlt</span>' : ''}für ${esc(nameOf(w.owner))} · dein Anteil ${esc(fmtCents(c.per[me()] || 0))}${bought ? ' · gekauft' : ''}</span></span>${icon('chev', 'chev')}</a></li>`);
    } else if (!w.have_at && !poolClosed(p) && !no[p.wish_id] && (p.open || (p.invited || []).includes(me()))) {
      rows.unshift(`<li class="row-item poolask"><a class="row-main" href="${href}"><span class="row-title">${esc(nameOf(p.buyer))} fragt: „${esc(w.title)}“</span>
        <span class="row-meta"><span class="tag new">Anfrage</span>für ${esc(nameOf(w.owner))} · ${sharesOf(p.wish_id).length} dabei</span></a>
        <button class="link" data-act="pooldecline" data-id="${p.wish_id}">Nein danke</button></li>`);
    }
  });
  if (!rows.length && !due.length) return '';
  return `${due.join('')}${rows.length ? `<h2>Gemeinsam schenken</h2><ul class="rows">${rows.join('')}</ul>` : ''}`;
}

function viewWishForm(id) {
  const pre = id === 'neu' ? sharedPrefill() : null;
  const w = id === 'neu' ? { title: pre ? pre.title : '', url: pre ? pre.url : '', note: '', all_groups: true, all_friends: true, priority: 2 } : D.wishes.find(x => x.id === id && x.owner === me());
  if (!w) return shell('Wunsch', emptyState('gift', 'Nicht gefunden', 'Diesen Wunsch gibt es nicht mehr.'), { tab: 'list', back: ['#/liste', 'Wunschliste'] });
  const gs = normGroups();
  const sel = id === 'neu' ? [] : groupIdsOf(id);
  const boxes = gs.map(g => `<label class="check"><input type="checkbox" name="g" value="${g.id}" ${sel.includes(g.id) ? 'checked' : ''}><span>${esc(g.name)}</span></label>`).join('');
  // Freunde (1.14): alle direkten Freunde oder nur ausgewählte
  const fids = D.friendsOk ? friendIds().slice().sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'de')) : [];
  const allF = w.all_friends !== false;
  const fsel = id === 'neu' ? [] : wishFriendIds(id);
  const fboxes = fids.map(u => `<label class="check"><input type="checkbox" name="fr" value="${u}" ${fsel.includes(u) ? 'checked' : ''}><span>${esc(nameOf(u))}</span></label>`).join('');
  const gCard = gs.length ? `
    <div class="card options">
      <label class="check"><input type="radio" name="vis" value="all" ${w.all_groups ? 'checked' : ''}><span>Alle meine Gruppen</span></label>
      <label class="check"><input type="radio" name="vis" value="some" ${w.all_groups ? '' : 'checked'}><span>Nur ausgewählte Gruppen</span></label>
      <div class="sub ${w.all_groups ? 'hide' : ''}" id="gsel">${boxes}</div>
    </div>` : '';
  const fCard = fids.length ? `
    <div class="card options" id="fvis">
      <label class="check"><input type="radio" name="fvis" value="all" ${allF ? 'checked' : ''}><span>Alle meine Freunde</span></label>
      <label class="check"><input type="radio" name="fvis" value="some" ${allF ? '' : 'checked'}><span>Nur ausgewählte Freunde<small>Ohne Auswahl sieht ihn kein direkter Freund</small></span></label>
      <div class="sub ${allF ? 'hide' : ''}" id="fsel">${fboxes}</div>
    </div>` : '';
  const vis = gs.length || fids.length ? `<h2>Wer darf das sehen?</h2>${gCard}${fCard}`
    : `<p class="foot">${icon('people')}<span>Sichtbar für alle Gruppen und Freunde, die später dazukommen.</span></p>`;
  const cats = '<option value="">Keine</option>' + CATS.map(([k, n]) => `<option value="${k}" ${w.category === k ? 'selected' : ''}>${esc(n)}</option>`).join('');
  const prios = PRIOS.map(([v, n]) => `<label><input type="radio" name="prio" value="${v}" ${prio(w) === v ? 'checked' : ''}><span>${n}</span></label>`).join('');
  const have = id === 'neu' ? '' : (w.have_at
    ? `<button type="button" class="secondary" data-act="unhave" data-id="${id}">Doch wieder wünschen</button>`
    : `<button type="button" class="secondary withicon" data-act="have" data-id="${id}">${icon('check')}Habe ich schon bekommen</button>`);
  const haveNote = w.have_at ? `<div class="banner">${icon('check')}<span><b>Hast du schon seit ${esc(fmtDay(w.have_at))}</b><small>Die anderen sehen das und können es nicht mehr reservieren.</small></span></div>` : '';
  const del = id === 'neu' ? '' : `<button type="button" class="ghost danger-text" data-act="delwish" data-id="${id}">Wunsch löschen</button>`;
  return shell(id === 'neu' ? 'Neuer Wunsch' : 'Wunsch bearbeiten', `
    ${haveNote}
    <form data-form="wish" data-id="${id}" class="stack">
      <div class="card fields">
        <label>Was wünschst du dir?<input name="title" maxlength="120" required value="${esc(w.title)}" placeholder="z. B. Kochbuch „Simple“"></label>
        <div class="field"><div class="fieldhead"><label for="f-url">Link</label><button type="button" class="link withicon" data-act="pasteurl">${icon('paste')}Einfügen</button></div>
          <input id="f-url" name="url" inputmode="url" autocomplete="off" value="${esc(w.url || '')}" placeholder="https://"></div>
        <label class="pricefield">Preis<span class="money"><input name="price" inputmode="decimal" autocomplete="off" maxlength="12" value="${esc(priceInput(w.price))}" placeholder="ca."><span>€</span></span></label>
      </div>
      ${fold('w-more-' + id, 'more', 't1', 'Mehr Angaben', 'Notiz, Kategorie, wer es sehen darf', `<div class="stack">
      <div class="card fields">
        <label>Notiz<textarea name="note" maxlength="1000" rows="3" placeholder="Größe, Farbe, Alternativen">${esc(w.note || '')}</textarea></label>
        <label>Kategorie<select name="category">${cats}</select></label>
        <div class="field"><span class="flabel">Wie sehr wünschst du es dir?</span><div class="seg">${prios}</div></div>
      </div>
      ${vis}</div>`, !!(w.note || w.category || prio(w) !== 2 || !w.all_groups || w.all_friends === false))}
      <button class="primary" type="submit">Speichern</button>
      ${have}
      ${del}
    </form>`, { tab: 'list', back: ['#/liste', 'Wunschliste'] });
}

function viewGroups() {
  const all = myGroups();
  const gs = all.filter(g => !g.archived_at);
  const archived = all.filter(g => g.archived_at);
  const rows = gs.map(g => {
    if (isBday(g)) return bdayRow(g);
    const ms = membersOf(g.id).map(m => m.user_id);
    const n = D.wishes.filter(w => ms.includes(w.owner) && w.owner !== me() && !w.have_at && visibleIn(w, g.id)).length;
    const nnew = newIn(g.id).length + newMembers().filter(m => m.group_id === g.id).length + (newDraws().some(x => x.gid === g.id) ? 1 : 0);
    return `<li><a class="row-item group" href="#/g/${g.id}"><span class="tile c${hueIdx(g.id)}">${esc(initials(g.name))}</span>
      <span class="row-main"><span class="row-title">${esc(g.name)}</span><span class="row-meta">${occLine(g) ? esc(occLine(g)) + ' · ' : ''}${plural(ms.length, 'Mitglied', 'Mitglieder')} · ${plural(n, 'Wunsch', 'Wünsche')}${nnew ? ` · <b class="newtxt">${nnew} neu</b>` : ''}</span></span>
      ${nnew ? countBadge(nnew) : avStack(ms)}${icon('chev', 'chev')}</a></li>`;
  }).join('');
  // 1.17: Formulare erst nach Tippen (ohne Gruppen gleich offen), Liste als Fenster mit 5 Gruppen
  const open = gs.length || archived.length ? ui.gform : 'all';
  const fNew = `<div class="card"><form data-form="newgroup" class="inline"><input name="name" maxlength="40" placeholder="Name, z. B. Familie" aria-label="Name der Gruppe" required><button class="primary" type="submit">Anlegen</button></form></div>`;
  const fJoin = `<div class="card"><form data-form="join" class="inline"><input name="code" maxlength="12" placeholder="ABCD-1234" aria-label="Einladungscode" autocapitalize="characters" autocomplete="off" required><button class="secondary" type="submit">Beitreten</button></form></div>`;
  const forms = open === 'all'
    ? `<h2>Neue Gruppe</h2>${fNew}
    ${D.bdgOk ? `<a class="link withicon bdnewlink" href="#/geburtstag/neu">${icon('cake')}Geburtstagsgruppe für jemanden</a>` : ''}
    <h2>Einladungscode eingeben</h2>${fJoin}`
    : `<div class="addbar"><button class="${open === 'new' ? 'secondary on' : 'secondary'} withicon" data-act="gform" data-v="new" aria-expanded="${open === 'new'}">${icon('plus')}Neue Gruppe</button>
      <button class="${open === 'join' ? 'secondary on' : 'secondary'} withicon" data-act="gform" data-v="join" aria-expanded="${open === 'join'}">${icon('key')}Einladungscode eingeben</button></div>
    ${open === 'new' ? fNew : open === 'join' ? fJoin : ''}
    ${D.bdgOk ? `<a class="link withicon bdnewlink" href="#/geburtstag/neu">${icon('cake')}Geburtstagsgruppe für jemanden</a>` : ''}`;
  const arch = archived.length ? fold('g-archiv', 'cake', 't0', 'Archiv', plural(archived.length, 'Geburtstagsgruppe', 'Geburtstagsgruppen'),
    `<ul class="rows plain">${archived.map(bdayRow).join('')}</ul>`) : '';
  const body = gs.length
    ? `<ul class="rows${gs.length > 5 ? ' scrollbox' : ''}" data-box="g">${rows}</ul>${arch}${forms}`
    : archived.length ? arch + forms
    : emptyState('people', 'Noch in keiner Gruppe', 'Lege eine Gruppe an und lade andere mit dem Code ein, oder tritt einer bestehenden Gruppe bei.') + forms;
  return shell('Gruppen', groupsSwitch('g') + body + plusMenu('g'), { tab: 'groups', plus: 'g', sub: gs.length ? plural(gs.length, 'Gruppe', 'Gruppen') : '' });
}

/* ---------- Geburtstagsgruppen (1.16) ---------- */
const gideasOf = gid => (D.gi || []).filter(i => i.group_id === gid);
function bdayRow(g) {
  const ms = membersOf(g.id);
  const nnew = newMembers().filter(m => m.group_id === g.id).length;
  const ni = gideasOf(g.id).length;
  const meta = g.archived_at ? 'Archiviert' : [occLine(g), plural(ms.length, 'Mitglied', 'Mitglieder'), ni ? plural(ni, 'Idee', 'Ideen') : ''].filter(Boolean).join(' · ');
  return `<li><a class="row-item group bday" href="#/g/${g.id}"><span class="tile plain">${icon('cake')}</span>
      <span class="row-main"><span class="row-title">${esc(g.name)}</span><span class="row-meta">${esc(meta)}${nnew ? ` · <b class="newtxt">${nnew} neu</b>` : ''}</span></span>
      ${nnew ? countBadge(nnew) : avStack(ms.map(m => m.user_id))}${icon('chev', 'chev')}</a></li>`;
}
// Letzter Geburtstag (null = noch keiner seit dem Anlegen)
function bdayLast(g) {
  const d = parseDay(g.occ_date);
  if (!d) return null;
  const t = todayDate();
  let last = new Date(t.getFullYear(), d.getMonth(), d.getMonth() === 1 && d.getDate() === 29 && !leap(t.getFullYear()) ? 28 : d.getDate());
  if (last >= t) last = new Date(t.getFullYear() - 1, d.getMonth(), d.getMonth() === 1 && d.getDate() === 29 && !leap(t.getFullYear() - 1) ? 28 : d.getDate());
  const made = parseDay(g.created_at);
  return made && last < made ? null : last;
}
function bdayDateFields(month, day) {
  const days = ['<option value="">Tag</option>'].concat(Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}"${day === i + 1 ? ' selected' : ''}>${i + 1}.</option>`)).join('');
  const months = ['<option value="">Monat</option>'].concat(MONTHS.map((m, i) => `<option value="${i + 1}"${month === i + 1 ? ' selected' : ''}>${m}</option>`)).join('');
  return `<div class="bdrow b2"><select name="day" aria-label="Tag">${days}</select><select name="month" aria-label="Monat">${months}</select></div>`;
}
function bdayDateOf(f) {
  const day = +f.day.value, month = +f.month.value;
  if (!day || !month) throw new Error('Wähle Tag und Monat.');
  const max = month === 2 ? 29 : ([4, 6, 9, 11].includes(month) ? 30 : 31);
  if (day > max) throw new Error('Diesen Tag gibt es im ' + MONTHS[month - 1] + ' nicht.');
  return `2000-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
function giCard(g, i) {
  const mine = i.taken_by === me();
  const bought = i.status === 'gekauft';
  let pill = '', acts = '';
  if (!i.taken_by) {
    pill = '<span class="pill open">Offen</span>';
    if (!g.archived_at) acts = `<button class="primary sm" data-act="gtake" data-id="${i.id}" data-s="reserviert">Ich schenke das</button>`;
  } else if (mine) {
    pill = `<span class="pill green">${icon(bought ? 'check' : 'lock')}${bought ? 'Von dir gekauft' : 'Übernimmst du'}</span>`;
    if (!g.archived_at) acts = (bought
      ? `<button class="secondary sm" data-act="gtake" data-id="${i.id}" data-s="reserviert">Doch nicht gekauft</button>`
      : `<button class="primary sm" data-act="gtake" data-id="${i.id}" data-s="gekauft">Als gekauft markieren</button>`)
      + `<button class="ghost sm" data-act="gtake" data-id="${i.id}" data-s="">Freigeben</button>`;
  } else {
    pill = `<span class="pill gold">${icon(bought ? 'check' : 'lock')}${bought ? 'Gekauft von' : 'Übernimmt'} ${esc(nameOf(i.taken_by))}</span>`;
  }
  const link = i.url ? `<a class="link-out" href="${esc(i.url)}" target="_blank" rel="noopener noreferrer">${icon('link')}${esc(domain(i.url) || 'Link')}</a>` : '';
  const meta = [i.price != null ? fmtPrice(i.price) : '', i.created_by === me() ? 'von dir' : 'von ' + nameOf(i.created_by)].filter(Boolean).join(' · ');
  const edit = i.created_by === me() && !g.archived_at ? `<a class="link sm giedit" href="#/g/${g.id}/idee/${i.id}">Bearbeiten</a>` : '';
  return `<li class="card wish gidea ${i.taken_by ? 'taken' : ''}">
      <div class="wish-head"><span class="tile plain">${icon('bulb')}</span><div class="row-main"><h3>${esc(i.title)}</h3>
        <p class="wmeta"><span>${esc(meta)}</span></p>${link}</div>${edit}</div>
      ${i.note ? `<p class="wnote">${esc(i.note)}</p>` : ''}
      <div class="wish-foot">${pill}${acts ? `<div class="acts">${acts}</div>` : ''}</div>
    </li>`;
}
function viewBdayGroup(g) {
  const gid = g.id, name = bdayName(g), uid = g.bday_user;
  const founder = isFounder(g);
  const d = occNext(g), n = d ? daysUntil(d) : null;
  const b = uid ? bdOf(uid) : null, age = b && d ? bdAge(b, d) : null;
  const when = d ? (n <= 1 ? (n === 0 ? 'Heute' : 'Morgen') : `Am ${fmtDate(d)}, in ${n} Tagen`) + (age ? ` · wird ${age}` : '') : '';
  const head = `<section class="profile bdayhead">${uid && realName(uid) ? avatar(uid, 'lg') : `<span class="tile plain lg">${icon('cake')}</span>`}<div class="profile-main">
      <p class="row-title big">Geburtstag von ${esc(name)}</p>${!g.archived_at && when ? `<p class="row-meta">${esc(when)}</p>` : ''}</div></section>
    <p class="foot">${icon('eyeoff')}<span>${esc(name)} sieht diese Gruppe nicht.</span></p>`;
  const ms = membersOf(gid).slice().sort((a, b) => (a.user_id === me()) - (b.user_id === me()) || nameOf(a.user_id).localeCompare(nameOf(b.user_id), 'de'));
  const mRows = ms.map(m => {
    const joined = isNewMember(gid, m.user_id);
    if (joined) markSeen('m', mkey(gid, m.user_id));
    return `<li class="row-item">${avatar(m.user_id)}<span class="row-main"><span class="row-title">${m.user_id === me() ? 'Du' : esc(nameOf(m.user_id))}</span>${joined ? `<span class="row-meta">${newTag('Neu dabei')}</span>` : ''}</span></li>`;
  }).join('');
  const recap = g.bday_recap && (g.bday_recap.items || []).length ? `<h2>Rückblick ${esc(String(g.bday_recap.year || ''))}</h2>
    <ul class="rows plain recap">${g.bday_recap.items.map(x => `<li class="row-item"><span class="tile plain">${icon(x.st === 'gekauft' ? 'check' : 'gift')}</span><span class="row-main"><span class="row-title">${esc(x.t)}</span><span class="row-meta">${x.by ? (x.by === me() ? 'von dir' : 'von ' + esc(nameOf(x.by))) : ''}</span></span></li>`).join('')}</ul>` : '';
  const delBtn = ui.confirmBdDel === gid
    ? `<button class="danger" data-act="bddelgrp" data-id="${gid}">Gruppe wirklich löschen</button>`
    : `<button class="ghost danger-text" data-act="askbddel" data-id="${gid}">Gruppe löschen</button>`;
  const leave = ui.confirmLeave === gid
    ? `<button class="danger" data-act="leave" data-id="${gid}">Wirklich verlassen</button>`
    : `<button class="ghost danger-text" data-act="askleave" data-id="${gid}">Gruppe verlassen</button>`;
  const back = ['#/gruppen', 'Gruppen'];
  if (g.archived_at) {
    return shell(g.name, `${head}
      <div class="banner">${icon('cake')}<span><b>Archiviert</b><small>${founder ? 'Zum nächsten Geburtstag kannst du die Gruppe wieder öffnen. Die Mitglieder bleiben dabei.' : 'Wer die Gruppe gegründet hat, kann sie zum nächsten Geburtstag wieder öffnen.'}</small></span></div>
      ${recap}
      <div class="card stack">${founder ? `<button class="primary" data-act="bdreopen" data-id="${gid}">Für den nächsten Geburtstag öffnen</button>${delBtn}` : leave}</div>`,
      { tab: 'groups', back, eyebrow: 'Geburtstagsgruppe' });
  }
  const last = bdayLast(g);
  const past = founder && last && daysUntil(last) >= -60 && daysUntil(last) < 0;
  const pastBanner = past ? `<div class="banner bdpast">${icon('cake')}<span><b>Der Geburtstag ist vorbei</b><small>Archivieren hebt die Gruppe fürs nächste Jahr auf. Was verschenkt wurde, bleibt als Rückblick.</small></span>
      <span class="acts"><button class="primary sm" data-act="bdarchive" data-id="${gid}">Archivieren</button></span></div>` : '';
  let wishes = '';
  if (uid) {
    const ws = openWishes(uid);
    const free = ws.filter(w => !resOf(w.id)).length;
    wishes = `<h2>Wünsche</h2><ul class="rows"><li><a class="row-item" href="#/g/${gid}/p/${uid}">${realName(uid) ? avatar(uid) : `<span class="tile plain">${icon('gift')}</span>`}
      <span class="row-main"><span class="row-title">Wunschliste von ${esc(name)}</span><span class="row-meta">${ws.length ? `${plural(ws.length, 'Wunsch', 'Wünsche')} · ${free} noch frei` : 'Noch keine Wünsche für alle'}</span></span>${icon('chev', 'chev')}</a></li></ul>`;
  }
  const ideas = gideasOf(gid);
  const iList = ideas.length ? `<ul class="cards">${ideas.map(i => giCard(g, i)).join('')}</ul>` : `<p class="empty-line">Notiert hier, was passen könnte. ${esc(name)} sieht es nicht.</p>`;
  const dt = parseDay(g.occ_date);
  return shell(g.name, `${pastBanner}${head}${wishes}
    <h2>Gemeinsame Ideen</h2>
    ${iList}
    <a class="secondary withicon addgidea" href="#/g/${gid}/idee/neu">${icon('plus')}Idee notieren</a>
    ${recap}
    <div class="card invite">
      <div><p class="eyebrow">Einladungscode</p><p class="code" id="gcode">${esc(fmtCode(g.code))}</p></div>
      <button class="primary withicon" data-act="invite" data-id="${gid}">${icon('share')}Einladen</button>
    </div>
    <h2>Mitglieder</h2>
    <ul class="rows plain">${mRows}</ul>
    <h2>Verwalten</h2>
    <div class="card stack">
      <form data-form="rename" data-id="${gid}" class="inline"><input name="name" maxlength="40" value="${esc(g.name)}" required><button class="secondary" type="submit">Umbenennen</button></form>
      <form data-form="bdaydate" data-id="${gid}" class="stack"><span class="flabel">Geburtstag</span>${bdayDateFields(dt ? dt.getMonth() + 1 : 0, dt ? dt.getDate() : 0)}<button class="secondary" type="submit">Datum speichern</button></form>
      ${founder ? `<button class="secondary" data-act="bdarchive" data-id="${gid}">Archivieren</button>${delBtn}` : ''}
      ${leave}
    </div>`, { tab: 'groups', back, eyebrow: 'Geburtstagsgruppe', sub: plural(ms.length, 'Mitglied', 'Mitglieder') });
}
// Gemeinsame Idee notieren oder bearbeiten: #/g/<gid>/idee/<id|neu>
function viewGIdeaForm(gid, id) {
  const g = myGroups().find(x => x.id === gid && isBday(x));
  const back = ['#/g/' + gid, g ? g.name : 'Gruppe'];
  const neu = id === 'neu';
  const i = neu ? { title: '', url: '', note: '', price: null } : gideasOf(gid).find(x => x.id === id && x.created_by === me());
  if (!g || !i || g.archived_at) return shell('Idee', emptyState('bulb', 'Nicht gefunden', 'Diese Idee gibt es nicht mehr.'), { tab: 'groups', back });
  const del = neu ? '' : (ui.confirmDel === id
    ? `<button type="button" class="danger" data-act="delgi" data-id="${id}" data-g="${gid}">Wirklich löschen</button>`
    : `<button type="button" class="ghost danger-text" data-act="askdel" data-id="${id}">Idee löschen</button>`);
  return shell(neu ? 'Neue Idee' : 'Idee bearbeiten', `
    <form data-form="gidea" data-id="${id}" data-g="${gid}" class="stack">
      <div class="card fields">
        <label>Was könnte passen?<input name="title" maxlength="120" required value="${esc(i.title)}" placeholder="z. B. Kochkurs"></label>
        <div class="field"><div class="fieldhead"><label for="f-url">Link</label><button type="button" class="link withicon" data-act="pasteurl">${icon('paste')}Einfügen</button></div>
          <input id="f-url" name="url" inputmode="url" autocomplete="off" value="${esc(i.url || '')}" placeholder="https://"></div>
        <label>Preis<span class="money"><input name="price" inputmode="decimal" autocomplete="off" maxlength="12" value="${esc(priceInput(i.price))}" placeholder="ca."><span>€</span></span></label>
        <label>Notiz<textarea name="note" maxlength="1000" rows="3" placeholder="Wo gesehen, Größe, Farbe">${esc(i.note || '')}</textarea></label>
      </div>
      <button class="primary" type="submit">Speichern</button>
      ${del}
    </form>
    <p class="foot">${icon('eyeoff')}<span>Alle in der Gruppe sehen die Idee, ${esc(bdayName(g))} nicht.</span></p>`, { tab: 'groups', back });
}
// Anlegen: #/geburtstag/neu[/u:<uid>|p:<pid>]
function viewBdayNew(key) {
  const back = backParam() ? [backParam(), 'Zurück'] : ['#/gruppen', 'Gruppen'];
  if (!D.bdgOk) return shell('Geburtstagsgruppe', dbHint(), { tab: 'groups', back });
  const f = key ? friendOf(key) : null;
  let who = '', dateNeeded = true, pick = '';
  if (f) {
    who = f.name;
    if (f.uid) {
      const ex = bdayGroupsFor(f.uid)[0];
      if (ex) return shell('Geburtstagsgruppe', `<div class="banner">${icon('cake')}<span><b>Du bist schon in einer Geburtstagsgruppe für ${esc(who)}</b></span><span class="acts"><a class="primary sm" href="#/g/${ex.id}">Öffnen</a></span></div>`, { tab: 'groups', back });
      dateNeeded = !bdOf(f.uid);
    }
  } else {
    const kp = knownPeople();
    const own = (D.ip || []).filter(p => !p.linked_user);
    pick = `<label>Für wen?<select name="person" required><option value="" selected disabled>Person auswählen</option>
        ${kp.length ? `<optgroup label="${friendIds().length ? 'Gruppen und Freunde' : 'Aus deinen Gruppen'}">${kp.map(u => `<option value="u:${u}">${esc(nameOf(u))}</option>`).join('')}</optgroup>` : ''}
        ${own.length ? `<optgroup label="Ohne App">${own.map(p => `<option value="p:${p.id}">${esc(ipName(p))}</option>`).join('')}</optgroup>` : ''}
        <option value="new">Neue Person ohne App …</option></select></label>
      <label class="hide" id="pnew">Name<input name="pname" maxlength="40" autocomplete="off" placeholder="z. B. Oma Ruth"></label>`;
  }
  const b = f && f.uid ? bdOf(f.uid) : null;
  const date = dateNeeded ? `<div class="field"><span class="flabel">Geburtstag</span>${bdayDateFields(0, 0)}${f ? '' : `<p class="muted fhelp">Wenn die Person ihren Geburtstag eingetragen hat, gilt der.</p>`}</div>`
    : `<p class="row-meta bdline">${icon('cake')}<span>Geburtstag am ${esc(fmtDate(bdNext(b)))}</span></p>`;
  return shell('Geburtstagsgruppe', `
    <form data-form="bdaynew" data-key="${esc(key || '')}" class="stack">
      <div class="card fields">
        ${who ? `<p class="row-title big">Für ${esc(who)}</p>` : pick}
        ${date}
      </div>
      <button class="primary" type="submit">Gruppe anlegen</button>
    </form>
    <p class="foot">${icon('eyeoff')}<span>${who ? esc(who) : 'Die Person'} sieht die Gruppe nicht. Mitglieder sehen nur Wünsche, die für alle freigegeben sind, und eure gemeinsamen Ideen.</span></p>`, { tab: 'groups', back });
}

// Kurzform des Anlasses, z. B. „Hochzeit am 14. Juni“ (1.15)
function occLine(g) {
  const d = occNext(g);
  if (!d) return '';
  const n = daysUntil(d);
  return `${occTitle(g)} ${n <= 1 ? whenText(n) : 'am ' + fmtDate(d)}`;
}
function occForm(g) {
  if (!D.occOk) return '';
  const k = g.occ_kind || '';
  const opts = OCC_KINDS.map(([v, l]) => `<option value="${v}"${v === k ? ' selected' : ''}>${l}</option>`).join('');
  const needName = k === 'geburtstag' || k === 'sonstiges';
  return `<form data-form="occasion" data-id="${g.id}" class="stack occform">
      <label>Anlass<select name="kind">${opts}</select></label>
      <label class="occ-name${needName ? '' : ' hide'}">Name<input name="name" maxlength="40" value="${esc(g.occ_name || '')}" placeholder="${k === 'geburtstag' ? 'z. B. Lenas Geburtstag' : 'z. B. Hochzeit'}"></label>
      <label class="occ-date${needName ? '' : ' hide'}">Datum<input name="date" type="date" value="${esc(g.occ_date || '')}"></label>
      <button class="secondary" type="submit">Anlass speichern</button>
    </form>`;
}

function viewGroup(gid) {
  const g = myGroups().find(x => x.id === gid);
  if (!g) return shell('Gruppe', emptyState('people', 'Nicht gefunden', 'Diese Gruppe gibt es nicht mehr.'), { tab: 'groups', back: ['#/gruppen', 'Gruppen'] });
  if (isBday(g)) return viewBdayGroup(g);
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
      ${occForm(g)}
      ${leave}
    </div>`, { tab: 'groups', back: ['#/gruppen', 'Gruppen'], sub: `${plural(ms.length, 'Mitglied', 'Mitglieder')}${occLine(g) ? ' · ' + esc(occLine(g)) : ''}` });
}

/* Liste einer Person: in einer Gruppe (#/g/<gid>/p/<uid>) oder ohne Gruppe (#/p/<uid>, seit 1.14):
   dann alle Wünsche, die ich von ihr sehe (über Gruppen oder als Freund). */
function viewPerson(gid, uid) {
  const g = gid ? myGroups().find(x => x.id === gid) : null;
  const forBday = !!(g && isBday(g) && g.bday_user === uid && !g.archived_at);
  const ok = gid ? g && (forBday || membersOf(gid).some(m => m.user_id === uid)) : known(uid);
  if (!ok || uid === me()) {
    return shell('Liste', emptyState('gift', 'Nicht verfügbar', 'Diese Liste kannst du nicht sehen.'), { tab: 'groups', back: gid ? ['#/g/' + gid, 'Gruppe'] : ['#/freunde', 'Freunde'] });
  }
  const name = nameOf(uid);
  const all = wishesOf(uid, forBday ? null : gid);
  const ws = all.filter(w => !w.have_at).sort(byPrio);
  const had = all.filter(w => w.have_at);
  const taken = ws.filter(w => resOf(w.id)).length;
  // Beim Ansehen der Liste gilt alles darauf als gesehen; die Markierung bleibt, bis du die Seite verlässt
  if (gid && isNewMember(gid, uid)) markSeen('m', mkey(gid, uid));
  ws.filter(isNewWish).forEach(w => markSeen('w', w.id));
  const ret = gid ? `?r=g/${gid}/p/${uid}` : `?r=p/${uid}`;
  const card = w => {
    const r = resOf(w.id);
    const pool = r ? poolOf(w.id) : null;
    let pill = '', acts = '', warn = '', extra = '';
    if (w.have_at) {
      pill = `<span class="pill">Hat ${esc(name)} schon</span>`;
      if (r && r.user_id === me()) {
        warn = `<p class="wwarn">${r.status === 'gekauft' ? 'Du hast es schon gekauft. Vielleicht lässt es sich umtauschen.' : 'Du hattest es reserviert. Gib es frei, falls du es noch nicht gekauft hast.'}</p>`;
        acts = `<button class="${r.status === 'gekauft' ? 'ghost' : 'primary'} sm" data-act="unreserve" data-id="${w.id}">Freigeben</button>`;
      }
      if (pool && inPool(w.id)) acts = `<a class="secondary sm" href="#/gemeinsam/${w.id}${ret}">Gemeinsames Geschenk</a>`;
    } else if (!r) {
      pill = '<span class="pill open">Offen</span>';
      acts = `<button class="primary sm" data-act="reserve" data-id="${w.id}">Ich schenke das</button>`
        + (D.poolsOk ? `<a class="secondary sm withicon" href="#/gemeinsam/${w.id}/neu${ret}">${icon('people')}Gemeinsam</a>` : '');
    } else if (pool) {
      const mine = inPool(w.id);
      const can = mine || (!poolClosed(pool) && (pool.open || (pool.invited || []).includes(me())));
      pill = `<span class="pill ${mine ? 'green' : 'gold'}">${icon('people')}${esc(poolLabel(pool))}</span>`;
      acts = `<a class="${mine || !can ? 'secondary' : 'primary'} sm" href="#/gemeinsam/${w.id}${ret}">${mine || !can ? 'Ansehen' : 'Mitmachen'}</a>`;
    } else if (r.user_id === me()) {
      pill = `<span class="pill green">${icon(r.status === 'gekauft' ? 'check' : 'lock')}${r.status === 'gekauft' ? 'Von dir gekauft' : 'Von dir reserviert'}</span>`;
      acts = (r.status === 'gekauft'
        ? `<button class="secondary sm" data-act="resstatus" data-id="${w.id}" data-s="reserviert">Doch nicht gekauft</button>`
        : `<button class="primary sm" data-act="resstatus" data-id="${w.id}" data-s="gekauft">Als gekauft markieren</button>`)
        + `<button class="ghost sm" data-act="unreserve" data-id="${w.id}">Freigeben</button>`;
      if (r.status !== 'gekauft' && D.poolsOk) extra = `<a class="link withicon poolconv" href="#/gemeinsam/${w.id}/neu${ret}">${icon('people')}Mit anderen zusammenlegen</a>`;
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
      ${extra}
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
    : (ws.length ? `<p class="empty-line">Nichts passt zum Filter. <button class="link" data-act="filtreset">Alle anzeigen</button></p>` : '');
  const hadHtml = had.length && !filtered ? `<h2>Hat ${esc(name)} schon</h2><ul class="cards">${had.map(card).join('')}</ul>` : '';

  const head = `<section class="profile">${avatar(uid, 'lg')}<div class="profile-main">
      <p class="row-meta">${ws.length ? `${plural(ws.length, 'Wunsch', 'Wünsche')} · ${ws.length - taken} noch frei` : 'Noch keine Wünsche'}</p>${bdLine(uid)}
      ${ws.length ? `<progress max="${ws.length}" value="${taken}"></progress>` : ''}</div></section>
    <p class="foot">${icon('eyeoff')}<span>${esc(name)} sieht nicht, was reserviert oder gekauft ist.</span></p>${forBday && !known(uid) ? cardFold(uid, name) : cardHint(gid, uid)}`;
  const body = ws.length || had.length ? filterBar + list + hadHtml : emptyState('gift', 'Noch leer', forBday ? `${esc(name)} hat noch nichts für alle freigegeben.` : `${esc(name)} hat ${gid ? 'für diese Gruppe ' : ''}noch nichts eingetragen.`);
  const back = gid ? ['#/g/' + gid, g.name] : (backParam() ? [backParam(), 'Zurück'] : ['#/f/u:' + uid, name]);
  return shell(name, head + body + (forBday ? '' : personIdeas(gid, uid)), { tab: 'groups', back, eyebrow: gid ? '' : 'Wunschliste' });
}

// „Geburtstag am 12. April · wird 30“ (1.15)
function bdLine(uid) {
  const b = bdOf(uid);
  if (!b) return '';
  const d = bdNext(b), n = daysUntil(d), age = bdAge(b, d);
  return `<p class="row-meta bdline">${icon('cake')}<span>${n <= 1 ? `Hat ${whenText(n)} Geburtstag` : `Geburtstag am ${fmtDate(d)}`}${age ? ` · wird ${age}` : ''}</span></p>`;
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
      <button class="secondary" type="submit">Zwei, die sich nicht ziehen sollen</button>
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

/* ---------- Steckbrief (1.12) ----------
   Ein Quiz mit einer Frage pro Karte (beim ersten Mal), danach Übersicht mit Abschnitten.
   Gespeichert pro Feld über card_put (Schlüssel „abschnitt.feld“). Andere bekommen nur,
   was sie sehen dürfen (card_list). Sichtbarkeit pro Steckbrief ('all'), Abschnitt oder Feld. */
const SB_SECS = [
  ['either', 'Diese oder jene', 'split', 't0'],
  ['likes', 'Mag ich', 'heart', 't1'],
  ['nope', 'Lieber nicht', 'ban', 't2'],
  ['sizes', 'Größen', 'ruler', 't0'],
  ['joy', 'Das freut mich immer', 'sparkle', 't1']];
const SB_COLORS = [['rot', 'Rot'], ['orange', 'Orange'], ['gelb', 'Gelb'], ['gruen', 'Grün'], ['tuerkis', 'Türkis'], ['blau', 'Blau'],
  ['lila', 'Lila'], ['rosa', 'Rosa'], ['braun', 'Braun'], ['beige', 'Beige'], ['grau', 'Grau'], ['schwarz', 'Schwarz'], ['weiss', 'Weiß'],
  ['gold', 'Gold'], ['silber', 'Silber']];
// [schlüssel, art, frage, kurzname, optionen, hinweis]
const SB_FIELDS = [
  ['either.thing', 'either', 'Erlebnis oder Ding?', 'Erlebnis oder Ding', [['Erlebnis', 'eher Erlebnisse'], ['Ding', 'eher Dinge']]],
  ['either.surprise', 'either', 'Überraschung oder Wunschliste?', 'Überraschung', [['Überraschung', 'mag Überraschungen'], ['Wunschliste', 'lieber von der Wunschliste']]],
  ['either.useful', 'either', 'Praktisch oder schön?', 'Praktisch oder schön', [['Praktisch', 'eher praktisch'], ['Schön', 'eher schön']]],
  ['either.diy', 'either', 'Selbstgemacht oder gekauft?', 'Selbstgemacht', [['Selbstgemacht', 'mag Selbstgemachtes'], ['Gekauft', 'lieber gekauft']]],
  ['either.count', 'either', 'Ein großes oder viele kleine?', 'Groß oder klein', [['Ein großes', 'lieber ein großes Geschenk'], ['Viele kleine', 'lieber viele kleine']]],
  ['either.place', 'either', 'Zu Hause oder unterwegs?', 'Zu Hause oder unterwegs', [['Zu Hause', 'gern zu Hause'], ['Unterwegs', 'gern unterwegs']]],
  ['either.taste', 'either', 'Süß oder herzhaft?', 'Süß oder herzhaft', [['Süß', 'eher süß'], ['Herzhaft', 'eher herzhaft']]],
  ['either.play', 'either', 'Lesen oder spielen?', 'Lesen oder spielen', [['Lesen', 'liest gern'], ['Spielen', 'spielt gern']]],
  ['likes.colors', 'colors', 'Welche Farben magst du?', 'Farben', SB_COLORS, 'Bis zu fünf'],
  ['likes.hobbies', 'chips', 'Womit verbringst du gern Zeit?', 'Hobbys', ['Lesen', 'Kochen', 'Backen', 'Sport', 'Wandern', 'Radfahren', 'Musik', 'Gaming',
    'Brettspiele', 'Garten', 'Reisen', 'Fotografie', 'Handarbeit', 'Basteln', 'Filme und Serien', 'Tiere']],
  ['likes.food', 'chips', 'Was isst oder naschst du gern?', 'Essen und Naschen', ['Schokolade', 'Gummibärchen', 'Lakritz', 'Chips', 'Nüsse', 'Kaffee', 'Tee',
    'Käse', 'Wein', 'Bier', 'Obst', 'Scharfes']],
  ['likes.brands', 'chips', 'Lieblingsmarken oder Läden?', 'Marken und Läden', [], 'Tippe sie einfach ein'],
  ['nope.things', 'chips', 'Was lieber nicht?', 'Lieber nicht', ['Duftkerzen', 'Deko', 'Süßes', 'Alkohol', 'Gutscheine', 'Kosmetik', 'Kleidung',
    'Bücher', 'Staubfänger', 'Pflanzen']],
  ['nope.allergy', 'chips', 'Allergien oder Unverträglichkeiten?', 'Allergien', ['Nüsse', 'Laktose', 'Gluten', 'Duftstoffe', 'Tierhaare', 'Nickel', 'Wolle']],
  ['nope.enough', 'chips', 'Wovon hast du schon genug?', 'Hat genug', ['Tassen', 'Socken', 'Schals', 'Notizbücher', 'Kerzen', 'Bücher', 'Taschen', 'Spiele']],
  ['sizes.top', 'one', 'Welche Größe bei Oberteilen?', 'Oberteile', ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL']],
  ['sizes.pants', 'text', 'Und bei Hosen?', 'Hosen', 'z. B. 32/32 oder 40'],
  ['sizes.shoe', 'one', 'Schuhgröße?', 'Schuhe', ['35', '36', '37', '38', '39', '40', '41', '42', '43', '44', '45', '46', '47']],
  ['sizes.ring', 'text', 'Ringgröße?', 'Ring', 'z. B. 54', 'Umfang in Millimetern. Überspring das ruhig.'],
  ['joy.text', 'long', 'Was freut dich immer?', 'Das freut mich immer', 'Zum Beispiel Zeit zusammen, gutes Essen oder etwas zum Selbermachen', 'Ein Satz reicht.']];
const SB_MAX = { text: 20, long: 300 };
const SB_STALE = 365 * 864e5;
const sbField = k => SB_FIELDS.find(f => f[0] === k);
const sbSec = s => SB_SECS.find(x => x[0] === s);
const sbFieldsOf = s => SB_FIELDS.filter(f => f[0].startsWith(s + '.'));
const sbMine = () => (D.card && D.card.data) || {};
const sbFilled = v => Array.isArray(v) ? v.length > 0 : !!v;
const sbCount = data => SB_FIELDS.filter(f => sbFilled(data[f[0]])).length;
const sbNext = () => Math.max(0, SB_FIELDS.findIndex(f => !sbFilled(sbMine()[f[0]])));
function sbItemName(item) {
  if (item === 'all') return 'Ganzer Steckbrief';
  const s = sbSec(item);
  if (s) return s[1];
  const f = sbField(item);
  return f ? f[3] : item;
}
// Wert für die Anzeige (bei „Diese oder jene“: die gewählte Seite bzw. ihr Kurzsatz)
function sbText(f, v, forOthers) {
  if (!sbFilled(v)) return '';
  if (f[1] === 'either') { const o = f[4][v === 'b' ? 1 : 0]; return forOthers ? o[1] : o[0]; }
  if (f[1] === 'colors') return v.map(c => (SB_COLORS.find(x => x[0] === c) || [c, c])[1]).join(', ');
  return Array.isArray(v) ? v.join(', ') : v;
}
const sbSwatch = c => SB_COLORS.some(x => x[0] === c) ? `<i class="sw cl-${c}"></i>` : '';
function sbStale(stamps, k) {
  const t = stamps && stamps[k];
  return t && Date.now() - new Date(t).getTime() > SB_STALE ? t : null;
}
const fmtMonth = ts => new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric' }).format(new Date(ts));

/* Sichtbarkeit */
const sbRule = item => (D.cardVis || []).find(r => r.item === item);
function sbNames(r) {
  const n = (r.groups || []).map(g => (D.groups.find(x => x.id === g) || {}).name).filter(Boolean)
    .concat((r.users || []).filter(u => D.profiles.some(p => p.id === u)).map(nameOf));
  if (!n.length) return '';
  return n.length > 3 ? `${n.slice(0, 2).join(', ')} und ${n.length - 2} weitere` : n.join(', ').replace(/, ([^,]*)$/, ' und $1');
}
function sbVisText(item) {
  const r = sbRule(item);
  if (!r) return item === 'all' ? 'Alle aus deinen Gruppen und Freunde' : 'Wie der Rest';
  const n = sbNames(r);
  if (r.mode === 'only') return n ? 'Nur ' + n : 'Niemand';
  return n ? 'Alle außer ' + n : (item === 'all' ? 'Alle aus deinen Gruppen und Freunde' : 'Wie der Rest');
}
const sbVisLink = (item, ret) => `<a class="vislink ${sbRule(item) ? 'on' : ''}" href="#/steckbrief/sicht/${item}?r=${ret}">${icon(sbRule(item) ? 'eyeoff' : 'eye')}<span>${esc(sbVisText(item))}</span></a>`;

/* Eingaben (im Quiz und in der Übersicht gleich). next = Ziel nach dem Antworten (nur im Quiz) */
function sbControl(f, next) {
  const [k, type, , , opts, hint] = f;
  const v = sbMine()[k];
  const nx = next ? ` data-next="${next}"` : '';
  if (type === 'either') {
    return `<div class="either" role="radiogroup" aria-label="${esc(f[2])}">${opts.map((o, i) => {
      const val = i ? 'b' : 'a';
      return `<button class="eopt e${i} ${v === val ? 'on' : ''}" role="radio" aria-checked="${v === val}" data-act="sbpick" data-k="${k}" data-v="${val}"${nx}>${esc(o[0])}</button>`;
    }).join('<span class="eor">oder</span>')}</div>`;
  }
  if (type === 'one') {
    return `<div class="sbchips" role="radiogroup" aria-label="${esc(f[3])}">${opts.map(o =>
      `<button class="chip ${v === o ? 'on' : ''}" role="radio" aria-checked="${v === o}" data-act="sbone" data-k="${k}" data-v="${esc(o)}"${nx}>${esc(o)}</button>`).join('')}</div>`;
  }
  if (type === 'chips' || type === 'colors') {
    const cur = Array.isArray(v) ? v : [];
    const keys = type === 'colors' ? opts.map(o => o[0]) : opts;
    const own = type === 'colors' ? [] : cur.filter(x => !keys.includes(x));
    const label = x => type === 'colors' ? (opts.find(o => o[0] === x) || [x, x])[1] : x;
    const chips = keys.concat(own).map(x => `<button class="chip ${cur.includes(x) ? 'on' : ''}" aria-pressed="${cur.includes(x)}" data-act="sbtoggle" data-k="${k}" data-v="${esc(x)}">${type === 'colors' ? sbSwatch(x) : ''}${esc(label(x))}</button>`).join('');
    const add = type === 'colors' ? '' : `<form data-form="sbown" data-k="${k}" class="inline sbadd"><input name="v" maxlength="40" placeholder="${keys.length ? 'Eigenes hinzufügen' : 'z. B. Lieblingsladen'}" aria-label="Eigenes hinzufügen" autocomplete="off"><button class="secondary sm" type="submit">${icon('plus')}<span class="vh">Hinzufügen</span></button></form>`;
    return `${hint ? `<p class="small muted">${esc(hint)}</p>` : ''}${chips ? `<div class="sbchips">${chips}</div>` : ''}${add}`;
  }
  // text / long
  const input = type === 'long'
    ? `<textarea name="v" rows="3" maxlength="${SB_MAX.long}" placeholder="${esc(opts)}">${esc(v || '')}</textarea>`
    : `<input name="v" maxlength="${SB_MAX.text}" placeholder="${esc(opts)}" value="${esc(v || '')}" autocomplete="off">`;
  return `<form data-form="sbtext" data-k="${k}"${nx} id="${next ? 'sbform' : 'sbf-' + k.replace('.', '-')}" class="${next ? 'stack' : 'inline'}">
      ${hint ? `<p class="small muted">${esc(hint)}</p>` : ''}${input}${next ? '' : '<button class="secondary sm" type="submit">Speichern</button>'}</form>`;
}

function sbMissing() {
  return shell('Steckbrief', `<div class="banner warn">${icon('shield')}<span><b>Noch nicht eingerichtet</b><small>Für den Steckbrief muss die neue schema.sql einmal im Supabase SQL Editor ausgeführt werden.</small></span></div>`, { tab: 'list', back: ['#/liste', 'Wunschliste'] });
}

function viewCard(parts) {
  if (!D.cardOk) return sbMissing();
  if (parts[1] === 'quiz') return viewQuiz(parseInt(parts[2], 10) || 0);
  if (parts[1] === 's' && sbSec(parts[2])) return viewCardSec(parts[2]);
  if (parts[1] === 'sicht' && parts[2] && (parts[2] === 'all' || sbSec(parts[2]) || sbField(parts[2]))) return viewCardVis(parts[2]);
  return viewCardHome();
}

function sbDots(i) {
  const cur = i < SB_FIELDS.length ? SB_FIELDS[i][0].split('.')[0] : null;
  const idx = cur ? SB_SECS.findIndex(s => s[0] === cur) : SB_SECS.length;
  return `<ol class="sbdots" aria-label="Fortschritt">${SB_SECS.map((s, j) =>
    `<li class="${j < idx ? 'done' : (j === idx ? 'cur' : '')}"><span class="vh">${esc(s[1])}</span></li>`).join('')}</ol>`;
}

function viewQuiz(i) {
  const n = SB_FIELDS.length;
  i = Math.min(Math.max(0, i), n);
  const back = ['#/steckbrief', 'Steckbrief'];
  if (i === n) {
    const c = sbCount(sbMine());
    return shell('Geschafft', `${sbDots(n)}<section class="card quiz done">
        <span class="emptyicon">${icon('idcard')}</span>
        <p class="quizq">Dein Steckbrief steht</p>
        <p class="small">${c} von ${n} Fragen beantwortet. Sichtbar für: ${esc(sbVisText('all'))}.</p>
        <p class="small muted">Ändern, ergänzen oder einzelne Teile verbergen kannst du jederzeit.</p></section>
      <a class="primary" href="#/steckbrief">Zum Steckbrief</a>`, { tab: 'list', back, eyebrow: 'Steckbrief' });
  }
  const f = SB_FIELDS[i];
  const sec = sbSec(f[0].split('.')[0]);
  const inSec = sbFieldsOf(sec[0]);
  const pos = inSec.indexOf(f) + 1;
  const next = `#/steckbrief/quiz/${i + 1}`;
  const textual = f[1] === 'text' || f[1] === 'long';
  const filled = sbFilled(sbMine()[f[0]]);
  const go = textual
    ? `<button class="primary" type="submit" form="sbform">Weiter</button>`
    : `<a class="primary ${filled ? '' : 'quiet'}" href="${next}">Weiter</a>`;
  return shell(sec[1], `${sbDots(i)}
    <section class="card quiz q-${f[1]}"><p class="quizcount">${pos} von ${inSec.length}</p>
      <p class="quizq">${esc(f[2])}</p>${sbControl(f, next)}</section>
    <div class="quiznav"><a class="ghost" href="${next}">Überspringen</a>${go}</div>
    <p class="linkrow"><a class="link" href="#/steckbrief">Später weiter</a></p>`, { tab: 'list', back, eyebrow: `Steckbrief · ${i + 1} von ${n}` });
}

function viewCardHome() {
  const data = sbMine();
  const n = SB_FIELDS.length, c = sbCount(data);
  if (!c) {
    return shell('Steckbrief', `<section class="card quiz intro"><span class="emptyicon">${icon('idcard')}</span>
        <p class="quizq">Damit die anderen wissen, was passt</p>
        <p class="small">${n} kurze Fragen, fast alle mit einem Tipp beantwortet. Alles lässt sich überspringen und später ändern.</p></section>
      <a class="primary" href="#/steckbrief/quiz/0">Los geht’s</a>
      <p class="foot">${icon('eye')}<span>Sichtbar für alle aus deinen Gruppen und deine Freunde. Einzelne Teile kannst du später verbergen.</span></p>`,
    { tab: 'list', back: ['#/liste', 'Wunschliste'] });
  }
  const stamps = (D.card && D.card.stamps) || {};
  const staleSizes = sbFieldsOf('sizes').filter(f => sbFilled(data[f[0]]) && sbStale(stamps, f[0]));
  const stale = staleSizes.length ? `<div class="banner warn">${icon('ruler')}<span><b>Stimmen deine Größen noch?</b><small>Zuletzt geändert im ${esc(fmtMonth(stamps[staleSizes[0][0]]))}.</small></span><button class="link" data-act="sbconfirm">Stimmen noch</button></div>` : '';
  const resume = c < n ? `<a class="secondary withicon" href="#/steckbrief/quiz/${sbNext()}">${icon('play')}Im Quiz weitermachen</a>`
    : `<a class="ghost sm" href="#/steckbrief/quiz/0">Quiz noch mal durchgehen</a>`;
  const top = `<section class="card sbtop"><div class="sbprog"><b>${c} von ${n}</b><span>beantwortet</span></div>
      <progress max="${n}" value="${c}"></progress>${resume}</section>`;
  const vis = `<a class="card row-item sbvis" href="#/steckbrief/sicht/all?r=steckbrief">${icon(sbRule('all') ? 'eyeoff' : 'eye')}
      <span class="row-main"><span class="row-title">Wer sieht deinen Steckbrief</span><span class="row-meta">${esc(sbVisText('all'))}</span></span>${icon('chev', 'chev')}</a>`;
  const secs = SB_SECS.map(([s, name, ic, tint]) => {
    const fs = sbFieldsOf(s);
    const done = fs.filter(f => sbFilled(data[f[0]])).length;
    const rows = s === 'either'
      ? `<p class="sbtags">${fs.filter(f => sbFilled(data[f[0]])).map(f => `<span class="tag">${esc(sbText(f, data[f[0]]))}</span>`).join('') || '<span class="muted">Noch nichts gewählt</span>'}</p>`
      : `<ul class="facts">${fs.map(f => {
        const v = data[f[0]];
        const val = f[1] === 'colors' && sbFilled(v) ? v.map(x => sbSwatch(x)).join('') + esc(sbText(f, v)) : esc(sbText(f, v));
        return `<li><span>${esc(f[3])}</span><b class="${sbFilled(v) ? '' : 'muted'}">${sbFilled(v) ? val : 'Offen'}</b></li>`;
      }).join('')}</ul>`;
    return `<section class="card sbsec"><a class="sbhead" href="#/steckbrief/s/${s}"><span class="tile ${tint}">${icon(ic)}</span>
        <span class="foldsum"><b>${esc(name)}</b><small>${done} von ${fs.length}${sbRule(s) ? ' · ' + esc(sbVisText(s)) : ''}</small></span><span class="link">Bearbeiten</span></a>${rows}</section>`;
  }).join('');
  const del = ui.confirmDelCard
    ? `<button class="danger" data-act="sbdelete">Steckbrief wirklich löschen</button>`
    : `<button class="ghost danger-text" data-act="sbaskdel">Steckbrief löschen</button>`;
  return shell('Steckbrief', `${stale}${top}${vis}${secs}<div class="card stack">${del}</div>`, { tab: 'list', back: ['#/liste', 'Wunschliste'], sub: 'So wissen die anderen, was zu dir passt.' });
}

function viewCardSec(s) {
  const [, name] = sbSec(s);
  const fs = sbFieldsOf(s);
  const data = sbMine(), stamps = (D.card && D.card.stamps) || {};
  const ret = 'steckbrief/s/' + s;
  const first = SB_FIELDS.indexOf(fs.find(f => !sbFilled(data[f[0]])) || fs[0]);
  const items = fs.map(f => {
    const st = sbStale(stamps, f[0]);
    return `<section class="card sbfield"><div class="sbfhead"><b>${esc(f[2])}</b></div>${sbControl(f)}
      <div class="sbffoot">${st && sbFilled(data[f[0]]) ? `<span class="muted small">Zuletzt geändert im ${esc(fmtMonth(st))}</span>` : '<span></span>'}${sbVisLink(f[0], ret)}</div></section>`;
  }).join('');
  return shell(name, `<div class="sbsecbar">${sbVisLink(s, ret)}<a class="link" href="#/steckbrief/quiz/${first}">Als Quiz</a></div>${items}`,
    { tab: 'list', back: ['#/steckbrief', 'Steckbrief'], eyebrow: 'Steckbrief' });
}

function viewCardVis(item) {
  const ret = backParam() || '#/steckbrief';
  const r = sbRule(item);
  const mode = r ? r.mode : 'all';
  const gs = normGroups(), ps = knownPeople();
  const box = (name, val, label, on, meta = '') => `<label class="check"><input type="checkbox" name="${name}" value="${val}" ${on ? 'checked' : ''}><span>${esc(label)}${meta ? `<small>${esc(meta)}</small>` : ''}</span></label>`;
  const opts = [['all', 'Alle'], ['except', 'Alle außer'], ['only', 'Nur']].map(([k, l]) =>
    `<label><input type="radio" name="vmode" value="${k}" ${mode === k ? 'checked' : ''}><span>${l}</span></label>`).join('');
  const parent = item === 'all' ? '' : (item.includes('.') ? `Gilt zusätzlich zu den Einstellungen für „${esc(sbItemName(item.split('.')[0]))}“ und den ganzen Steckbrief.` : 'Gilt zusätzlich zu den Einstellungen für den ganzen Steckbrief.');
  const body = `<form data-form="sbvis" data-item="${item}" data-ret="${esc(ret)}" class="stack">
      <div class="seg" role="radiogroup" aria-label="Wer sieht das">${opts}</div>
      <div id="vispick" class="${mode === 'all' ? 'hide' : ''}">
        <p class="small muted" id="vishelp">${mode === 'only' ? 'Nur wen du hier auswählst, sieht es.' : 'Wer in einer anderen deiner Gruppen ist oder direkt mit dir befreundet, sieht es trotzdem. Einzelne Personen kannst du direkt auswählen.'}</p>
        ${gs.length ? `<h2>Gruppen</h2><div class="card options">${gs.map(g => box('g', g.id, g.name, r && r.groups.includes(g.id), plural(membersOf(g.id).length, 'Person', 'Personen'))).join('')}</div>` : ''}
        ${ps.length ? `<h2>Personen</h2><div class="card options">${ps.map(u => box('u', u, nameOf(u), r && r.users.includes(u))).join('')}</div>` : ''}
      </div>
      ${parent ? `<p class="foot">${icon('eye')}<span>${parent}</span></p>` : ''}
      <button class="primary" type="submit">Speichern</button></form>`;
  return shell('Wer sieht das?', body, { tab: 'list', back: [ret, 'Zurück'], eyebrow: sbItemName(item) });
}

/* Ansicht für andere (Freundesseite) */
function sbOf(uid) { return D.cardsOk && D.cards ? D.cards[uid] || null : null; }
function sbSummary(c) {
  if (!c) return '';
  const a = c.d['nope.allergy'];
  if (sbFilled(a)) return 'Allergien: ' + a.join(', ');
  const tags = SB_FIELDS.filter(f => f[1] === 'either' && sbFilled(c.d[f[0]])).slice(0, 2).map(f => sbText(f, c.d[f[0]], true));
  return tags.length ? tags.join(' · ') : plural(SB_FIELDS.filter(f => sbFilled(c.d[f[0]])).length, 'Angabe', 'Angaben');
}
function cardFold(uid, name) {
  if (!D.cardsOk) return '';
  const c = sbOf(uid);
  if (!c) return fold('fr-card', 'idcard', 't1', 'Steckbrief', 'Noch kein Steckbrief', `<p class="empty-line">${esc(name)} hat noch keinen Steckbrief ausgefüllt.</p>`);
  const d = c.d;
  const vals = (k, cls = 'tag') => (d[k] || []).map(x => `<span class="${cls}">${esc(x)}</span>`).join('');
  const row = (label, html) => html ? `<div class="sbrow"><span class="sblabel">${label}</span><span class="sbval">${html}</span></div>` : '';
  const nope = (sbFilled(d['nope.allergy']) ? `<div class="banner warn sballergy">${icon('shield')}<span><b>Allergien</b><small>${esc(d['nope.allergy'].join(', '))}</small></span></div>` : '')
    + row('Lieber nicht', vals('nope.things', 'tag no')) + row('Hat genug', vals('nope.enough', 'tag no'));
  const either = SB_FIELDS.filter(f => f[1] === 'either' && sbFilled(d[f[0]])).map(f => `<span class="tag hi">${esc(sbText(f, d[f[0]], true))}</span>`).join('');
  const colors = sbFilled(d['likes.colors']) ? d['likes.colors'].map(x => `<span class="tag">${sbSwatch(x)}${esc((SB_COLORS.find(o => o[0] === x) || [x, x])[1])}</span>`).join('') : '';
  const likes = row('Farben', colors) + row('Hobbys', vals('likes.hobbies')) + row('Isst gern', vals('likes.food')) + row('Marken', vals('likes.brands'));
  const sizes = sbFieldsOf('sizes').filter(f => sbFilled(d[f[0]])).map(f => {
    const st = sbStale(c.s, f[0]);
    return `<li><span>${esc(f[3])}</span><b>${esc(d[f[0]])}${st ? `<small class="muted"> · Stand ${esc(fmtMonth(st))}</small>` : ''}</b></li>`;
  }).join('');
  const joy = d['joy.text'] ? `<blockquote class="sbjoy"><span class="sblabel">Das freut ${esc(name)} immer</span>${esc(d['joy.text'])}</blockquote>` : '';
  const inner = `<div class="card sbview">${nope}${either ? `<p class="sbtags">${either}</p>` : ''}${likes}${sizes ? `<ul class="facts">${sizes}</ul>` : ''}${joy}</div>`;
  return fold('fr-card', 'idcard', 't1', 'Steckbrief', sbSummary(c), inner, true);
}

// Eintrag auf der eigenen Wunschliste (seit 1.17, vorher unter Konto)
function cardLink(listHint) {
  if (!D.cardOk) return '';
  const n = SB_FIELDS.length, c = sbCount(sbMine());
  const sub = !c ? 'Größen, Lieblingsdinge und was lieber nicht' : (c < n ? `${c} von ${n} beantwortet` : 'Vollständig');
  return `<a class="card row-item sblink ${listHint ? 'inlist' : ''}" href="#/steckbrief"><span class="tile t1">${icon('idcard')}</span>
      <span class="row-main"><span class="row-title">Mein Steckbrief</span><span class="row-meta">${sub}</span></span>${icon('chev', 'chev')}</a>`;
}
// Auf der Liste einer Person in der Gruppe: Hinweis auf ihren Steckbrief (Allergien zuerst)
function cardHint(gid, uid) {
  const c = sbOf(uid);
  if (!c) return '';
  return `<a class="banner tap sbhint" href="#/f/u:${uid}?r=${gid ? `g/${gid}/p/${uid}` : `p/${uid}`}">${icon('idcard')}<span><b>Steckbrief</b><small>${esc(sbSummary(c))}</small></span>${icon('chev', 'chev')}</a>`;
}

/* ---------- Früh dran (1.12) ----------
   Dezentes Lob nur für mich: beim Abhaken einer Besorgung mindestens 14 Tage vor dem Anlass
   und auf der Startseite, wenn alles erledigt ist. Anlass ist bis Paket 9 Heiligabend. */
const EARLY_DAYS = 14;
function errandStats() {
  const errands = D.res.filter(r => r.user_id === me() && D.wishes.some(w => w.id === r.wish_id));
  const ideasDone = (D.ideas || []).filter(i => i.done_at).length;
  return { n: errands.length + ideasDone, done: errands.filter(r => r.status === 'gekauft').length + ideasDone };
}
function earlyToast() {
  const days = daysToXmas();
  if (days < EARLY_DAYS) return;
  const st = errandStats();
  toast(st.n && st.done === st.n ? `Alles besorgt, ${days} Tage vor Heiligabend. Früh dran.` : `Früh dran. Noch ${days} Tage bis Heiligabend.`);
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
  const ps = D.ps;
  const sub = ps && ps.last_error ? 'Benachrichtigungen: Fehler' : ps && ps.configured ? 'Zugänge zurücksetzen, Benachrichtigungen' : 'Zugänge zurücksetzen';
  return fold('admin', 'shield', 't1', 'Verwaltung', sub, `
    <div class="card stack">
      <p class="small muted">Wer Passwort und Code verloren hat, bekommt hier einen Rücksetz-Code.</p>
      <form data-form="adminsearch" class="inline"><input name="q" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="Name oder Benutzername" value="${esc(ui.adminQuery || '')}" required><button class="secondary" type="submit">Suchen</button></form>
    </div>
    ${result}${list}
    ${pushAdmin()}`);
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
    ${bdSection()}
    <h2>Hilfe</h2>
    <ul class="rows plain"><li><a class="row-item" href="#/hilfe"><span class="tile plain">${icon('book')}</span>
      <span class="row-main"><span class="row-title">So funktioniert es</span><span class="row-meta">Kurze Antworten auf die wichtigsten Fragen</span></span>${icon('chev', 'chev')}</a></li>
      <li><button class="row-item" data-act="tourshow"><span class="tile plain">${icon('play')}</span>
      <span class="row-main"><span class="row-title">Erste Schritte noch mal zeigen</span><span class="row-meta">Die drei Karten vom ersten Start</span></span></button></li></ul>
    ${fold('k-more', 'more', 't1', 'Weitere Einstellungen', 'Aussehen, Anmeldung, Benachrichtigungen, Abmelden', `<div class="foldin">
    ${bdaySwitch()}
    ${themeSection()}
    ${acc ? `<h2>Anmeldung</h2>${codeCard()}` : ''}
    ${adminSection()}
    <div id="install" data-ctx="konto">${installCard('konto')}</div>
    ${notifySection()}
    ${fold('privacy', 'lock', 't1', 'Datenschutz', 'Was gespeichert wird und wer was sieht', `    <div class="card prose">
      <p>Name, Benutzername, Gruppen, Wünsche und Reservierungen liegen in einer Datenbank bei Supabase in der EU. Passwort und Wiederherstellungscode werden nur verschlüsselt gespeichert.</p>
      <p>Andere sehen deinen Namen und die Wünsche, die du für ihre Gruppe oder für sie als Freund freigibst. Reservierungen sieht der Beschenkte nie.</p>
      <p>Bei gemeinsamen Geschenken sehen nur die Gefragten und wer mitmacht, wer dabei ist, wie viel jeder gibt und wer bezahlt hat. Die beschenkte Person sieht nichts davon.</p>
      <p>Deinen Geburtstag sehen alle aus deinen Gruppen und deine Freunde. Schenklisten siehst nur du.</p>
      <p>Freunde und Leute aus deinen Gruppen können eine Geburtstagsgruppe für dich anlegen und andere einladen. Darin sieht man nur Wünsche, die du für alle Gruppen oder alle Freunde freigibst, und deinen Steckbrief ohne die Teile, die nur bestimmte sehen. Die Gruppe und die Ideen darin siehst du nicht. Unter Konto lässt sich das ausschalten.</p>
      <p>Deinen Steckbrief sehen alle aus deinen Gruppen und deine Freunde. Unter Steckbrief kannst du ihn ganz oder teilweise für bestimmte Gruppen oder Personen verbergen.</p>
      <p>Direkte Freunde sehen deinen Namen, die Wünsche, die du für Freunde freigibst, und deinen Steckbrief. Niemand kann nach dir suchen: Freund wird nur, wer deinen Freundes-Link hat oder deinen Benutzernamen kennt und du die Anfrage annimmst. Ob es einen Benutzernamen gibt, verrät die App nicht. Spitznamen siehst nur du.</p>
      <p>Für Benachrichtigungen wird eine Adresse des Push-Dienstes deines Geräts gespeichert (Apple, Google oder Mozilla). Die Nachrichten sind verschlüsselt.</p>
      <p>Auf dem Gerät bleiben nur die Anmeldung und eine Kopie der Listen, damit die App schnell startet.</p>
    </div>`)}
    <div class="card stack">
      ${unsafe && ui.confirmLogout
        ? `<p class="small">Ohne Benutzername und Passwort kommst du danach nicht mehr in dieses Konto zurück. Deine Liste wäre verloren.</p><button class="danger" data-act="logout">Trotzdem abmelden</button>`
        : `<button class="ghost danger-text" data-act="${unsafe ? 'asklogout' : 'logout'}">Abmelden</button>`}
      ${ui.confirmDelAcc
        ? `<button class="danger withicon" id="delacc" data-act="delaccdlg">${icon('trash')}Sicher?</button>`
        : `<button class="ghost danger-text withicon" id="delacc" data-act="askdelacc">${icon('trash')}Konto löschen</button>`}
    </div>
    </div>`)}
    <p class="version">Geschenkeliste ${VERSION}</p>
    ${ui.delAccDlg ? delAccDialog() : ''}`, { tab: 'acc' });
}

/* Geburtstag (1.15): Tag und Monat, Jahr freiwillig. Sehen alle aus deinen Gruppen und deine Freunde. */
function bdSection() {
  if (!D.bdOk) return '';
  const b = bdOf(me());
  const days = ['<option value="">Tag</option>'].concat(Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}"${b && b.day === i + 1 ? ' selected' : ''}>${i + 1}.</option>`)).join('');
  const months = ['<option value="">Monat</option>'].concat(MONTHS.map((m, i) => `<option value="${i + 1}"${b && b.month === i + 1 ? ' selected' : ''}>${m}</option>`)).join('');
  return `<h2>Geburtstag</h2>
    <div class="card"><form data-form="birthday" class="stack">
      <div class="bdrow"><select name="day" aria-label="Tag">${days}</select><select name="month" aria-label="Monat">${months}</select>
        <input name="year" inputmode="numeric" maxlength="4" placeholder="Jahr" aria-label="Jahr, freiwillig" value="${b && b.year ? b.year : ''}"></div>
      <p class="muted small">Das Jahr ist freiwillig. Deine Gruppen und Freunde sehen den Tag und werden vorher erinnert.</p>
      <div class="btnrow"><button class="secondary" type="submit">Speichern</button>${b ? '<button class="ghost danger-text" type="button" data-act="bddel">Entfernen</button>' : ''}</div>
    </form></div>`;
}

/* Geburtstagsgruppen für mich erlaubt (1.16), Standard an */
function bdaySwitch() {
  if (!D.bdgOk) return '';
  const on = !D.bdOff;
  return `<ul class="rows plain bdswitch"><li class="row-item"><span class="row-main"><span class="row-title">Geburtstagsgruppen für dich</span><span class="row-meta">Andere dürfen eine Gruppe für deinen Geburtstag anlegen. Du siehst sie nicht.</span></span>
      <button class="switch ${on ? 'on' : ''}" role="switch" aria-checked="${on}" aria-label="Geburtstagsgruppen für dich" data-act="bdopt" data-on="${on ? '0' : '1'}"></button></li></ul>`;
}

/* Konto löschen (1.13.1): Knopf → „Sicher?“ → Fenster mit Warnung → „Ja, löschen“ */
function delAccDialog() {
  const acc = D.account;
  return `<div class="modalwrap"><div class="modalbg" data-act="delacccancel"></div>
    <div class="modal card stack" role="alertdialog" aria-modal="true" aria-labelledby="delacct" aria-describedby="delaccd">
      <span class="tile t2 modalicon">${icon('trash')}</span>
      <h2 class="modaltitle" id="delacct">Konto wirklich löschen?</h2>
      <div id="delaccd" class="stack">
        <p>Dein Konto${acc ? ` <b>${esc(acc.username)}</b>` : ''} ist danach vollständig weg. Das lässt sich nicht rückgängig machen, auch nicht durch die Verwaltung.</p>
        <p class="small muted">Gelöscht werden deine Wunschliste, deine Reservierungen (die Wünsche sind dann wieder frei), deine Ideen, dein Steckbrief und deine Mitgliedschaft in allen Gruppen. Gruppen, die du gegründet hast, übernimmt das nächste Mitglied.</p>
      </div>
      <button class="danger" data-act="delacc">Ja, löschen</button>
      <button class="ghost" data-act="delacccancel">Abbrechen</button>
    </div></div>`;
}

/* ---------- Erste Schritte und Hilfe (1.17) ---------- */
const TOUR = [
  ['gift', 'Deine Wunschliste', 'Schreib auf, was du dir wünschst.'],
  ['people', 'Gruppen und Freunde', 'Lade deine Familie in eine Gruppe ein oder füge Freunde hinzu.'],
  ['lock', 'Geheim schenken', 'Tippe bei anderen auf „Ich schenke das“. Die Person sieht es nicht.'],
];
function tourDialog() {
  const i = Math.min(Math.max((S.tour || 1) - 1, 0), TOUR.length - 1);
  const [ic, title, text] = TOUR[i];
  const last = i === TOUR.length - 1;
  return `<div class="modalwrap"><div class="modalbg"></div>
    <div class="modal card stack tour" role="dialog" aria-modal="true" aria-labelledby="tourt" aria-describedby="tourd">
      <span class="tile t${i} modalicon">${icon(ic)}</span>
      <h2 class="modaltitle" id="tourt">${title}</h2>
      <p id="tourd">${text}</p>
      <ol class="tourdots" aria-label="Schritt ${i + 1} von ${TOUR.length}">${TOUR.map((_, k) => `<li class="${k === i ? 'cur' : ''}"></li>`).join('')}</ol>
      <button class="primary" data-act="${last ? 'tourskip' : 'tournext'}">${last ? 'Los geht’s' : 'Weiter'}</button>
      ${last ? '' : '<button class="ghost" data-act="tourskip">Überspringen</button>'}
    </div></div>`;
}
const HELP = [
  ['Wie lege ich einen Wunsch an?', 'Tippe unten auf Wunschliste und dann auf „Wunsch hinzufügen“. Ein Name reicht. Link und Preis helfen den anderen, genau das Richtige zu finden.'],
  ['Wie komme ich in eine Gruppe?', 'Lass dir von jemandem aus der Gruppe den Einladungslink schicken und öffne ihn. Oder tippe unter Gruppen oben auf das Plus und dann auf „Einladungscode eingeben“. Eine eigene Gruppe legst du über das Plus mit „Neue Gruppe“ an und lädst dann mit „Einladen“ andere ein.'],
  ['Wer sieht meine Wünsche?', 'Alle aus deinen Gruppen und deine Freunde. Bei jedem Wunsch kannst du unter „Mehr Angaben“ bei „Wer darf das sehen?“ einstellen, wer ihn sieht.'],
  ['Sieht jemand, was ich ihm schenke?', 'Nein. Wenn du bei einem Wunsch auf „Ich schenke das“ tippst, sehen das nur die anderen, damit nichts doppelt gekauft wird. Die beschenkte Person sieht es nie.'],
  ['Was mache ich, wenn ich mein Passwort vergessen habe?', 'Tippe bei der Anmeldung auf „Passwort vergessen“. Mit deinem Benutzernamen und deinem Wiederherstellungscode legst du ein neues Passwort fest. Hast du noch keinen Benutzernamen, sichere dein Konto unter Konto, solange du angemeldet bist.'],
  ['Wie schenken wir etwas zusammen?', 'Öffne den Wunsch einer Person und tippe auf „Gemeinsam“. Dann wählst du, wen du fragst. Wer mitmacht, gibt einen Teil dazu, und einer kauft.'],
];
function viewHelp() {
  const items = HELP.map(([q, a], k) => `<details class="fold helpq" id="help-${k}"${folds['help-' + k] ? ' open' : ''}><summary><span class="foldsum"><b>${q}</b></span>${icon('chev', 'chev')}</summary>
      <div class="card prose"><p>${a}</p></div></details>`).join('');
  return shell('So funktioniert es', items, { tab: 'acc', back: ['#/konto', 'Konto'] });
}

/* ---------- Router ---------- */
function route() {
  const h = location.hash.replace(/^#/, '') || '/';
  return h.split('?')[0].split('/').filter(Boolean);
}

function render() {
  const app = $('#app');
  let parts = route();
  if (parts[0] === 'freund' && parts[1] && !S.session) {
    S.pendingFriend = parts[1];
    saveState();
    history.replaceState(null, '', location.pathname + '#/');
    parts = [];
  }
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
  else if (parts[0] === 'i' && parts[1]) html = viewIdeaForm(parts[1], parts[2]);
  else if (parts[0] === 'ideen' && parts[1] === 'p' && parts[2]) html = viewFriend('p:' + parts[2]);
  else if (parts[0] === 'f' && parts[1]) html = viewFriend(parts[1]);
  else if (parts[0] === 'freunde') html = viewFriends();
  else if (parts[0] === 'freund' && parts[1]) html = viewFriendCode(parts[1]);
  else if (parts[0] === 'p' && parts[1]) html = viewPerson(null, parts[1]);
  else if (parts[0] === 'ideen') html = viewIdeas();
  else if (parts[0] === 'schenken' && parts[1]) html = viewGiftList(parts[1]);
  else if (parts[0] === 'gruppen') html = viewGroups();
  else if (parts[0] === 'g' && parts[1] && parts[2] === 'p' && parts[3]) html = viewPerson(parts[1], parts[3]);
  else if (parts[0] === 'g' && parts[1] && parts[2] === 'wichteln') html = viewWichteln(parts[1]);
  else if (parts[0] === 'g' && parts[1] && parts[2] === 'idee' && parts[3]) html = viewGIdeaForm(parts[1], parts[3]);
  else if (parts[0] === 'geburtstag' && parts[1] === 'neu') html = viewBdayNew(parts[2]);
  else if (parts[0] === 'g' && parts[1]) html = viewGroup(parts[1]);
  else if (parts[0] === 'liste') html = viewList();
  else if (parts[0] === 'konto' || parts[0] === 'mehr') html = viewAccount();
  else if (parts[0] === 'steckbrief') html = viewCard(parts);
  else if (parts[0] === 'hilfe') html = viewHelp();
  else if (parts[0] === 'gemeinsam' && parts[1]) html = parts[2] ? viewPoolForm(parts[1], parts[2]) : viewPool(parts[1]);
  else html = viewHome();
  const y = render.lastKey === location.hash ? window.scrollY : 0;
  const box = render.lastKey === location.hash && $('.scrollbox');
  const boxY = box ? box.scrollTop : 0;
  if (S.tour) html += tourDialog();
  app.innerHTML = html;
  fitBoxes(boxY);
  applyMarks();
  paintBadges();
  if (render.lastKey === location.hash) window.scrollTo(0, y); else window.scrollTo(0, 0);
  render.lastKey = location.hash;
}

// Listen-Fenster (1.17): genau 5 Zeilen hoch, die sechste schaut ein Stück heraus
function fitBoxes(y) {
  $$('.scrollbox').forEach(b => {
    const li = [...b.children].slice(0, 5);
    if (li.length < 5) return;
    const h = li.reduce((n, x) => n + x.getBoundingClientRect().height, 0);
    if (h) b.style.maxHeight = Math.round(h + 26) + 'px';
    b.scrollTop = y || 0;
  });
}

// Freundes-Link vor der Anmeldung geöffnet: danach die Bestätigungsseite zeigen (1.14)
function doPendingFriend() {
  const code = S.pendingFriend;
  if (!code || !S.session) return false;
  if (D.loaded && !(D.profiles.find(x => x.id === me()) || {}).name) return false; // erst Namen setzen
  delete S.pendingFriend;
  saveState();
  go('#/freund/' + code);
  return true;
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
    if (!doPendingFriend()) go('#/g/' + gid);
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

/* Steckbrief speichern: sofort lokal anzeigen, dann an die Datenbank */
async function sbPut(k, v) {
  const empty = !sbFilled(v);
  D.card = D.card || { data: {}, stamps: {} };
  const data = Object.assign({}, D.card.data), stamps = Object.assign({}, D.card.stamps);
  if (empty) { delete data[k]; delete stamps[k]; } else { data[k] = v; stamps[k] = new Date().toISOString(); }
  D.card = { data, stamps };
  render();
  sbPending++;
  try {
    await sb('/rest/v1/rpc/card_put', { method: 'POST', body: { p_key: k, p_val: empty ? null : v } });
    saveState();
  } catch (e) { sbPending--; await sync(true); throw e; }
  sbPending--;
}
// Einzelauswahl (Diese oder jene, Größen): nochmal tippen hebt sie auf; im Quiz geht es danach weiter
async function sbChoose(el) {
  const k = el.dataset.k, v = el.dataset.v;
  const off = sbMine()[k] === v;
  const p = sbPut(k, off ? null : v);
  if (!off && el.dataset.next) { await new Promise(r => setTimeout(r, 220)); go(el.dataset.next); }
  await p;
}

const forms = {
  async poolstart(f) {
    const body = Object.assign({ p_wish: f.dataset.id, p_amount: amountOf(f) }, poolFormData(f));
    await sb('/rest/v1/rpc/pool_start', { method: 'POST', body });
    await sync(true);
    toast(body.p_open ? 'Gestartet. Alle, die die Liste sehen, können mitmachen.' : 'Gestartet. Die Ausgewählten werden gefragt.');
    location.replace('#/gemeinsam/' + f.dataset.id + poolRet());
  },
  async pooledit(f) {
    await sb('/rest/v1/rpc/pool_update', { method: 'POST', body: Object.assign({ p_wish: f.dataset.id }, poolFormData(f)) });
    await sync(true);
    toast('Gespeichert.');
    go(backParam() || '#/gemeinsam/' + f.dataset.id);
  },
  async pooljoin(f) {
    const was = inPool(f.dataset.id);
    await sb('/rest/v1/rpc/pool_join', { method: 'POST', body: { p_wish: f.dataset.id, p_amount: amountOf(f) } });
    const n = poolNo();
    if (n[f.dataset.id]) { delete n[f.dataset.id]; try { localStorage.setItem(POOL_NO, JSON.stringify(n)); } catch (e) { /* egal */ } }
    await sync(true);
    toast(was ? 'Betrag geändert.' : 'Du machst mit.');
  },
  async sbown(f) {
    const k = f.dataset.k, v = f.v.value.trim().replace(/\s+/g, ' ').slice(0, 40);
    if (!v) return;
    const cur = Array.isArray(sbMine()[k]) ? sbMine()[k].slice() : [];
    if (cur.some(x => x.toLowerCase() === v.toLowerCase())) { f.v.value = ''; return; }
    if (cur.length >= 30) { toast('Höchstens 30 Einträge.'); return; }
    cur.push(v);
    await sbPut(k, cur);
    const again = document.querySelector(`form[data-form="sbown"][data-k="${k}"] input`);
    if (again) again.focus();
  },
  async sbtext(f) {
    const k = f.dataset.k, v = f.v.value.trim();
    if (v !== (sbMine()[k] || '')) await sbPut(k, v || null);
    if (f.dataset.next) go(f.dataset.next); else toast('Gespeichert.');
  },
  async sbvis(f) {
    const item = f.dataset.item;
    const mode = (f.querySelector('input[name="vmode"]:checked') || {}).value || 'all';
    const pick = n => [...f.querySelectorAll(`input[name="${n}"]:checked`)].map(x => x.value);
    if (mode === 'all') {
      await sb(`/rest/v1/profile_card_vis?owner=eq.${me()}&item=eq.${encodeURIComponent(item)}`, { method: 'DELETE' });
    } else {
      await sb('/rest/v1/profile_card_vis?on_conflict=owner,item', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
        body: { owner: me(), item, mode, users: pick('u'), groups: pick('g') } });
    }
    await sync(true);
    toast('Gespeichert.');
    go(f.dataset.ret || '#/steckbrief');
  },
  async start(f) {
    const name = f.name.value.trim();
    if (!name) return;
    const j = await sb('/auth/v1/signup', { method: 'POST', auth: false, body: { data: {} } });
    setSession(j);
    S.pendingName = name;
    S.tour = 1;   // 1.17: Erste Schritte nach dem Anlegen
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
    if (S.pendingJoin) await doPendingJoin(); else if (!doPendingFriend()) render();
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
    if (doPendingFriend()) return;
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
    // Freunde (1.14): nur wenn die Auswahl angezeigt wurde
    const fv = f.querySelector('input[name=fvis]:checked');
    const allF = !fv || fv.value === 'all';
    const fsel = allF ? [] : [...f.querySelectorAll('input[name=fr]:checked')].map(x => x.value);
    if (fv) row.all_friends = allF;
    let wid = id;
    if (id === 'neu') {
      const r = await sb('/rest/v1/wishes', { method: 'POST', prefer: 'return=representation', body: row });
      wid = r[0].id;
    } else {
      await sb('/rest/v1/wishes?id=eq.' + id, { method: 'PATCH', prefer: 'return=minimal', body: row });
      await sb('/rest/v1/wish_groups?wish_id=eq.' + id, { method: 'DELETE' });
      if (fv) await sb('/rest/v1/wish_friends?wish_id=eq.' + id, { method: 'DELETE' });
    }
    if (!all) await sb('/rest/v1/wish_groups', { method: 'POST', prefer: 'return=minimal', body: sel.map(g => ({ wish_id: wid, group_id: g })) });
    if (fsel.length) await sb('/rest/v1/wish_friends', { method: 'POST', prefer: 'return=minimal', body: fsel.map(u => ({ wish_id: wid, user_id: u })) });
    if (id === 'neu' && S.share) { delete S.share; saveState(); }
    await sync(true);
    toast('Gespeichert.');
    go('#/liste');
  },
  async idea(f) {
    const id = f.dataset.id;
    const title = f.title.value.trim();
    const url = normUrl(f.url.value);
    if (url === false) throw new Error('Der Link sieht nicht richtig aus.');
    const price = parsePrice(f.price.value);
    if (price === false) throw new Error('Der Preis sieht nicht richtig aus, z. B. 24,99.');
    const v = f.person.value;
    let person;
    if (v === 'new') {
      const name = f.pname.value.trim();
      if (!name) throw new Error('Gib einen Namen ein.');
      person = (await sb('/rest/v1/idea_people', { method: 'POST', prefer: 'return=representation', body: { name } }))[0].id;
    } else if (v.startsWith('u:')) {
      const uid = v.slice(2);
      const p = ipFor(uid);
      person = p ? p.id : (await sb('/rest/v1/idea_people', { method: 'POST', prefer: 'return=representation', body: { name: (realName(uid) || baseName(uid)).slice(0, 40), linked_user: uid } }))[0].id;
    } else if (v.startsWith('p:')) person = v.slice(2);
    else throw new Error('Wähle aus, für wen die Idee ist.');
    const row = { person, title, url, price, category: f.category.value || null, note: f.note.value.trim() || null };
    if (id === 'neu') await sb('/rest/v1/ideas', { method: 'POST', prefer: 'return=minimal', body: row });
    else await sb('/rest/v1/ideas?id=eq.' + id, { method: 'PATCH', prefer: 'return=minimal', body: row });
    await sync(true);
    toast('Gespeichert. Nur du siehst diese Idee.');
    go(backParam() || '#/ideen');
  },
  // Freund hinzufügen (1.14): Freundes-Link oder -Code → Bestätigungsseite, sonst Anfrage per Benutzername
  async friendadd(f) {
    const q = f.q.value.trim();
    const m = /#\/freund\/([A-Za-z0-9-]+)/.exec(q);
    const raw = m ? m[1] : q;
    const norm = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (m || (/^[A-Za-z0-9-\s]+$/.test(raw) && norm.length === 12 && /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]+$/.test(norm))) {
      const x = await sb('/rest/v1/rpc/friend_peek', { method: 'POST', body: { p_code: norm } });
      if (x) { ui.peek = Object.assign(ui.peek || {}, { [norm]: x }); f.q.value = ''; go('#/freund/' + norm); return; }
      if (m) throw new Error('Diesen Freundes-Link gibt es nicht (mehr).');
    }
    const u = normUser(q);
    checkUser(u);
    const r = await sb('/rest/v1/rpc/friend_request', { method: 'POST', body: { p_username: u } });
    f.q.value = '';
    await sync(true);
    toast(r === 'accepted' ? 'Ihr seid jetzt befreundet.' : (r === 'friends' ? 'Ihr seid schon befreundet.' : 'Anfrage verschickt. Sobald sie angenommen ist, seid ihr befreundet.'));
  },
  async nick(f) {
    const uid = f.dataset.u, nick = f.nick.value.trim().slice(0, 40);
    if (nick) {
      await sb('/rest/v1/nicknames?on_conflict=owner,user_id', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: { owner: me(), user_id: uid, nick } });
    } else {
      await sb(`/rest/v1/nicknames?owner=eq.${me()}&user_id=eq.${uid}`, { method: 'DELETE' });
    }
    await sync(true);
    toast(nick ? 'Spitzname gespeichert. Nur du siehst ihn.' : 'Spitzname entfernt.');
  },
  async newfriend(f) {
    const r = await sb('/rest/v1/idea_people', { method: 'POST', prefer: 'return=representation', body: { name: f.name.value.trim() } });
    await sync(true);
    go('#/f/p:' + r[0].id);
  },
  async ipname(f) {
    await sb('/rest/v1/idea_people?id=eq.' + f.dataset.id, { method: 'PATCH', prefer: 'return=minimal', body: { name: f.name.value.trim() } });
    await sync(true);
    toast('Umbenannt.');
  },
  async iplink(f) {
    if (!f.u.value) throw new Error('Wähle eine Person aus.');
    // Ist das die Person einer Geburtstagsgruppe ohne App? Erst fragen (1.16)
    const gids = myGroups().filter(g => isBday(g) && !g.bday_user && g.bday_person === f.dataset.id).map(g => g.id);
    if (gids.length) { ui.bdLinkAsk = { pid: f.dataset.id, uid: f.u.value, gids }; render(); window.scrollTo(0, 0); return; }
    await sb('/rest/v1/rpc/idea_link', { method: 'POST', body: { p_person: f.dataset.id, p_user: f.u.value } });
    await sync(true);
    toast('Verknüpft. Die Ideen bleiben privat.');
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
  async newgl(f) {
    const r = await sb('/rest/v1/gift_lists', { method: 'POST', prefer: 'return=representation', body: { name: f.name.value.trim() } });
    await sync(true);
    go('#/schenken/' + r[0].id);
  },
  async glAdd(f) {
    const v = f.person.value;
    let person;
    if (v === 'new') {
      const name = f.pname.value.trim();
      if (!name) throw new Error('Gib einen Namen ein.');
      person = (await sb('/rest/v1/idea_people', { method: 'POST', prefer: 'return=representation', body: { name } }))[0].id;
    } else if (v.startsWith('u:')) {
      const uid = v.slice(2);
      const p = ipFor(uid);
      person = p ? p.id : (await sb('/rest/v1/idea_people', { method: 'POST', prefer: 'return=representation', body: { name: (realName(uid) || baseName(uid)).slice(0, 40), linked_user: uid } }))[0].id;
    } else if (v.startsWith('p:')) person = v.slice(2);
    else throw new Error('Wähle eine Person aus.');
    await sb('/rest/v1/gift_list_people', { method: 'POST', prefer: 'return=minimal', body: { list_id: f.dataset.id, person } });
    await sync(true);
  },
  async glEdit(f) {
    await sb('/rest/v1/gift_lists?id=eq.' + f.dataset.id, { method: 'PATCH', prefer: 'return=minimal', body: { name: f.name.value.trim(), occ_date: f.date.value || null } });
    await sync(true);
    toast('Gespeichert.');
  },
  async birthday(f) {
    const day = +f.day.value, month = +f.month.value, yt = f.year.value.trim();
    if (!day || !month) throw new Error('Wähle Tag und Monat.');
    const year = yt ? +yt : null;
    const now = new Date().getFullYear();
    if (yt && (!/^\d{4}$/.test(yt) || year < 1900 || year > now)) throw new Error('Das Jahr stimmt nicht.');
    const max = month === 2 ? (year && !leap(year) ? 28 : 29) : ([4, 6, 9, 11].includes(month) ? 30 : 31);
    if (day > max) throw new Error('Diesen Tag gibt es im ' + MONTHS[month - 1] + ' nicht.');
    await sb('/rest/v1/birthdays?on_conflict=user_id', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
      body: { user_id: me(), day, month, year, updated_at: new Date().toISOString() } });
    await sync(true);
    toast('Geburtstag gespeichert.');
  },
  async occasion(f) {
    const kind = f.kind.value;
    const name = f.name.value.trim();
    const date = f.date.value;
    if (kind === 'sonstiges' && !name) throw new Error('Gib dem Anlass einen Namen, z. B. Hochzeit.');
    if ((kind === 'sonstiges' || kind === 'geburtstag') && !date) throw new Error('Wähle ein Datum.');
    if (kind === 'sonstiges' && parseDay(date) < todayDate()) throw new Error('Das Datum liegt in der Vergangenheit.');
    await sb('/rest/v1/rpc/set_group_occasion', { method: 'POST', body: { p_group: f.dataset.id, p_kind: kind, p_name: kind === 'weihnachten' ? null : name, p_date: kind === 'weihnachten' || !kind ? null : date } });
    await sync(true);
    toast(kind ? 'Anlass gespeichert.' : 'Anlass entfernt.');
  },
  async bdaynew(f) {
    let key = f.dataset.key;
    if (!key) {
      key = f.person.value;
      if (!key) throw new Error('Wähle aus, für wen die Gruppe ist.');
    }
    const body = { p_user: null, p_person: null, p_name: null, p_date: null };
    let who = '';
    if (key === 'new') { body.p_name = f.pname.value.trim(); if (!body.p_name) throw new Error('Gib einen Namen ein.'); }
    else if (key.startsWith('u:')) { body.p_user = key.slice(2); who = nameOf(body.p_user); }
    else if (key.startsWith('p:')) body.p_person = key.slice(2);
    if (f.day && (!body.p_user || !bdOf(body.p_user))) body.p_date = bdayDateOf(f);
    let gid;
    try { gid = await sb('/rest/v1/rpc/create_bday_group', { method: 'POST', body }); } catch (e) {
      if (who && /darfst/.test(e.message)) throw new Error(`${who} möchte keine Geburtstagsgruppen.`);
      throw e;
    }
    await sync(true);
    toast('Gruppe angelegt. Lade jetzt andere ein.');
    go('#/g/' + gid);
  },
  async bdaydate(f) {
    await sb('/rest/v1/rpc/set_group_occasion', { method: 'POST', body: { p_group: f.dataset.id, p_kind: 'geburtstag', p_name: null, p_date: bdayDateOf(f) } });
    await sync(true);
    toast('Datum gespeichert.');
  },
  async gidea(f) {
    const id = f.dataset.id, gid = f.dataset.g;
    const url = normUrl(f.url.value);
    if (url === false) throw new Error('Der Link sieht nicht richtig aus.');
    const price = parsePrice(f.price.value);
    if (price === false) throw new Error('Der Preis sieht nicht richtig aus, z. B. 24,99.');
    const row = { title: f.title.value.trim(), url, price, note: f.note.value.trim() || null };
    if (id === 'neu') await sb('/rest/v1/group_ideas', { method: 'POST', prefer: 'return=minimal', body: Object.assign({ group_id: gid }, row) });
    else await sb('/rest/v1/group_ideas?id=eq.' + id, { method: 'PATCH', prefer: 'return=minimal', body: row });
    await sync(true);
    toast('Gespeichert.');
    go('#/g/' + gid);
  },
  async rename(f) {
    await sb('/rest/v1/rpc/rename_group', { method: 'POST', body: { p_group: f.dataset.id, p_name: f.name.value.trim() } });
    ui = {};
    await sync(true);
    toast('Umbenannt.');
  }
};

/* Löschen mit Rückgängig (1.17): Wunsch oder Idee verschwindet sofort, gelöscht wird nach 8 Sekunden */
const UNDO_MS = 8000;
const undoMs = () => window.GL_UNDO_MS || UNDO_MS;   // Tests setzen das kürzer
let pendingDel = null;   // { kind: 'w' | 'i', id, timer }
function hidePendingDel() {
  if (!pendingDel) return;
  if (pendingDel.kind === 'w') D.wishes = D.wishes.filter(w => w.id !== pendingDel.id);
  else D.ideas = (D.ideas || []).filter(i => i.id !== pendingDel.id);
}
async function commitDel(keepalive) {
  const p = pendingDel;
  if (!p) return;
  pendingDel = null;
  clearTimeout(p.timer);
  try {
    await sb(`/rest/v1/${p.kind === 'w' ? 'wishes' : 'ideas'}?id=eq.${p.id}`, { method: 'DELETE', keepalive });
  } catch (e) {
    if (!keepalive) toast(e.message);
  }
  if (!keepalive) sync(true);
}
async function startDel(kind, id, msg, to) {
  if (pendingDel) await commitDel();
  pendingDel = { kind, id, timer: setTimeout(() => commitDel(), undoMs()) };
  hidePendingDel();
  ui = {};
  go(to);
  toastUndo(msg, undoMs());
}
window.addEventListener('pagehide', () => { if (pendingDel) commitDel(true); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && pendingDel) commitDel(true); });

const acts = {
  sync: () => sync(),
  /* Anlässe und Geburtstage (1.15) */
  gldone: async el => {
    const x = glPeople(el.dataset.l).find(o => o.person === el.dataset.p);
    if (!x) return;
    x.done_at = x.done_at ? null : new Date().toISOString();
    render();
    await sb(`/rest/v1/gift_list_people?list_id=eq.${el.dataset.l}&person=eq.${el.dataset.p}`, { method: 'PATCH', prefer: 'return=minimal', body: { done_at: x.done_at } });
    sync(true);
  },
  askgldel: el => { ui.confirmDelGl = el.dataset.id; render(); },
  gldel: async el => {
    await sb('/rest/v1/gift_lists?id=eq.' + el.dataset.id, { method: 'DELETE' });
    ui = {};
    await sync(true);
    go('#/ideen');
    toast('Schenkliste gelöscht.');
  },
  bddel: async () => {
    await sb('/rest/v1/birthdays?user_id=eq.' + me(), { method: 'DELETE' });
    await sync(true);
    toast('Geburtstag entfernt.');
  },
  /* Direkte Freundschaft (1.14) */
  friendshare: async () => {
    if (ui.plus) { delete ui.plus; render(); }
    if (!D.fcode) D.fcode = await sb('/rest/v1/rpc/friend_code', { method: 'POST', body: {} });
    const link = friendLink(D.fcode);
    const text = `Lass uns bei der Geschenkeliste befreundet sein, dann sehen wir gegenseitig unsere Wünsche. Freundes-Code: ${fmtFriendCode(D.fcode)}`;
    if (navigator.share) {
      try { await navigator.share({ title: 'Geschenkeliste', text, url: link }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    try { await navigator.clipboard.writeText(text + '\n' + link); toast('Freundes-Link kopiert.'); } catch (e) { toast('Freundes-Code: ' + fmtFriendCode(D.fcode)); }
  },
  asknewcode: async () => { ui.confirmNewCode = 1; render(); },
  friendnewcode: async () => {
    D.fcode = await sb('/rest/v1/rpc/friend_code', { method: 'POST', body: { p_new: true } });
    delete ui.confirmNewCode;
    toast('Neuer Freundes-Link. Der alte gilt nicht mehr.');
    render();
  },
  friendcode: async el => {
    const uid = await sb('/rest/v1/rpc/friend_accept_code', { method: 'POST', body: { p_code: el.dataset.id } });
    if (ui.peek) delete ui.peek[el.dataset.id];
    await sync(true);
    toast('Ihr seid jetzt befreundet.');
    location.replace('#/f/u:' + uid);
  },
  freqyes: async el => {
    await sb('/rest/v1/rpc/friend_answer', { method: 'POST', body: { p_id: el.dataset.id, p_accept: true } });
    await sync(true);
    toast('Ihr seid jetzt befreundet.');
  },
  freqno: async el => {
    await sb('/rest/v1/rpc/friend_answer', { method: 'POST', body: { p_id: el.dataset.id, p_accept: false } });
    await sync(true);
    toast('Abgelehnt. Die andere Person erfährt das nicht.');
  },
  freqwithdraw: async el => {
    await sb('/rest/v1/rpc/friend_withdraw', { method: 'POST', body: { p_id: el.dataset.id } });
    await sync(true);
  },
  friendask: async el => {
    const r = await sb('/rest/v1/rpc/friend_request_user', { method: 'POST', body: { p_user: el.dataset.id } });
    await sync(true);
    toast(r === 'accepted' ? 'Ihr seid jetzt befreundet.' : 'Anfrage verschickt.');
  },
  askremove: async () => { ui.removeDlg = 1; render(); const b = $('.modal .ghost'); if (b) b.focus(); },
  removecancel: async () => { delete ui.removeDlg; render(); },
  unfriend: async el => {
    await sb('/rest/v1/rpc/friend_remove', { method: 'POST', body: { p_user: el.dataset.id } });
    ui = {};
    await sync(true);
    toast('Freund entfernt.');
    go('#/freunde');
  },
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
  askdelacc: async () => { ui.confirmDelAcc = 1; render(); },
  delaccdlg: async () => { ui.delAccDlg = 1; render(); const b = $('.modal .ghost'); if (b) b.focus(); },
  tournext: async () => { S.tour = (S.tour || 1) + 1; saveState(); render(); },
  tourskip: async () => { delete S.tour; saveState(); render(); },
  tourshow: async () => { S.tour = 1; saveState(); render(); },
  plus: async el => { ui.plus = el.dataset.v; render(); const b = $('.plusmenu .row-item'); if (b) b.focus(); },
  plusclose: async el => { delete ui.plus; if (el.tagName === 'A') location.hash = el.getAttribute('href'); else render(); },
  gform: async el => openForm('gform', el.dataset.v),
  fform: async el => openForm('fform', el.dataset.v),
  delacccancel: async () => { delete ui.delAccDlg; delete ui.confirmDelAcc; render(); },
  delacc: async () => {
    const uid = me();
    await sb('/rest/v1/rpc/delete_account', { method: 'POST', body: {} });
    if (push.sub) { try { await push.sub.unsubscribe(); } catch (e) { /* egal */ } }
    try {
      const all = JSON.parse(localStorage.getItem('geschenkeliste-seen') || '{}');
      delete all[uid];
      localStorage.setItem('geschenkeliste-seen', JSON.stringify(all));
    } catch (e) { /* egal */ }
    logout('Dein Konto wurde gelöscht.');
  },
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
  ideadone: async el => {
    const i = (D.ideas || []).find(x => x.id === el.dataset.id);
    if (!i) return;
    const at = i.done_at ? null : new Date().toISOString();
    await sb('/rest/v1/ideas?id=eq.' + i.id, { method: 'PATCH', prefer: 'return=minimal', body: { done_at: at } });
    i.done_at = at;
    render();
    if (at) earlyToast();
    sync(true);
  },
  delidea: async el => startDel('i', el.dataset.id, 'Idee gelöscht.', backParam() || '#/ideen'),
  undo: async () => {
    const p = pendingDel;
    if (!p) return;
    clearTimeout(p.timer);
    pendingDel = null;
    $('#toast').classList.remove('show', 'withundo');
    await sync(true);
    toast(p.kind === 'w' ? 'Der Wunsch ist wieder da.' : 'Die Idee ist wieder da.');
  },
  askdelip: async el => { ui.confirmDelIp = el.dataset.id; render(); },
  delip: async el => {
    await sb('/rest/v1/idea_people?id=eq.' + el.dataset.id, { method: 'DELETE' });
    ui = {};
    await sync(true);
    toast('Gelöscht.');
    go(backParam() || '#/freunde');
  },
  ipunlink: async el => {
    await sb('/rest/v1/rpc/idea_link', { method: 'POST', body: { p_person: el.dataset.id, p_user: null } });
    await sync(true);
    toast('Verknüpfung gelöst.');
    go('#/f/p:' + el.dataset.id);
  },
  delwish: async el => startDel('w', el.dataset.id, 'Wunsch gelöscht.', '#/liste'),
  manage: async el => { ui.manage = el.dataset.id; render(); },
  askleave: async el => { ui.confirmLeave = el.dataset.id; render(); },
  // Geburtstagsgruppen (1.16)
  gtake: async el => {
    await sb('/rest/v1/rpc/gidea_take', { method: 'POST', body: { p_id: el.dataset.id, p_status: el.dataset.s || null } });
    await sync(true);
    if (el.dataset.s === 'gekauft') earlyToast();
  },
  delgi: async el => {
    await sb('/rest/v1/group_ideas?id=eq.' + el.dataset.id, { method: 'DELETE' });
    ui = {};
    await sync(true);
    toast('Idee gelöscht.');
    go('#/g/' + el.dataset.g);
  },
  bdarchive: async el => {
    await sb('/rest/v1/rpc/bday_archive', { method: 'POST', body: { p_group: el.dataset.id } });
    await sync(true);
    toast('Archiviert.');
  },
  bdreopen: async el => {
    await sb('/rest/v1/rpc/bday_reopen', { method: 'POST', body: { p_group: el.dataset.id } });
    await sync(true);
    toast('Die Gruppe ist wieder offen.');
  },
  askbddel: async el => { ui.confirmBdDel = el.dataset.id; render(); },
  bddelgrp: async el => {
    await sb('/rest/v1/rpc/bday_delete', { method: 'POST', body: { p_group: el.dataset.id } });
    ui = {};
    await sync(true);
    toast('Gruppe gelöscht.');
    go('#/gruppen');
  },
  bdopt: async el => {
    if (el.dataset.on === '1') await sb('/rest/v1/bday_optout?user_id=eq.' + me(), { method: 'DELETE' });
    else await sb('/rest/v1/bday_optout', { method: 'POST', prefer: 'return=minimal', body: { user_id: me() } });
    await sync(true);
  },
  bdlinkyes: async () => {
    const a = ui.bdLinkAsk;
    delete ui.bdLinkAsk;
    for (const g of a.gids) await sb('/rest/v1/rpc/bday_link', { method: 'POST', body: { p_group: g, p_user: a.uid } });
    await sb('/rest/v1/rpc/idea_link', { method: 'POST', body: { p_person: a.pid, p_user: a.uid } });
    await sync(true);
    toast('Verknüpft, auch für alle in der Gruppe.');
  },
  bdlinkno: async () => {
    const a = ui.bdLinkAsk;
    delete ui.bdLinkAsk;
    await sb('/rest/v1/rpc/idea_link', { method: 'POST', body: { p_person: a.pid, p_user: a.uid } });
    await sync(true);
    toast('Verknüpft. Die Ideen bleiben privat.');
  },
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
    if (el.dataset.s === 'gekauft') earlyToast();
  },
  // Steckbrief (1.12)
  sbpick: el => sbChoose(el),
  sbone: el => sbChoose(el),
  sbtoggle: async el => {
    const k = el.dataset.k, v = el.dataset.v;
    const cur = Array.isArray(sbMine()[k]) ? sbMine()[k].slice() : [];
    const i = cur.indexOf(v);
    if (i >= 0) cur.splice(i, 1);
    else {
      if (k === 'likes.colors' && cur.length >= 5) { toast('Höchstens fünf Farben.'); return; }
      if (cur.length >= 30) { toast('Höchstens 30 Einträge.'); return; }
      cur.push(v);
    }
    await sbPut(k, cur);
  },
  sbconfirm: async () => {
    const d = sbMine();
    for (const f of sbFieldsOf('sizes')) if (sbFilled(d[f[0]])) await sbPut(f[0], d[f[0]]);
    toast('Danke, ist vermerkt.');
  },
  sbaskdel: async () => { ui.confirmDelCard = 1; render(); },
  sbdelete: async () => {
    await sb('/rest/v1/profile_card_vis?owner=eq.' + me(), { method: 'DELETE' });
    await sb('/rest/v1/profile_cards?user_id=eq.' + me(), { method: 'DELETE' });
    ui = {};
    await sync(true);
    toast('Steckbrief gelöscht.');
    go('#/konto');
  },
  // Gemeinsam schenken (1.13)
  poolpaid: async el => {
    await sb('/rest/v1/rpc/pool_paid', { method: 'POST', body: { p_wish: el.dataset.id, p_user: el.dataset.u, p_on: el.dataset.on === '1' } });
    await sync(true);
    if (el.dataset.on === '1') toast(el.dataset.u === me() ? 'Danke, ist abgehakt.' : 'Als bezahlt markiert.');
  },
  askpoolcancel: async el => { ui.confirmPool = el.dataset.id; render(); },
  poolnoconfirm: async () => { delete ui.confirmPool; delete ui.handover; render(); },
  poolcancel: async el => {
    await sb('/rest/v1/rpc/pool_cancel', { method: 'POST', body: { p_wish: el.dataset.id } });
    const w = D.wishes.find(x => x.id === el.dataset.id);
    ui = {};
    await sync(true);
    toast('Abgesagt. Der Wunsch ist wieder frei.');
    go(w ? poolBack(w)[0] : '#/');
  },
  poolleave: async el => {
    await sb('/rest/v1/rpc/pool_leave', { method: 'POST', body: { p_wish: el.dataset.id } });
    ui = {};
    await sync(true);
    toast('Du machst nicht mehr mit.');
  },
  pooltrotz: async el => {
    await poolUpdate(poolOf(el.dataset.id), { p_min: null });
    await sync(true);
    toast('Ihr schenkt es trotzdem.');
  },
  poolhand: async el => { ui.handover = el.dataset.id; render(); },
  poolhandto: async el => {
    await sb('/rest/v1/rpc/pool_handover', { method: 'POST', body: { p_wish: el.dataset.id, p_user: el.dataset.u } });
    ui = {};
    await sync(true);
    toast(nameOf(el.dataset.u) + ' kauft jetzt.');
  },
  pooldecline: async el => {
    const n = poolNo();
    n[el.dataset.id] = 1;
    try { localStorage.setItem(POOL_NO, JSON.stringify(n)); } catch (e) { /* egal */ }
    render();
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
  else if (!doPendingFriend()) render();
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
/* ---------- Wischen (1.17) ----------
   Vom linken Rand nach rechts: zurück (nur als installierte App, im Browser macht das der Browser selbst).
   Auf den vier Hauptseiten links/rechts wischen: zum nächsten bzw. vorigen Bereich. */
const TAB_ORDER = ['#/', '#/liste', '#/gruppen', '#/konto'];
const tabOfHash = h => {
  const p = route()[0] || '';
  if (p === '') return 0;
  if (p === 'liste' || p === 'ideen') return 1;
  if (p === 'gruppen' || p === 'freunde') return 2;
  if (p === 'konto' || p === 'mehr') return 3;
  return -1;
};
const standalone = () => (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
let swipe = null;
document.addEventListener('touchstart', e => {
  swipe = null;
  if (e.touches.length !== 1 || !S.session || $('.modalwrap')) return;
  const t = e.touches[0], el = e.target;
  if (el.closest('input, textarea, select, .seg, .scrollx, [data-noswipe]')) return;
  swipe = { x: t.clientX, y: t.clientY, at: Date.now(), edge: t.clientX < 28 };
}, { passive: true });
document.addEventListener('touchend', e => {
  const s0 = swipe;
  swipe = null;
  if (!s0 || !e.changedTouches.length) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - s0.x, dy = t.clientY - s0.y;
  if (Date.now() - s0.at > 700 || Math.abs(dx) < 80 || Math.abs(dx) < 2 * Math.abs(dy)) return;
  const back = $('.topbar .back');
  if (back) {
    if (s0.edge && dx > 0 && standalone()) location.hash = back.getAttribute('href');
    return;
  }
  const i = tabOfHash();
  if (i < 0) return;
  const j = i + (dx < 0 ? 1 : -1);
  if (j < 0 || j >= TAB_ORDER.length) return;
  document.body.classList.remove('swl', 'swr');
  void document.body.offsetWidth;
  document.body.classList.add(dx < 0 ? 'swl' : 'swr');
  setTimeout(() => document.body.classList.remove('swl', 'swr'), 260);
  location.hash = TAB_ORDER[j];
}, { passive: true });

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = acts[el.dataset.act];
  if (fn) { e.preventDefault(); run(() => fn(el)); }
});
document.addEventListener('paste', e => {
  const el = e.target;
  if (!el || el.name !== 'url' || !el.form || !['wish', 'idea', 'gidea'].includes(el.form.dataset.form)) return;
  const t = (e.clipboardData || window.clipboardData).getData('text');
  if (/\s/.test(t.trim()) && findUrl(t)) { e.preventDefault(); fillLink(el.form, t); }
});
document.addEventListener('change', e => {
  if (e.target.name === 'person' && e.target.form && ['idea', 'glAdd', 'bdaynew'].includes(e.target.form.dataset.form)) {
    const n = $('#pnew');
    if (n) { n.classList.toggle('hide', e.target.value !== 'new'); if (e.target.value === 'new') n.querySelector('input').focus(); }
  }
  if (e.target.name === 'kind' && e.target.form && e.target.form.dataset.form === 'occasion') {
    const f = e.target.form, k = e.target.value, need = k === 'geburtstag' || k === 'sonstiges';
    f.querySelector('.occ-name').classList.toggle('hide', !need);
    f.querySelector('.occ-date').classList.toggle('hide', !need);
    f.name.placeholder = k === 'geburtstag' ? 'z. B. Lenas Geburtstag' : 'z. B. Hochzeit';
  }
  if (e.target.name === 'vmode') {
    const box = $('#vispick'), help = $('#vishelp');
    if (box) box.classList.toggle('hide', e.target.value === 'all');
    if (help) help.textContent = e.target.value === 'only' ? 'Nur wen du hier auswählst, sieht es.' : 'Wer in einer anderen deiner Gruppen ist oder direkt mit dir befreundet, sieht es trotzdem. Einzelne Personen kannst du direkt auswählen.';
  }
  if (e.target.name === 'split' && e.target.form) {
    const v = e.target.value, f = e.target.form;
    const h = $('#splithelp'), a = $('#myamt'), l = $('#myamtlabel');
    if (h) h.textContent = SPLITS.find(x => x[0] === v)[2];
    if (a) a.classList.toggle('hide', v === 'equal');
    if (l) l.textContent = v === 'budget' ? 'Dein Höchstbetrag' : 'Dein Betrag';
    if (v === 'equal' && f.amount) f.amount.value = '';
  }
  if (e.target.name === 'who') {
    const box = $('#ppick');
    if (box) box.classList.toggle('hide', e.target.value === 'all');
  }
  if (e.target.name === 'vis') {
    const sub = $('#gsel');
    if (sub) sub.classList.toggle('hide', e.target.value === 'all');
  }
  if (e.target.name === 'fvis') {
    const sub = $('#fsel');
    if (sub) sub.classList.toggle('hide', e.target.value === 'all');
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && ui.delAccDlg) { delete ui.delAccDlg; delete ui.confirmDelAcc; render(); }
  if (e.key === 'Escape' && (ui.removeDlg || ui.plus)) { delete ui.removeDlg; delete ui.plus; render(); }
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
