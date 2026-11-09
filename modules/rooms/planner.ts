/**
 * Raumplaner (reine Logik, ohne Datenbank): verteilt die Termine **eines Kalendertags** auf Räume.
 *
 * Harte Regeln
 * - Feste Buchungen bleiben in ihrem Raum; gesperrte Termine (kurz vor dem Termin) bleiben im bisherigen Raum.
 * - Flexible Buchungen: Kapazität ≥ Personen, alle geforderten Merkmale vorhanden, Raum buchbar und nicht gesperrt.
 * - Keine Überschneidung im selben Raum, inklusive Puffer (`bufferMinutes`) zwischen zwei Terminen.
 *
 * Kosten (kleiner ist besser, Einheit ≈ Cent)
 * - Heizkosten des Raums je Stunde × Dauer,
 * - Überdimensionierung: `oversizeCents` je freiem Platz (kleiner Raum bevorzugt, auch ohne Heizkosten-Angabe),
 * - Wechsel weg vom bisherigen Raum: `moveCents` (gegen unnötiges Hin-und-Her),
 * - Abweichung vom bevorzugten Raum einer Serie: `seriesCents` (jede Woche derselbe Raum),
 * - Rabatt „schon warm“: folgt ein Termin im selben Raum mit höchstens `warmGapMinutes` Abstand, spart er
 *   `warmPercent` % einer Heizstunde.
 *
 * Ablauf: am stärksten eingeschränkte Termine zuerst, Tiefensuche mit Rücksprung (Schrittgrenze), danach
 * Verbesserung durch Verschieben und paarweises Tauschen, solange die Gesamtkosten sinken. Geht nicht alles auf,
 * werden Termine mit niedrigster Priorität zuerst zurückgestellt (neue/geänderte Buchungen haben Priorität 0 und
 * verdrängen damit nie bestehende).
 */

export interface PlanRoom {
	id: string;
	capacity: number;
	featureIds: readonly string[];
	heatingCentsPerHour: number;
	/** Buchbar und an diesem Tag nicht gesperrt */
	available: boolean;
}

export interface PlanSlot {
	/** Eindeutig je Tag, üblicherweise `bookingId:datum` */
	key: string;
	bookingId: string;
	/** Minuten seit Mitternacht */
	start: number;
	end: number;
	persons: number;
	featureIds: readonly string[];
	/** Feste Buchung: nur dieser Raum */
	fixedRoomId: string | null;
	/** Nicht mehr verschieben (bleibt in `currentRoomId`, solange der Raum verfügbar ist) */
	locked: boolean;
	/** Bisher zugewiesener Raum */
	currentRoomId: string | null;
	/** Bevorzugter Raum der Serie (meist an den übrigen Terminen zugewiesen) */
	preferredRoomId: string | null;
	/** Höher = wird zuletzt zurückgestellt (bestehende Buchungen 1, neue/geänderte 0) */
	priority: number;
}

export interface PlanWeights {
	bufferMinutes: number;
	warmGapMinutes: number;
	oversizeCents: number;
	moveCents: number;
	seriesCents: number;
	warmPercent: number;
}

export interface Unplaced {
	key: string;
	reason: string;
	/** Räume, die passen würden, aber belegt sind */
	busyRoomIds: string[];
}

export interface DayPlan {
	/** Schlüssel → Raum (`null` = ohne Raum) */
	assignment: Map<string, string | null>;
	unplaced: Unplaced[];
	/** Gesamtkosten inkl. Strafen */
	cost: number;
	/** Nur Heizkosten (abzüglich „schon warm“) in Cent */
	heatingCost: number;
}

/** Höchstzahl Suchschritte je Tag */
const MAX_STEPS = 50_000;
/** Höchstzahl Verbesserungsrunden */
const MAX_ROUNDS = 25;

export const REASON_FIXED_UNAVAILABLE =
	'Der gewählte Raum ist an diesem Tag gesperrt oder nicht buchbar.';
export const REASON_NO_MATCH = 'Kein Raum erfüllt die Anforderungen (Personenzahl, Merkmale).';
export const REASON_BUSY = 'Alle passenden Räume sind zu dieser Zeit belegt.';

/** Erfüllt der Raum die Anforderungen einer flexiblen Buchung? */
export function roomMatches(
	room: PlanRoom,
	req: { persons: number; featureIds: readonly string[] }
): boolean {
	if (!room.available || room.capacity < req.persons) return false;
	const have = new Set(room.featureIds);
	return req.featureIds.every((f) => have.has(f));
}

/** Überschneiden sich zwei Termine (mit Puffer)? */
export function overlaps(
	a: { start: number; end: number },
	b: { start: number; end: number },
	buffer: number
): boolean {
	return a.start < b.end + buffer && b.start < a.end + buffer;
}

/** Heizkosten eines Termins in einem Raum (Cent, gerundet) */
export function heatingCents(room: PlanRoom, slot: { start: number; end: number }): number {
	return Math.round((room.heatingCentsPerHour * (slot.end - slot.start)) / 60);
}

/** Mögliche Räume eines Termins (ohne Rücksicht auf andere Termine), günstigste zuerst */
export function candidatesFor(
	slot: PlanSlot,
	rooms: readonly PlanRoom[],
	weights: PlanWeights
): PlanRoom[] {
	if (slot.fixedRoomId) {
		const r = rooms.find((x) => x.id === slot.fixedRoomId);
		return r && r.available ? [r] : [];
	}
	if (slot.locked && slot.currentRoomId) {
		const r = rooms.find((x) => x.id === slot.currentRoomId);
		if (r && r.available) return [r];
	}
	return rooms
		.filter((r) => roomMatches(r, slot))
		.sort(
			(a, b) =>
				baseCost(slot, a, weights) - baseCost(slot, b, weights) ||
				a.capacity - b.capacity ||
				(a.id < b.id ? -1 : 1)
		);
}

/** Kosten eines Termins in einem Raum ohne Nachbarschaftsrabatt */
export function baseCost(slot: PlanSlot, room: PlanRoom, w: PlanWeights): number {
	let cost = heatingCents(room, slot);
	if (!slot.fixedRoomId) cost += w.oversizeCents * Math.max(0, room.capacity - slot.persons);
	if (slot.currentRoomId && slot.currentRoomId !== room.id) cost += w.moveCents;
	if (slot.preferredRoomId && slot.preferredRoomId !== room.id) cost += w.seriesCents;
	return cost;
}

interface Costs {
	cost: number;
	heating: number;
}

function evaluate(
	slots: readonly PlanSlot[],
	assignment: ReadonlyMap<string, string | null>,
	roomById: ReadonlyMap<string, PlanRoom>,
	w: PlanWeights
): Costs {
	let cost = 0;
	let heating = 0;
	const byRoom = new Map<string, PlanSlot[]>();
	for (const s of slots) {
		const roomId = assignment.get(s.key);
		if (!roomId) continue;
		const room = roomById.get(roomId)!;
		cost += baseCost(s, room, w);
		heating += heatingCents(room, s);
		const list = byRoom.get(roomId) ?? [];
		list.push(s);
		byRoom.set(roomId, list);
	}
	for (const [roomId, list] of byRoom) {
		const room = roomById.get(roomId)!;
		const discount = Math.round((room.heatingCentsPerHour * w.warmPercent) / 100);
		if (!discount) continue;
		list.sort((a, b) => a.start - b.start);
		for (let i = 1; i < list.length; i++) {
			const gap = list[i]!.start - list[i - 1]!.end;
			if (gap <= w.warmGapMinutes) {
				const d = Math.min(discount, heatingCents(room, list[i]!));
				cost -= d;
				heating -= d;
			}
		}
	}
	return { cost, heating };
}

/** Passt der Termin in den Raum, ohne andere zugewiesene Termine zu überschneiden? */
function fits(
	slot: PlanSlot,
	roomId: string,
	slots: readonly PlanSlot[],
	assignment: ReadonlyMap<string, string | null>,
	buffer: number,
	ignore?: string
): boolean {
	for (const other of slots) {
		if (other.key === slot.key || other.key === ignore) continue;
		if (assignment.get(other.key) !== roomId) continue;
		if (overlaps(slot, other, buffer)) return false;
	}
	return true;
}

/** Tiefensuche über alle Termine; `null`, wenn keine vollständige Zuweisung gefunden wurde */
function search(
	slots: readonly PlanSlot[],
	cands: ReadonlyMap<string, PlanRoom[]>,
	buffer: number
): Map<string, string | null> | null {
	const order = [...slots].sort(
		(a, b) =>
			cands.get(a.key)!.length - cands.get(b.key)!.length ||
			b.priority - a.priority ||
			b.persons - a.persons ||
			b.end - b.start - (a.end - a.start) ||
			(a.key < b.key ? -1 : 1)
	);
	const assignment = new Map<string, string | null>();
	let steps = 0;
	const step = (i: number): boolean => {
		if (i === order.length) return true;
		if (++steps > MAX_STEPS) return false;
		const slot = order[i]!;
		for (const room of cands.get(slot.key)!) {
			if (!fits(slot, room.id, order, assignment, buffer)) continue;
			assignment.set(slot.key, room.id);
			if (step(i + 1)) return true;
			assignment.delete(slot.key);
		}
		return false;
	};
	return step(0) ? assignment : null;
}

/** Verbessert eine vollständige Zuweisung durch Verschieben und Tauschen (nur bewegliche Termine) */
function improve(
	slots: readonly PlanSlot[],
	cands: ReadonlyMap<string, PlanRoom[]>,
	assignment: Map<string, string | null>,
	roomById: ReadonlyMap<string, PlanRoom>,
	w: PlanWeights
): void {
	const movable = slots.filter((s) => assignment.get(s.key) && (cands.get(s.key)?.length ?? 0) > 1);
	let best = evaluate(slots, assignment, roomById, w).cost;
	for (let round = 0; round < MAX_ROUNDS; round++) {
		let improved = false;
		for (const s of movable) {
			const current = assignment.get(s.key)!;
			for (const room of cands.get(s.key)!) {
				if (room.id === current) continue;
				if (!fits(s, room.id, slots, assignment, w.bufferMinutes)) continue;
				assignment.set(s.key, room.id);
				const c = evaluate(slots, assignment, roomById, w).cost;
				if (c < best) {
					best = c;
					improved = true;
					break;
				}
				assignment.set(s.key, current);
			}
		}
		for (let i = 0; i < movable.length; i++) {
			for (let j = i + 1; j < movable.length; j++) {
				const a = movable[i]!;
				const b = movable[j]!;
				const ra = assignment.get(a.key)!;
				const rb = assignment.get(b.key)!;
				if (ra === rb) continue;
				if (!cands.get(a.key)!.some((r) => r.id === rb)) continue;
				if (!cands.get(b.key)!.some((r) => r.id === ra)) continue;
				assignment.set(a.key, rb);
				assignment.set(b.key, ra);
				const ok =
					fits(a, rb, slots, assignment, w.bufferMinutes) &&
					fits(b, ra, slots, assignment, w.bufferMinutes);
				const c = ok ? evaluate(slots, assignment, roomById, w).cost : Infinity;
				if (c < best) {
					best = c;
					improved = true;
				} else {
					assignment.set(a.key, ra);
					assignment.set(b.key, rb);
				}
			}
		}
		if (!improved) break;
	}
}

/** Heizkosten (Cent, abzüglich „schon warm“) einer bestehenden Zuweisung – für Vorher/Nachher-Vergleiche */
export function heatingCostOf(
	rooms: readonly PlanRoom[],
	slots: readonly PlanSlot[],
	assignment: ReadonlyMap<string, string | null>,
	weights: PlanWeights
): number {
	const roomById = new Map(rooms.map((r) => [r.id, r]));
	const known = new Map(
		[...assignment].filter(([, roomId]) => roomId === null || roomById.has(roomId))
	);
	return evaluate(slots, known, roomById, weights).heating;
}

/** Plant einen Kalendertag. */
export function planDay(
	rooms: readonly PlanRoom[],
	slots: readonly PlanSlot[],
	weights: PlanWeights
): DayPlan {
	const roomById = new Map(rooms.map((r) => [r.id, r]));
	const cands = new Map(slots.map((s) => [s.key, candidatesFor(s, rooms, weights)]));
	const buffer = weights.bufferMinutes;

	const unplaced: Unplaced[] = [];
	const noRoom = slots.filter((s) => cands.get(s.key)!.length === 0);
	for (const s of noRoom) {
		unplaced.push({
			key: s.key,
			reason: s.fixedRoomId ? REASON_FIXED_UNAVAILABLE : REASON_NO_MATCH,
			busyRoomIds: []
		});
	}
	let pool = slots.filter((s) => cands.get(s.key)!.length > 0);

	// Vollständig lösbar? Sonst Termine niedrigster Priorität zurückstellen.
	let assignment = search(pool, cands, buffer);
	const deferred: PlanSlot[] = [];
	const priorities = [...new Set(pool.map((s) => s.priority))].sort((a, b) => a - b);
	for (const p of priorities) {
		if (assignment) break;
		const drop = pool.filter((s) => s.priority === p);
		if (drop.length === pool.length) break;
		deferred.push(...drop);
		pool = pool.filter((s) => s.priority !== p);
		assignment = search(pool, cands, buffer);
	}
	if (!assignment) {
		// Rückfall: gierig in Suchreihenfolge, was nicht passt, bleibt ohne Raum
		assignment = new Map();
		deferred.push(...pool);
		pool = [];
	}
	// Zurückgestellte einzeln nachträglich einsetzen, wo noch Platz ist
	const placed = [...pool];
	for (const s of deferred.sort((a, b) => b.priority - a.priority)) {
		const room = cands.get(s.key)!.find((r) => fits(s, r.id, placed, assignment!, buffer));
		if (room) {
			assignment.set(s.key, room.id);
			placed.push(s);
		} else {
			unplaced.push({
				key: s.key,
				reason: REASON_BUSY,
				busyRoomIds: cands.get(s.key)!.map((r) => r.id)
			});
		}
	}
	improve(placed, cands, assignment, roomById, weights);
	for (const s of slots) if (!assignment.has(s.key)) assignment.set(s.key, null);
	const { cost, heating } = evaluate(slots, assignment, roomById, weights);
	return { assignment, unplaced, cost, heatingCost: heating };
}
