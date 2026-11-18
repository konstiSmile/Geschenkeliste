# Geschenkeliste – Fahrplan (Stand 18.11.2026, Version 1.14)

Ein Paket = ein Chat. Jedes Paket ist für sich nutzbar. „schema.sql“ heißt: nach dem Push einmal im Supabase SQL-Editor ausführen. Details zu gebauten Paketen: `docs/technik.md`.

## Gebaut
| Version | Paket | Inhalt | Commit |
|---|---|---|---|
| 1.5 | 1 | Konto ohne Mail (Benutzername, Wiederherstellungscode, Admin-Reset) | `85375a1` |
| 1.6 | 2 | Wichteln | `e79caf7` |
| 1.7 | 3 | Mehr am Wunsch (Preis, Kategorie, Wichtigkeit, Hab ich schon, Teilen) | `5c699b2` |
| 1.7.1 | 3b | Als App installieren | `45634ae` |
| 1.8 | 4 | Neu seit letztem Besuch | `d508cd7` |
| 1.9 | 5 | Push-Benachrichtigungen | `c8c6896` |
| 1.10–1.10.4 | 5b | Pop-Design, Ganzjährig + Weihnachten, hell/dunkel | `bffb352`, `d3c008b` |
| 1.11, 1.11.1 | 12 | Private Ideenliste, Freundesliste | `98aabea` |
| 1.12 | 11 | Steckbrief + Früh dran | `d0369b7` |
| 1.13, 1.13.1 | 6 | Gemeinsam schenken; Konto löschen | `b423ea9`, `0956c41` |
| 1.14 | 15 | Direkte Freundschaft, Spitznamen | `9977b5a` |

Gestrichen: Pakete 7 und 8 (Chats), Absprachen laufen über WhatsApp und Co.

## Offen für den Nutzer
- schema.sql ausführen (enthält 1.13.1 und 1.14), App neu laden, Freundes-Link ausprobieren
- iPhone-App: Statusleiste oben lesbar? (seit 1.10)
- Familie einladen, Wichteln eintragen und auslosen (Anfang Dezember)

## Als Nächstes: Paket 9 – 1.15 Anlässe und Geburtstage (L), schema.sql
- Anlass pro Gruppe (Weihnachten, Geburtstag, Hochzeit, …), Countdown allgemein, Erinnerungen (`push_daily` ist noch fest auf Heiligabend), neutrales App-Symbol (dazu Kurzbefehl-Symbole und Screenshots neu)
- Geburtstag im Profil, Gruppen und Freunde werden vorher erinnert
- **Geburtstagsgruppe für jemanden**, ohne dass die Person es merkt. Entschieden (18.11.):
  - Mitglieder sehen alles, was die Person für Gruppen oder Freunde freigibt (Wünsche, Steckbrief), als wäre sie dabei, deutlich markiert („Geburtstag von X am …“), mit Reservieren und gemeinsam schenken
  - „Geburtstagsgruppen für mich erlaubt“ unter Konto, standardmäßig an
  - Anlegen dürfen direkte Freunde und Leute aus gemeinsamen Gruppen der Person; einladen dürfen sie jeden
  - Nach dem Geburtstag entscheidet die Gründerin/der Gründer: archivieren oder löschen. Archivierte Gruppen im nächsten Jahr wiederverwendbar (Mitglieder bleiben, Vorjahr als Rückblick „Letztes Jahr geschenkt“)
  - Betrifft `wish_visible_to`, `card_list`, `pool_audience`, Push
- Offene Ideen aus früheren Paketen, die hier passen: Ideen pro Anlass, Geburtstage für Personen ohne App
- **Neu vom Nutzer (18.11.): eigene Schenkliste.** Man legt selbst eine Liste mit Leuten an, denen man etwas schenken will, und hakt sie ab. Passt zu Anlässen (z. B. „Weihnachten 2026: Mama, Papa, Lena“). Mit dem Nutzer klären, wie das zur Ideenliste (Personen, Ideen, besorgt) passt
- **Kleiner Fix:** Ohne aktuelle schema.sql blendet die Freunde-Seite „Freund hinzufügen“ einfach aus (`D.friendsOk` false). Stattdessen einen Hinweis „Datenbank aktualisieren“ zeigen

## Danach
- **Paket 10 – Farbthemen** (S): weitere Themen, Wahl im Profil speichern, Thema pro Anlass. Vorher klären: Standarddesign und zwei Zusatzthemen (Namen, Stimmung)
- **Paket 13 – Öffnen für Freunde** (M): Datenschutz-Seite, Captcha, verbotene Benutzernamen, Benutzername ändern, Spam-Schutz für Freundschaftsanfragen; optional echte Mail (dann eigene Domain + SMTP); klären: Admin-Reset für Fremde
- **Paket 14 – Fotos am Wunsch** (M): Supabase Storage einrichten

## Später (gesammelt)
Idee in Reservierung umwandeln; Idee → gemeinsames Geschenk; gemeinsam schenken ohne Wunsch; Steckbrief für Personen ohne App; Größe im Wunsch-/Ideenformular; eigener Benutzername unter Konto („So finden dich Freunde“); „gesehen“ geräteübergreifend; Schriften als woff2.

## Vision
Wunschlisten-App für Freundeskreise, Familien und Anlässe aller Art, Weihnachten nicht fest verdrahtet.
