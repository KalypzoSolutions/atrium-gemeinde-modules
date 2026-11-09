# Atrium – Gemeindemodule für Kalypzo Atrium

Module für Kirchengemeinden auf der Plattform [Kalypzo Atrium](https://github.com/KalypzoSolutions/kalypzo-atrium).
Alle Module liegen unter `modules/<id>/`, der Katalog unter `modules/atrium-modules.json`.

| Modul | Inhalt |
|---|---|
| `rooms` | **Räume** – Raumplanung: Räume mit Merkmalen, feste oder flexible Buchungen, wöchentliche Dauertermine, automatische Zuweisung des kleinsten passenden Raums (Heizkosten sparen), Umplanung mit Benachrichtigung, Verknüpfung mit „Termine“ |

## Raumplanung (`rooms`) im Überblick

- **Räume** mit Plätzen, Fläche, **Heizaufwand 1–10** (Regler), Sperrzeiten und frei konfigurierbaren **Merkmalen**
  (Klavier, Orgel, Beamer, ebenerdig, Küche …). **Gruppen** mit Farbe und Vorrang.
- **Buchen in drei Schritten** (Was · Wann · Raum) mit drei Stufen: **Nur dieser Raum** (eigenes Recht),
  **Raum wie dieser** (Wunschraum, sonst gleichwertig) oder **Nach Anforderungen** (Personen, Merkmale). Raumvorschläge
  nennen den Grund („Passt genau“, „Belegt: Chorprobe 19:30–21:30“, „Fehlt: Klavier“).
- **Automatisches Umplanen**: braucht eine andere Gruppe genau so einen Raum, ziehen flexible und „Raum wie dieser“-
  Buchungen um (nie kurz vor dem Termin, höchstens zweimal im Monat). Die Gruppe wird benachrichtigt und kann
  48 Stunden lang widersprechen. Feste Buchungen bekommen stattdessen eine **Tauschanfrage**.
- **Drag & Drop fürs Büro**: Termine in andere Räume ziehen, solange die Anforderungen passen – passende Räume leuchten
  grün, die anderen nennen den Grund. Mit Rückgängig.
- **Heizaufwand sparen**: Räume mit niedriger Stufe zuerst, aufeinanderfolgende Termine im schon warmen Raum, Serien
  jede Woche im selben Raum; Gesamtoptimierung mit Vorschau.
- **Dauertermine**: wöchentlich (auch alle n Wochen, mehrere Wochentage), einzelne Termine absagbar.
- **Belegungsplan**: Woche (Räume × Tage) in Gruppenfarben, Tag (Räume × Uhrzeit), „Meine Buchungen“; auf dem Handy als Liste.
- **Kalender**: Verknüpfung mit Terminen aus `events` (atrium-basic-modules); `events` bucht über `RoomsService`
  Räume direkt am Termin (`modules/rooms/contract.ts`).

## Installation auf einem Server

Administration → Module → **Installieren** → Link `https://github.com/<org>/atrium-gemeinde-modules/tree/<commit>/modules`
(oder ZIP dieses Repos) → Module auswählen.

## Entwickeln

Der Core ist als Git-Submodul `.core` auf einen festen Stand gepinnt.

```bash
git clone --recurse-submodules <url> && cd atrium-gemeinde-modules
npm run setup        # Core-Abhängigkeiten, node_modules-Link, Pakete der Module
npm run check        # Typprüfung (Core + Module)
npm test             # Tests der Module (Vitest, PGlite)
npm run build        # Produktions-Build
npm run demo         # Demo-Server http://localhost:4300 mit diesen Modulen
node scripts/seed-demo-rooms.mjs   # Beispielräume und -buchungen
npm run check:catalog && npm run check:migrations
```

Core aktualisieren: `git -C .core fetch --tags && git -C .core checkout <tag>`, dann `npm run setup -- --force`, prüfen, committen.
Regeln für die Arbeit an Modulen: `.core/.claude/rules/modules.md` und `.claude/rules/module-<id>.md`.
