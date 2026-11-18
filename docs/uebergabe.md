# Geschenkeliste – Übergabe (Stand 18.11.2026, Version 1.14)

**Erster Satz im neuen Chat:** „Geschenkeliste: Lies claude/geschenkeliste-uebergabe. Version 1.14 ist gebaut. Jetzt besprechen und bauen wir Paket 9 (Anlässe und Geburtstage, 1.15).“

## Stand
- Version **1.14** (Direkte Freundschaft, Spitznamen) gepusht, Commit `9977b5a`, Cache `geschenkeliste-v23`, `?v=23`.
- Tests: 391 RLS, 306 Playwright, 14 Edge Function, 9 Service Worker, alle grün.
- Läuft beim Nutzer: Supabase, Anmeldung mit Benutzername, Push (iPhone bestätigt, auch die Testnachricht).
- App: https://konstismile.github.io/Geschenkeliste/ (Claude kann github.io nicht abrufen, der Nutzer prüft selbst).
- Anleitung für den Nutzer: Claude Doc „Geschenkeliste – Einrichtung Schritt für Schritt“, Doc-ID `56a9dfdd-971a-494a-ac08-f7b19209c32c`. Ab 1.15 nur noch kurze Abschnitte (3–5 Zeilen „Was du tun musst“).

## Offen beim Nutzer
- schema.sql ausführen (enthält 1.13.1 und 1.14), neu laden, Freundes-Link ausprobieren
- iPhone-App: Statusleiste lesbar?

## Nächster Schritt
Paket 9 (1.15) Anlässe und Geburtstage, Details und Entscheidungen in `docs/fahrplan.md`. Erst besprechen, dann bauen.

## So arbeiten (sparsam)
- **Alles Technische liegt im Repo** `konstiSmile/Geschenkeliste` unter `docs/`:
  - `uebergabe.md`: diese Datei
  - `fahrplan.md`: Pakete, Entscheidungen, „Später“-Liste
  - `technik.md`: Aufbau, Testumgebung, Release-Ablauf und ein Abschnitt pro Bereich. Nur die passenden Abschnitte lesen (`grep -n "^## "`).
  - `design-pop.md`: Pop-Design
- Repo einbinden: erst `add_repo` (owner `konstiSmile`, repo `Geschenkeliste`, access `push`), dann `git clone --depth 1 https://github.com/konstiSmile/geschenkeliste /home/claude/geschenkeliste`. Pushen mit `git -c push.negotiate=true push origin HEAD:main`.
- Tests geben nur Fehler und eine Summe aus. Vor dem Push laufen immer alle vier komplett.
- Nach jedem Paket: `docs/uebergabe.md` neu schreiben, Abschnitt in `technik.md`, Haken in `fahrplan.md`. Die Kurz-Übergabe kommt zusätzlich ins Projekt als `claude/geschenkeliste-uebergabe.md`; das Projekt hat nur diese eine Geschenkeliste-Datei.
- Versionsnummern: Paket 9 wird 1.15.
