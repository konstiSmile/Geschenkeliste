# Geschenkeliste

Wunschlisten für Familie und Freunde als Web-App (PWA). Gruppen mit Einladungs-Code,
eine Wunschliste pro Person mit Freigabe pro Gruppe, Reservieren und „gekauft“ –
unsichtbar für den Wünschenden (abgesichert in der Datenbank per Row Level Security).

- App: `index.html`, `app.js`, `app.css`, `sw.js`, `manifest.webmanifest`, `icons/`
- Datenbank: `supabase/schema.sql` (im Supabase SQL Editor ausführen, mehrfach ausführbar)
- Tests: `tests/test_rls.py` (Zugriffsregeln gegen lokales Postgres),
  `tests/test_app.py` (Playwright, zwei bis drei Nutzer gegen eine Supabase-Attrappe)

Bei jeder Änderung: `VERSION` in `app.js`, `?v=` in `index.html` und `sw.js`, `CACHE` in `sw.js` erhöhen.
Der Publishable key in `app.js` ist öffentlich. Secret key und Datenbank-Passwort gehören nie ins Repo.
