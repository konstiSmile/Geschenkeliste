# Geschenkeliste – Übergabe (Stand 18.11.2026, Version 1.14)

**Projekt-Übergabe:** Doc „Übergabe 5 – Geschenkeliste“ im Projekt (Thema 5, Chats heißen „5.<Nr> …“, letzter Chat 5.21). Startsatz: „Thema 5 (Geschenkeliste), Chat 5.<Nr>. Weiter laut ‚Übergabe 5 – Geschenkeliste‘. Nächster Schritt: …“

## ZUERST (Wunsch des Nutzers, 18.11.)
**Bevor irgendetwas besprochen oder gebaut wird:** Gib dem Nutzer als allererstes die To-do-Liste aus „Offen beim Nutzer“ (unten) als kurze, nummerierte Liste zum Abhaken. Dann **warten**, bis er bestätigt, dass alles erledigt ist, und kurz nachfragen, ob dabei etwas aufgefallen ist (Fehlermeldungen, Freunde-Abschnitt sichtbar?). Erst danach Paket 9 besprechen und bauen. Repo erst danach klonen.

## Stand
- Version **1.14** (Direkte Freundschaft, Spitznamen) gepusht, Commit `9977b5a`, Cache `geschenkeliste-v23`, `?v=23`.
- Tests: 391 RLS, 306 Playwright, 14 Edge Function, 9 Service Worker, alle grün.
- Läuft beim Nutzer: Supabase, Anmeldung mit Benutzername, Push (iPhone bestätigt, auch die Testnachricht).
- App: https://konstismile.github.io/Geschenkeliste/ (Claude kann github.io nicht abrufen, der Nutzer prüft selbst).
- Anleitung für den Nutzer: Claude Doc „Geschenkeliste – Einrichtung Schritt für Schritt“, Doc-ID `56a9dfdd-971a-494a-ac08-f7b19209c32c`. Ab 1.15 nur noch kurze Abschnitte (3–5 Zeilen „Was du tun musst“).

## Offen beim Nutzer (To-do-Liste)
1. Aktuelle `supabase/schema.sql` aus dem Repo im Supabase SQL-Editor komplett ausführen (enthält 1.13.1 und 1.14). Ohne sie fehlt unter Gruppen → Freunde der Abschnitt „Freund hinzufügen“.
2. App neu laden, unter Konto prüfen: Version 1.14.
3. Gruppen → Freunde → Freund hinzufügen: Freundes-Link an jemanden schicken oder eine Anfrage per Benutzername senden.
4. Einer Person einen Spitznamen geben (Personenseite → Verwalten).
5. iPhone-App vom Home-Bildschirm: Ist die Statusleiste oben (Uhrzeit, Akku) lesbar, hell und dunkel?

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
- Nach jedem Paket: `docs/uebergabe.md` neu schreiben, Abschnitt in `technik.md`, Haken in `fahrplan.md`. Zusätzlich im Projekt das Doc `claude/Übergabe 5 – Geschenkeliste.md` ersetzen (Gliederung laut Projektanweisung); das Projekt hat nur diese eine Geschenkeliste-Datei. Backups (nur nach OK) in „Claude-Backups/5 Geschenkeliste“.
- Versionsnummern: Paket 9 wird 1.15.
