/**
 * Buchungen: Prüfung der Eingaben, Zugriff, Aufbau der Antworten (Vorkommen, Details). Datenbankteile laufen in
 * der Transaktion des Aufrufers, Namen (`core.users.byIds`) werden danach ergänzt.
 */
import { sql } from 'drizzle-orm';
import {
	addDays,
	core,
	CoreError,
	errors,
	rowsOf,
	userLabel,
	type RequestContext,
	type Tx
} from '$lib/sdk/server';
import {
	existingFeatureIds,
	loadAssignments,
	loadBookingsInWindow,
	loadRoom,
	type BookingRow,
	type BookingWrite
} from './data';
import { horizonEnd, type PlanContext, type PlanOutcome } from './planning.service';
import { expandDates, lastOccurrence } from './recurrence';
import {
	MAX_OCCURRENCES,
	PERM_EDIT_ALL,
	PERM_FIX,
	ROOMS_NO_ROOM,
	type AvailabilityResult,
	type BookingDetail,
	type BookingMode,
	type Occurrence,
	type PlanConflict,
	type RecurrenceRule
} from './schemas';

export interface BookingSpec {
	title: string;
	description: string | null;
	mode: BookingMode;
	roomId: string | null;
	persons: number;
	featureIds: string[];
	startsOn: string;
	startsAt: string;
	endsAt: string;
	recurrence: RecurrenceRule | null;
	eventId: string | null;
}

export function toWrite(spec: BookingSpec, managedByEvent = false): BookingWrite {
	return {
		...spec,
		roomId: spec.mode === 'fixed' ? spec.roomId : null,
		featureIds: [...new Set(spec.featureIds)],
		recurrenceUntil: spec.recurrence ? lastOccurrence(spec.startsOn, spec.recurrence) : null,
		managedByEvent
	};
}

/** Virtuelle Buchung für Probeläufe */
export function virtualBooking(id: string, ownerId: string, spec: BookingSpec): BookingRow {
	const w = toWrite(spec);
	return {
		id,
		title: w.title,
		description: w.description,
		ownerId,
		createdBy: ownerId,
		mode: w.mode,
		fixedRoomId: w.roomId,
		persons: w.persons,
		startsOn: w.startsOn,
		startsAt: w.startsAt,
		endsAt: w.endsAt,
		recurrence: w.recurrence,
		recurrenceUntil: w.recurrenceUntil,
		eventId: w.eventId,
		managedByEvent: false,
		featureIds: w.featureIds,
		cancelled: new Set()
	};
}

/**
 * Prüft Merkmale, festen Raum und Zeitraum (422). `isNew`: Beginn darf nicht in der Vergangenheit liegen.
 * Das Recht für feste Buchungen prüft der Aufrufer VOR der Transaktion (`requireFixPermission`).
 */
export async function validateSpec(
	tx: Tx,
	pc: PlanContext,
	spec: BookingSpec,
	opts: { isNew: boolean; previousStartsOn?: string }
): Promise<void> {
	const issues: { path: (string | number)[]; message: string }[] = [];
	const known = await existingFeatureIds(tx, spec.featureIds);
	spec.featureIds.forEach((f, i) => {
		if (!known.has(f)) issues.push({ path: ['featureIds', i], message: 'Unbekanntes Merkmal' });
	});
	if (spec.mode === 'fixed' && spec.roomId) {
		const room = await loadRoom(tx, spec.roomId);
		if (!room) issues.push({ path: ['roomId'], message: 'Raum nicht gefunden' });
		else if (!room.bookable) {
			issues.push({ path: ['roomId'], message: 'Dieser Raum ist nicht buchbar' });
		} else if (room.capacity < spec.persons) {
			issues.push({
				path: ['persons'],
				message: `Der Raum „${room.name}“ fasst höchstens ${room.capacity} Personen`
			});
		}
	}
	const earliest =
		opts.previousStartsOn && opts.previousStartsOn < pc.today ? opts.previousStartsOn : pc.today;
	if ((opts.isNew || spec.startsOn !== opts.previousStartsOn) && spec.startsOn < earliest) {
		issues.push({ path: ['startsOn'], message: 'Der Termin liegt in der Vergangenheit' });
	}
	if (spec.startsOn > horizonEnd(pc)) {
		issues.push({
			path: ['startsOn'],
			message: `Buchungen sind höchstens ${pc.settings.horizonDays} Tage im Voraus möglich`
		});
	}
	if (issues.length) throw errors.validation(issues);
}

export async function requireFixPermission(ctx: RequestContext, spec: { mode: BookingMode }) {
	if (spec.mode === 'fixed') await core.permissions.require(ctx, PERM_FIX);
}

export function canEditBooking(ctx: RequestContext, b: BookingRow): boolean {
	if (b.managedByEvent) return false;
	if (ctx.actor.type === 'system') return true;
	return b.ownerId === ctx.userId || core.permissions.has(ctx, PERM_EDIT_ALL);
}

/** 404 für Unbekannte, 409 für Buchungen aus dem Termine-Modul, 403 ohne Bearbeitungsrecht */
export function requireEditable(ctx: RequestContext, b: BookingRow | null): BookingRow {
	if (!b) throw errors.notFound('Buchung nicht gefunden');
	if (b.managedByEvent) {
		throw errors.conflict('Diese Buchung gehört zu einem Termin und wird dort bearbeitet');
	}
	if (!canEditBooking(ctx, b)) throw errors.forbidden('Keine Berechtigung für diese Buchung');
	return b;
}

/** 409 mit den nicht planbaren Terminen (die Transaktion rollt zurück) */
export function noRoomError(conflicts: PlanConflict[]): CoreError {
	const first = conflicts[0];
	const more = conflicts.length > 1 ? ` (und ${conflicts.length - 1} weitere Termine)` : '';
	const day = first ? first.date.split('-').reverse().join('.') : '';
	return new CoreError(
		'conflict',
		first ? `Kein Raum frei am ${day}${more}: ${first.reason}` : 'Kein Raum frei',
		{ code: ROOMS_NO_ROOM, conflicts: conflicts.slice(0, 60) }
	);
}

export function availabilityOf(
	outcome: PlanOutcome,
	bookingId: string,
	beyondHorizon: number
): AvailabilityResult {
	const mine = outcome.entries.filter((e) => e.bookingId === bookingId);
	return {
		ok: outcome.subjectConflicts.length === 0,
		assignments: mine.slice(0, 60).map((e) => ({
			date: e.date,
			roomId: e.roomId,
			roomName: e.roomId ? (outcome.roomNames.get(e.roomId) ?? null) : null
		})),
		moves: outcome.moves.filter((m) => m.bookingId !== bookingId).slice(0, 100),
		conflicts: outcome.subjectConflicts.slice(0, 60),
		beyondHorizon
	};
}

/** Anzahl der Vorkommen nach dem Horizont (noch nicht geplant), höchstens 999 */
export function countBeyondHorizon(pc: PlanContext, spec: BookingSpec): number {
	if (!spec.recurrence) return 0;
	const start = addDays(horizonEnd(pc), 1);
	return expandDates(spec.startsOn, spec.recurrence, start, addDays(start, 3650), 999).length;
}

// --- Antworten ---------------------------------------------------------------------------------

type RawOccurrence = Omit<Occurrence, 'ownerName'>;

/** Vorkommen im Zeitraum (ohne Namen) */
export async function listOccurrences(
	tx: Tx,
	ctx: RequestContext,
	filter: { from: string; to: string; roomId?: string; mine?: boolean; unassigned?: boolean }
): Promise<RawOccurrence[]> {
	const bookings = await loadBookingsInWindow(tx, filter.from, filter.to);
	const assigned = await loadAssignments(tx, filter.from, filter.to);
	const roomRows = await rowsOf(tx, sql`SELECT id, name FROM rooms`);
	const roomNames = new Map(roomRows.map((r) => [String(r.id), String(r.name)]));
	const out: RawOccurrence[] = [];
	for (const b of bookings) {
		if (filter.mine && b.ownerId !== ctx.userId) continue;
		const canEdit = canEditBooking(ctx, b);
		for (const date of expandDates(b.startsOn, b.recurrence, filter.from, filter.to)) {
			if (b.cancelled.has(date)) continue;
			const key = `${b.id}:${date}`;
			const roomId = assigned.get(key) ?? null;
			if (filter.roomId && roomId !== filter.roomId) continue;
			if (filter.unassigned && (roomId !== null || !assigned.has(key))) continue;
			out.push({
				key,
				bookingId: b.id,
				date,
				title: b.title,
				startsAt: b.startsAt,
				endsAt: b.endsAt,
				mode: b.mode,
				persons: b.persons,
				featureIds: b.featureIds,
				roomId,
				roomName: roomId ? (roomNames.get(roomId) ?? null) : null,
				planned: assigned.has(key),
				recurring: !!b.recurrence,
				ownerId: b.ownerId,
				mine: b.ownerId === ctx.userId,
				canEdit,
				eventId: b.eventId,
				managedByEvent: b.managedByEvent
			});
			if (out.length >= MAX_OCCURRENCES) break;
		}
	}
	return out.sort(
		(a, b) =>
			(a.date < b.date ? -1 : a.date > b.date ? 1 : 0) ||
			(a.startsAt < b.startsAt ? -1 : a.startsAt > b.startsAt ? 1 : 0) ||
			(a.title < b.title ? -1 : 1)
	);
}

/** Ergänzt Namen der Eigentümer*innen (außerhalb der Transaktion) */
export async function withOwnerNames(
	ctx: RequestContext,
	items: RawOccurrence[]
): Promise<Occurrence[]> {
	const users = await core.users.byIds(ctx, new Set(items.map((i) => i.ownerId)));
	return items.map((i) => ({ ...i, ownerName: userLabel(users, i.ownerId) }));
}

export type RawDetail = Omit<BookingDetail, 'ownerName' | 'eventTitle'>;

export async function buildDetail(
	tx: Tx,
	ctx: RequestContext,
	pc: PlanContext,
	b: BookingRow
): Promise<RawDetail> {
	const until = addDays(pc.today, 366);
	const assigned = await loadAssignments(tx, pc.today, until);
	const roomRows = await rowsOf(tx, sql`SELECT id, name FROM rooms`);
	const roomNames = new Map(roomRows.map((r) => [String(r.id), String(r.name)]));
	const from = b.startsOn > pc.today ? b.startsOn : pc.today;
	const upcoming = expandDates(b.startsOn, b.recurrence, from, until, 30).map((date) => {
		const roomId = assigned.get(`${b.id}:${date}`) ?? null;
		return {
			date,
			roomId,
			roomName: roomId ? (roomNames.get(roomId) ?? null) : null,
			cancelled: b.cancelled.has(date)
		};
	});
	return {
		id: b.id,
		title: b.title,
		description: b.description,
		mode: b.mode,
		roomId: b.fixedRoomId,
		persons: b.persons,
		featureIds: b.featureIds,
		startsOn: b.startsOn,
		startsAt: b.startsAt,
		endsAt: b.endsAt,
		recurrence: b.recurrence,
		eventId: b.eventId,
		managedByEvent: b.managedByEvent,
		ownerId: b.ownerId,
		canEdit: canEditBooking(ctx, b),
		cancelledDates: [...b.cancelled].sort(),
		upcoming
	};
}

/** Namen + Termintitel ergänzen (außerhalb der Transaktion) */
export async function finishDetail(
	ctx: RequestContext,
	d: RawDetail,
	eventTitle: (ctx: RequestContext, id: string) => Promise<string | null>
): Promise<BookingDetail> {
	const users = await core.users.byIds(ctx, [d.ownerId]);
	return {
		...d,
		ownerName: userLabel(users, d.ownerId),
		eventTitle: d.eventId ? await eventTitle(ctx, d.eventId) : null
	};
}
