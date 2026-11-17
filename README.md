# Geschenkeliste

Wunschlisten für Familie und Freunde als Web-App (PWA). Konten ohne Mail (Benutzername, Passwort,
Wiederherstellungscode, Rücksetzen durch Admin). Gruppen mit Einladungs-Code,
eine Wunschliste pro Person mit Freigabe pro Gruppe, Reservieren und „gekauft“ –
unsichtbar für den Wünschenden (abgesichert in der Datenbank per Row Level Security).

- App: `index.html`, `app.js`, `app.css`, `sw.js`, `manifest.webmanifest`, `icons/`
- Datenbank: `supabase/schema.sql` (im Supabase SQL Editor ausführen, mehrfach ausführbar)
- Tests: `tests/test_rls.py` (Zugriffsregeln gegen lokales Postgres),
  `tests/test_app.py` (Playwright, mehrere Nutzer und Geräte gegen eine Supabase-Attrappe)

Bei jeder Änderung: `VERSION` in `app.js`, `?v=` in `index.html` und `sw.js`, `CACHE` in `sw.js` erhöhen.
Der Publishable key in `app.js` ist öffentlich. Secret key und Datenbank-Passwort gehören nie ins Repo.

Admin eintragen (nur im Supabase SQL Editor):
`insert into public.app_admins select user_id from public.accounts where username = 'konsti';`
