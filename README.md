# Atrium – Gemeindemodule für Kalypzo Atrium

Module für Kirchengemeinden auf der Plattform [Kalypzo Atrium](https://github.com/KalypzoSolutions/kalypzo-atrium).
Alle Module liegen unter `modules/<id>/`, der Katalog unter `modules/atrium-modules.json`.

| Modul | Inhalt |
|---|---|
| `rooms` | **Räume** – Raumplanung: Räume mit Merkmalen, feste oder flexible Buchungen, wöchentliche Dauertermine, automatische Zuweisung des kleinsten passenden Raums (Heizkosten sparen), Umplanung mit Benachrichtigung, Verknüpfung mit „Termine“ |

## Raumplanung (`rooms`) im Überblick

- **Räume** mit Plätzen, Fläche, geschätzten Heizkosten je Stunde, Sperrzeiten und frei konfigurierbaren **Merkmalen**
  (Klavier, Orgel, Beamer, ebenerdig, Küche …).
- **Buchen**: entweder einen bestimmten Raum **fest** (eigenes Recht) oder nur **Anforderungen** angeben
  (Personenzahl, Merkmale) – das System wählt den kleinsten bzw. am günstigsten zu heizenden passenden Raum.
- **Automatisches Umplanen**: kommt eine neue Buchung dazu, wird ein Raum gesperrt oder frei, werden flexible Buchungen
  neu verteilt (nie kurz vor dem Termin); Betroffene werden benachrichtigt. Neue Buchungen verdrängen nie bestehende.
- **Heizkosten sparen**: kleine Räume bevorzugt, aufeinanderfolgende Termine im selben (schon warmen) Raum, Serien
  bleiben möglichst jede Woche im selben Raum; Gesamtoptimierung mit Vorschau und Ersparnis in der Verwaltung.
- **Dauertermine**: wöchentlich (auch alle n Wochen, mehrere Wochentage), einzelne Termine absagbar.
- **Kalender**: Buchungen lassen sich mit Terminen aus dem Modul `events` (atrium-basic-modules) verknüpfen;
  `events` kann über den Dienst `RoomsService` Räume direkt am Termin buchen (`modules/rooms/contract.ts`).

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
