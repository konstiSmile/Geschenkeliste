# Geschenkeliste – Übergabe (Stand 20.11.2026, Version 1.15)

**Projekt-Übergabe:** Doc „Übergabe 5 – Geschenkeliste“ im Projekt (Thema 5, Chats heißen „5.<Nr> …“, letzter Chat 5.22). Startsatz: „Thema 5 (Geschenkeliste), Chat 5.<Nr>. Weiter laut ‚Übergabe 5 – Geschenkeliste‘. Nächster Schritt: …“

## ZUERST (Wunsch des Nutzers)
Bevor etwas besprochen oder gebaut wird: To-do-Liste aus „Offen beim Nutzer“ als kurze nummerierte Liste zum Abhaken geben, warten, kurz nachfragen, ob etwas aufgefallen ist. Repo erst danach klonen.

## Stand
- Version **1.15** (Anlässe, Geburtstage, Schenklisten, neues App-Symbol) gepusht, Cache `geschenkeliste-v24`, `?v=24`.
- Tests: 433 RLS, 320 Playwright, 14 Edge Function, 9 Service Worker, alle grün.
- App: https://konstismile.github.io/Geschenkeliste/ (Claude kann github.io nicht abrufen).

## Offen beim Nutzer (To-do-Liste)
1. Aktuelle `supabase/schema.sql` im Supabase SQL-Editor komplett ausführen.
2. App neu laden, unter Konto prüfen: Version 1.15.
3. Eine Gruppe öffnen → Verwalten → Anlass prüfen (bestehende Gruppen sind Weihnachten).
4. Unter Konto den eigenen Geburtstag eintragen.
5. Neues Symbol aufs iPhone: App vom Home-Bildschirm löschen und in Safari neu „Zum Home-Bildschirm“ hinzufügen (Anmeldung danach mit Benutzername).

## Nächster Schritt
Paket 9b (1.16) Geburtstagsgruppe für jemanden, Entscheidungen in `docs/fahrplan.md`. Danach: Überblick über alle offenen Ideen für den Nutzer, dann Paket „Einfach bedienen“ (Nutzer über 60).

## So arbeiten (sparsam)
- Technik in `docs/technik.md` (nur passende Abschnitte lesen, `grep -n "^## "`), Planung in `docs/fahrplan.md`, Design in `docs/design-pop.md`.
- Repo: `add_repo` (owner `konstiSmile`, repo `Geschenkeliste`, access `push`), `git clone --depth 1 https://github.com/konstiSmile/geschenkeliste /home/claude/geschenkeliste`, pushen mit `git -c push.negotiate=true push origin HEAD:main`.
- Vor dem Push alle vier Tests komplett. Nach jedem Paket: diese Datei neu, Abschnitt in `technik.md`, Haken in `fahrplan.md`, Projekt-Doc „Übergabe 5 – Geschenkeliste“ ersetzen.
