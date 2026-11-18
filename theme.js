// Geschenkeliste – Design (1.10, Hell/Dunkel seit 1.10.1)
// Läuft im <head> vor dem ersten Zeichnen, damit nichts aufblitzt.
// Thema in localStorage 'geschenkeliste-theme': jahr | weihnachten, fehlt = automatisch
//   (Weihnachten vom 1. November bis 6. Januar, sonst Ganzjährig).
// Hell/Dunkel in localStorage 'geschenkeliste-mode': light | dark, fehlt = wie das Gerät.
// Setzt <html data-theme="jahr|weihnachten" data-mode="light|dark">.
(function () {
  var KEY = 'geschenkeliste-theme';
  var MKEY = 'geschenkeliste-mode';
  var BAR = {
    jahr: { light: '#FFF9EC', dark: '#1E1B2E' },
    weihnachten: { light: '#FFF4EC', dark: '#0D1F17' }
  };
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function put(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) { /* egal */ } }
  function pref() { var v = get(KEY); return v === 'jahr' || v === 'weihnachten' ? v : 'auto'; }
  function modePref() { var v = get(MKEY); return v === 'light' || v === 'dark' ? v : 'auto'; }
  function season(d) {
    var m = d.getMonth();
    return m === 10 || m === 11 || (m === 0 && d.getDate() <= 6) ? 'weihnachten' : 'jahr';
  }
  function resolve(p) { p = p || pref(); return p === 'auto' ? season(new Date()) : p; }
  function mode() { var p = modePref(); return p === 'auto' ? (mq && mq.matches ? 'dark' : 'light') : p; }
  function apply() {
    var t = resolve(), m = mode();
    var root = document.documentElement;
    var changed = root.getAttribute('data-theme') !== t || root.getAttribute('data-mode') !== m;
    root.setAttribute('data-theme', t);
    root.setAttribute('data-mode', m);
    // Beide theme-color-Einträge auf die tatsächliche Farbe (auch wenn Hell/Dunkel fest gewählt ist)
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) metas[i].setAttribute('content', BAR[t][m]);
    // iPhone-App: dunkle Schrift im hellen Modus, weiße Schrift über dem dunklen Grund
    var sb = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
    if (sb) sb.setAttribute('content', m === 'dark' ? 'black-translucent' : 'default');
    return changed;
  }
  function set(p) { put(KEY, p === 'auto' ? null : p); return apply(); }
  function setMode(p) { put(MKEY, p === 'auto' ? null : p); return apply(); }
  window.GLTheme = { pref: pref, resolve: resolve, apply: apply, set: set, season: season, modePref: modePref, mode: mode, setMode: setMode };
  apply();
  // Gerät wechselt Hell/Dunkel (z. B. abends automatisch): nachziehen
  if (mq) {
    var onChange = function () { if (apply() && window.GLThemeChanged) window.GLThemeChanged(); };
    mq.addEventListener ? mq.addEventListener('change', onChange) : mq.addListener && mq.addListener(onChange);
  }
})();
