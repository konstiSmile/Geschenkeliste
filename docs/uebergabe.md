# Geschenkeliste – Übergabe (Stand 20.11.2026, Version 1.18)

**Projekt-Übergabe:** Doc „Übergabe 5 – Geschenkeliste“ im Projekt (Thema 5, Chats heißen „5.<Nr> …“, letzter Chat 5.25). Startsatz: „Thema 5 (Geschenkeliste), Chat 5.<Nr>. Weiter laut ‚Übergabe 5 – Geschenkeliste‘. Nächster Schritt: …“

## ZUERST (Wunsch des Nutzers)
Bevor etwas besprochen oder gebaut wird: To-do-Liste aus „Offen beim Nutzer“ als kurze nummerierte Liste zum Abhaken geben, warten, kurz nachfragen, ob etwas aufgefallen ist. Repo erst danach klonen.

## Stand
- Version **1.18 Feinschliff** gepusht (Commit `58f96f7`), Cache `geschenkeliste-v28`, `?v=28` (Symbole `?v=24`). **schema.sql geändert.**
- Tests: 523 RLS, 388 Playwright, 14 Edge Function, 9 Service Worker, alle grün.
- App: https://konstismile.github.io/Geschenkeliste/ (Claude kann github.io nicht abrufen).

## Offen beim Nutzer (To-do-Liste)
1. schema.sql im Supabase SQL-Editor ausführen (Rohlink: https://raw.githubusercontent.com/konstiSmile/Geschenkeliste/main/supabase/schema.sql).
2. App neu laden, unter Konto → Weitere Einstellungen ganz unten: Version 1.18.
3. Unter Konto die Karte „So finden dich Freunde“ ansehen.
4. Bei einem Wunsch unter „Mehr Angaben“ eine Größe eintragen.
5. Eine Idee für jemanden mit App öffnen, „Passt zu einem Wunsch“ antippen und einen Wunsch wählen.
6. Bei einer Person ohne App den Steckbrief ausfüllen.
7. Gesehen auf zwei Geräten: auf dem einen neue Wünsche ansehen, auf dem anderen sind sie danach nicht mehr neu.
8. In der Anleitung (Claude Doc) den Vorschlag „Neu mit Version 1.18“ annehmen (dazu die offenen 1.16/1.17, falls noch nicht).

## Nächster Schritt
Paket 13 „Öffnen für Freunde“ (siehe `docs/fahrplan.md`, Abschnitt „Als Nächstes“). Vorher mit dem Nutzer klären: Captcha ja/nein, Admin-Reset für Fremde, echte Mail ja/nein.

## So arbeiten (sparsam)
- Technik in `docs/technik.md` (nur passende Abschnitte lesen, `grep -n "^## "`), Planung in `docs/fahrplan.md`, Design in `docs/design-pop.md`.
- Repo: `add_repo` (owner `konstiSmile`, repo `Geschenkeliste`, access `push`), `git clone --depth 1 https://github.com/konstiSmile/geschenkeliste /home/claude/geschenkeliste`, pushen mit `git -c push.negotiate=true push origin HEAD:main`.
- Vor dem Push alle vier Tests komplett. Nach jedem Paket: diese Datei neu, Abschnitt in `technik.md`, Haken in `fahrplan.md`, Projekt-Doc „Übergabe 5 – Geschenkeliste“ ersetzen.
