'use strict';
/* Geschenkeliste – Wunschlisten für Familie und Freunde.
   Ohne Bibliotheken: spricht direkt mit Supabase (Auth + REST). */

const VERSION = '1.4';
const SB_URL = 'https://qbdpzamygonpruaafcrt.supabase.co';
const SB_KEY = 'sb_publishable_A7zukzk82Suux8jteQvLGA_WmXnZb14';
const LS_KEY = 'geschenkeliste-v1';

/* ---------- Speicher ---------- */
let S = loadState();      // {session, loginEmail, loginSent, pendingJoin, cache}
let D = emptyData();      // Daten vom Server
let busy = false;
let ui = {};              // flüchtiger Zustand der Ansicht (offene Formulare, Löschbestätigung)

function emptyData() {
  return { profiles: [], groups: [], members: [], wishes: [], wg: [], res: [], at: 0, loaded: false };
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

/* ---------- Supabase ---------- */
function errText(j, status) {
  const m = j ? (j.message || j.msg || j.error_description || j.error || '') : '';
  const code = j && (j.code || j.error_code);
  if (status === 429 || /rate limit|over_email_send_rate_limit/i.test(m + code)) return 'Zu viele Versuche. Bitte ein paar Minuten warten.';
  if (/expired|invalid/i.test(m) && /token|otp/i.test(m)) return 'Code falsch oder abgelaufen.';
  if (code === '23505' || /duplicate key/i.test(m)) return 'Das hat gerade schon jemand anderes reserviert.';
  if (code === '42501' || /row-level security/i.test(m)) return 'Das darfst du leider nicht.';
  if (/Code nicht gefunden/.test(m)) return 'Diesen Gruppen-Code gibt es nicht.';
  if (/Zu viele Gruppen/.test(m)) return 'Du hast schon 20 Gruppen angelegt.';
  if (/anonymous/i.test(m) && /disabled/i.test(m)) return 'Start ohne Mail ist in Supabase noch nicht eingeschaltet.';
  if (/already/i.test(m) && /regist|exist/i.test(m)) return 'Für diese Mail-Adresse gibt es schon ein Konto.';
  if (/email/i.test(m) && /invalid/i.test(m)) return 'Diese Mail-Adresse sieht nicht richtig aus.';
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
  ui = {};
  saveState();
  if (msg) toast(msg);
  go('#/');
}

/* Link aus der Mail: Tokens stehen im Adress-Hash */
async function handleAuthHash() {
  const h = location.hash;
  if (h.includes('error_description=')) {
    const p = new URLSearchParams(h.replace(/^#\/?/, ''));
    history.replaceState(null, '', location.pathname);
    toast(/expired|invalid/i.test(p.get('error_description')) ? 'Der Link ist abgelaufen. Fordere einen neuen Code an.' : p.get('error_description'));
    return;
  }
  if (!h.includes('access_token=')) return;
  const p = new URLSearchParams(h.replace(/^#\/?/, ''));
  history.replaceState(null, '', location.pathname);
  const token = p.get('access_token');
  try {
    const r = await fetch(SB_URL + '/auth/v1/user', { headers: { apikey: SB_KEY, Authorization: 'Bearer ' + token } });
    if (!r.ok) throw new Error();
    const user = await r.json();
    setSession({ access_token: token, refresh_token: p.get('refresh_token'), expires_at: +p.get('expires_at') || 0, expires_in: +p.get('expires_in') || 3600, user });
  } catch (e) {
    toast('Anmeldung über den Link hat nicht geklappt. Gib den Code ein.');
  }
}

/* ---------- Daten laden ---------- */
async function refreshUser() {
  if (!S.session || !S.session.user.anon) return false;
  try {
    const u = await sb('/auth/v1/user');
    if (u && u.email) {
      S.session.user = { id: u.id, email: u.email, anon: false };
      delete S.secureSent;
      saveState();
      return true;
    }
  } catch (e) { /* später nochmal */ }
  return false;
}

async function sync(quiet) {
  if (!S.session) return;
  if (S.session.user.anon && S.secureSent) refreshUser();
  try {
    const [profiles, groups, members, wishes, wg, res] = await Promise.all([
      sb('/rest/v1/profiles?select=id,name'),
      sb('/rest/v1/groups?select=id,name,code,created_by,created_at&order=created_at'),
      sb('/rest/v1/members?select=group_id,user_id,joined_at&order=joined_at'),
      sb('/rest/v1/wishes?select=id,owner,title,url,note,all_groups,created_at&order=created_at.desc'),
      sb('/rest/v1/wish_groups?select=wish_id,group_id'),
      sb('/rest/v1/reservations?select=wish_id,user_id,status')
    ]);
    if (!S.session) return;
    D = { profiles, groups, members, wishes, wg, res, at: Date.now(), loaded: true };
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
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 6.5 8.5 6.5 8.5-6.5"/>',
  heart: '<path d="M12 20s-7.5-4.6-7.5-10A4.5 4.5 0 0 1 12 7a4.5 4.5 0 0 1 7.5 3c0 5.4-7.5 10-7.5 10z"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M16 7l3 3M14 9l2 2"/>'
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
  if (S.loginSent && S.loginEmail) {
    return `<main class="login">
      ${brand()}
      <h1 class="title xl">Schau in dein Postfach</h1>
      <p class="lead">Wir haben einen Anmelde-Link an <b>${esc(S.loginEmail)}</b> geschickt.</p>
      ${invited}
      <ol class="steps">
        <li>Öffne die Mail und drücke lang auf den Link.</li>
        <li>Wähle „Link kopieren“.</li>
        <li>Komm zurück und füge ihn hier ein.</li>
      </ol>
      <form data-form="verify" class="card stack">
        <label>Link oder Code<input name="code" autocomplete="one-time-code" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="https://… oder 123456" required></label>
        <button class="primary" type="submit">Anmelden</button>
        <button type="button" class="secondary" data-act="pastelink">Kopierten Link einfügen</button>
      </form>
      <p class="muted small">Keine Mail bekommen? Sieh im Spam-Ordner nach. Der Link ist eine Stunde gültig.</p>
      <div class="linkrow"><button class="link" data-act="resend">Erneut senden</button><button class="link" data-act="otheremail">Andere Adresse</button></div>
    </main>`;
  }
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) && !navigator.standalone;
  const tip = ios ? `<div class="banner">${icon('share')}<span><b>Tipp fürs iPhone</b><small>Erst über Teilen „Zum Home-Bildschirm“ hinzufügen und die App von dort öffnen. Safari und Home-Bildschirm speichern getrennt.</small></span></div>` : '';
  return `<main class="login">
    ${brand()}
    <h1 class="title xl">Wünsche teilen, ohne die Überraschung zu verderben.</h1>
    <ul class="features">
      <li>${icon('people')}<span><b>Für Familie und Freunde</b>Eine Wunschliste, beliebig viele Gruppen.</span></li>
      <li>${icon('eyeoff')}<span><b>Reservierungen bleiben geheim</b>Wer sich etwas wünscht, sieht nicht, was schon vergeben ist.</span></li>
      <li>${icon('heart')}<span><b>Kostenlos und ohne Werbung</b>Es wird nur gespeichert, was die App braucht.</span></li>
    </ul>
    ${invited}${tip}
    <form data-form="start" class="card stack">
      <label>Wie heißt du?<input name="name" maxlength="40" placeholder="Vorname" required autocomplete="given-name" value="${esc(S.pendingName || '')}"></label>
      <button class="primary" type="submit">Weiter</button>
    </form>
    <div class="card stack mailcard">
      <div class="mailhead">${icon('mail')}<b>Mit E-Mail anmelden</b><span class="badge">Empfohlen</span></div>
      <p class="small muted">Mit deiner Mail-Adresse kommst du auf jedem Gerät an deine Liste, auch nach einem Handywechsel. Ohne Mail bleibt alles auf diesem Gerät. Wir schicken nur Anmelde-Links.</p>
      <form data-form="login" class="stack">
        <input name="email" type="email" autocomplete="email" placeholder="name@beispiel.de" required value="${esc(S.loginEmail || '')}">
        <button type="submit" class="secondary">Anmelde-Link schicken</button>
      </form>
    </div>
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

  const secure = S.session.user.anon ? `<a class="banner tap" href="#/konto">${icon('lock')}<span><b>Konto sichern</b><small>Mit E-Mail bleibt deine Liste auch beim Handywechsel erhalten.</small></span>${icon('chev', 'chev')}</a>` : '';
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

  return shell('Hallo ' + myName(), `${secure}${hero}${stats}
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
  return shell(g.name, `
    <div class="card invite">
      <div><p class="eyebrow">Einladungscode</p><p class="code" id="gcode">${esc(fmtCode(g.code))}</p></div>
      <button class="primary withicon" data-act="invite" data-id="${gid}">${icon('share')}Einladen</button>
    </div>
    <h2>Mitglieder</h2>
    <ul class="rows">${rows}</ul>
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

function secureCard() {
  if (S.secureSent) {
    return `<div class="card stack mailcard">
      <div class="mailhead">${icon('mail')}<b>Bestätigung ausstehend</b></div>
      <p class="small muted">Wir haben eine Mail an <b>${esc(S.secureSent)}</b> geschickt. Tippe auf den Link darin. Es ist in Ordnung, wenn sich Safari öffnet. Danach hier auf „Prüfen“ tippen.</p>
      <button class="primary" data-act="checkuser">Prüfen</button>
      <button class="link" data-act="securecancel">Andere Adresse</button>
    </div>`;
  }
  return `<div class="card stack mailcard">
    <div class="mailhead">${icon('lock')}<b>Konto sichern</b></div>
    <p class="small muted">Gerade hängt dein Konto an diesem Gerät. Mit deiner Mail-Adresse kannst du dich überall wieder anmelden.</p>
    <form data-form="secure" class="inline"><input name="email" type="email" autocomplete="email" placeholder="name@beispiel.de" required><button class="primary" type="submit">Sichern</button></form>
  </div>`;
}

function viewAccount() {
  const anon = S.session.user.anon;
  return shell('Konto', `
    <section class="profile">${avatar(me(), 'lg')}<div class="profile-main">
      <p class="row-title big">${esc(myName())}</p>
      <p class="row-meta">${anon ? 'Ohne E-Mail angemeldet' : `Angemeldet als ${esc(S.session.user.email)}`}</p></div></section>
    ${anon ? secureCard() : ''}
    <h2>Profil</h2>
    <div class="card"><form data-form="name" class="inline"><input name="name" maxlength="40" value="${esc(myName())}" required><button class="secondary" type="submit">Name ändern</button></form></div>
    <h2>Datenschutz</h2>
    <div class="card prose">
      <p>Name, Mail-Adresse, Gruppen, Wünsche und Reservierungen liegen in einer Datenbank bei Supabase in der EU.</p>
      <p>Andere sehen deinen Namen und die Wünsche, die du für ihre Gruppe freigibst. Reservierungen sieht der Beschenkte nie.</p>
      <p>Auf dem Gerät bleiben nur die Anmeldung und eine Kopie der Listen, damit die App schnell startet.</p>
    </div>
    <div class="card stack">
      ${anon && ui.confirmLogout
        ? `<p class="small">Ohne Mail-Adresse kommst du danach nicht mehr in dieses Konto zurück. Deine Liste wäre verloren.</p><button class="danger" data-act="logout">Trotzdem abmelden</button>`
        : `<button class="ghost danger-text" data-act="${anon ? 'asklogout' : 'logout'}">Abmelden</button>`}
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
  if (!S.session) { app.innerHTML = viewLogin(); return; }
  const prof = D.profiles.find(x => x.id === me());
  if (D.loaded && (!prof || !prof.name)) { app.innerHTML = S.pendingName ? '<p class="boot">Lädt …</p>' : viewName(); return; }
  if (!D.loaded) { app.innerHTML = '<p class="boot">Lädt …</p>'; return; }
  let html;
  if (parts[0] === 'w' && parts[1]) html = viewWishForm(parts[1]);
  else if (parts[0] === 'gruppen') html = viewGroups();
  else if (parts[0] === 'g' && parts[1] && parts[2] === 'p' && parts[3]) html = viewPerson(parts[1], parts[3]);
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
  async secure(f) {
    const email = f.email.value.trim().toLowerCase();
    await sb('/auth/v1/user?redirect_to=' + encodeURIComponent(location.origin + location.pathname), { method: 'PUT', body: { email } });
    S.secureSent = email;
    saveState();
    render();
  },
  async login(f) {
    const nm = $('form[data-form=start] input[name=name]');
    if (nm && nm.value.trim()) S.pendingName = nm.value.trim();
    const email = f.email.value.trim().toLowerCase();
    await sb('/auth/v1/otp?redirect_to=' + encodeURIComponent(location.origin + location.pathname), { method: 'POST', auth: false, body: { email, create_user: true } });
    S.loginEmail = email;
    S.loginSent = Date.now();
    saveState();
    render();
  },
  async verify(f) {
    const raw = f.code.value.trim();
    let j;
    const m = raw.match(/[?&#]token=([^&#\s]+)/);
    if (m) {
      // eingefügter Link aus der Mail: enthält einen gehashten Token
      const tm = raw.match(/[?&#]type=([a-z_]+)/);
      const type = tm ? tm[1] : 'magiclink';
      const token_hash = decodeURIComponent(m[1]);
      try {
        j = await sb('/auth/v1/verify', { method: 'POST', auth: false, body: { type, token_hash } });
      } catch (e) {
        try { j = await sb('/auth/v1/verify', { method: 'POST', auth: false, body: { type: 'email', token_hash } }); } catch (e2) { throw new Error('Der Link ist abgelaufen oder schon benutzt. Fordere einen neuen an.'); }
      }
      setSession(j);
      await afterLogin();
      return;
    }
    if (/^https?:/i.test(raw)) throw new Error('Das ist nicht der Anmelde-Link aus der Mail.');
    const token = raw.replace(/\D/g, '');
    if (token.length < 6) throw new Error('Der Code hat mindestens 6 Ziffern.');
    try {
      j = await sb('/auth/v1/verify', { method: 'POST', auth: false, body: { type: 'email', email: S.loginEmail, token } });
    } catch (e) {
      // ältere Einstellung: neue Konten bekommen eine Bestätigungs-Mail
      try { j = await sb('/auth/v1/verify', { method: 'POST', auth: false, body: { type: 'signup', email: S.loginEmail, token } }); } catch (e2) { throw e; }
    }
    setSession(j);
    await afterLogin();
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
  async rename(f) {
    await sb('/rest/v1/rpc/rename_group', { method: 'POST', body: { p_group: f.dataset.id, p_name: f.name.value.trim() } });
    ui = {};
    await sync(true);
    toast('Umbenannt.');
  }
};

const acts = {
  sync: () => sync(),
  resend: async () => {
    await sb('/auth/v1/otp?redirect_to=' + encodeURIComponent(location.origin + location.pathname), { method: 'POST', auth: false, body: { email: S.loginEmail, create_user: true } });
    toast('Neuer Code ist unterwegs.');
  },
  pastelink: async () => {
    let t = '';
    try { t = await navigator.clipboard.readText(); } catch (e) { /* nicht erlaubt */ }
    const inp = $('input[name=code]');
    if (!t) { inp.focus(); toast('Ins Feld tippen und „Einsetzen“ wählen.'); return; }
    inp.value = t.trim();
    await forms.verify(inp.form);
  },
  asklogout: async () => { ui.confirmLogout = 1; render(); },
  checkuser: async () => {
    const ok = await refreshUser();
    toast(ok ? 'Konto gesichert.' : 'Noch nicht bestätigt. Hast du auf den Link in der Mail getippt?');
    render();
  },
  securecancel: async () => { delete S.secureSent; saveState(); render(); },
  otheremail: async () => { delete S.loginSent; saveState(); render(); },
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
  await handleAuthHash();
  if (S.session && S.cache && S.cache.uid === me()) {
    D = Object.assign(emptyData(), S.cache.D, { at: 0 });
  }
  render();
  if (S.session) await afterLogin();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
