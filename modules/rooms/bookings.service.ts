/**
 * Buchungen: Prüfung der Eingaben, Zugriff, Aufbau der Antworten (Vorkommen, Details, Raumvorschläge). Datenbankteile
 * laufen in der Transaktion des Aufrufers, Namen (`core.users.byIds`) werden danach ergänzt.
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
	loadBlocks,
	loadBookingsInWindow,
	loadGroups,
	loadRoom,
	loadRooms,
	type BookingRow,
	type BookingWrite
} from './data';
import { loadMovesFor, recentMoves } from './moves.service';
import { overlaps } from './planner';
import { horizonEnd, type PlanContext, type PlanOutcome } from './planning.service';
import { expandDates, lastOccurrence } from './recurrence';
import {
	MAX_OCCURRENCES,
	PERM_EDIT_ALL,
	PERM_FIX,
	ROOMS_NO_ROOM,
	needsRoom,
	toMinutes,
	type AvailabilityResult,
	type BookingDetail,
	type BookingMode,
	type Occurrence,
	type PlanConflict,
	type RecurrenceRule,
	type Room,
	type RoomCandidate,
	type SwapOption
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
	groupId?: string | null;
}

export function toWrite(spec: BookingSpec, managedByEvent = false): BookingWrite {
	return {
		...spec,
		roomId: needsRoom(spec.mode) ? spec.roomId : null,
		featureIds: [...new Set(spec.featureIds)],
		recurrenceUntil: spec.recurrence ? lastOccurrence(spec.startsOn, spec.recurrence) : null,
		managedByEvent,
		groupId: spec.groupId ?? null
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
		groupId: w.groupId,
		cancelled: new Set(),
		pinned: new Map()
	};
}

/**
 * Prüft Merkmale, Gruppe, (Wunsch-)Raum und Zeitraum (422). `isNew`: Beginn darf nicht in der Vergangenheit liegen.
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
	if (spec.groupId) {
		const rows = await rowsOf(tx, sql`SELECT 1 FROM groups WHERE id = ${spec.groupId}`);
		if (!rows.length) issues.push({ path: ['groupId'], message: 'Gruppe nicht gefunden' });
	}
	if (needsRoom(spec.mode) && spec.roomId) {
		const room = await loadRoom(tx, spec.roomId);
		if (!room) issues.push({ path: ['roomId'], message: 'Raum nicht gefunden' });
		else if (!room.bookable) {
			issues.push({ path: ['roomId'], message: 'Dieser Raum ist nicht buchbar' });
		} else if (room.capacity < spec.persons) {
			issues.push({
				path: ['persons'],
				message: `Der Raum „${room.name}“ fasst höchstens ${room.capacity} Personen`
			});
		} else if (spec.mode === 'similar') {
			const have = new Set(room.featureIds);
			if (spec.featureIds.some((f) => !have.has(f))) {
				issues.push({
					path: ['featureIds'],
					message: `Der Wunschraum „${room.name}“ hat nicht alle gewählten Merkmale`
				});
			}
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
export function noRoomError(conflicts: PlanConflict[], swapOptions: SwapOption[] = []): CoreError {
	const first = conflicts[0];
	const more = conflicts.length > 1 ? ` (und ${conflicts.length - 1} weitere Termine)` : '';
	const day = first ? first.date.split('-').reverse().join('.') : '';
	return new CoreError(
		'conflict',
		first ? `Kein Raum frei am ${day}${more}: ${first.reason}` : 'Kein Raum frei',
		{ code: ROOMS_NO_ROOM, conflicts: conflicts.slice(0, 60), swapOptions }
	);
}

// --- Raumvorschläge und Tauschpartner -------------------------------------------------------------

const range = (b: { startsAt: string; endsAt: string }) => ({
	start: toMinutes(b.startsAt),
	end: toMinutes(b.endsAt)
});

interface DayContext {
	rooms: Room[];
	blockedRoomIds: Set<string>;
	/** Raum → belegende Termine (nach der Planung) */
	occupants: Map<string, BookingRow[]>;
}

async function dayContext(
	tx: Tx,
	outcome: PlanOutcome,
	date: string,
	exceptId: string
): Promise<DayContext> {
	const rooms = await loadRooms(tx);
	const blocks = await loadBlocks(tx, { from: date, to: date });
	const occupants = new Map<string, BookingRow[]>();
	for (const e of outcome.entries) {
		if (e.date !== date || !e.roomId || e.bookingId === exceptId) continue;
		const b = outcome.bookings.get(e.bookingId);
		if (!b) continue;
		const list = occupants.get(e.roomId) ?? [];
		list.push(b);
		occupants.set(e.roomId, list);
	}
	return { rooms, blockedRoomIds: new Set(blocks.map((b) => b.roomId)), occupants };
}

function unsuitableReason(
	room: Room,
	req: { persons: number; featureIds: readonly string[] },
	featureNames: Map<string, string>,
	blocked: boolean
): string | null {
	if (!room.bookable) return 'Nicht buchbar';
	if (blocked) return 'Gesperrt';
	if (room.capacity < req.persons) return `Zu klein (${room.capacity} < ${req.persons})`;
	const have = new Set(room.featureIds);
	const missing = req.featureIds.filter((f) => !have.has(f)).map((f) => featureNames.get(f) ?? '?');
	return missing.length ? `Fehlt: ${missing.join(', ')}` : null;
}

function busyWith(
	occupants: BookingRow[] | undefined,
	slot: { start: number; end: number },
	buffer: number
): BookingRow | null {
	return occupants?.find((o) => overlaps(range(o), slot, buffer)) ?? null;
}

/** Räume für einen Termin der Buchung mit Status und Begründung (Buchungsdialog) */
export async function roomCandidates(
	tx: Tx,
	pc: PlanContext,
	outcome: PlanOutcome,
	subject: BookingRow,
	date: string
): Promise<RoomCandidate[]> {
	const ctx = await dayContext(tx, outcome, date, subject.id);
	const features = await rowsOf(tx, sql`SELECT id, name FROM features`);
	const featureNames = new Map(features.map((f) => [String(f.id), String(f.name)]));
	const assigned = outcome.entries.find(
		(e) => e.bookingId === subject.id && e.date === date
	)?.roomId;
	const slot = range(subject);
	const out = ctx.rooms.map((room): RoomCandidate => {
		const base = {
			roomId: room.id,
			name: room.name,
			capacity: room.capacity,
			heatingLevel: room.heatingLevel,
			featureIds: room.featureIds
		};
		const bad = unsuitableReason(room, subject, featureNames, ctx.blockedRoomIds.has(room.id));
		if (bad) return { ...base, status: 'unsuitable', reason: bad };
		const free = room.capacity - subject.persons;
		if (room.id === assigned) {
			return {
				...base,
				status: 'best',
				reason: free === 0 ? 'Passt genau' : `Passt · ${free} Plätze Luft`
			};
		}
		const other = busyWith(ctx.occupants.get(room.id), slot, pc.settings.bufferMinutes);
		if (other) {
			return {
				...base,
				status: 'busy',
				reason: `Belegt: ${other.title} ${other.startsAt}–${other.endsAt}`
			};
		}
		return { ...base, status: 'ok', reason: `Frei · ${free} Plätze Luft` };
	});
	const order = { best: 0, ok: 1, busy: 2, unsuitable: 3 } as const;
	return out.sort(
		(a, b) =>
			order[a.status] - order[b.status] ||
			a.heatingLevel - b.heatingLevel ||
			a.capacity - b.capacity ||
			a.name.localeCompare(b.name, 'de')
	);
}

/**
 * Tauschpartner, wenn eine einmalige Buchung keinen Raum findet: feste Buchungen anderer, die einen für die Anfrage
 * passenden Raum belegen und selbst in einen anderen freien, für sie passenden Raum ausweichen könnten.
 */
export async function swapOptionsFor(
	tx: Tx,
	pc: PlanContext,
	outcome: PlanOutcome,
	subject: BookingRow,
	ownerId: string | null
): Promise<SwapOption[]> {
	if (subject.recurrence || !outcome.subjectConflicts.length) return [];
	const date = outcome.subjectConflicts[0]!.date;
	const ctx = await dayContext(tx, outcome, date, subject.id);
	const slot = range(subject);
	const buffer = pc.settings.bufferMinutes;
	const noNames = new Map<string, string>();
	const out: SwapOption[] = [];
	for (const room of ctx.rooms) {
		if (unsuitableReason(room, subject, noNames, ctx.blockedRoomIds.has(room.id))) continue;
		const blockers = (ctx.occupants.get(room.id) ?? []).filter((o) =>
			overlaps(range(o), slot, buffer)
		);
		if (blockers.length !== 1) continue;
		const target = blockers[0]!;
		if (target.mode !== 'fixed' || target.ownerId === ownerId || target.managedByEvent) continue;
		const alt = ctx.rooms
			.filter(
				(r) =>
					r.id !== room.id &&
					!unsuitableReason(r, target, noNames, ctx.blockedRoomIds.has(r.id)) &&
					!busyWith(ctx.occupants.get(r.id), range(target), buffer)
			)
			.sort((a, b) => a.heatingLevel - b.heatingLevel || a.capacity - b.capacity)[0];
		if (!alt) continue;
		out.push({
			date,
			targetBookingId: target.id,
			targetTitle: target.title,
			roomId: room.id,
			roomName: room.name,
			proposedRoomId: alt.id,
			proposedRoomName: alt.name
		});
	}
	return out.slice(0, 5);
}

export async function availabilityOf(
	tx: Tx,
	pc: PlanContext,
	outcome: PlanOutcome,
	subject: BookingRow,
	beyondHorizon: number
): Promise<AvailabilityResult> {
	const mine = outcome.entries.filter((e) => e.bookingId === subject.id);
	const first = outcome.subjectConflicts[0]?.date ?? mine[0]?.date;
	return {
		ok: outcome.subjectConflicts.length === 0,
		assignments: mine.slice(0, 60).map((e) => ({
			date: e.date,
			roomId: e.roomId,
			roomName: e.roomId ? (outcome.roomNames.get(e.roomId) ?? null) : null
		})),
		moves: outcome.moves.filter((m) => m.bookingId !== subject.id).slice(0, 100),
		conflicts: outcome.subjectConflicts.slice(0, 60),
		beyondHorizon,
		candidates: first ? await roomCandidates(tx, pc, outcome, subject, first) : [],
		swapOptions: await swapOptionsFor(tx, pc, outcome, subject, subject.ownerId)
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
	filter: {
		from: string;
		to: string;
		roomId?: string;
		mine?: boolean;
		unassigned?: boolean;
		groupId?: string;
	}
): Promise<RawOccurrence[]> {
	const bookings = await loadBookingsInWindow(tx, filter.from, filter.to);
	const assigned = await loadAssignments(tx, filter.from, filter.to);
	const roomRows = await rowsOf(tx, sql`SELECT id, name FROM rooms`);
	const roomNames = new Map(roomRows.map((r) => [String(r.id), String(r.name)]));
	const groups = new Map((await loadGroups(tx)).map((g) => [g.id, g]));
	const moved = await recentMoves(tx, filter.from, filter.to);
	const out: RawOccurrence[] = [];
	for (const b of bookings) {
		if (filter.mine && b.ownerId !== ctx.userId) continue;
		if (filter.groupId && b.groupId !== filter.groupId) continue;
		const canEdit = canEditBooking(ctx, b);
		const group = b.groupId ? groups.get(b.groupId) : undefined;
		for (const date of expandDates(b.startsOn, b.recurrence, filter.from, filter.to)) {
			if (b.cancelled.has(date)) continue;
			const key = `${b.id}:${date}`;
			const roomId = assigned.get(key) ?? null;
			if (filter.roomId && roomId !== filter.roomId) continue;
			if (filter.unassigned && (roomId !== null || !assigned.has(key))) continue;
			const m = moved.get(key);
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
				managedByEvent: b.managedByEvent,
				groupId: b.groupId,
				groupName: group?.name ?? null,
				groupColor: group?.color ?? null,
				pinned: b.pinned.has(date),
				moved: m
					? {
							moveId: m.id,
							fromRoomName: m.fromRoomId ? (roomNames.get(m.fromRoomId) ?? null) : null,
							kind: m.kind,
							objectionOpen: m.objectionOpen
						}
					: null
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
			cancelled: b.cancelled.has(date),
			pinned: b.pinned.has(date)
		};
	});
	const group = b.groupId ? (await loadGroups(tx)).find((g) => g.id === b.groupId) : undefined;
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
		groupId: b.groupId,
		groupName: group?.name ?? null,
		upcoming,
		moves: await loadMovesFor(tx, ctx, { bookingId: b.id, from: pc.today })
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
