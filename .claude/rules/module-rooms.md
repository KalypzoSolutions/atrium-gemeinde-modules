---
paths: ["modules/rooms/**", "scripts/seed-demo-rooms.mjs"]
---

# Modul `rooms` (Räume / Raumplanung)

Raumbuchung für Kirchengemeinden. Schema `mod_rooms`, Version 1.0.0, keine harten Abhängigkeiten,
`optionalDependencies: events` (Termin verknüpfen; Gegenrichtung über `provides`). Navigation „Räume“ (Icon `house`,
`order` 15) und „Raumverwaltung“ (`admin: true`, Seite `/modules/rooms/admin`).

## Fachliche Regeln (Nutzerentscheidungen 2026-11-09)
- Buchen **fest** (bestimmter Raum, Recht `rooms.booking.fix`) oder **flexibel** nach Anforderungen: Personenzahl +
  konfigurierbare **Merkmale** (Klavier, Beamer, ebenerdig …). Buchungen gelten **sofort** (keine Genehmigung).
- Das System weist den **kleinsten bzw. günstigsten** passenden Raum zu (Heizkosten je Stunde am Raum, sonst
  wenigste freie Plätze) und plant flexible Buchungen **automatisch um**, wenn eine neue/geänderte Buchung das braucht
  oder ein Raum frei wird. Betroffene bekommen eine Benachrichtigung (`booking-moved`). Termine vor
  `heute + rooms.lockDays` (Standard 3) werden nicht mehr verlegt.
- **Wöchentliche Dauertermine** (`recurrence`: `freq: 'weekly'`, Intervall, Wochentage, Ende nie/bis/Anzahl),
  einzelne Termine absagbar (`booking_exceptions`). Kein „diesen und folgende“.
- Neue/geänderte Buchungen verdrängen **nie** bestehende Termine in „ohne Raum“: passt sie nicht → **409**
  `details.code = 'ROOMS_NO_ROOM'` + `details.conflicts`, nichts wird gespeichert. Ein bestehender Termin kann nur durch
  Verwaltungsänderungen (Sperrzeit, Raum gelöscht/verkleinert, Merkmal gelöscht) ohne Raum bleiben →
  Benachrichtigung `booking-unassigned` an Eigentümer*in + Raumverwaltung, Eintrag in „Zu erledigen“.
- Belegung ist für alle mit `rooms.booking.view` sichtbar (Titel, Zeit, Raum, Person). Bearbeiten: Eigentümer*in oder
  `rooms.booking.edit-all`; Buchungen aus Terminen (`managed_by_event`) nur über das Termine-Modul (sonst 409).

## Dateien
- `planner.ts` – **reine** Planung eines Tages (`planDay`): harte Regeln, Kostenfunktion, Tiefensuche mit Rücksprung,
  Verschiebe-/Tausch-Verbesserung, Rückstellen nach Priorität. Hauptfokus der Unit-Tests.
- `recurrence.ts` – wöchentliche Serien (reine Logik, auch im Browser).
- `planning.service.ts` – `loadPlanContext` (Einstellungen + heute, **vor** der Transaktion), `computePlan` (lädt
  Räume, Sperren, Buchungen, bisherige Zuweisungen; plant Tag für Tag), `applyPlan` (ersetzt alle Zuweisungen der
  geplanten Tage), `lockPlanning` (`pg_advisory_xact_lock(hashtext('rooms:plan'))`), `replan`.
- `data.ts` – SQL-Zugriffe; `bookings.service.ts` – Prüfung, Zugriff, Antworten; `notify.ts` – Benachrichtigungen.
- `rooms.endpoints.ts` (Merkmale, Räume, Sperrzeiten; jede Änderung plant den ganzen Zeitraum neu),
  `bookings.endpoints.ts`, `plan.endpoints.ts` (`/meta`, `/plan/preview|run`, Job `replan` täglich).
- `contract.ts` + `refs.service.ts` – `RoomsService` für `events`; `peer-contracts.ts` + `events-link.ts` – Termine suchen.
- `dashboard.ts` (Agenda-Art `room`, Todos „Kein Raum“), `search.ts`, `privacy.ts`.

## Datenmodell (`0001_init.sql`)
`features`, `rooms` (Kapazität, Fläche, `heating_cost_cents_per_hour`, buchbar), `room_features`, `room_blocks`
(Sperrzeiten), `bookings` (`mode`, `fixed_room_id`, `persons`, Datum + `HH:MM`, `recurrence` jsonb,
`recurrence_until` = letztes Vorkommen bzw. NULL, `event_id`, `managed_by_event`), `booking_features`,
`booking_exceptions`, `assignments(booking_id, occurrence_date, room_id NULL = ohne Raum)`.
Zuweisungen existieren nur von heute bis `heute + rooms.horizonDays` (Standard 180); der Job verlängert.

## Kosten (Einstellungen `rooms.weight.*`)
Heizkosten/h × Dauer + `oversizeCents` je freiem Platz + `moveCents` (100) bei Wechsel weg vom bisherigen Raum +
`seriesCents` (150) bei Abweichung vom Stammraum der Serie − `warmPercent` % einer Heizstunde, wenn im selben Raum
ein Termin mit ≤ `warmGapMinutes` Abstand vorausgeht. Puffer zwischen Belegungen `bufferMinutes` (15).

## Kopplung mit `events` (`RoomsService`)
`roomOptions`, `checkEventBooking` (Probelauf), `syncEventBooking` (anlegen/ersetzen; Fehler als `{ ok: false, code }`),
`removeEventBooking`, `eventRooms` (Anforderung + Zuweisungen je Termin). Nur einmalige oder wöchentliche Termine mit
Uhrzeit, eintägig (sonst `ROOMS_UNSUPPORTED`). Die Bearbeitungsrechte am Termin prüft `events`; `rooms` prüft
`rooms.booking.create`/`fix`. Gegenstück: Änderung in `atrium-basic-modules` → `events` v1.6.0.

## Tests
`tests/unit/planner.test.ts`, `recurrence.test.ts`, `tests/integration/rooms.test.ts` (Heute fest per
`setTodayForTests('2026-11-09')`, Termine ab dem 12.11. außerhalb des Sperrfensters).
