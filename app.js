'use strict';
/* Geschenkeliste – Wunschlisten für Familie und Freunde.
   Ohne Bibliotheken: spricht direkt mit Supabase (Auth + REST). */

const VERSION = '1.3';
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


/* ---------- Illustrationen (flach, leicht animiert) ---------- */
const ART = {
  gift: `<svg class="art art-gift" viewBox="0 0 160 150" aria-hidden="true">
    <ellipse cx="80" cy="142" rx="54" ry="6" fill="#1A2821" opacity=".12"/>
    <path class="spark s1" d="M26 22 L29 30 L37 33 L29 36 L26 44 L23 36 L15 33 L23 30 Z" fill="#B27F49"/>
    <path class="spark s2" d="M134 14 L136 19 L141 21 L136 23 L134 28 L132 23 L127 21 L132 19 Z" fill="#B27F49"/>
    <path class="spark s3" d="M144 62 L146 67 L151 69 L146 71 L144 76 L142 71 L137 69 L142 67 Z" fill="#28604C"/>
    <rect x="34" y="74" width="92" height="64" rx="8" fill="#A0061B"/>
    <rect x="34" y="74" width="40" height="64" rx="8" fill="#B5203A"/>
    <rect x="72" y="74" width="16" height="64" fill="#B27F49"/>
    <g class="lid">
      <path d="M80 60 C66 34 42 38 50 52 C56 61 70 60 80 60 Z" fill="#B27F49"/>
      <path d="M80 60 C94 34 118 38 110 52 C104 61 90 60 80 60 Z" fill="#9A6A3A"/>
      <rect x="28" y="58" width="104" height="22" rx="6" fill="#7E0516"/>
      <rect x="72" y="58" width="16" height="22" fill="#C9965F"/>
      <circle cx="80" cy="58" r="7" fill="#C9965F"/>
    </g>
  </svg>`,
  letter: `<svg class="art art-letter" viewBox="0 0 160 130" aria-hidden="true">
    <ellipse cx="80" cy="122" rx="56" ry="5" fill="#1A2821" opacity=".12"/>
    <path d="M24 52 L80 16 L136 52 V112 H24 Z" fill="#7E0516"/>
    <g class="sheet">
      <rect x="38" y="30" width="84" height="68" rx="5" fill="#FBF4E8"/>
      <path d="M80 66 C68 58 64 52 68 47 C72 42 78 44 80 48 C82 44 88 42 92 47 C96 52 92 58 80 66 Z" fill="#C9536A"/>
    </g>
    <path d="M24 52 L80 88 L136 52 V110 Q136 116 130 116 H30 Q24 116 24 110 Z" fill="#A0061B"/>
    <path d="M24 114 L68 80 M136 114 L92 80" stroke="#7E0516" stroke-width="2" fill="none"/>
  </svg>`,
  bauble: `<svg class="art art-bauble" viewBox="0 0 140 160" aria-hidden="true">
    <path d="M6 14 Q40 2 70 10 Q100 2 134 14" stroke="#28604C" stroke-width="7" fill="none" stroke-linecap="round"/>
    <path d="M22 9 l-6 -8 M40 6 l-2 -9 M100 6 l2 -9 M118 9 l6 -8 M30 12 l-5 9 M110 12 l5 9" stroke="#3E5647" stroke-width="3" stroke-linecap="round"/>
    <circle cx="60" cy="14" r="4" fill="#A0061B"/><circle cx="68" cy="18" r="4" fill="#A0061B"/>
    <g class="swing">
      <line x1="70" y1="12" x2="70" y2="44" stroke="#B27F49" stroke-width="2"/>
      <rect x="61" y="42" width="18" height="11" rx="2.5" fill="#B27F49"/>
      <circle cx="70" cy="94" r="40" fill="#A0061B"/>
      <path d="M32 86 Q70 104 108 86" stroke="#B27F49" stroke-width="3.5" fill="none"/>
      <path d="M33 104 Q70 122 107 104" stroke="#B27F49" stroke-width="2" fill="none" stroke-dasharray="2 6" stroke-linecap="round"/>
      <ellipse cx="54" cy="76" rx="8" ry="13" fill="#FFFFFF" opacity=".22" transform="rotate(35 54 76)"/>
    </g>
  </svg>`
};
const ICON = {
  gift: '<svg class="ti" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11h16v9H4zM3 7.5h18V11H3zM12 7.5V20M12 7.5C10 4 6.5 3.5 6.5 5.6S10 7.5 12 7.5zm0 0c2-3.5 5.5-4 5.5-1.9S14 7.5 12 7.5z"/></svg>',
  people: '<svg class="ti" viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.4"/><path d="M2.6 20c.8-3.9 3.3-6 6.4-6s5.6 2.1 6.4 6"/><circle cx="17" cy="9" r="2.5"/><path d="M16.3 14c2.7 0 4.6 1.8 5.3 5"/></svg>',
  more: '<svg class="ti" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/></svg>'
};

/* ---------- Ansichten ---------- */
function shell(title, body, opt = {}) {
  const tab = opt.tab || '';
  const back = opt.back ? `<a class="back" href="${opt.back}" aria-label="Zurück">‹</a>` : '';
  return `
  <header class="top">${back}<h1 class="display">${esc(title)}</h1>
    <button class="icon" data-act="sync" aria-label="Aktualisieren" title="Aktualisieren">↻</button></header>
  <main>${body}</main>
  <nav class="tabs">
    <a href="#/" class="${tab === 'mine' ? 'on' : ''}">${ICON.gift}Meine Wünsche</a>
    <a href="#/gruppen" class="${tab === 'groups' ? 'on' : ''}">${ICON.people}Gruppen</a>
    <a href="#/mehr" class="${tab === 'more' ? 'on' : ''}">${ICON.more}Mehr</a>
  </nav>`;
}

function viewLogin() {
  const invited = S.pendingJoin ? '<p class="note">Du wurdest in eine Gruppe eingeladen. Nach dem Start bist du automatisch drin.</p>' : '';
  if (S.loginSent && S.loginEmail) {
    return `<main class="login">
      ${ART.gift}<h1 class="display hero">Geschenke-<br>liste</h1>${invited}
      <p>Wir haben dir eine Mail an <b>${esc(S.loginEmail)}</b> geschickt.</p>
      <p class="small">Darin ist ein Link: <b>lang drücken → „Link kopieren“</b>, dann hier einfügen. Steht ein Code in der Mail, kannst du auch den eintippen.</p>
      <form data-form="verify">
        <input name="code" autocomplete="one-time-code" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Link oder Code" required autofocus>
        <button class="primary" type="submit">Anmelden</button>
      </form>
      <button class="link" data-act="pastelink">Kopierten Link einfügen</button>
      <p class="muted small">Keine Mail? Schau im Spam-Ordner nach. Der Link gilt etwa eine Stunde.</p>
      <div class="row"><button class="link" data-act="resend">Erneut senden</button><button class="link" data-act="otheremail">Zurück</button></div>
    </main>`;
  }
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) && !navigator.standalone;
  const tip = ios ? '<p class="note">Tipp: Erst <b>Teilen → Zum Home-Bildschirm</b>, dann die App von dort starten. Safari und Home-Bildschirm sind auf dem iPhone getrennt – sonst hast du zwei Konten.</p>' : '';
  return `<main class="login">
    ${ART.gift}<h1 class="display hero">Geschenke-<br>liste</h1>
    <p class="muted">Wunschlisten für Familie und Freunde. Was reserviert ist, sieht der Beschenkte nie.</p>${invited}${tip}
    <form data-form="start">
      <input name="name" maxlength="40" placeholder="Dein Vorname" required autocomplete="given-name" value="${esc(S.pendingName || '')}">
      <button class="primary" type="submit">Los geht’s</button>
    </form>
    <div class="card mailcard">
      <h3>Mit E-Mail (empfohlen)</h3>
      <p class="small">Mit deiner Mail-Adresse kommst du jederzeit wieder an deine Liste und deine Reservierungen: auf einem neuen Handy, einem zweiten Gerät oder nach dem Löschen der Browserdaten. Ohne Mail hängt alles an diesem einen Gerät. Du bekommst nur Anmelde-Mails, keine Werbung.</p>
      <form data-form="login">
        <input name="email" type="email" autocomplete="email" placeholder="Deine Mail-Adresse" required value="${esc(S.loginEmail || '')}">
        <button type="submit">Anmelde-Link schicken</button>
      </form>
      <p class="muted small">Schon ein Konto? Einfach hier deine Mail eingeben. Du kannst die Mail auch später in „Mehr“ ergänzen.</p>
    </div>
  </main>`;
}

function viewName() {
  return `<main class="login">
    ${ART.bauble}<h1 class="display hero">Wie heißt du?</h1>
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
  const empty = `<div class="empty">${ART.bauble}<p>Noch keine Wünsche.</p><p class="muted">Lege los mit „+ Wunsch“.</p></div>`;
  const unsafe = S.session.user.anon && list.length ? `<p class="note">Deine Liste hängt noch an diesem Gerät. <a href="#/mehr">Mail-Adresse ergänzen</a>, damit sie sicher ist.</p>` : '';
  const noGroup = myGroups().length ? unsafe : `<p class="note">Du bist noch in keiner Gruppe. <a href="#/gruppen">Gruppe anlegen oder beitreten</a>, damit andere deine Wünsche sehen.</p>`;
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
    ${gs.length ? '' : '<div class="empty">' + ART.letter + '<p>Noch in keiner Gruppe.</p><p class="muted">Lege eine an und lade andere ein, oder tritt mit einem Code bei.</p></div>'}
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

function secureCard() {
  if (S.secureSent) {
    return `<div class="card stack mailcard">
      <h3>Fast geschafft</h3>
      <p class="small">Wir haben eine Mail an <b>${esc(S.secureSent)}</b> geschickt. Tippe auf den Link darin (es darf sich Safari öffnen). Komm dann hierher zurück und tippe auf „Prüfen“.</p>
      <button class="primary" data-act="checkuser">Prüfen</button>
      <button class="link" data-act="securecancel">Andere Adresse</button>
    </div>`;
  }
  return `<div class="card stack mailcard">
    <h3>Konto sichern</h3>
    <p class="small">Du nutzt die App gerade ohne Mail-Adresse. Deine Liste hängt an diesem Gerät: Beim Handywechsel oder Löschen der Browserdaten ist sie weg. Mit deiner Mail kannst du dich überall wieder anmelden.</p>
    <form data-form="secure" class="inline"><input name="email" type="email" autocomplete="email" placeholder="Mail-Adresse" required><button type="submit">Sichern</button></form>
  </div>`;
}

function viewMore() {
  const p = D.profiles.find(x => x.id === me()) || {};
  return shell('Mehr', `
    <div class="card stack">
      <form data-form="name" class="inline"><input name="name" maxlength="40" value="${esc(p.name || '')}" required><button type="submit">Name ändern</button></form>
      ${S.session.user.anon ? '' : `<p class="muted small">Angemeldet als ${esc(S.session.user.email)}</p>`}
    </div>
    ${S.session.user.anon ? secureCard() : ''}
    <div class="card stack">
      ${S.session.user.anon && ui.confirmLogout
        ? `<p class="small">Ohne Mail-Adresse kommst du danach nicht mehr in dieses Konto zurück. Deine Liste wäre weg.</p><button class="danger" data-act="logout">Trotzdem abmelden</button>`
        : `<button class="ghost" data-act="${S.session.user.anon ? 'asklogout' : 'logout'}">Abmelden</button>`}
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
  if (D.loaded && (!prof || !prof.name)) { app.innerHTML = S.pendingName ? '<p class="boot">Lädt …</p>' : viewName(); return; }
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
