/**
 * Drag & Drop der Raumverwaltung: Termin von Hand in einen anderen Raum legen. Erlaubt ist nur ein Raum, der die
 * Anforderungen erfüllt (Plätze, Merkmale, buchbar, nicht gesperrt) und zu der Zeit frei ist (inklusive Puffer).
 *
 * - `one`: nur dieser Termin; er wird für diesen Tag festgelegt (`booking_exceptions.pinned_room_id`) und vom
 *   Planer nicht mehr verlegt.
 * - `following`: dieser und alle folgenden Termine einer Serie – der Raum wird Wunschraum der Buchung
 *   („Nach Anforderungen“ wird dabei zu „Raum wie dieser“, „Fest“ bleibt fest mit neuem Raum).
 * Feste Buchungen nur mit ausdrücklicher Bestätigung (`confirmFixed`). Jede Verlegung wird protokolliert
 * (`kind = 'manual'`) und die Gruppe benachrichtigt.
 */
import { sql } from 'drizzle-orm';
import { CoreError, errors, rowsOf, type RequestContext, type Tx } from '$lib/sdk/server';
import {
	insertMoves,
	loadAssignments,
	loadBlocks,
	loadBookingsInWindow,
	loadRooms,
	pinOccurrence,
	type BookingRow
} from './data';
import { overlaps } from './planner';
import { plannedDates, replan, type PlanContext, type PlanOutcome } from './planning.service';
import { isOccurrence } from './recurrence';
import { OBJECTION_HOURS, toMinutes, type DropTarget, type PlaceInput } from './schemas';

export const ROOMS_CONFIRM_FIXED = 'ROOMS_CONFIRM_FIXED';

const span = (b: { startsAt: string; endsAt: string }) => ({
	start: toMinutes(b.startsAt),
	end: toMinutes(b.endsAt)
});

/** Prüfung aller Räume für einen Termin (Grundlage für das Hervorheben beim Ziehen) */
export async function dropTargets(
	tx: Tx,
	pc: PlanContext,
	b: BookingRow,
	date: string
): Promise<DropTarget[]> {
	const rooms = await loadRooms(tx);
	const blocked = new Set((await loadBlocks(tx, { from: date, to: date })).map((x) => x.roomId));
	const assigned = await loadAssignments(tx, date, date);
	const current = assigned.get(`${b.id}:${date}`) ?? null;
	const others = (await loadBookingsInWindow(tx, date, date)).filter(
		(o) =>
			o.id !== b.id &&
			!o.cancelled.has(date) &&
			isOccurrence(o.startsOn, o.recurrence, date) &&
			assigned.get(`${o.id}:${date}`)
	);
	const featureRows = await rowsOf(tx, sql`SELECT id, name FROM features`);
	const featureNames = new Map(featureRows.map((f) => [String(f.id), String(f.name)]));
	const slot = span(b);
	return rooms.map((room): DropTarget => {
		const base = { roomId: room.id, current: room.id === current };
		if (room.id === current) return { ...base, ok: false, label: 'Aktueller Raum' };
		if (!room.bookable) return { ...base, ok: false, label: 'Nicht buchbar' };
		if (blocked.has(room.id)) return { ...base, ok: false, label: 'Gesperrt' };
		if (room.capacity < b.persons) {
			return { ...base, ok: false, label: `Zu klein (${room.capacity} < ${b.persons})` };
		}
		const have = new Set(room.featureIds);
		const missing = b.featureIds.filter((f) => !have.has(f));
		if (missing.length) {
			return {
				...base,
				ok: false,
				label: `Fehlt: ${missing.map((f) => featureNames.get(f) ?? '?').join(', ')}`
			};
		}
		const busy = others.find(
			(o) =>
				assigned.get(`${o.id}:${date}`) === room.id &&
				overlaps(span(o), slot, pc.settings.bufferMinutes)
		);
		if (busy) return { ...base, ok: false, label: `Belegt ${busy.startsAt}–${busy.endsAt}` };
		const free = room.capacity - b.persons;
		return {
			...base,
			ok: true,
			label:
				free === 0 ? `Passt genau (${b.persons} / ${room.capacity})` : `Passt · ${free} Plätze Luft`
		};
	});
}

export interface PlaceResult {
	outcome: PlanOutcome;
	fromRoomId: string | null;
}

/** Legt den Termin in den Raum (Prüfung wie `dropTargets`), plant den Tag bzw. die Serie neu */
export async function placeOccurrence(
	tx: Tx,
	ctx: RequestContext,
	pc: PlanContext,
	b: BookingRow,
	date: string,
	input: PlaceInput
): Promise<PlaceResult> {
	if (!isOccurrence(b.startsOn, b.recurrence, date) || b.cancelled.has(date)) {
		throw errors.notFound('Termin nicht gefunden');
	}
	if (date < pc.today) throw errors.badRequest('Vergangene Termine lassen sich nicht verschieben');
	if (b.mode === 'fixed' && !input.confirmFixed) {
		throw new CoreError('conflict', 'Feste Buchung wirklich verschieben?', {
			code: ROOMS_CONFIRM_FIXED
		});
	}
	const target = (await dropTargets(tx, pc, b, date)).find((t) => t.roomId === input.roomId);
	if (!target) throw errors.notFound('Raum nicht gefunden');
	if (!target.ok) {
		throw errors.validation([{ path: ['roomId'], message: target.label }]);
	}
	const assigned = await loadAssignments(tx, date, date);
	const fromRoomId = assigned.get(`${b.id}:${date}`) ?? null;

	// Zuweisung sofort setzen, damit der Planer den Termin dort vorfindet (keine automatische Gegenbewegung)
	await tx.execute(
		sql`INSERT INTO assignments (booking_id, occurrence_date, room_id)
			VALUES (${b.id}, ${date}::date, ${input.roomId})
			ON CONFLICT (booking_id, occurrence_date) DO UPDATE SET room_id = EXCLUDED.room_id, updated_at = now()`
	);
	let dates: string[] = [date];
	if (input.scope === 'following' && b.recurrence) {
		const mode = b.mode === 'flexible' ? 'similar' : b.mode;
		await tx.execute(
			sql`UPDATE bookings SET fixed_room_id = ${input.roomId}, mode = ${mode}, updated_at = now()
				WHERE id = ${b.id}`
		);
		// Festlegungen einzelner folgender Termine aufheben – jetzt gilt der neue Wunschraum
		await tx.execute(
			sql`UPDATE booking_exceptions SET pinned_room_id = NULL
				WHERE booking_id = ${b.id} AND occurrence_date >= ${date}::date`
		);
		dates = plannedDates(b, pc).filter((d) => d >= date);
	} else {
		await pinOccurrence(tx, b.id, date, input.roomId, ctx.userId);
	}
	await insertMoves(tx, [{ bookingId: b.id, date, fromRoomId, toRoomId: input.roomId }], {
		kind: 'manual',
		reason:
			input.scope === 'following'
				? 'Von der Raumverwaltung verschoben (Serie)'
				: 'Von der Raumverwaltung verschoben',
		createdBy: ctx.userId,
		objectionHours: OBJECTION_HOURS
	});
	const outcome = await replan(tx, pc, {
		dates,
		reason: `Raumverwaltung hat „${b.title}“ verschoben`,
		actorId: ctx.userId
	});
	return { outcome, fromRoomId };
}

/** Festlegung eines Termins aufheben (der Planer darf ihn wieder frei verteilen) */
export async function unpinOccurrence(
	tx: Tx,
	ctx: RequestContext,
	pc: PlanContext,
	b: BookingRow,
	date: string
): Promise<PlanOutcome> {
	if (!b.pinned.has(date)) throw errors.notFound('Termin ist nicht festgelegt');
	await pinOccurrence(tx, b.id, date, null, ctx.userId);
	return replan(tx, pc, { dates: [date], actorId: ctx.userId });
}

/** Bester freier Raum (geringster Heizaufwand, dann kleinster) unter den passenden Zielen */
export async function bestTarget(
	tx: Tx,
	targets: readonly DropTarget[]
): Promise<DropTarget | null> {
	const rooms = new Map((await loadRooms(tx)).map((r) => [r.id, r]));
	return (
		targets
			.filter((t) => t.ok)
			.sort((a, b) => {
				const ra = rooms.get(a.roomId)!;
				const rb = rooms.get(b.roomId)!;
				return ra.heatingLevel - rb.heatingLevel || ra.capacity - rb.capacity;
			})[0] ?? null
	);
}
