'use strict';
/* Geschenkeliste – Wunschlisten für Familie und Freunde.
   Ohne Bibliotheken: spricht direkt mit Supabase (Auth + REST). */

const VERSION = '1.0';
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
  S.session = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: exp, user: { id: j.user.id, email: j.user.email } };
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
async function sync(quiet) {
  if (!S.session) return;
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

/* ---------- Ansichten ---------- */
function shell(title, body, opt = {}) {
  const tab = opt.tab || '';
  const back = opt.back ? `<a class="back" href="${opt.back}" aria-label="Zurück">‹</a>` : '';
  return `
  <header class="top">${back}<h1>${esc(title)}</h1>
    <button class="icon" data-act="sync" aria-label="Aktualisieren" title="Aktualisieren">↻</button></header>
  <main>${body}</main>
  <nav class="tabs">
    <a href="#/" class="${tab === 'mine' ? 'on' : ''}"><span>🎁</span>Meine Wünsche</a>
    <a href="#/gruppen" class="${tab === 'groups' ? 'on' : ''}"><span>👥</span>Gruppen</a>
    <a href="#/mehr" class="${tab === 'more' ? 'on' : ''}"><span>⚙︎</span>Mehr</a>
  </nav>`;
}

function viewLogin() {
  const invited = S.pendingJoin ? '<p class="note">Du wurdest in eine Gruppe eingeladen. Melde dich an, dann trittst du automatisch bei.</p>' : '';
  if (S.loginSent && S.loginEmail) {
    return `<main class="login">
      <div class="logo">🎁</div><h1>Geschenkeliste</h1>${invited}
      <p>Wir haben dir eine Mail an <b>${esc(S.loginEmail)}</b> geschickt. Gib den Code aus der Mail ein.</p>
      <form data-form="verify">
        <input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*" maxlength="12" placeholder="Code" required autofocus>
        <button class="primary" type="submit">Anmelden</button>
      </form>
      <p class="muted small">Keine Mail? Schau im Spam-Ordner nach. Der Code gilt etwa eine Stunde.</p>
      <div class="row"><button class="link" data-act="resend">Code erneut senden</button><button class="link" data-act="otheremail">Andere Adresse</button></div>
    </main>`;
  }
  return `<main class="login">
    <div class="logo">🎁</div><h1>Geschenkeliste</h1>
    <p class="muted">Wunschlisten für Familie und Freunde. Was reserviert ist, sieht der Beschenkte nie.</p>${invited}
    <form data-form="login">
      <input name="email" type="email" autocomplete="email" placeholder="Deine Mail-Adresse" required value="${esc(S.loginEmail || '')}">
      <button class="primary" type="submit">Code per Mail schicken</button>
    </form>
    <p class="muted small">Kein Passwort nötig: Du bekommst einen Code per Mail.</p>
  </main>`;
}

function viewName() {
  return `<main class="login">
    <div class="logo">👋</div><h1>Wie heißt du?</h1>
    <p class="muted">So sehen dich die anderen in deinen Gruppen.</p>
    <form data-form="name">
      <input name="name" maxlength="40" placeholder="Vorname" required autofocus autocomplete="given-name">
      <button class="primary" type="submit">Weiter</button>
    </form>
  </main>`;
}

function visLabel(w) {
  if (w.all_groups) return 'Alle Gruppen';
  const names = groupIdsOf(w.id).map(g => (D.groups.find(x => x.id === g) || {}).name).filter(Boolean);
  return names.length ? names.join(', ') : 'Für niemanden sichtbar';
}

function wishBody(w) {
  const link = w.url ? `<a class="link-out" href="${esc(w.url)}" target="_blank" rel="noopener noreferrer">${esc(domain(w.url) || 'Link')} ↗</a>` : '';
  const note = w.note ? `<p class="wnote">${esc(w.note)}</p>` : '';
  return `<h3>${esc(w.title)}</h3>${note}${link}`;
}

function viewMine() {
  const list = wishesOf(me());
  const items = list.map(w => `
    <li class="card wish">
      <a class="cover" href="#/w/${w.id}" aria-label="Bearbeiten"></a>
      ${wishBody(w)}
      <p class="chips"><span class="chip">${esc(visLabel(w))}</span></p>
    </li>`).join('');
  const empty = `<div class="empty"><p>Noch keine Wünsche.</p><p class="muted">Lege los mit „+ Wunsch“.</p></div>`;
  const noGroup = myGroups().length ? '' : `<p class="note">Du bist noch in keiner Gruppe. <a href="#/gruppen">Gruppe anlegen oder beitreten</a>, damit andere deine Wünsche sehen.</p>`;
  return shell('Meine Wünsche', `
    ${noGroup}
    <a class="primary block" href="#/w/neu">+ Wunsch</a>
    <ul class="list">${items || ''}</ul>${list.length ? '' : empty}
    <p class="muted small center">Ob etwas reserviert ist, siehst du nicht – die Überraschung bleibt.</p>`, { tab: 'mine' });
}

function viewWishForm(id) {
  const w = id === 'neu' ? { title: '', url: '', note: '', all_groups: true } : D.wishes.find(x => x.id === id && x.owner === me());
  if (!w) return shell('Wunsch', '<div class="empty"><p>Wunsch nicht gefunden.</p></div>', { tab: 'mine', back: '#/' });
  const gs = myGroups();
  const sel = id === 'neu' ? [] : groupIdsOf(id);
  const boxes = gs.map(g => `<label class="check"><input type="checkbox" name="g" value="${g.id}" ${sel.includes(g.id) ? 'checked' : ''}> ${esc(g.name)}</label>`).join('');
  const vis = gs.length ? `
    <fieldset><legend>Wer sieht den Wunsch?</legend>
      <label class="check"><input type="radio" name="vis" value="all" ${w.all_groups ? 'checked' : ''}> Alle meine Gruppen</label>
      <label class="check"><input type="radio" name="vis" value="some" ${w.all_groups ? '' : 'checked'}> Nur ausgewählte Gruppen</label>
      <div class="sub ${w.all_groups ? 'hide' : ''}" id="gsel">${boxes}</div>
    </fieldset>` : '<p class="note">Sichtbar für alle Gruppen, denen du beitrittst.</p>';
  const del = id === 'neu' ? '' : (ui.confirmDel === id
    ? `<button type="button" class="danger" data-act="delwish" data-id="${id}">Wirklich löschen</button>`
    : `<button type="button" class="ghost" data-act="askdel" data-id="${id}">Löschen</button>`);
  return shell(id === 'neu' ? 'Neuer Wunsch' : 'Wunsch bearbeiten', `
    <form data-form="wish" data-id="${id}" class="stack">
      <label>Was wünschst du dir?<input name="title" maxlength="120" required value="${esc(w.title)}" placeholder="z. B. Kochbuch „Simple“"></label>
      <label>Link (optional)<input name="url" inputmode="url" autocomplete="off" value="${esc(w.url || '')}" placeholder="https://…"></label>
      <label>Notiz (optional)<textarea name="note" maxlength="1000" rows="3" placeholder="Größe, Farbe, Alternativen …">${esc(w.note || '')}</textarea></label>
      ${vis}
      <button class="primary" type="submit">Speichern</button>
      ${del}
    </form>`, { tab: 'mine', back: '#/' });
}

function viewGroups() {
  const gs = myGroups();
  const items = gs.map(g => {
    const n = membersOf(g.id).length;
    return `<li class="card"><a class="cover" href="#/g/${g.id}" aria-label="${esc(g.name)} öffnen"></a>
      <h3>${esc(g.name)}</h3><p class="muted small">${n} ${n === 1 ? 'Mitglied' : 'Mitglieder'}</p></li>`;
  }).join('');
  const forms = `
    <div class="card">
      <form data-form="newgroup" class="inline"><input name="name" maxlength="40" placeholder="Neue Gruppe, z. B. Familie" required><button class="primary" type="submit">Anlegen</button></form>
    </div>
    <div class="card">
      <form data-form="join" class="inline"><input name="code" maxlength="12" placeholder="Code einer Gruppe" autocapitalize="characters" autocomplete="off" required><button type="submit">Beitreten</button></form>
    </div>`;
  return shell('Gruppen', `
    <ul class="list">${items}</ul>
    ${gs.length ? '' : '<div class="empty"><p>Noch in keiner Gruppe.</p><p class="muted">Lege eine an und lade andere ein, oder tritt mit einem Code bei.</p></div>'}
    ${forms}`, { tab: 'groups' });
}

function viewGroup(gid) {
  const g = myGroups().find(x => x.id === gid);
  if (!g) return shell('Gruppe', '<div class="empty"><p>Diese Gruppe gibt es nicht (mehr).</p></div>', { tab: 'groups', back: '#/gruppen' });
  const ms = membersOf(gid).slice().sort((a, b) => (a.user_id === me()) - (b.user_id === me()) || nameOf(a.user_id).localeCompare(nameOf(b.user_id), 'de'));
  const rows = ms.map(m => {
    const ws = wishesOf(m.user_id, gid);
    if (m.user_id === me()) {
      return `<li class="card person self"><a class="cover" href="#/" aria-label="Meine Wünsche"></a>
        <h3>Du</h3><p class="muted small">${ws.length} ${ws.length === 1 ? 'Wunsch' : 'Wünsche'} für diese Gruppe sichtbar</p></li>`;
    }
    const taken = ws.filter(w => resOf(w.id)).length;
    return `<li class="card person"><a class="cover" href="#/g/${gid}/p/${m.user_id}" aria-label="${esc(nameOf(m.user_id))}"></a>
      <h3>${esc(nameOf(m.user_id))}</h3>
      <p class="muted small">${ws.length} ${ws.length === 1 ? 'Wunsch' : 'Wünsche'}${taken ? ` · ${taken} vergeben` : ''}</p></li>`;
  }).join('');
  const manage = ui.manage === gid ? `
    <div class="card stack">
      <form data-form="rename" data-id="${gid}" class="inline"><input name="name" maxlength="40" value="${esc(g.name)}" required><button type="submit">Umbenennen</button></form>
      ${ui.confirmLeave === gid
        ? `<button class="danger" data-act="leave" data-id="${gid}">Wirklich verlassen</button>`
        : `<button class="ghost" data-act="askleave" data-id="${gid}">Gruppe verlassen</button>`}
      <p class="muted small">Wer die Gruppe verlässt, sieht ihre Listen nicht mehr. Deine Wünsche sind dort dann nicht mehr sichtbar.</p>
    </div>` : `<button class="link center-btn" data-act="manage" data-id="${gid}">Gruppe verwalten</button>`;
  return shell(g.name, `
    <div class="card invite">
      <p class="muted small">Einladungs-Code</p>
      <p class="code" id="gcode">${esc(fmtCode(g.code))}</p>
      <button class="primary" data-act="invite" data-id="${gid}">Einladen</button>
    </div>
    <h2>Mitglieder</h2>
    <ul class="list">${rows}</ul>
    ${manage}`, { tab: 'groups', back: '#/gruppen' });
}

function viewPerson(gid, uid) {
  const g = myGroups().find(x => x.id === gid);
  if (!g || !membersOf(gid).some(m => m.user_id === uid) || uid === me()) {
    return shell('Liste', '<div class="empty"><p>Diese Liste ist nicht verfügbar.</p></div>', { tab: 'groups', back: '#/g/' + gid });
  }
  const name = nameOf(uid);
  const ws = wishesOf(uid, gid);
  const items = ws.map(w => {
    const r = resOf(w.id);
    let status, acts;
    if (!r) {
      status = '';
      acts = `<button class="primary" data-act="reserve" data-id="${w.id}">Reservieren</button>`;
    } else if (r.user_id === me()) {
      status = r.status === 'gekauft' ? '<p class="status mine">✓ Von dir gekauft</p>' : '<p class="status mine">Von dir reserviert</p>';
      acts = (r.status === 'gekauft'
        ? `<button data-act="resstatus" data-id="${w.id}" data-s="reserviert">Doch nicht gekauft</button>`
        : `<button class="primary" data-act="resstatus" data-id="${w.id}" data-s="gekauft">Als gekauft markieren</button>`)
        + `<button class="ghost" data-act="unreserve" data-id="${w.id}">Freigeben</button>`;
    } else {
      status = `<p class="status other">${r.status === 'gekauft' ? 'Gekauft' : 'Reserviert'} von ${esc(nameOf(r.user_id))}</p>`;
      acts = '';
    }
    return `<li class="card wish ${r ? 'taken' : ''}">${wishBody(w)}${status}${acts ? `<div class="row">${acts}</div>` : ''}</li>`;
  }).join('');
  return shell(genitive(name) + ' Wünsche', `
    <p class="note">${esc(name)} sieht nicht, was reserviert oder gekauft ist.</p>
    <ul class="list">${items}</ul>
    ${ws.length ? '' : `<div class="empty"><p>${esc(name)} hat für diese Gruppe noch keine Wünsche.</p></div>`}`,
  { tab: 'groups', back: '#/g/' + gid });
}

function viewMore() {
  const p = D.profiles.find(x => x.id === me()) || {};
  return shell('Mehr', `
    <div class="card stack">
      <form data-form="name" class="inline"><input name="name" maxlength="40" value="${esc(p.name || '')}" required><button type="submit">Name ändern</button></form>
      <p class="muted small">Angemeldet als ${esc(S.session.user.email || '')}</p>
      <button class="ghost" data-act="logout">Abmelden</button>
    </div>
    <div class="card">
      <h3>Datenschutz in Kürze</h3>
      <p class="small">Dein Name, deine Mail-Adresse, Gruppen, Wünsche und Reservierungen liegen in einer Supabase-Datenbank in der EU. Andere sehen nur deinen Namen und die Wünsche, die du für ihre Gruppe freigibst. Reservierungen sieht der Beschenkte nie. Auf dem Gerät bleibt nur die Anmeldung und eine Kopie der Listen für den schnellen Start.</p>
    </div>
    <p class="muted small center">Geschenkeliste ${VERSION}</p>`, { tab: 'more' });
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
  if (D.loaded && (!prof || !prof.name)) { app.innerHTML = viewName(); return; }
  if (!D.loaded) { app.innerHTML = '<p class="boot">Lädt …</p>'; return; }
  let html;
  if (parts[0] === 'w' && parts[1]) html = viewWishForm(parts[1]);
  else if (parts[0] === 'gruppen') html = viewGroups();
  else if (parts[0] === 'g' && parts[1] && parts[2] === 'p' && parts[3]) html = viewPerson(parts[1], parts[3]);
  else if (parts[0] === 'g' && parts[1]) html = viewGroup(parts[1]);
  else if (parts[0] === 'mehr') html = viewMore();
  else html = viewMine();
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
  async login(f) {
    const email = f.email.value.trim().toLowerCase();
    await sb('/auth/v1/otp?redirect_to=' + encodeURIComponent(location.origin + location.pathname), { method: 'POST', auth: false, body: { email, create_user: true } });
    S.loginEmail = email;
    S.loginSent = Date.now();
    saveState();
    render();
  },
  async verify(f) {
    const token = f.code.value.replace(/\D/g, '');
    if (token.length < 6) throw new Error('Der Code hat mindestens 6 Ziffern.');
    let j;
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
    go('#/');
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
    go('#/');
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
