# Geschenkeliste – Fahrplan (Stand 20.11.2026, Version 1.16)

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

Gestrichen: Pakete 7 und 8 (Chats), Absprachen laufen über WhatsApp und Co.

## Offen für den Nutzer
- schema.sql ausführen (1.16), App neu laden, Version 1.16 prüfen, Geburtstagsgruppe ausprobieren
- Familie einladen, Wichteln eintragen und auslosen (Anfang Dezember)

## Als Nächstes: Paket „Einfach bedienen“
Die App nutzen auch Leute über 60, die nicht so gut mit Technik können. Ganze App durchgehen: größere Schrift und Knöpfe, klarere Beschriftungen, weniger auf einmal, kurze Hilfe beim ersten Start, evtl. Einfach-Modus. Ergebnis als Auswahlliste für den Nutzer, dann bauen. Gilt ab sofort auch für jedes neue Paket: zurückhaltend, nichts Neues auf den Hauptseiten ohne Not.

Reihenfolge laut Nutzer (20.11.): erst 9b (erledigt), dann „Einfach bedienen“. Die übrigen Ideen (unten) hat er noch nicht sortiert, danach fragen.

## Weitere Pakete
- **Paket 10 – Farbthemen** (S): weitere Themen, Wahl im Profil speichern, Thema pro Anlass. Vorher klären: Standarddesign und zwei Zusatzthemen (Namen, Stimmung)
- **Paket 13 – Öffnen für Freunde** (M): Datenschutz-Seite, Captcha, verbotene Benutzernamen, Benutzername ändern, Spam-Schutz für Freundschaftsanfragen; optional echte Mail (dann eigene Domain + SMTP); klären: Admin-Reset für Fremde
- **Paket 14 – Fotos am Wunsch** (M): Supabase Storage einrichten

## Später (gesammelt)
Idee in Reservierung umwandeln; Push bei neuen Ideen in Geburtstagsgruppen; Ideen pro Anlass; Idee → gemeinsames Geschenk; gemeinsam schenken ohne Wunsch; Steckbrief für Personen ohne App; Größe im Wunsch-/Ideenformular; eigener Benutzername unter Konto („So finden dich Freunde“); „gesehen“ geräteübergreifend; Schriften als woff2.

## Vision
Wunschlisten-App für Freundeskreise, Familien und Anlässe aller Art, Weihnachten nicht fest verdrahtet.
