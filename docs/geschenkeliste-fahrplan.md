# Geschenkeliste – Fahrplan (Stand 18. November 2026, Version 1.11)

Reihenfolge der Features in kleinen Paketen. **Ein Paket = ein Chat** (Übergabe lesen, Paket bauen, testen, pushen, Übergabe aktualisieren). Jedes Paket ist für sich nutzbar, die Familie merkt nie eine halbe Baustelle.

Legende: **[Du]** = deine Aufgabe, **[Claude]** = ich baue. Größe S/M/L. „schema.sql“ heißt: nach dem Push einmal im Supabase SQL-Editor neu ausführen.

---

## Phase 0: Startklar machen (diese Woche)

- [x] **[Du]** GitHub Pages prüfen (Schritt 4 der Einrichtungs-Anleitung): Seite öffnet sich unter konstismile.github.io/Geschenkeliste (17.11. bestätigt)
- [x] **[Du]** Mail-Problem entschieden (17.11.): **Konten ganz ohne Mail** (Benutzername + Passwort + Wiederherstellungscode + Admin-Reset). Kein Mailserver nötig.
- [x] **Paket 1 – 1.5 Konto ohne Mail** (M) [Claude], schema.sql – **gebaut und gepusht 17.11. (Commit `85375a1`)**
  - Anmeldung mit Benutzername + Passwort (intern Platzhalter-Mail `…@nutzer.geschenkeliste.invalid`, nie eine Mail)
  - „Start ohne Mail“ bleibt, „Konto sichern“ wandelt das anonyme Konto um (gleiche User-ID)
  - Wiederherstellungscode (16 Zeichen, 4er-Gruppen, Kopieren/Teilen, letzte 4 Zeichen bestätigen, nur als Hash, neuer Code unter Konto)
  - „Passwort vergessen“ mit 5 Fehlversuchen → 1 Stunde Sperre
  - Admin: `app_admins`, Bereich „Verwaltung“, Rücksetz-Code 24 h, Hinweis „Zugang wurde am … zurückgesetzt“
  - Benutzername liegt in eigener Tabelle `accounts` (nicht in profiles), damit andere ihn nicht sehen
  - Einrichtungs-Anleitung angepasst (Abschnitt „Neu mit Version 1.5“, Schritte A–D, neue Fehlertabelle)
  - Tests: 85 RLS-Prüfungen, 42 Playwright-Prüfungen
- [x] **[Du]** Anleitung Abschnitt „Neu mit Version 1.5“: A schema.sql ausgeführt, B Konto „konsti“ gesichert, C Admin eingetragen, D geprüft (Verwaltung sichtbar, Anmeldung in Safari klappt). Alles am 17.11. ohne Fehler.
- [ ] **[Du]** Schritte 6–8: selbst testen (Safari + Home-Bildschirm, beide mit Benutzername anmelden = ein Konto), dann Familie einladen (Paket 3b ist fertig, die Installieren-Anleitung steht jetzt auf der Anmeldeseite)

## Phase 1: Weihnachten (bis ca. 1. Dezember)

- [ ] **[Du]** Vorher klären: Wer darf wen beim Wichteln nicht ziehen? Machen alle mit? (Trägst du direkt in der App ein, blockiert den Bau nicht.)
- [x] **Paket 2 – 1.6 Wichteln** (M) [Claude], schema.sql – **gebaut und gepusht 17.11. (Commit `e79caf7`)**
  - Teilnehmer und Ausschlüsse (nur Gründer), Auslosung in der Datenbank, neu auslosen und aufheben mit Bestätigung, Startseite zeigt gezogene Person
  - Gründer übergibt beim Verlassen der Gruppe an das am längsten dabei gebliebene Mitglied
  - Einrichtungs-Anleitung: Abschnitt „Neu mit Version 1.6: Wichteln“ (Schritte A–D, Fehlertabelle)
  - Tests: 112 RLS-Prüfungen, 54 Playwright-Prüfungen
- [ ] **[Du]** Anleitung Abschnitt „Neu mit Version 1.6“: A schema.sql ausführen, B App neu laden (Version 1.6), C Teilnehmer und Ausschlüsse eintragen, D auslosen, wenn alle beigetreten sind
- [x] **Paket 3 – 1.7 Mehr am Wunsch** (M) [Claude], schema.sql – **gebaut und gepusht 17.11. (Commit `5c699b2`)**
  - Preis, Kategorie (13 feste), Wichtigkeit (Sehr gern / Normal / Nur eine Idee); Filter in der Liste einer Person (Noch frei, Preisspanne, Kategorie); „Hab ich schon“ mit Hinweis an Reservierende, nicht mehr reservierbar; Knopf „Einfügen“ am Link + Android-Teilen (`share_target`)
  - Einrichtungs-Anleitung: Abschnitt „Neu mit Version 1.7: Mehr am Wunsch“ (Schritte A–D, Fehlertabelle)
  - Tests: 131 RLS-Prüfungen, 78 Playwright-Prüfungen
- [ ] **[Du]** Anleitung Abschnitt „Neu mit Version 1.7“: A schema.sql ausführen, B App neu laden (Version 1.7), C Wunsch mit Preis/Kategorie anlegen, D Android: App neu installieren für das Teilen-Menü
- [x] **Paket 3b – 1.7.1 „Als App installieren“** (S) [Claude] – **gebaut und gepusht 17.11. (Commit `45634ae`)**
  - Anmeldeseite und Konto → „App“: Anleitung je nach Gerät (iPhone 3 Schritte, Android Installieren-Knopf oder Menü-Anleitung, Rechner beide zugeklappt), die andere aufklappbar; in der installierten App ausgeblendet
  - iPhone mit Einladungslink: Einladungscode für die App angezeigt (Safari und App speichern getrennt); Hinweis auf Safari in anderen Browsern
  - Manifest: `id`, eigenes maskierbares Symbol, Farben passend zur Seite, Kurzbefehle (Neuer Wunsch, Wunschliste, Gruppen), 3 Screenshots für den großen Installieren-Dialog
  - Einrichtungs-Anleitung: Abschnitt „Neu mit Version 1.7.1: Als App installieren“ (A–D, Fehlertabelle)
  - Tests: 131 RLS-Prüfungen, 101 Playwright-Prüfungen
- [ ] **[Du]** Anleitung Abschnitt „Neu mit Version 1.7.1“: A neu laden, B iPhone und C Android unter Konto → App prüfen, D Familie einladen
- [x] **Paket 4 – 1.8 „Neu seit letztem Besuch“** (S) [Claude] – **gebaut und gepusht 17.11. (Commit `d508cd7`)**
  - Markierung neuer Wünsche, Mitglieder und Auslosungen („Neu“, „Neu dabei“, „Neu ausgelost“), Abschnitt „Neu seit deinem letzten Besuch“ auf der Startseite mit „Alles gesehen“, Zähler am Tab Gruppen und am App-Symbol (iPhone nach Erlauben der Mitteilungen; Android erst mit Push). Nur auf dem Gerät gespeichert, keine schema.sql
  - Einrichtungs-Anleitung: Abschnitt „Neu mit Version 1.8: Neu seit letztem Besuch“ (A–D, Fehlertabelle)
  - Tests: 131 RLS-Prüfungen, 123 Playwright-Prüfungen
- [ ] **[Du]** Anleitung Abschnitt „Neu mit Version 1.8“: A neu laden, B mit zweitem Gerät einen Wunsch anlegen, C Markierung prüfen, D iPhone: Zähler am App-Symbol einschalten

## Phase 2: Zusammenarbeit (Dezember, Rest nach Weihnachten)

- [x] **Paket 5 – 1.9 Push-Benachrichtigungen** (L) [Claude], schema.sql – **gebaut und gepusht 17.11. (Commit `c8c6896`)**
  - Knopf „Benachrichtigungen erlauben“ (Startseite und Konto; wer den Zähler aus 1.8 erlaubt hat, ist automatisch dabei), 5 Schalter pro Art, Testnachricht, auf diesem Gerät ausschalten
  - Anlässe: neuer Wunsch (gebündelt), jemand beigetreten, Wichteln ausgelost (ohne Namen), „hat sie schon“ an Reservierende, Erinnerung 14/7/1 Tag vor Heiligabend
  - Edge Function `push` ohne Bibliotheken, Schlüssel erzeugt der Admin in der App (keine Secrets), Datenbank weckt die Funktion (pg_net, pg_cron)
  - Zahl am App-Symbol zählt auch ohne Öffnen weiter (Android als Punkt), Antippen öffnet die richtige Seite
  - Einrichtungs-Anleitung: Abschnitt „Neu mit Version 1.9: Benachrichtigungen“ (A–F, Fehlertabelle)
  - Tests: 171 RLS-Prüfungen, 147 Playwright-Prüfungen, 14 Edge Function, 9 Service Worker
- [ ] **[Du]** Anleitung Abschnitt „Neu mit Version 1.9“: A schema.sql ausführen, B Edge Function `push` anlegen, C Verify JWT aus, D Schlüssel erzeugen, E iPhone erlauben + Testnachricht, F zweites Gerät legt Wunsch an (ca. 15 Min.). Rückmeldung an Claude, ob Nachrichten ankommen (noch nie gegen echte Push-Dienste getestet)
- [x] **Paket 5b – 1.10 Pop-Design mit zwei Themen** (L) [Claude] – **gebaut und gepusht 17.11. (Commit `bffb352`)**
  - Look komplett nach Entwurf „Richtung 2 · Pop“ (Fredoka/Nunito selbst gehostet, dicke Konturen, harte Schatten, runde Icons, Kategorie-Kacheln, Status-Pillen), Aufbau und Tabs bleiben
  - Themen Ganzjährig (Violett, Koralle, Sonnengelb) und Weihnachten (Zuckerstange, Minze, Vanille), je hell und dunkel, Standard automatisch nach Datum (1.11. bis 6.1. Weihnachten), unter Konto → Design umschaltbar
  - Keine schema.sql. Einrichtungs-Anleitung: Abschnitt „Neu mit Version 1.10: Pop-Design“ (A–D)
  - Tests: 171 RLS-Prüfungen, 165 Playwright-Prüfungen, 14 Edge Function, 9 Service Worker
- [x] **1.10.1–1.10.4** (18.11.): Hell/Dunkel fest wählbar, Tab-Leiste als schwebende Kapsel, Weihnachten dunkel neu (Tannennacht, Cranberry, Gold, Salbei, Creme), Design und Datenschutz unter Konto aufklappbar (anfangs zu)
- [ ] **[Du]** Anleitung Abschnitt „Neu mit Version 1.10“: A neu laden, B Konto → Design ausprobieren, C Dunkelmodus ansehen, D iPhone-App: Statusleiste oben lesbar? (Rückmeldung an Claude)
- [x] **Paket 12 – 1.11 Private Ideenliste** (S–M) [Claude], schema.sql – **gebaut und gepusht 18.11. (Commit `98aabea`)**
  - Wunschliste hat zwei Reiter „Meine Wünsche | Ideen für andere“; Ideen für Leute aus den Gruppen oder für selbst angelegte Personen ohne App, später mit echtem Konto verknüpfbar (Ideen wandern mit); Titel, Link, Preis, Kategorie, Notiz; als besorgt abhaken (zählt bei den Besorgungen); Abschnitt „Deine Ideen“ auf der Personenseite. Nur ich sehe sie
  - Später: Idee in Reservierung umwandeln
  - Einrichtungs-Anleitung: Abschnitt „Neu mit Version 1.11: Private Ideenliste“ (A–D)
  - Tests: 201 RLS-Prüfungen, 194 Playwright-Prüfungen, 14 Edge Function, 9 Service Worker
- [ ] **[Du]** Anleitung Abschnitt „Neu mit Version 1.11“: A schema.sql ausführen, B neu laden (Version 1.11), C Idee für jemanden aus der Gruppe notieren, D Person ohne App anlegen
- [ ] **Paket 11 – 1.12 Steckbrief + „Früh dran“** (M) [Claude], schema.sql – **vorgezogen (18.11.), als Nächstes**
  - Erst Ideen besprechen, wie der Steckbrief Spaß macht statt zu überfordern; Inhalte Größen, Lieblingsdinge, Lieber nicht, Freitext. „Früh dran“: dezentes Lob nur für mich, auch für einzelne Besorgungen
- [ ] **[Du]** Vorher klären für Paket 6: Wer kauft und streckt vor? Was, wenn zu wenige mitmachen?
- [ ] **Paket 6 – 1.13 Gemeinsam schenken** (M) [Claude], schema.sql – nach Paket 12 und 11
  - Anfrage an bestimmte Leute oder offen, Aufteilung fair/Budget/individuell, „bezahlt“ abhaken, Benachrichtigung (Preis am Wunsch gibt es seit 1.7, Push seit 1.9)
- [ ] **Paket 7 – 1.14 Chats Teil 1** (M) [Claude], schema.sql
  - Chat pro Geschenk + Plattform-Abfrage (WhatsApp, Signal, …, ausgegraut wenn gewählt)
- [ ] **Paket 8 – 1.15 Chats Teil 2** (S) [Claude]
  - Gruppenchat und „ohne X“-Chats, Push bei neuer Nachricht

## Phase 3: Nach Weihnachten – Umbau zur Wunschlisten-App für alle Anlässe

- [ ] **Paket 9 – 2.0 Anlässe** (L) [Claude], schema.sql
  - Anlass pro Gruppe (Weihnachten, Geburtstag, Hochzeit, …), Geburtstage im Profil, Countdown allgemein, Erinnerungen (Push-Erinnerung ist bis dahin fest auf Heiligabend), neutrales App-Symbol (dann auch Kurzbefehl-Symbole und Screenshots neu)
- [ ] **[Du]** Vorher festlegen: Wie sieht das Standarddesign aus, welche zwei Zusatzthemen (Namen, Stimmung)?
- [ ] **Paket 10 – 2.1 Farbthemen** (S) [Claude], schema.sql – größtenteils mit 1.10 erledigt
  - Rest: weitere Themen, Wahl im Profil speichern (geräteübergreifend), Thema pro Anlass
- Pakete 11 und 12 sind nach Phase 2 vorgezogen (siehe oben).
- [ ] **Paket 13 – 2.4 Öffnen für Freunde** (M) [Claude + Du]
  - [Claude] Datenschutz-Seite, Captcha für anonyme Anmeldungen und Registrierung, Benutzernamen-Regeln (verbotene Namen), Benutzername ändern
  - Optional: freiwillige echte Mail als zusätzlicher Rettungsweg → dann **[Du]** eigene Domain + SMTP (Brevo/Resend), Rate Limits erhöhen
  - Klären: Admin-Reset für Fremde beibehalten oder nur Code?
- [ ] **Paket 14 – 2.5 Fotos am Wunsch** (M) [Claude], Supabase Storage einrichten [Du]

---

## Warum diese Reihenfolge
- Erst muss die Anmeldung für die Familie klappen, sonst nützt nichts anderes. Ohne Mail gibt es kein Versandlimit und keine Einrichtung beim Mailanbieter.
- Wichteln hat eine feste Frist (Auslosung Anfang Dezember).
- Paket 3b vor dem Einladen der Familie: Wer die App gleich richtig installiert, hat weniger Probleme (getrennter Speicher Safari/Home-Bildschirm).
- Preis kommt vor „gemeinsam schenken“, Push kommt vor Chats und „gemeinsam schenken“, damit die überhaupt Sinn ergeben.
- Anlässe kommen vor Farbthemen, weil dabei das fest eingebaute Weihnachten verschwindet.
- Öffnen für Freunde erst, wenn Datenschutz und Schutz vor Spam stehen.

**Erster Satz im neuen Chat:** „Geschenkeliste: Lies claude/geschenkeliste-uebergabe und claude/geschenkeliste-fahrplan, dann besprechen und bauen wir Paket 11 (Steckbrief + Früh dran).“
