# Geschenkeliste – Übergabe (Stand 20.11.2026, Version 1.19)

**Projekt-Übergabe:** Doc „Übergabe 5 – Geschenkeliste“ im Projekt (Thema 5, Chats heißen „5.<Nr> …“, letzter Chat 5.26). Startsatz: „Thema 5 (Geschenkeliste), Chat 5.<Nr>. Weiter laut ‚Übergabe 5 – Geschenkeliste‘. Nächster Schritt: …“

## ZUERST (Wunsch des Nutzers)
Bevor etwas besprochen oder gebaut wird: To-do-Liste aus „Offen beim Nutzer“ als kurze nummerierte Liste zum Abhaken geben, warten, kurz nachfragen, ob etwas aufgefallen ist. Repo erst danach klonen.

## Stand
- Version **1.19 Öffnen für Freunde** gepusht (Commit `a2df016`), Cache `geschenkeliste-v29`, `?v=29` (Symbole `?v=24`). **schema.sql geändert**, Edge Function unverändert.
- Tests: 552 RLS, 394 Playwright, 14 Edge Function, 9 Service Worker, alle grün.
- App: https://konstismile.github.io/Geschenkeliste/ (Claude kann github.io nicht abrufen).

## Offen beim Nutzer
1. schema.sql im Supabase SQL Editor ausführen: https://raw.githubusercontent.com/konstiSmile/Geschenkeliste/main/supabase/schema.sql
2. Supabase → Authentication → Rate Limits: anonyme Anmeldungen pro Stunde von 30 auf 10.
3. App neu laden, Konto → Weitere Einstellungen ganz unten: Version 1.19.
4. Konto → Weitere Einstellungen → Anmeldung: Benutzername ändern ausprobieren (danach 30 Tage gesperrt, also bewusst wählen).
5. Eine Freundschaftsanfrage ablehnen und „Rückgängig“ antippen.
6. Anleitung (Claude Doc): Vorschlag „Neu mit Version 1.19“ annehmen.

## Nächster Schritt
Gemeinsam schenken ohne Wunsch bzw. Idee → gemeinsames Geschenk; Anlass beim Anlegen einer Idee wählen; Push bei neuen Ideen in Geburtstagsgruppen (siehe `docs/fahrplan.md`).

## So arbeiten (sparsam)
- Technik in `docs/technik.md` (nur passende Abschnitte lesen, `grep -n "^## "`), Planung in `docs/fahrplan.md`, Design in `docs/design-pop.md`.
- Repo: `add_repo` (owner `konstiSmile`, repo `Geschenkeliste`, access `push`), `git clone --depth 1 https://github.com/konstiSmile/geschenkeliste /home/claude/geschenkeliste`, pushen mit `git -c push.negotiate=true push origin HEAD:main`.
- Vor dem Push alle vier Tests komplett. Nach jedem Paket: diese Datei neu, Abschnitt in `technik.md`, Haken in `fahrplan.md`, Projekt-Doc „Übergabe 5 – Geschenkeliste“ ersetzen.
