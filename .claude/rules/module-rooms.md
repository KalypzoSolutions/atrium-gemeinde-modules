---
paths: ["modules/rooms/**", "scripts/seed-demo-rooms.mjs"]
---

# Modul `rooms` (Räume / Raumplanung)

Raumbuchung für Kirchengemeinden. Schema `mod_rooms`, Version 1.0.0 (Migr. 0001 + 0002 „Raumplanung 2.0“), keine harten
Abhängigkeiten, `optionalDependencies: events`. Navigation „Räume“ (Icon `house`, `order` 15) und „Raumverwaltung“
(`admin: true`, `/modules/rooms/admin`). Konzept mit Mockups: Artifact „Raumplanung 2.0“.

## Fachliche Regeln (Nutzerentscheidungen 2026-11-09)
- **Drei Stufen** je Buchung (`mode`): `fixed` = nur dieser Raum, nie automatisch verlegt (Recht `rooms.booking.fix`);
  `similar` = „Raum wie dieser“ (Wunschraum in `fixed_room_id`, zieht nur um, wenn eine andere Gruppe genau diesen Raum
  braucht; Standard im Dialog); `flexible` = irgendein passender Raum.
- **Heizaufwand 1–10** je Raum (Regler in der Verwaltung) statt Euro. Planer nimmt den passenden Raum mit der niedrigsten
  Stufe, bei gleicher Stufe den kleinsten. Alte Spalte `heating_cost_cents_per_hour` bleibt ungenutzt (Migration hat
  daraus `heating_level` abgeleitet: 2,50 € je Stufe).
- **Gruppen** (`groups`: Name, Farbe, Vorrang 1–4): Farbe im Belegungsplan; Vorrang multipliziert die Wechsel-Strafe
  (Gottesdienst zieht seltener um als Fremdnutzung).
- Buchungen gelten sofort. Neue/geänderte Buchungen verdrängen nie bestehende in „ohne Raum“ → 409 `ROOMS_NO_ROOM`
  (`details.conflicts`, bei einmaligen Buchungen `details.swapOptions`).
- **Verlegungen** werden protokolliert (`moves`, `kind` auto|manual) mit **48 h Widerspruch** (`OBJECTION_HOURS`).
  Widerspruch → Benachrichtigung + „Zu erledigen“ für die Raumverwaltung, die ihn per Drag & Drop löst oder erledigt.
  **Fairness:** mehr als `MAX_AUTO_MOVES` (2) automatische Verlegungen einer Buchung in 30 Tagen → bleibt, wo sie ist.
  Kein Verlegen im Sperrfenster (`rooms.lockDays`, Standard 3).
- **Drag & Drop** (nur `rooms.room.manage`): beim Anfassen `GET …/occurrences/:date/targets` (je Raum `ok` + Grund),
  Ablegen nur auf passende Räume am selben Tag → `PUT …/occurrences/:date/room` (`scope` one|following, feste Buchungen
  nur mit `confirmFixed`, sonst 409 `ROOMS_CONFIRM_FIXED`). `one` legt den Termin fest (`booking_exceptions.pinned_room_id`,
  gilt für den Planer wie „fest“), `following` macht den Raum zum Wunschraum der Serie. Toast mit Rückgängig, Gruppe wird
  benachrichtigt. Tastatur-Alternative: „Verschieben nach …“ im Buchungsdialog.
- **Tauschanfragen** (`swap_requests`): nur einmalige Buchungen, Ziel = feste Buchung einer anderen Person, die den
  passenden Raum belegt und selbst in einen freien, passenden Raum ausweichen kann. Antwort bis
  `min(heute + 7, Vortag)`, danach `expired` (Job). Annehmen: feste Buchung an dem Tag in den Ausweichraum festgelegt,
  anfragende Buchung (`similar`, festgelegt im Raum) angelegt.
- Belegung für alle mit `rooms.booking.view` sichtbar; Bearbeiten: Eigentümer*in oder `rooms.booking.edit-all`;
  Buchungen aus Terminen (`managed_by_event`) nur über das Termine-Modul (einzelne Termine darf die Verwaltung ziehen).

## Dateien
- `planner.ts` – reine Tagesplanung (`planDay`): harte Regeln, Kosten (Heizaufwand × Stunden × 100, Überdimensionierung,
  Wechsel × Vorrang, Serie, `WISH_PENALTY` für „Raum wie dieser“, Rabatt „schon warm“), Tiefensuche + Verbesserung.
- `planning.service.ts` – `loadPlanContext`, `computePlan` (Festlegungen, Wunschraum, Vorrang, Fairness), `applyPlan`
  (Zuweisungen + Verlegungsprotokoll), `lockPlanning`, `replan` (`reason`/`actorId` fürs Protokoll).
- `placement.service.ts` (Drag & Drop, `dropTargets`, `bestTarget`), `moves.service.ts` (Protokoll, Widerspruch),
  `swaps.service.ts` (Tausch), `bookings.service.ts` (Prüfung, Raumvorschläge `roomCandidates`, `swapOptionsFor`).
- Endpunkte: `rooms.endpoints.ts`, `bookings.endpoints.ts`, `workflow.endpoints.ts` (Gruppen, Drag & Drop, Verlegungen,
  Tausch), `plan.endpoints.ts` (`/meta`, Optimierung, Job `replan`: Horizont, Nachoptimierung, abgelaufene Tauschanfragen).
- Oberfläche: `RoomsPage` (Woche Standard, Tag, Meine; Drag & Drop; Handy = Liste + runder Knopf), `BookingDialog`
  (Was · Wann · Raum, Satz-Zusammenfassung, Stufenkarten, Raumvorschläge, Tausch, Widerspruch, „Verschieben nach …“),
  `SwapDialog`, `RoomsAdmin` (Räume mit Heizaufwand-Regler, Merkmale, `GroupsPanel`, Optimierung), `HeatMeter`.

## Kopplung mit `events` (`RoomsService`)
`roomOptions`, `checkEventBooking`, `syncEventBooking`, `removeEventBooking`, `eventRooms`. `mode` akzeptiert auch
`similar`. Absagen aus dem Termin ersetzen nur Absagen; von Hand festgelegte Räume einzelner Termine bleiben.

## Tests
`tests/unit/planner.test.ts`, `recurrence.test.ts`; `tests/integration/rooms.test.ts` (Grundfunktionen),
`rooms-v2.test.ts` (Stufen, Widerspruch, Drag & Drop, Tausch, Gruppen), `rooms-migration.test.ts` (0001 → 0002).
Heute fest per `setTodayForTests('2026-11-09')`; Termine ab dem 12.11. liegen außerhalb des Sperrfensters.
