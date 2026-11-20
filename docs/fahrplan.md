# Geschenkeliste – Fahrplan (Stand 20.11.2026, Version 1.18)

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
| 1.15 | 9a | Anlass pro Gruppe, Geburtstag, Schenklisten, neues App-Symbol | `9d3c5cb` |
| 1.16 | 9b | Geburtstagsgruppe für jemanden (auch ohne App), gemeinsame Ideen, Archiv | `0f60ca4` |
| 1.17 | Einfach bedienen | Klarere Wörter, Plus-Menü, Gruppenfenster, Mehr Angaben, Erste Schritte, Hilfe, Rückgängig, Wischen; 1.17.1 Freund entfernen | `5ba8114` |
| 1.18 | Feinschliff | Benutzername unter Konto, Größe, Idee wird „Ich schenke das“, gesehen im Konto, Steckbrief für Personen ohne App | `58f96f7` |

Gestrichen: Pakete 7 und 8 (Chats), Absprachen laufen über WhatsApp und Co.

## Offen für den Nutzer
- schema.sql ausführen, App neu laden, Version 1.18 prüfen, Neues ausprobieren
- Familie einladen, Wichteln eintragen und auslosen (Anfang Dezember)

## Als Nächstes (vom Nutzer sortiert, 20.11.)
1. **Paket 13 – Öffnen für Freunde** (M): bald, weil Freunde die App schon nutzen. Datenschutz-Seite, Captcha, verbotene Benutzernamen, Benutzername ändern, Spam-Schutz für Freundschaftsanfragen; optional echte Mail (dann eigene Domain + SMTP); klären: Admin-Reset für Fremde.
2. Danach: gemeinsam schenken ohne Wunsch bzw. Idee → gemeinsames Geschenk; Anlass beim Anlegen einer Idee wählen (Ideen pro Anlass); Push bei neuen Ideen in Geburtstagsgruppen.

Für jedes Paket: zurückhaltend, nichts Neues auf den Hauptseiten ohne Not, nicht überfordern.
Aus „Einfach bedienen“ nicht gewählt (bei Bedarf später): größere Schrift, Schalter „Große Schrift“, dunklere Hinweistexte, größere Knöpfe, Einfach-Modus, Wischen auf Zeilen.

## Für später gemerkt
- **Paket 10 – Farbthemen** (S): braucht es laut Nutzer eigentlich nicht, aber nicht verworfen.
- **Paket 14 – Fotos am Wunsch** (M): Supabase Storage. Einschätzung 20.11.: Gratis-Plan hat 1 GB Speicher und 5 GB Datenverkehr (plus 5 GB aus dem Zwischenspeicher) im Monat. Fotos vor dem Hochladen auf ca. 150 KB verkleinern, kleine Vorschaubilder auf dem Gerät behalten, dann reicht es für Familie und Freunde. Aufwand vor allem bei den Zugriffsregeln (Foto nur für die, die den Wunsch sehen).
- **Schriften als woff2:** ging am 20.11. nicht (Paket brotli fehlt, Installationen im Konto aus). Spart nur ca. 15 KB.
- Größe bei gemeinsamen Ideen in Geburtstagsgruppen, Steckbrief der Person in der Geburtstagsgruppe teilen.

## Vision
Wunschlisten-App für Freundeskreise, Familien und Anlässe aller Art, Weihnachten nicht fest verdrahtet.
