# Geschenkeliste – Pop-Design mit zwei Themen (Paket 5b, Version 1.10)

Wunsch des Nutzers vom 17.11.: App auf das Design „Richtung 2 · Pop“ umstellen, in zwei Themen **Ganzjährig** und **Weihnachten**, in der App umschaltbar. Vorlage: zwei Screenshots aus einem Design-Canvas (der Nutzer hängt sie im neuen Chat nochmal an). Ersetzt die alte Idee „Farbthemen“ (Paket 10) weitgehend.

## Entscheidungen (17.11.)
- **Umfang: Look komplett, Aufbau bleibt.** Farben, Schriften, dicke Konturen, harte Schatten, Icons, Knöpfe, Karten, Chips, Tags werden neu. Seiten, Tabs (Start, Wunschliste, Gruppen, Konto), Abläufe und Texte bleiben. Nicht übernehmen: Tabs „Listen/Entdecken/Freunde/Profil“, Schnelleingabe auf der Startseite, Herz-Knopf zum Merken (vielleicht später als eigenes Paket).
- **Standard: Automatisch nach Datum.** Weihnachten vom 1. November bis 6. Januar, sonst Ganzjährig. Unter Konto fest wählbar: Automatisch / Ganzjährig / Weihnachten.

## Gemeinsame Pop-Formensprache
- Dicke dunkle Konturen (ca. 2 px in der Tinten-/Lakritzfarbe) an Karten, Eingabefeldern, Chips, Knöpfen, Kacheln.
- Harte Schatten ohne Weichzeichnung, nach rechts unten versetzt (ca. 4 px 4 px 0 in der dunklen Farbe), bei Hauptknöpfen und Karten.
- Große Rundungen: Karten ca. 18–20 px, Eingabefeld ca. 14 px, Chips und Status-Tags vollrund (Pille), Icon-Kacheln ca. 14 px.
- **Schriften:** Überschriften **Fredoka** (fett, rund), Fließtext **Nunito**. Müssen selbst gehostet werden (CSP erlaubt nur `self`): woff2 in `fonts/`, `@font-face` in `app.css`, in `sw.js` vorladen. Bezug: Google Fonts (OFL), z. B. per `git clone --filter=blob:none --sparse https://github.com/google/fonts` und `ofl/fredoka`, `ofl/nunito` (variable TTF → mit fonttools in woff2 umwandeln, wenn vorhanden) oder der Nutzer lädt die woff2-Dateien hoch. Fallback: Systemschrift.
- **Icons:** Linien, dick und rund, Strichstärke 2,25 px, runde Enden. Bestehendes Icon-Objekt `I` behalten, `stroke-width` anpassen; neue Icons bei Bedarf (Stern, Schneeflocke, Tanne, Kalender, Funkeln, Sprechblase).
- **Wunsch-Karte (Liste einer Person, eigene Liste):** weiße Karte mit Kontur + Schatten, links Kachel in Pastellfarbe mit Kategorie-Icon (statt Buchstaben-Kachel), Titel fett, darunter „Kategorie · Preis“, darunter Status-Pille „Reserviert“ (mit Schloss-Icon) bzw. „Offen“.
- **Chips/Filter:** Pillen mit Kontur; aktiv = gefüllt in der Akzentfarbe mit weißer Schrift.
- **Knöpfe:** Hauptknopf gefüllt in Akzentfarbe, weiße Schrift, Icon links, Kontur + harter Schatten. Zweitknopf weiß/hell mit Kontur, ohne Füllung.
- **Tab-Leiste:** weiß, aktive Lasche in Akzentfarbe (Icon + Text), sonst grau.
- **Kopf:** kleine Überzeile in Großbuchstaben mit Sperrung (z. B. „WEIHNACHTEN 2026“, „ALLE ANLÄSSE“), großer Titel in Fredoka, rechts runder Kontur-Knopf (Teilen/Aktualisieren).

## Thema Ganzjährig
- Violett `#5B3FE0` (Akzent: Hauptknopf, aktive Chips, aktive Tab, Herz/Prio)
- Koralle `#FF7A59` (Status „Offen“: Schrift Koralle auf hellem Koralle)
- Sonnengelb `#FFC93C` (Hero-Karte „Nächster Anlass“, gelb gefüllt mit Kontur + Schatten, weißer Kreis mit Icon links)
- Creme `#FFF9EC` (Seitengrund)
- Tinte `#1E1B2E` (Text, Konturen, Schatten)
- Pastell-Kacheln: helles Violett, helles Koralle/Rosa, helles Gelb. Status „Reserviert“: Violett auf hellem Violett.
- Hero auf der Startseite: Countdown neutral (bis Anlässe kommen: „Nächster Anlass · Heiligabend 24. Dezember“ bzw. Tage), ohne Christbaumkugel.

## Thema Weihnachten
- Zuckerstange `#C8102E` (Akzent: Hauptknopf, aktive Chips, aktive Tab, Herz)
- Minze `#2FA37C` (Status „Reserviert“: Minze auf hellem Minz)
- Vanille `#FFE9B3` (Status „Offen“: dunkle Schrift auf Vanille; Kachel-Pastell)
- Schnee `#FFF4EC` (Seitengrund)
- Lakritz `#2B1720` (Text, Konturen, Schatten)
- Hero: rote Karte mit Kontur + Schatten, oben **Zuckerstangen-Streifen** (schräge weiß-rote Streifen, als CSS-Verlauf oder data-URI-SVG, CSP erlaubt data-Bilder in CSS), große weiße Zahl „37“, daneben „Tage bis Heiligabend“ fett und „5 von 12 Wünschen sind reserviert“ (bzw. eigene Besorgungen, Text klären), rechts kleine Icons Stern und Schneeflocke. Bisherige Kugel-Animation darf entfallen oder klein bleiben.
- Icons zusätzlich: Tanne (Advent), Stern (Favorit), Schneeflocke (Winter).

## Technik (Plan)
- `data-theme="jahr|weihnachten"` am `<html>`, CSS-Variablen pro Thema; alle festen Farben in `app.css` und im SVG `BAUBLE` auf Variablen umstellen. Avatar-Farben `c0–c5` und Kachel-Pastelle pro Thema.
- Kleine externe Datei `theme.js` im `<head>` (CSP: nur `self`, keine Inline-Skripte), setzt das Thema vor dem ersten Zeichnen aus localStorage `geschenkeliste-theme` (`auto|jahr|weihnachten`) und Datum. `meta theme-color` mitziehen.
- Konto: Abschnitt „Design“ mit drei Auswahlkarten und Farbvorschau (Automatisch / Ganzjährig / Weihnachten). Zunächst nur auf dem Gerät gespeichert (kein schema.sql nötig); später ins Profil.
- Dunkelmodus: die Entwürfe zeigen nur hell. Vorschlag: dunkle Varianten ableiten (Grund Tinte bzw. Lakritz, Konturen hell, Schatten schwarz) oder vorerst immer hell. Im neuen Chat kurz klären.
- `prefers-reduced-motion` beachten. Manifest-Farben und Screenshots (`make_screenshots.py`) neu, Statusleisten-Frage (`black-translucent`) mit erledigen.
- Tests: Playwright-Bilder beider Themen ansehen, Kontrast prüfen (Weiß auf Violett/Rot ok; Koralle-Schrift auf Hell prüfen), Überlauf, Themewechsel unter Konto, automatischer Wechsel per Datum (Init-Skript mit festem Datum).
