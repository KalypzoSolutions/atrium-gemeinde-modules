# Atrium – Gemeindemodule (Kalypzo Atrium) – Projekthinweise für Claude

Module für Kirchengemeinden (zuerst `rooms`, Raumplanung) für den Core **Kalypzo Atrium**. Der Core liegt als Git-Submodul
unter `.core` (fester Stand); seine Regeln gelten weiter: **`.core/.claude/CLAUDE.md`** und `.core/.claude/rules/*.md`
(vor allem `modules.md`, `architecture.md`, `ui-design.md`, `testing-and-verification.md`). Der Nutzer ist deutschsprachig.
Allgemeine Basismodule (u. a. `events` = Termine) liegen in `atrium-basic-modules` – Abhängigkeiten dorthin sind nur **optional**.

## Aufbau
- `modules/<id>/` – je Modul `atrium-module.json`, `module.ts`, `ui.ts`, `migrations/`, `pages/`, `tests/`; Katalog `modules/atrium-modules.json`.
- `scripts/` – `setup.mjs`, `core.mjs` (Befehle im Core mit `ATRIUM_MODULES_DIR=./modules`), Prüfskripte, Demo-Seeds `seed-demo-*.mjs`.
- `.claude/rules/module-<id>.md` – Regeln je Modul (laden per `paths:`).

## Befehle
| Befehl | Zweck |
|---|---|
| `bun run setup` | Core holen/installieren (`bun install`), `node_modules` → `.core/node_modules`, Modul-Pakete |
| `bun run check` / `bun run lint` / `bun run format` | Typen / Biome (Format + Lint) + Modulgrenzen / Biome-Korrekturen schreiben |
| `bun run test` | Tests der Module (`bun test`; `from 'bun:test'`, Helfer wie `waitFor`/`encodeMultipart` aus `$testing`) |
| `bun run build` / `bun run e2e` / `bun run demo` | Build / Playwright / Demo (:4300) |
| `bun run check:catalog` / `bun run check:migrations` | Katalog vollständig / angewendete Migrationen unverändert |

## Regeln (zusätzlich zu den Core-Regeln)
1. Nur Dateien unter `modules/`, `scripts/` und `.claude/` ändern – **nie** in `.core`.
2. Module importieren nur `$lib/sdk/*`, `$lib/components/{ui,layout,forms}` und `import type` aus fremden `contract.ts`;
   Module aus anderen Repos (z. B. `events`) über lokale Spiegel in `peer-contracts.ts`.
3. Version/Abhängigkeiten nur in `atrium-module.json`; neue Rechte in Manifest **und** JSON; Katalog pflegen.
4. Migrationen additiv und unveränderlich (`check:migrations`).
5. Texte deutsch mit echten Umlauten.
6. Nichts committen oder pushen, solange der Nutzer es nicht verlangt.
7. `eslint.config.js` entfernt leere `group`-Muster aus der Core-Konfiguration (Core-Grenzfall bei nur einem Modul).
