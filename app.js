'use strict';
/* Geschenkeliste – Wunschlisten für Familie und Freunde.
   Ohne Bibliotheken: spricht direkt mit Supabase (Auth + REST). */

const VERSION = '1.6';
const SB_URL = 'https://qbdpzamygonpruaafcrt.supabase.co';
const SB_KEY = 'sb_publishable_A7zukzk82Suux8jteQvLGA_WmXnZb14';
const LS_KEY = 'geschenkeliste-v1';
const MAIL_DOMAIN = '@nutzer.geschenkeliste.invalid'; // nur intern, es wird nie eine Mail verschickt
const USER_RE = /^[a-z0-9][a-z0-9._-]{2,23}$/;

/* ---------- Speicher ---------- */
let S = loadState();      // {session, pendingJoin, pendingName, cache}
let D = emptyData();      // Daten vom Server
let busy = false;
let ui = {};              // flüchtiger Zustand der Ansicht (offene Formulare, Löschbestätigung)
let fresh = null;         // neu erzeugter Wiederherstellungscode {code, username, reason}, nur im Speicher

function emptyData() {
  return { profiles: [], groups: [], members: [], wishes: [], wg: [], res: [], account: null, admin: false, wd: [], wp: [], wx: [], wo: [], at: 0, loaded: false };
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
  if (/Could not find the function|PGRST202|42883/.test(m + code)) return 'Die Datenbank ist noch nicht aktualisiert (schema.sql ausführen).';
  if (code === '23505' || /duplicate key/i.test(m)) return 'Das hat gerade schon jemand anderes reserviert.';
  if (code === '42501' || /row-level security/i.test(m)) return 'Das darfst du leider nicht.';
  if (/Nur der Gründer/.test(m)) return 'Das darf nur, wer die Gruppe gegründet hat.';
  if (/Keine Auslosung möglich/.test(m)) return 'Mit diesen Ausschlüssen geht die Auslosung nicht auf. Entferne einen Ausschluss und versuch es nochmal.';
  if (/Zu wenige Teilnehmer/.test(m)) return 'Zum Auslosen braucht es mindestens 3 Personen.';
  if (/Zu viele Teilnehmer/.test(m)) return 'Mehr als 60 Personen gehen nicht.';
  if (/Zu viele Ausschlüsse/.test(m)) return 'Mehr als 200 Ausschlüsse gehen nicht.';
  if (/Zwei verschiedene Personen/.test(m)) return 'Wähle zwei verschiedene Personen.';
  if (/Kein Mitglied/.test(m)) return 'Diese Person ist nicht mehr in der Gruppe.';
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
    const [profiles, groups, members, wishes, wg, res, acc, admin, wd, wp, wx, wo] = await Promise.all([
      sb('/rest/v1/profiles?select=id,name'),
      sb('/rest/v1/groups?select=id,name,code,created_by,created_at&order=created_at'),
      sb('/rest/v1/members?select=group_id,user_id,joined_at&order=joined_at'),
      sb('/rest/v1/wishes?select=id,owner,title,url,note,all_groups,created_at&order=created_at.desc'),
      sb('/rest/v1/wish_groups?select=wish_id,group_id'),
      sb('/rest/v1/reservations?select=wish_id,user_id,status'),
      // ab 1.5; vor dem Ausführen der neuen schema.sql fehlen sie, die App läuft trotzdem
      sb('/rest/v1/accounts?select=username,reset_at,reset_notice').catch(() => null),
      sb('/rest/v1/rpc/is_app_admin', { method: 'POST', body: {} }).catch(() => false),
      // Wichteln ab 1.6, ebenfalls tolerant
      sb('/rest/v1/wichtel_draws?select=group_id,drawn_at,participants').catch(() => []),
      sb('/rest/v1/wichtel_pairs?select=group_id,receiver').catch(() => []),
      sb('/rest/v1/wichtel_exclusions?select=group_id,a,b,created_at&order=created_at').catch(() => []),
      sb('/rest/v1/wichtel_out?select=group_id,user_id').catch(() => [])
    ]);
    if (!S.session) return;
    D = { profiles, groups, members, wishes, wg, res, account: acc && acc[0] ? acc[0] : null, admin: admin === true,
      wd: wd || [], wp: wp || [], wx: wx || [], wo: wo || [], at: Date.now(), loaded: true };
    S.cache = { uid: me(), D };
    saveState();
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
  shuffle: '<path d="M4 7h3.2c1.9 0 3 .9 4.2 2.8l1.2 2c1.2 1.9 2.4 3.2 4.3 3.2H20M4 17h3.2c1.3 0 2.2-.5 3-1.4M13.6 8.4c.8-.9 1.8-1.4 3.1-1.4H20M17.5 4.5 20 7l-2.5 2.5M17.5 12.5 20 15l-2.5 2.5"/>'
};
const icon = (n, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${I[n]}</svg>`;

const BAUBLE = `<svg class="art" viewBox="0 0 140 160" aria-hidden="true">
  <path d="M6 14 Q40 2 70 10 Q100 2 134 14" stroke="#3E5647" stroke-width="7" fill="none" stroke-linecap="round"/>
  <path d="M22 9 l-6 -8 M40 6 l-2 -9 M100 6 l2 -9 M118 9 l6 -8 M30 12 l-5 9 M110 12 l5 9" stroke="#28604C" stroke-width="3" stroke-linecap="round"/>
  <g class="swing">
    <line x1="70" y1="12" x2="70" y2="44" stroke="#B27F49" stroke-width="2"/>
    <rect x="61" y="42" width="18" height="11" rx="2.5" fill="#B27F49"/>
    <circle cx="70" cy="94" r="40" fill="#A0061B"/>
    <path d="M32 86 Q70 104 108 86" stroke="#B27F49" stroke-width="3.5" fill="none"/>
    <path d="M33 104 Q70 122 107 104" stroke="#B27F49" stroke-width="2" fill="none" stroke-dasharray="2 6" stroke-linecap="round"/>
    <ellipse cx="54" cy="76" rx="8" ry="13" fill="#FFFFFF" opacity=".22" transform="rotate(35 54 76)"/>
  </g>
</svg>`;

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
function tile(w) {
  const d = w.url ? domain(w.url) : '';
  return d ? `<span class="tile c${hueIdx(d)}">${esc(d[0].toUpperCase())}</span>` : `<span class="tile plain">${icon('gift')}</span>`;
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
    <div class="topbar">${back}<button class="iconbtn" data-act="sync" aria-label="Aktualisieren">${icon('sync')}</button></div>
    ${opt.eyebrow ? `<p class="eyebrow">${esc(opt.eyebrow)}</p>` : ''}
    <h1 class="title">${esc(title)}</h1>
    ${opt.sub ? `<p class="subtitle">${opt.sub}</p>` : ''}
  </header>
  <main>${body}</main>
  <nav class="tabs">${T('#/', 'home', 'home', 'Start')}${T('#/liste', 'list', 'gift', 'Wunschliste')}${T('#/gruppen', 'groups', 'people', 'Gruppen')}${T('#/konto', 'acc', 'user', 'Konto')}</nav>`;
}

function brand() {
  return `<div class="brand"><img class="brandmark" src="icons/icon-192.png" alt=""><span>Geschenkeliste</span></div>`;
}

function viewLogin() {
  const invited = S.pendingJoin ? `<div class="banner">${icon('people')}<span><b>Du wurdest eingeladen</b><small>Nach der Anmeldung bist du automatisch in der Gruppe.</small></span></div>` : '';
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) && !navigator.standalone;
  const tip = ios ? `<div class="banner">${icon('share')}<span><b>Tipp fürs iPhone</b><small>Über Teilen „Zum Home-Bildschirm“ wird die Geschenkeliste zur App.</small></span></div>` : '';
  return `<main class="login">
    ${brand()}
    <h1 class="title xl">Wünsche teilen, ohne die Überraschung zu verderben.</h1>
    <ul class="features">
      <li>${icon('people')}<span><b>Für Familie und Freunde</b>Eine Wunschliste, beliebig viele Gruppen.</span></li>
      <li>${icon('eyeoff')}<span><b>Reservierungen bleiben geheim</b>Wer sich etwas wünscht, sieht nicht, was schon vergeben ist.</span></li>
    </ul>
    ${invited}${tip}
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
  const mine = wishesOf(me());
  const errands = D.res.filter(r => r.user_id === me())
    .map(r => ({ r, w: D.wishes.find(w => w.id === r.wish_id) })).filter(x => x.w);
  const bought = errands.filter(x => x.r.status === 'gekauft').length;
  const days = daysToXmas();
  const today = new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());

  const acc = D.account;
  const secure = needsSecure() ? `<a class="banner tap" href="#/konto">${icon('lock')}<span><b>Konto sichern</b><small>Mit Benutzername und Passwort kommst du auf jedem Gerät an deine Liste.</small></span>${icon('chev', 'chev')}</a>`
    : (acc && acc.reset_notice ? `<div class="banner notice">${icon('shield')}<span><b>Dein Zugang wurde am ${esc(fmtDay(acc.reset_at))} zurückgesetzt</b><small>Du hast jetzt ein neues Passwort und einen neuen Wiederherstellungscode.</small></span><button class="link" data-act="dismissreset">OK</button></div>` : '');
  const hero = `<section class="hero">
      <div><p class="hero-num">${days === 0 ? 'Heute' : days}</p><p class="hero-label">${days === 0 ? 'ist Heiligabend' : (days === 1 ? 'Tag bis Heiligabend' : 'Tage bis Heiligabend')}</p></div>
      ${BAUBLE}
    </section>`;
  const stats = `<div class="stats">
      <a href="#/liste"><b>${mine.length}</b><span>${mine.length === 1 ? 'Wunsch' : 'Wünsche'}</span></a>
      <div><b>${errands.length ? `${bought}<small>/${errands.length}</small>` : '0'}</b><span>besorgt</span></div>
      <a href="#/gruppen"><b>${gs.length}</b><span>${gs.length === 1 ? 'Gruppe' : 'Gruppen'}</span></a>
    </div>`;

  if (!gs.length) {
    return shell('Hallo ' + myName(), `${secure}${hero}${stats}
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
    const n = wishesOf(st.receiver, g.id).length;
    return `<li><a class="row-item" href="#/g/${g.id}/p/${st.receiver}">${avatar(st.receiver)}
      <span class="row-main"><span class="row-title">Du beschenkst ${esc(nameOf(st.receiver))}</span><span class="row-meta">${esc(g.name)} · ${n ? plural(n, 'Wunsch', 'Wünsche') : 'noch keine Wünsche'}</span></span>${icon('chev', 'chev')}</a></li>`;
  }).join('');
  const wichtelHtml = wRows ? `<h2>Wichteln</h2><ul class="rows">${wRows}</ul>` : '';

  const errHtml = errands.length ? `<ul class="rows">${errands.map(({ r, w }) => {
    const g = groupFor(w);
    const done = r.status === 'gekauft';
    return `<li class="row-item ${done ? 'done' : ''}">
        <button class="tick ${done ? 'on' : ''}" data-act="resstatus" data-id="${w.id}" data-s="${done ? 'reserviert' : 'gekauft'}" aria-label="${done ? 'Doch nicht gekauft' : 'Als gekauft markieren'}">${icon('check')}</button>
        <a class="row-main" href="${g ? `#/g/${g}/p/${w.owner}` : '#/'}"><span class="row-title">${esc(w.title)}</span><span class="row-meta">für ${esc(nameOf(w.owner))} · ${done ? 'gekauft' : 'reserviert'}</span></a>
        ${avatar(w.owner, 'sm')}
      </li>`;
  }).join('')}</ul>`
    : `<p class="empty-line">Noch nichts reserviert. Öffne eine Liste in deinen Gruppen und tippe auf „Reservieren“.</p>`;

  const feed = D.wishes.filter(w => w.owner !== me()).slice(0, 6);
  const feedHtml = feed.length ? `<ul class="rows">${feed.map(w => {
    const g = groupFor(w);
    const r = resOf(w.id);
    return `<li><a class="row-item" href="${g ? `#/g/${g}/p/${w.owner}` : '#/'}">${avatar(w.owner)}
        <span class="row-main"><span class="row-title">${esc(w.title)}</span><span class="row-meta">${esc(nameOf(w.owner))} · ${ago(w.created_at)}${r ? ' · vergeben' : ''}</span></span>${icon('chev', 'chev')}</a></li>`;
  }).join('')}</ul>`
    : `<p class="empty-line">Sobald jemand aus deinen Gruppen etwas einträgt, erscheint es hier.</p>`;

  return shell('Hallo ' + myName(), `${secure}${hero}${stats}${wichtelHtml}
    <h2>Deine Besorgungen</h2>${errHtml}
    <h2>Neu in deinen Gruppen</h2>${feedHtml}`, { tab: 'home', eyebrow: today });
}

function viewList() {
  const list = wishesOf(me());
  const rows = list.map(w => `<li><a class="row-item wish" href="#/w/${w.id}">${tile(w)}
      <span class="row-main"><span class="row-title">${esc(w.title)}</span>
      <span class="row-meta">${esc([w.url ? domain(w.url) : '', visLabel(w)].filter(Boolean).join(' · '))}</span></span>${icon('chev', 'chev')}</a></li>`).join('');
  const add = `<a class="primary withicon" href="#/w/neu">${icon('plus')}Wunsch hinzufügen</a>`;
  const body = list.length
    ? `${add}<ul class="rows">${rows}</ul><p class="foot">${icon('eyeoff')}<span>Ob etwas reserviert ist, siehst du nicht. So bleibt es eine Überraschung.</span></p>`
    : emptyState('gift', 'Deine Liste ist noch leer', 'Trag ein, worüber du dich freuen würdest. Ein Link hilft den anderen, genau das Richtige zu finden.', add);
  return shell('Meine Wunschliste', body, { tab: 'list', sub: plural(list.length, 'Wunsch', 'Wünsche') });
}

function viewWishForm(id) {
  const w = id === 'neu' ? { title: '', url: '', note: '', all_groups: true } : D.wishes.find(x => x.id === id && x.owner === me());
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
  const del = id === 'neu' ? '' : (ui.confirmDel === id
    ? `<button type="button" class="danger" data-act="delwish" data-id="${id}">Wirklich löschen</button>`
    : `<button type="button" class="ghost danger-text" data-act="askdel" data-id="${id}">Wunsch löschen</button>`);
  return shell(id === 'neu' ? 'Neuer Wunsch' : 'Wunsch bearbeiten', `
    <form data-form="wish" data-id="${id}" class="stack">
      <div class="card fields">
        <label>Was wünschst du dir?<input name="title" maxlength="120" required value="${esc(w.title)}" placeholder="z. B. Kochbuch „Simple“"></label>
        <label>Link<input name="url" inputmode="url" autocomplete="off" value="${esc(w.url || '')}" placeholder="https://"></label>
        <label>Notiz<textarea name="note" maxlength="1000" rows="3" placeholder="Größe, Farbe, Alternativen">${esc(w.note || '')}</textarea></label>
      </div>
      ${vis}
      <button class="primary" type="submit">Speichern</button>
      ${del}
    </form>`, { tab: 'list', back: ['#/liste', 'Wunschliste'] });
}

function viewGroups() {
  const gs = myGroups();
  const rows = gs.map(g => {
    const ms = membersOf(g.id).map(m => m.user_id);
    const n = D.wishes.filter(w => ms.includes(w.owner) && w.owner !== me() && visibleIn(w, g.id)).length;
    return `<li><a class="row-item group" href="#/g/${g.id}"><span class="tile c${hueIdx(g.id)}">${esc(initials(g.name))}</span>
      <span class="row-main"><span class="row-title">${esc(g.name)}</span><span class="row-meta">${plural(ms.length, 'Mitglied', 'Mitglieder')} · ${plural(n, 'Wunsch', 'Wünsche')}</span></span>
      ${avStack(ms)}${icon('chev', 'chev')}</a></li>`;
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
    const ws = wishesOf(m.user_id, gid);
    if (m.user_id === me()) {
      return `<li><a class="row-item person self" href="#/liste">${avatar(m.user_id)}
        <span class="row-main"><span class="row-title">Du</span><span class="row-meta">${plural(ws.length, 'Wunsch', 'Wünsche')} für diese Gruppe sichtbar</span></span>${icon('chev', 'chev')}</a></li>`;
    }
    const taken = ws.filter(w => resOf(w.id)).length;
    const meta = ws.length ? `${plural(ws.length, 'Wunsch', 'Wünsche')} · ${ws.length - taken} frei` : 'Noch keine Wünsche';
    return `<li><a class="row-item person" href="#/g/${gid}/p/${m.user_id}">${avatar(m.user_id)}
      <span class="row-main"><span class="row-title">${esc(nameOf(m.user_id))}</span><span class="row-meta">${meta}</span></span>${icon('chev', 'chev')}</a></li>`;
  }).join('');
  const leave = ui.confirmLeave === gid
    ? `<button class="danger" data-act="leave" data-id="${gid}">Wirklich verlassen</button>`
    : `<button class="ghost danger-text" data-act="askleave" data-id="${gid}">Gruppe verlassen</button>`;
  const st = wichtelState(gid);
  let wMeta = '';
  if (st.drawn) {
    if (st.receiver) wMeta = `Du beschenkst ${esc(nameOf(st.receiver))}`;
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
  const ws = wishesOf(uid, gid);
  const taken = ws.filter(w => resOf(w.id)).length;
  const items = ws.map(w => {
    const r = resOf(w.id);
    let pill = '', acts = '';
    if (!r) {
      acts = `<button class="primary sm" data-act="reserve" data-id="${w.id}">Reservieren</button>`;
    } else if (r.user_id === me()) {
      pill = `<span class="pill green">${r.status === 'gekauft' ? 'Von dir gekauft' : 'Von dir reserviert'}</span>`;
      acts = (r.status === 'gekauft'
        ? `<button class="secondary sm" data-act="resstatus" data-id="${w.id}" data-s="reserviert">Doch nicht gekauft</button>`
        : `<button class="primary sm" data-act="resstatus" data-id="${w.id}" data-s="gekauft">Als gekauft markieren</button>`)
        + `<button class="ghost sm" data-act="unreserve" data-id="${w.id}">Freigeben</button>`;
    } else {
      pill = `<span class="pill gold">${r.status === 'gekauft' ? 'Gekauft' : 'Reserviert'} von ${esc(nameOf(r.user_id))}</span>`;
    }
    const link = w.url ? `<a class="link-out" href="${esc(w.url)}" target="_blank" rel="noopener noreferrer">${icon('link')}${esc(domain(w.url) || 'Link')}</a>` : '';
    return `<li class="card wish ${r ? 'taken' : ''}">
      <div class="wish-head">${tile(w)}<div class="row-main"><h3>${esc(w.title)}</h3>${link}</div></div>
      ${w.note ? `<p class="wnote">${esc(w.note)}</p>` : ''}
      ${pill || acts ? `<div class="wish-foot">${pill}${acts ? `<div class="acts">${acts}</div>` : ''}</div>` : ''}
    </li>`;
  }).join('');
  const head = `<section class="profile">${avatar(uid, 'lg')}<div class="profile-main">
      <p class="row-meta">${ws.length ? `${plural(ws.length, 'Wunsch', 'Wünsche')} · ${ws.length - taken} noch frei` : 'Noch keine Wünsche'}</p>
      ${ws.length ? `<progress max="${ws.length}" value="${taken}"></progress>` : ''}</div></section>
    <p class="foot">${icon('eyeoff')}<span>${esc(name)} sieht nicht, was reserviert oder gekauft ist.</span></p>`;
  return shell(name, head + (ws.length ? `<ul class="cards">${items}</ul>` : emptyState('gift', 'Noch leer', `${esc(name)} hat für diese Gruppe noch nichts eingetragen.`)),
    { tab: 'groups', back: ['#/g/' + gid, g.name] });
}

function viewWichteln(gid) {
  const g = myGroups().find(x => x.id === gid);
  if (!g) return shell('Wichteln', emptyState('people', 'Nicht gefunden', 'Diese Gruppe gibt es nicht mehr.'), { tab: 'groups', back: ['#/gruppen', 'Gruppen'] });
  const st = wichtelState(gid);
  const founder = isFounder(g);
  const opt = { tab: 'groups', back: ['#/g/' + gid, g.name], sub: esc(g.name) };
  let top = '';
  if (st.receiver) {
    const n = wishesOf(st.receiver, gid).length;
    top = `<div class="card reveal">
      ${avatar(st.receiver, 'lg')}
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
    ${result}${list}`;
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
    ${acc ? `<h2>Anmeldung</h2>${codeCard()}` : ''}
    ${adminSection()}
    <h2>Datenschutz</h2>
    <div class="card prose">
      <p>Name, Benutzername, Gruppen, Wünsche und Reservierungen liegen in einer Datenbank bei Supabase in der EU. Passwort und Wiederherstellungscode werden nur verschlüsselt gespeichert.</p>
      <p>Andere sehen deinen Namen und die Wünsche, die du für ihre Gruppe freigibst. Reservierungen sieht der Beschenkte nie.</p>
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
    const visEl = f.querySelector('input[name=vis]:checked');
    const all = !visEl || visEl.value === 'all';
    const sel = [...f.querySelectorAll('input[name=g]:checked')].map(x => x.value);
    if (!all && !sel.length) throw new Error('Wähle mindestens eine Gruppe aus.');
    const row = { title, url, note, all_groups: all };
    let wid = id;
    if (id === 'neu') {
      const r = await sb('/rest/v1/wishes', { method: 'POST', prefer: 'return=representation', body: row });
      wid = r[0].id;
    } else {
      await sb('/rest/v1/wishes?id=eq.' + id, { method: 'PATCH', prefer: 'return=minimal', body: row });
      await sb('/rest/v1/wish_groups?wish_id=eq.' + id, { method: 'DELETE' });
    }
    if (!all) await sb('/rest/v1/wish_groups', { method: 'POST', prefer: 'return=minimal', body: sel.map(g => ({ wish_id: wid, group_id: g })) });
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
document.addEventListener('change', e => {
  if (e.target.name === 'vis') {
    const sub = $('#gsel');
    if (sub) sub.classList.toggle('hide', e.target.value === 'all');
  }
});
window.addEventListener('hashchange', () => {
  ui = {};
  render();
  if (S.session && Date.now() - D.at > 20000) sync(true);
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.session && Date.now() - D.at > 20000) sync(true);
});

(async function start() {
  cleanAuthHash();
  ['loginEmail', 'loginSent', 'secureSent'].forEach(k => delete S[k]); // Reste der Mail-Anmeldung bis 1.4
  if (S.session && S.cache && S.cache.uid === me()) {
    D = Object.assign(emptyData(), S.cache.D, { at: 0 });
  }
  render();
  if (S.session) await afterLogin();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
