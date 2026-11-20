# Geschenkeliste – Übergabe (Stand 20.11.2026, Version 1.16)

**Projekt-Übergabe:** Doc „Übergabe 5 – Geschenkeliste“ im Projekt (Thema 5, Chats heißen „5.<Nr> …“, letzter Chat 5.23). Startsatz: „Thema 5 (Geschenkeliste), Chat 5.<Nr>. Weiter laut ‚Übergabe 5 – Geschenkeliste‘. Nächster Schritt: …“

## ZUERST (Wunsch des Nutzers)
Bevor etwas besprochen oder gebaut wird: To-do-Liste aus „Offen beim Nutzer“ als kurze nummerierte Liste zum Abhaken geben, warten, kurz nachfragen, ob etwas aufgefallen ist. Repo erst danach klonen.

## Stand
- Version **1.16** (Geburtstagsgruppen für jemanden, auch ohne App) gepusht, Commit `0f60ca4`, Cache `geschenkeliste-v25`, `?v=25`.
- Tests: 496 RLS, 338 Playwright, 14 Edge Function, 9 Service Worker, alle grün.
- App: https://konstismile.github.io/Geschenkeliste/ (Claude kann github.io nicht abrufen).

## Offen beim Nutzer (To-do-Liste)
1. Aktuelle `supabase/schema.sql` im Supabase SQL-Editor komplett ausführen: https://raw.githubusercontent.com/konstiSmile/Geschenkeliste/main/supabase/schema.sql (Rohlink immer mitgeben, Wunsch des Nutzers).
2. App neu laden, unter Konto prüfen: Version 1.16.
3. Geburtstagsgruppe ausprobieren: Gruppen → Freunde → Person öffnen → „Geburtstagsgruppe anlegen“.

## Nächster Schritt
Paket „Einfach bedienen“ (Nutzer über 60): ganze App durchgehen, Ergebnis als Auswahlliste vorlegen, dann bauen. Danach den Nutzer die übrigen Ideen sortieren lassen (Liste in `docs/fahrplan.md`).

## So arbeiten (sparsam)
- Technik in `docs/technik.md` (nur passende Abschnitte lesen, `grep -n "^## "`), Planung in `docs/fahrplan.md`, Design in `docs/design-pop.md`.
- Repo: `add_repo` (owner `konstiSmile`, repo `Geschenkeliste`, access `push`), `git clone --depth 1 https://github.com/konstiSmile/geschenkeliste /home/claude/geschenkeliste`, pushen mit `git -c push.negotiate=true push origin HEAD:main`.
- Vor dem Push alle vier Tests komplett. Nach jedem Paket: diese Datei neu, Abschnitt in `technik.md`, Haken in `fahrplan.md`, Projekt-Doc „Übergabe 5 – Geschenkeliste“ ersetzen.
