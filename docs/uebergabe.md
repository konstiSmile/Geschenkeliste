# Geschenkeliste – Übergabe (Stand 20.11.2026, Version 1.17)

**Projekt-Übergabe:** Doc „Übergabe 5 – Geschenkeliste“ im Projekt (Thema 5, Chats heißen „5.<Nr> …“, letzter Chat 5.24). Startsatz: „Thema 5 (Geschenkeliste), Chat 5.<Nr>. Weiter laut ‚Übergabe 5 – Geschenkeliste‘. Nächster Schritt: …“

## ZUERST (Wunsch des Nutzers)
Bevor etwas besprochen oder gebaut wird: To-do-Liste aus „Offen beim Nutzer“ als kurze nummerierte Liste zum Abhaken geben, warten, kurz nachfragen, ob etwas aufgefallen ist. Repo erst danach klonen.

## Stand
- Version **1.17** (Einfach bedienen) gepusht, Commit `5ba8114`, Cache `geschenkeliste-v26`, `?v=26` (Symbole `?v=24`). Keine schema.sql-Änderung.
- Tests: 496 RLS, 363 Playwright, 14 Edge Function, 9 Service Worker, alle grün.
- App: https://konstismile.github.io/Geschenkeliste/ (Claude kann github.io nicht abrufen).

## Offen beim Nutzer (To-do-Liste)
1. App neu laden, unter Konto → Weitere Einstellungen ganz unten prüfen: Version 1.17.
2. Plus oben unter Gruppen und unter Freunde ausprobieren.
3. Wischen ausprobieren: auf Start, Wunschliste, Gruppen, Konto nach links/rechts; in der App vom Home-Bildschirm vom linken Rand nach rechts = zurück. Stört es, Bescheid geben.
4. Einen Wunsch löschen und „Rückgängig“ tippen.
5. Unter Konto „So funktioniert es“ und „Erste Schritte noch mal zeigen“ ansehen.
6. In der Anleitung (Claude Doc) den Vorschlag „Neu mit Version 1.17“ annehmen.

## Nächster Schritt
Nutzer die übrigen Ideen sortieren lassen (Pakete und Später-Liste in `docs/fahrplan.md`). Leitlinie: nicht überfordern, nichts Neues auf den Hauptseiten ohne Not.

## So arbeiten (sparsam)
- Technik in `docs/technik.md` (nur passende Abschnitte lesen, `grep -n "^## "`), Planung in `docs/fahrplan.md`, Design in `docs/design-pop.md`.
- Repo: `add_repo` (owner `konstiSmile`, repo `Geschenkeliste`, access `push`), `git clone --depth 1 https://github.com/konstiSmile/geschenkeliste /home/claude/geschenkeliste`, pushen mit `git -c push.negotiate=true push origin HEAD:main`.
- Vor dem Push alle vier Tests komplett. Nach jedem Paket: diese Datei neu, Abschnitt in `technik.md`, Haken in `fahrplan.md`, Projekt-Doc „Übergabe 5 – Geschenkeliste“ ersetzen.
