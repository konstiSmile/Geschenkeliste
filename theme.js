// Geschenkeliste – Design (1.10)
// Läuft im <head> vor dem ersten Zeichnen, damit nichts aufblitzt.
// Wahl in localStorage 'geschenkeliste-theme': auto | jahr | weihnachten.
// Automatisch: Weihnachten vom 1. November bis 6. Januar, sonst Ganzjährig.
(function () {
  var KEY = 'geschenkeliste-theme';
  var BAR = {
    jahr: { light: '#FFF9EC', dark: '#1E1B2E' },
    weihnachten: { light: '#FFF4EC', dark: '#2B1720' }
  };
  function pref() {
    try { var v = localStorage.getItem(KEY); return v === 'jahr' || v === 'weihnachten' ? v : 'auto'; } catch (e) { return 'auto'; }
  }
  function season(d) {
    var m = d.getMonth();
    return m === 10 || m === 11 || (m === 0 && d.getDate() <= 6) ? 'weihnachten' : 'jahr';
  }
  function resolve(p) { p = p || pref(); return p === 'auto' ? season(new Date()) : p; }
  function apply() {
    var t = resolve();
    var root = document.documentElement;
    var changed = root.getAttribute('data-theme') !== t;
    root.setAttribute('data-theme', t);
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) {
      var dark = /dark/.test(metas[i].getAttribute('media') || '');
      metas[i].setAttribute('content', BAR[t][dark ? 'dark' : 'light']);
    }
    // iPhone-App: helle Statusleiste im hellen Modus, sonst weiße Schrift über dem dunklen Grund
    var sb = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
    var darkNow = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (sb) sb.setAttribute('content', darkNow ? 'black-translucent' : 'default');
    return changed;
  }
  function set(p) {
    try { p === 'auto' ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, p); } catch (e) { /* egal */ }
    return apply();
  }
  window.GLTheme = { pref: pref, resolve: resolve, apply: apply, set: set, season: season };
  apply();
})();
