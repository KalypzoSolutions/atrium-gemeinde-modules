/**
 * Planungsablauf: lädt Räume, Sperrzeiten, Buchungen und bisherige Zuweisungen, plant jeden betroffenen Tag mit
 * `planDay` und schreibt das Ergebnis (`applyPlan`). Läuft innerhalb einer Modul-Transaktion; Einstellungen und
 * „heute“ werden VORHER mit `loadPlanContext` gelesen (Core-Dienst, nicht in der Transaktion).
 *
 * - Geplant werden nur Tage ab heute bis zum Planungshorizont (`rooms.horizonDays`); Vergangenes bleibt, wie es war.
 * - Termine vor `heute + rooms.lockDays` behalten ihren Raum (außer der Raum ist gesperrt oder gelöscht).
 * - „Betreff“-Buchungen (neu oder gerade geändert) haben die niedrigste Priorität und verdrängen nie bestehende
 *   Termine in „ohne Raum“; passt eine Betreff-Buchung nicht, entscheidet der Aufrufer (409, Transaktion zurückrollen).
 */
import { sql } from 'drizzle-orm';
import { addDays, core, inList, todayBerlin, type Tx } from '$lib/sdk/server';
import {
	autoMoveCounts,
	groupPriorities,
	insertMoves,
	loadAssignments,
	loadBlocks,
	loadBookingsInWindow,
	loadRooms,
	type BookingRow
} from './data';
import { heatingCostOf, planDay, type PlanRoom, type PlanSlot } from './planner';
import { expandDates } from './recurrence';
import {
	DEFAULT_PRIORITY,
	HEAT_POINTS_PER_LEVEL,
	MAX_AUTO_MOVES,
	OBJECTION_HOURS,
	SETTING,
	SETTING_DEFAULTS,
	toMinutes,
	type PlanConflict,
	type PlanMove,
	type PlanningSettings
} from './schemas';

export interface PlanContext {
	today: string;
	settings: PlanningSettings;
}

/** Einstellungen + „heute“ (außerhalb jeder Transaktion aufrufen) */
export async function loadPlanContext(): Promise<PlanContext> {
	const keys = Object.keys(SETTING) as (keyof typeof SETTING)[];
	const values = await core.settings.getMany(keys.map((k) => SETTING[k]));
	const settings = { ...SETTING_DEFAULTS } as PlanningSettings;
	for (const k of keys) {
		const v = Number(values[SETTING[k]]);
		if (Number.isFinite(v)) settings[k] = v;
	}
	return { today: todayBerlin(), settings };
}

export const horizonEnd = (pc: PlanContext) => addDays(pc.today, pc.settings.horizonDays);

/** Vorkommen einer Buchung im Planungszeitraum (ohne abgesagte) */
export function plannedDates(b: BookingRow, pc: PlanContext): string[] {
	const from = b.startsOn > pc.today ? b.startsOn : pc.today;
	return expandDates(b.startsOn, b.recurrence, from, horizonEnd(pc)).filter(
		(d) => !b.cancelled.has(d)
	);
}

/** Alle Tage von heute bis zum Horizont */
export function allPlanDates(pc: PlanContext, from = pc.today, to = horizonEnd(pc)): string[] {
	const out: string[] = [];
	for (let d = from < pc.today ? pc.today : from; d <= to; d = addDays(d, 1)) out.push(d);
	return out;
}

export interface PlanRequest {
	/** Zu planende Tage (Vergangenes wird ignoriert) */
	dates: Iterable<string>;
	/** Neue bzw. geänderte Buchungen (niedrigste Priorität, nie gesperrt) */
	subjectIds?: ReadonlySet<string>;
	/** Buchungen, die statt der gespeicherten gelten (Probelauf) */
	overlay?: readonly BookingRow[];
	/** Buchungen, die als gelöscht gelten (Probelauf) */
	remove?: ReadonlySet<string>;
	/** Anlass für das Verlegungsprotokoll, z. B. „Platz für „Kirchenchor““ */
	reason?: string | null;
	/** Wer die Änderung ausgelöst hat (Protokoll) */
	actorId?: string | null;
}

export interface PlannedEntry {
	bookingId: string;
	date: string;
	roomId: string | null;
}

export interface UnassignedEntry extends PlanConflict {
	bookingId: string;
	title: string;
	ownerId: string;
}

export interface PlanOutcome {
	dates: string[];
	entries: PlannedEntry[];
	moves: PlanMove[];
	/** Bestehende Termine, die ihren Raum verloren haben */
	unassigned: UnassignedEntry[];
	/** Nicht planbare Termine der Betreff-Buchungen */
	subjectConflicts: PlanConflict[];
	heatingBefore: number;
	heatingAfter: number;
	roomNames: Map<string, string>;
	bookings: Map<string, BookingRow>;
}

function mostCommon(values: (string | null | undefined)[]): string | null {
	const counts = new Map<string, number>();
	for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
	let best: string | null = null;
	let n = 0;
	for (const [v, c] of counts) {
		if (c > n || (c === n && best !== null && v < best)) {
			best = v;
			n = c;
		}
	}
	return best;
}

/** Plant die Tage, ohne zu schreiben. */
export async function computePlan(tx: Tx, pc: PlanContext, req: PlanRequest): Promise<PlanOutcome> {
	const dates = [...new Set(req.dates)].filter((d) => d >= pc.today).sort();
	const roomsRaw = await loadRooms(tx);
	const roomNames = new Map(roomsRaw.map((r) => [r.id, r.name]));
	const empty: PlanOutcome = {
		dates,
		entries: [],
		moves: [],
		unassigned: [],
		subjectConflicts: [],
		heatingBefore: 0,
		heatingAfter: 0,
		roomNames,
		bookings: new Map()
	};
	if (!dates.length) return empty;
	const from = dates[0]!;
	const to = dates.at(-1)!;
	const subject = req.subjectIds ?? new Set<string>();

	const blocks = await loadBlocks(tx, { from, to });
	const priorities = await groupPriorities(tx);
	// Fairness: wer in den letzten 30 Tagen schon oft automatisch verlegt wurde, bleibt, wo er ist
	const moveCounts = await autoMoveCounts(tx, addDays(pc.today, -30));
	const stored = await loadBookingsInWindow(tx, from, to);
	const bookings = new Map(stored.map((b) => [b.id, b]));
	for (const id of req.remove ?? []) bookings.delete(id);
	for (const b of req.overlay ?? []) bookings.set(b.id, b);

	// Bisherige Zuweisungen im ganzen Planungszeitraum (für den bevorzugten Serienraum)
	const before = await loadAssignments(tx, pc.today, horizonEnd(pc) > to ? horizonEnd(pc) : to);
	const preferred = new Map<string, string | null>();
	for (const b of bookings.values()) {
		if (!b.recurrence) continue;
		const rooms: (string | null)[] = [];
		for (const [key, roomId] of before) if (key.startsWith(`${b.id}:`)) rooms.push(roomId);
		preferred.set(b.id, mostCommon(rooms));
	}

	const lockUntil = addDays(pc.today, pc.settings.lockDays);
	const s = pc.settings;
	const weights = {
		bufferMinutes: s.bufferMinutes,
		warmGapMinutes: s.warmGapMinutes,
		oversizeCents: s.oversizeCents,
		moveCents: s.moveCents,
		seriesCents: s.seriesCents,
		warmPercent: s.warmPercent
	};

	const out: PlanOutcome = { ...empty, bookings };
	for (const date of dates) {
		const rooms: PlanRoom[] = roomsRaw.map((r) => ({
			id: r.id,
			capacity: r.capacity,
			featureIds: r.featureIds,
			heatingCentsPerHour: r.heatingLevel * HEAT_POINTS_PER_LEVEL,
			available:
				r.bookable &&
				!blocks.some((x) => x.roomId === r.id && x.startsOn <= date && x.endsOn >= date)
		}));
		const slots: PlanSlot[] = [];
		for (const b of bookings.values()) {
			if (b.cancelled.has(date)) continue;
			if (!expandDates(b.startsOn, b.recurrence, date, date).length) continue;
			const key = `${b.id}:${date}`;
			const current = before.has(key) ? (before.get(key) ?? null) : null;
			const isSubject = subject.has(b.id);
			slots.push({
				key,
				bookingId: b.id,
				start: toMinutes(b.startsAt),
				end: toMinutes(b.endsAt),
				persons: b.persons,
				featureIds: b.featureIds,
				// von Hand gelegt (Drag & Drop) gilt für diesen Tag wie „fest“
				fixedRoomId: b.pinned.get(date) ?? (b.mode === 'fixed' ? b.fixedRoomId : null),
				wishRoomId: b.mode === 'similar' ? b.fixedRoomId : null,
				moveWeight: b.groupId ? (priorities.get(b.groupId) ?? DEFAULT_PRIORITY) : DEFAULT_PRIORITY,
				locked:
					!isSubject &&
					current !== null &&
					(date < lockUntil || (moveCounts.get(b.id) ?? 0) >= MAX_AUTO_MOVES),
				currentRoomId: current,
				preferredRoomId: preferred.get(b.id) ?? null,
				priority: isSubject ? 0 : 1
			});
		}
		if (!slots.length) continue;
		const plan = planDay(rooms, slots, weights);
		out.heatingBefore += heatingCostOf(
			rooms,
			slots,
			new Map(slots.map((x) => [x.key, x.currentRoomId])),
			weights
		);
		out.heatingAfter += plan.heatingCost;
		const reasons = new Map(plan.unplaced.map((u) => [u.key, u]));
		for (const slot of slots) {
			const b = bookings.get(slot.bookingId)!;
			const roomId = plan.assignment.get(slot.key) ?? null;
			out.entries.push({ bookingId: b.id, date, roomId });
			// Serie ohne bisherigen Raum: der erste geplante Raum wird für die Folgewochen bevorzugt
			if (b.recurrence && roomId && !preferred.get(b.id)) preferred.set(b.id, roomId);
			const u = reasons.get(slot.key);
			if (subject.has(b.id)) {
				if (u) out.subjectConflicts.push({ date, reason: u.reason, busyRoomIds: u.busyRoomIds });
				continue;
			}
			if (roomId === slot.currentRoomId) continue;
			if (roomId === null && slot.currentRoomId !== null && u) {
				out.unassigned.push({
					date,
					reason: u.reason,
					busyRoomIds: u.busyRoomIds,
					bookingId: b.id,
					title: b.title,
					ownerId: b.ownerId
				});
			}
			if (!before.has(slot.key)) continue; // erstmals geplant (Horizont verlängert)
			out.moves.push({
				bookingId: b.id,
				title: b.title,
				date,
				fromRoomId: slot.currentRoomId,
				fromRoomName: slot.currentRoomId ? (roomNames.get(slot.currentRoomId) ?? null) : null,
				toRoomId: roomId,
				toRoomName: roomId ? (roomNames.get(roomId) ?? null) : null,
				ownerId: b.ownerId
			});
		}
	}
	return out;
}

/**
 * Schreibt die Zuweisungen der geplanten Tage (ersetzt alle Zuweisungen dieser Tage) und protokolliert automatische
 * Verlegungen bestehender Termine (mit Widerspruchsfrist).
 */
export async function applyPlan(
	tx: Tx,
	outcome: PlanOutcome,
	log: { reason?: string | null; actorId?: string | null } = {}
): Promise<void> {
	if (!outcome.dates.length) return;
	const logged = outcome.moves.filter((m) => m.toRoomId !== null);
	if (logged.length) {
		await insertMoves(
			tx,
			logged.map((m) => ({
				bookingId: m.bookingId,
				date: m.date,
				fromRoomId: m.fromRoomId,
				toRoomId: m.toRoomId
			})),
			{
				kind: 'auto',
				reason: log.reason ?? null,
				createdBy: log.actorId ?? null,
				objectionHours: OBJECTION_HOURS
			}
		);
	}
	for (let i = 0; i < outcome.dates.length; i += 200) {
		const chunk = outcome.dates.slice(i, i + 200);
		await tx.execute(
			sql`DELETE FROM assignments WHERE occurrence_date IN (${inList(chunk.map((d) => sql`${d}::date`))})`
		);
	}
	for (let i = 0; i < outcome.entries.length; i += 200) {
		const chunk = outcome.entries.slice(i, i + 200);
		const values = chunk.map((e) => sql`(${e.bookingId}, ${e.date}::date, ${e.roomId})`);
		await tx.execute(
			sql`INSERT INTO assignments (booking_id, occurrence_date, room_id)
				VALUES ${sql.join(values, sql`, `)}`
		);
	}
}

/** Sperre gegen gleichzeitige Planungen (am Anfang jeder schreibenden Transaktion) */
export async function lockPlanning(tx: Tx): Promise<void> {
	await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('rooms:plan'))`);
}

/** Plant und schreibt; liefert das Ergebnis (für Benachrichtigungen nach dem Commit). */
export async function replan(tx: Tx, pc: PlanContext, req: PlanRequest): Promise<PlanOutcome> {
	const outcome = await computePlan(tx, pc, req);
	await applyPlan(tx, outcome, { reason: req.reason, actorId: req.actorId });
	return outcome;
}
