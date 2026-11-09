/**
 * Datenbank-Zugriffe des Moduls (nur innerhalb von `moduleDb(MODULE_ID).transaction`, keine Core-Dienste).
 */
import { sql } from 'drizzle-orm';
import { inList, num, rowsOf, type Row, type Tx } from '$lib/sdk/server';
import {
	recurrenceRule,
	type BookingMode,
	type Feature,
	type RecurrenceRule,
	type Room,
	type RoomBlock
} from './schemas';

export interface BookingRow {
	id: string;
	title: string;
	description: string | null;
	ownerId: string;
	createdBy: string | null;
	mode: BookingMode;
	fixedRoomId: string | null;
	persons: number;
	startsOn: string;
	startsAt: string;
	endsAt: string;
	recurrence: RecurrenceRule | null;
	recurrenceUntil: string | null;
	eventId: string | null;
	managedByEvent: boolean;
	featureIds: string[];
	/** Abgesagte Termine (ursprüngliches Datum) */
	cancelled: Set<string>;
}

const text = (v: unknown): string | null => (v == null || v === '' ? null : String(v));
const bool = (v: unknown): boolean => v === true || v === 't' || v === 'true';

function parseRule(v: unknown): RecurrenceRule | null {
	if (v == null) return null;
	const raw: unknown = typeof v === 'string' ? JSON.parse(v) : v;
	const r = recurrenceRule.safeParse(raw);
	return r.success ? r.data : null;
}

// --- Merkmale ----------------------------------------------------------------------------------

export async function loadFeatures(tx: Tx): Promise<Feature[]> {
	const rows = await rowsOf(
		tx,
		sql`SELECT f.id, f.name, f.icon, f.position,
				(SELECT count(*) FROM room_features rf WHERE rf.feature_id = f.id) AS room_count
			FROM features f ORDER BY f.position, lower(f.name), f.id`
	);
	return rows.map((r) => ({
		id: String(r.id),
		name: String(r.name),
		icon: text(r.icon),
		position: num(r.position),
		roomCount: num(r.room_count)
	}));
}

export async function existingFeatureIds(tx: Tx, ids: readonly string[]): Promise<Set<string>> {
	if (!ids.length) return new Set();
	const rows = await rowsOf(tx, sql`SELECT id FROM features WHERE id IN (${inList([...ids])})`);
	return new Set(rows.map((r) => String(r.id)));
}

// --- Räume -------------------------------------------------------------------------------------

function toRoom(r: Row, features: Map<string, string[]>): Room {
	const id = String(r.id);
	return {
		id,
		name: String(r.name),
		building: text(r.building),
		description: text(r.description),
		capacity: num(r.capacity),
		areaM2: r.area_m2 == null ? null : Number(r.area_m2),
		heatingCostCentsPerHour: num(r.heating_cost_cents_per_hour),
		bookable: bool(r.bookable),
		position: num(r.position),
		featureIds: features.get(id) ?? []
	};
}

export async function loadRooms(tx: Tx): Promise<Room[]> {
	const rows = await rowsOf(
		tx,
		sql`SELECT id, name, building, description, capacity, area_m2, heating_cost_cents_per_hour,
				bookable, position
			FROM rooms ORDER BY position, lower(name), id`
	);
	const links = await rowsOf(tx, sql`SELECT room_id, feature_id FROM room_features`);
	const features = new Map<string, string[]>();
	for (const l of links) {
		const list = features.get(String(l.room_id)) ?? [];
		list.push(String(l.feature_id));
		features.set(String(l.room_id), list);
	}
	return rows.map((r) => toRoom(r, features));
}

export async function loadRoom(tx: Tx, id: string): Promise<Room | null> {
	return (await loadRooms(tx)).find((r) => r.id === id) ?? null;
}

const BLOCK_COLUMNS = sql`id, room_id, to_char(starts_on, 'YYYY-MM-DD') AS starts_on,
	to_char(ends_on, 'YYYY-MM-DD') AS ends_on, reason`;

function toBlock(r: Row): RoomBlock {
	return {
		id: String(r.id),
		roomId: String(r.room_id),
		startsOn: String(r.starts_on),
		endsOn: String(r.ends_on),
		reason: text(r.reason)
	};
}

export async function loadBlocks(
	tx: Tx,
	window: { from: string; to: string } | null,
	roomId?: string
): Promise<RoomBlock[]> {
	const conds = [sql`TRUE`];
	if (window) {
		conds.push(sql`starts_on <= ${window.to}::date AND ends_on >= ${window.from}::date`);
	}
	if (roomId) conds.push(sql`room_id = ${roomId}`);
	const rows = await rowsOf(
		tx,
		sql`SELECT ${BLOCK_COLUMNS} FROM room_blocks WHERE ${sql.join(conds, sql` AND `)}
			ORDER BY starts_on, id`
	);
	return rows.map(toBlock);
}

// --- Buchungen ---------------------------------------------------------------------------------

const BOOKING_COLUMNS = sql`b.id, b.title, b.description, b.owner_id, b.created_by, b.mode,
	b.fixed_room_id, b.persons, to_char(b.starts_on, 'YYYY-MM-DD') AS starts_on, b.starts_at, b.ends_at,
	b.recurrence, to_char(b.recurrence_until, 'YYYY-MM-DD') AS recurrence_until, b.event_id,
	b.managed_by_event`;

async function hydrate(tx: Tx, rows: Row[]): Promise<BookingRow[]> {
	if (!rows.length) return [];
	const ids = rows.map((r) => String(r.id));
	const features = await rowsOf(
		tx,
		sql`SELECT booking_id, feature_id FROM booking_features WHERE booking_id IN (${inList(ids)})`
	);
	const exceptions = await rowsOf(
		tx,
		sql`SELECT booking_id, to_char(occurrence_date, 'YYYY-MM-DD') AS d FROM booking_exceptions
			WHERE cancelled AND booking_id IN (${inList(ids)})`
	);
	const fMap = new Map<string, string[]>();
	for (const f of features) {
		const list = fMap.get(String(f.booking_id)) ?? [];
		list.push(String(f.feature_id));
		fMap.set(String(f.booking_id), list);
	}
	const xMap = new Map<string, Set<string>>();
	for (const x of exceptions) {
		const set = xMap.get(String(x.booking_id)) ?? new Set<string>();
		set.add(String(x.d));
		xMap.set(String(x.booking_id), set);
	}
	return rows.map((r) => {
		const id = String(r.id);
		return {
			id,
			title: String(r.title),
			description: text(r.description),
			ownerId: String(r.owner_id),
			createdBy: text(r.created_by),
			mode: String(r.mode) === 'fixed' ? 'fixed' : 'flexible',
			fixedRoomId: text(r.fixed_room_id),
			persons: num(r.persons),
			startsOn: String(r.starts_on),
			startsAt: String(r.starts_at),
			endsAt: String(r.ends_at),
			recurrence: parseRule(r.recurrence),
			recurrenceUntil: text(r.recurrence_until),
			eventId: text(r.event_id),
			managedByEvent: bool(r.managed_by_event),
			featureIds: fMap.get(id) ?? [],
			cancelled: xMap.get(id) ?? new Set()
		};
	});
}

export async function loadBooking(tx: Tx, id: string): Promise<BookingRow | null> {
	const rows = await rowsOf(tx, sql`SELECT ${BOOKING_COLUMNS} FROM bookings b WHERE b.id = ${id}`);
	return (await hydrate(tx, rows))[0] ?? null;
}

export async function loadBookingByEvent(tx: Tx, eventId: string): Promise<BookingRow | null> {
	const rows = await rowsOf(
		tx,
		sql`SELECT ${BOOKING_COLUMNS} FROM bookings b WHERE b.event_id = ${eventId} AND b.managed_by_event`
	);
	return (await hydrate(tx, rows))[0] ?? null;
}

/** Buchungen, die im Zeitraum mindestens ein Vorkommen haben können (SQL-Vorfilter) */
export async function loadBookingsInWindow(
	tx: Tx,
	from: string,
	to: string
): Promise<BookingRow[]> {
	const rows = await rowsOf(
		tx,
		sql`SELECT ${BOOKING_COLUMNS} FROM bookings b
			WHERE b.starts_on <= ${to}::date
				AND ((b.recurrence IS NULL AND b.starts_on >= ${from}::date)
					OR (b.recurrence IS NOT NULL
						AND (b.recurrence_until IS NULL OR b.recurrence_until >= ${from}::date)))
			ORDER BY b.starts_on, b.starts_at, b.id`
	);
	return hydrate(tx, rows);
}

/** Zugewiesene Räume im Zeitraum: `bookingId:datum` → Raum */
export async function loadAssignments(
	tx: Tx,
	from: string,
	to: string
): Promise<Map<string, string | null>> {
	const rows = await rowsOf(
		tx,
		sql`SELECT booking_id, to_char(occurrence_date, 'YYYY-MM-DD') AS d, room_id FROM assignments
			WHERE occurrence_date BETWEEN ${from}::date AND ${to}::date`
	);
	return new Map(rows.map((r) => [`${String(r.booking_id)}:${String(r.d)}`, text(r.room_id)]));
}

export interface BookingWrite {
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
	recurrenceUntil: string | null;
	eventId: string | null;
	managedByEvent: boolean;
}

export async function insertBooking(
	tx: Tx,
	id: string,
	ownerId: string,
	createdBy: string | null,
	b: BookingWrite
): Promise<void> {
	await tx.execute(
		sql`INSERT INTO bookings (id, title, description, owner_id, created_by, mode, fixed_room_id, persons,
				starts_on, starts_at, ends_at, recurrence, recurrence_until, event_id, managed_by_event)
			VALUES (${id}, ${b.title}, ${b.description}, ${ownerId}, ${createdBy}, ${b.mode},
				${b.mode === 'fixed' ? b.roomId : null}, ${b.persons}, ${b.startsOn}::date, ${b.startsAt},
				${b.endsAt}, ${b.recurrence ? JSON.stringify(b.recurrence) : null}::jsonb,
				${b.recurrenceUntil}::date, ${b.eventId}, ${b.managedByEvent})`
	);
	await replaceBookingFeatures(tx, id, b.featureIds);
}

export async function updateBooking(tx: Tx, id: string, b: BookingWrite): Promise<void> {
	await tx.execute(
		sql`UPDATE bookings SET title = ${b.title}, description = ${b.description}, mode = ${b.mode},
				fixed_room_id = ${b.mode === 'fixed' ? b.roomId : null}, persons = ${b.persons},
				starts_on = ${b.startsOn}::date, starts_at = ${b.startsAt}, ends_at = ${b.endsAt},
				recurrence = ${b.recurrence ? JSON.stringify(b.recurrence) : null}::jsonb,
				recurrence_until = ${b.recurrenceUntil}::date, event_id = ${b.eventId}, updated_at = now()
			WHERE id = ${id}`
	);
	await replaceBookingFeatures(tx, id, b.featureIds);
}

async function replaceBookingFeatures(tx: Tx, id: string, featureIds: string[]): Promise<void> {
	await tx.execute(sql`DELETE FROM booking_features WHERE booking_id = ${id}`);
	for (const f of new Set(featureIds)) {
		await tx.execute(
			sql`INSERT INTO booking_features (booking_id, feature_id) VALUES (${id}, ${f})`
		);
	}
}
