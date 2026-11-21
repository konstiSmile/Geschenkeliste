# Geschenkeliste – Übergabe (Stand 21.11.2026, Version 1.20)

**Projekt-Übergabe:** Doc „Übergabe 5 – Geschenkeliste“ im Projekt (Thema 5, Chats heißen „5.<Nr> …“, letzter Chat 5.27). Startsatz: „Thema 5 (Geschenkeliste), Chat 5.<Nr>. Weiter laut ‚Übergabe 5 – Geschenkeliste‘. Nächster Schritt: …“

## ZUERST (Wunsch des Nutzers)
Bevor etwas besprochen oder gebaut wird: To-do-Liste aus „Offen beim Nutzer“ als kurze nummerierte Liste zum Abhaken geben, warten, kurz nachfragen, ob etwas aufgefallen ist. Repo erst danach klonen.

## Stand
- Version **1.20 Gemeinsam ohne Wunsch** gepusht (Commit `a9d07b4`), Cache `geschenkeliste-v30`, `?v=30` (Symbole `?v=24`). **schema.sql geändert**, Edge Function unverändert.
- Tests: 596 RLS, 415 Playwright, 14 Edge Function, 9 Service Worker, alle grün.
- 1.19 beim Nutzer eingerichtet und geprüft (21.11.). Supabase-Limit anonyme Anmeldungen: 15 pro Stunde (Nutzerwahl).
- App: https://konstismile.github.io/Geschenkeliste/ (Claude kann github.io nicht abrufen).

## Offen beim Nutzer
1. schema.sql im Supabase SQL Editor ausführen: https://raw.githubusercontent.com/konstiSmile/Geschenkeliste/main/supabase/schema.sql
2. App neu laden, Konto → Weitere Einstellungen ganz unten: Version 1.20.
3. Liste einer Person öffnen, ganz unten „Gemeinsam etwas anderes schenken“ ausprobieren.
4. Eine eigene Idee öffnen: „Mit anderen zusammenlegen“.
5. Anleitung (Claude Doc): Vorschlag „Neu mit Version 1.20“ annehmen.

## Nächster Schritt
Anlass beim Anlegen einer Idee wählen, danach Push bei neuen Ideen in Geburtstagsgruppen (siehe `docs/fahrplan.md`). Offene Frage an den Nutzer: Grenze 5 gesicherte Konten pro Anschluss/Stunde auf 10?

## So arbeiten (sparsam)
- Technik in `docs/technik.md` (nur passende Abschnitte lesen, `grep -n "^## "`), Planung in `docs/fahrplan.md`, Design in `docs/design-pop.md`.
- Repo: `add_repo` (owner `konstiSmile`, repo `Geschenkeliste`, access `push`), `git clone --depth 1 https://github.com/konstiSmile/geschenkeliste /home/claude/geschenkeliste`, pushen mit `git -c push.negotiate=true push origin HEAD:main`.
- Vor dem Push alle vier Tests komplett. Nach jedem Paket: diese Datei neu, Abschnitt in `technik.md`, Haken in `fahrplan.md`, Projekt-Doc „Übergabe 5 – Geschenkeliste“ ersetzen.
