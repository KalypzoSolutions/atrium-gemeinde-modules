/**
 * Dienst `RoomsService` für andere Module (siehe `contract.ts`): Raumbuchung direkt am Termin (`events`).
 * Buchungen aus Terminen sind `managed_by_event` (je Termin höchstens eine) und werden nur über diesen Dienst
 * geändert. Fehler werden als `{ ok: false, code, message }` geliefert, nie geworfen (außer Programmierfehlern).
 */
import { sql } from 'drizzle-orm';
import {
	addDays,
	core,
	inList,
	isCoreError,
	moduleDb,
	rowsOf,
	type RequestContext,
	type Tx
} from '$lib/sdk/server';
import {
	availabilityOf,
	noRoomError,
	toWrite,
	validateSpec,
	virtualBooking,
	type BookingSpec
} from './bookings.service';
import type {
	EventRoomInfo,
	EventRoomResult,
	EventRoomSpec,
	RoomOptions,
	RoomsService
} from './contract';
import {
	insertBooking,
	loadAssignments,
	loadBookingByEvent,
	loadFeatures,
	loadRooms,
	updateBooking,
	type BookingRow
} from './data';
import { notifyPlanChanges } from './notify';
import {
	computePlan,
	loadPlanContext,
	lockPlanning,
	plannedDates,
	replan,
	type PlanContext
} from './planning.service';
import {
	MODULE_ID,
	PERM_CREATE,
	PERM_FIX,
	PERM_VIEW,
	ROOMS_NO_ROOM,
	bookingInput,
	recurrenceRule,
	type PlanConflict
} from './schemas';

type Failure = Extract<EventRoomResult, { ok: false }>;

const fail = (code: Failure['code'], message: string, conflicts: PlanConflict[] = []): Failure => ({
	ok: false,
	code,
	message,
	conflicts: conflicts.map((c) => ({ date: c.date, reason: c.reason }))
});

const has = (ctx: RequestContext, perm: string) =>
	ctx.actor.type === 'system' || core.permissions.has(ctx, perm);

/** Termin-Angaben → Buchung; Fehler als `Failure` */
export function specFromEvent(eventId: string | null, spec: EventRoomSpec): BookingSpec | Failure {
	if (!spec.startsAt || !spec.endsAt) {
		return fail('ROOMS_UNSUPPORTED', 'Für eine Raumbuchung braucht der Termin Beginn und Ende');
	}
	if (spec.endsOn && spec.endsOn !== spec.startsOn) {
		return fail('ROOMS_UNSUPPORTED', 'Mehrtägige Termine können keinen Raum buchen');
	}
	let recurrence = null;
	if (spec.recurrence) {
		const r = spec.recurrence as Record<string, unknown>;
		if (r.freq !== 'weekly') {
			return fail(
				'ROOMS_UNSUPPORTED',
				'Raumbuchung gibt es nur für einmalige oder wöchentliche Termine'
			);
		}
		const parsed = recurrenceRule.safeParse({
			freq: 'weekly',
			interval: r.interval ?? 1,
			byWeekday: Array.isArray(r.byWeekday) && r.byWeekday.length ? r.byWeekday : undefined,
			end: r.end ?? { type: 'never' }
		});
		if (!parsed.success) {
			return fail('ROOMS_UNSUPPORTED', 'Diese Wiederholung wird für Räume nicht unterstützt');
		}
		recurrence = parsed.data;
	}
	const input = bookingInput.safeParse({
		title: spec.title.slice(0, 200) || 'Termin',
		description: null,
		mode: spec.mode,
		roomId: spec.roomId,
		persons: spec.persons,
		featureIds: spec.featureIds,
		startsOn: spec.startsOn,
		startsAt: spec.startsAt,
		endsAt: spec.endsAt,
		recurrence,
		eventId
	});
	if (!input.success) {
		return fail('ROOMS_INVALID', input.error.issues[0]?.message ?? 'Ungültige Raum-Anforderung');
	}
	return input.data;
}

async function permissionFailure(
	ctx: RequestContext,
	spec: { mode: string }
): Promise<Failure | null> {
	if (!has(ctx, PERM_VIEW) || !has(ctx, PERM_CREATE)) {
		return fail('ROOMS_FORBIDDEN', 'Keine Berechtigung, Räume zu buchen');
	}
	if (spec.mode === 'fixed' && !has(ctx, PERM_FIX)) {
		return fail('ROOMS_FORBIDDEN', 'Keine Berechtigung, einen bestimmten Raum fest zu buchen');
	}
	return null;
}

/** Fehler aus Prüfung/Planung als `Failure` (andere Fehler weiterwerfen) */
function asFailure(e: unknown): Failure {
	if (isCoreError(e)) {
		const details = e.details as { code?: string; conflicts?: PlanConflict[] } | undefined;
		if (e.code === 'conflict' && details?.code === ROOMS_NO_ROOM) {
			return fail('ROOMS_NO_ROOM', e.message, details.conflicts ?? []);
		}
		if (e.code === 'validation_failed') {
			const issues = e.details as { message?: string }[] | undefined;
			return fail('ROOMS_INVALID', issues?.[0]?.message ?? e.message);
		}
	}
	throw e;
}

function withCancelled(b: BookingRow, dates: readonly string[]): BookingRow {
	return { ...b, cancelled: new Set(dates) };
}

async function replaceExceptions(tx: Tx, bookingId: string, dates: readonly string[]) {
	await tx.execute(sql`DELETE FROM booking_exceptions WHERE booking_id = ${bookingId}`);
	for (const d of new Set(dates)) {
		await tx.execute(
			sql`INSERT INTO booking_exceptions (booking_id, occurrence_date, cancelled)
				VALUES (${bookingId}, ${d}::date, TRUE)`
		);
	}
}

export const roomsService = {
	async roomOptions(ctx: RequestContext): Promise<RoomOptions | null> {
		if (!has(ctx, PERM_VIEW)) return null;
		const { features, rooms } = await moduleDb(MODULE_ID).transaction(async (tx) => ({
			features: await loadFeatures(tx),
			rooms: await loadRooms(tx)
		}));
		return {
			features: features.map((f) => ({ id: f.id, name: f.name })),
			rooms: rooms
				.filter((r) => r.bookable)
				.map((r) => ({
					id: r.id,
					name: r.name,
					building: r.building,
					capacity: r.capacity,
					featureIds: r.featureIds
				})),
			canBook: has(ctx, PERM_CREATE),
			canFix: has(ctx, PERM_FIX)
		};
	},

	async checkEventBooking(ctx, eventId, input): Promise<EventRoomResult> {
		const spec = specFromEvent(eventId, input);
		if ('ok' in spec) return spec;
		const denied = await permissionFailure(ctx, spec);
		if (denied) return denied;
		const pc = await loadPlanContext();
		try {
			return await moduleDb(MODULE_ID).transaction(async (tx) => {
				const existing = eventId ? await loadBookingByEvent(tx, eventId) : null;
				await validateSpec(tx, pc, spec, {
					isNew: !existing,
					previousStartsOn: existing?.startsOn
				});
				const id = existing?.id ?? crypto.randomUUID();
				const virtual = withCancelled(
					virtualBooking(id, existing?.ownerId ?? ctx.userId ?? 'system', spec),
					input.cancelledDates
				);
				const outcome = await computePlan(tx, pc, {
					dates: new Set([
						...plannedDates(virtual, pc),
						...(existing ? plannedDates(existing, pc) : [])
					]),
					subjectIds: new Set([id]),
					overlay: [virtual]
				});
				const result = availabilityOf(outcome, id, 0);
				if (!result.ok) throw noRoomError(result.conflicts);
				return {
					ok: true as const,
					bookingId: existing?.id ?? null,
					assignments: result.assignments
				};
			});
		} catch (e) {
			return asFailure(e);
		}
	},

	async syncEventBooking(ctx, eventId, input): Promise<EventRoomResult> {
		const spec = specFromEvent(eventId, input);
		if ('ok' in spec) return spec;
		const denied = await permissionFailure(ctx, spec);
		if (denied) return denied;
		const pc = await loadPlanContext();
		try {
			const done = await moduleDb(MODULE_ID).transaction(async (tx) => {
				await lockPlanning(tx);
				const before = await loadBookingByEvent(tx, eventId);
				await validateSpec(tx, pc, spec, { isNew: !before, previousStartsOn: before?.startsOn });
				const id = before?.id ?? crypto.randomUUID();
				const write = toWrite(spec, true);
				if (before) await updateBooking(tx, id, write);
				else {
					const owner = ctx.userId ?? 'system';
					await insertBooking(tx, id, owner, ctx.userId, write);
				}
				await replaceExceptions(tx, id, input.cancelledDates);
				const after = (await loadBookingByEvent(tx, eventId))!;
				const outcome = await replan(tx, pc, {
					dates: new Set([...(before ? plannedDates(before, pc) : []), ...plannedDates(after, pc)]),
					subjectIds: new Set([id])
				});
				if (outcome.subjectConflicts.length) throw noRoomError(outcome.subjectConflicts);
				return { id, created: !before, outcome };
			});
			await core.audit.logFromContext(
				ctx,
				done.created ? 'rooms.booking.created' : 'rooms.booking.updated',
				{ target: done.id, metadata: { source: 'events', moved: done.outcome.moves.length } }
			);
			await notifyPlanChanges(ctx, done.outcome);
			const result = availabilityOf(done.outcome, done.id, 0);
			return { ok: true, bookingId: done.id, assignments: result.assignments };
		} catch (e) {
			return asFailure(e);
		}
	},

	async removeEventBooking(ctx, eventId): Promise<void> {
		const pc = await loadPlanContext();
		const done = await moduleDb(MODULE_ID).transaction(async (tx) => {
			await lockPlanning(tx);
			const b = await loadBookingByEvent(tx, eventId);
			if (!b) return null;
			await tx.execute(sql`DELETE FROM bookings WHERE id = ${b.id}`);
			return { id: b.id, outcome: await replan(tx, pc, { dates: plannedDates(b, pc) }) };
		});
		if (!done) return;
		await core.audit.logFromContext(ctx, 'rooms.booking.deleted', {
			target: done.id,
			metadata: { source: 'events' }
		});
		await notifyPlanChanges(ctx, done.outcome);
	},

	async eventRooms(ctx, eventIds, window?): Promise<EventRoomInfo[]> {
		const ids = [...new Set(eventIds)].filter((id) => typeof id === 'string' && id).slice(0, 500);
		if (!ids.length || !has(ctx, PERM_VIEW)) return [];
		const pc: PlanContext = await loadPlanContext();
		const from = window?.from ?? pc.today;
		const to = window?.to ?? addDays(pc.today, 366);
		return moduleDb(MODULE_ID).transaction(async (tx) => {
			const rows = await rowsOf(
				tx,
				sql`SELECT id, event_id, mode, fixed_room_id, persons FROM bookings
					WHERE managed_by_event AND event_id IN (${inList(ids)})`
			);
			if (!rows.length) return [];
			const features = await rowsOf(
				tx,
				sql`SELECT booking_id, feature_id FROM booking_features
					WHERE booking_id IN (${inList(rows.map((r) => String(r.id)))})`
			);
			const assigned = await loadAssignments(tx, from, to);
			const roomRows = await rowsOf(tx, sql`SELECT id, name FROM rooms`);
			const names = new Map(roomRows.map((r) => [String(r.id), String(r.name)]));
			return rows.map((r) => {
				const bookingId = String(r.id);
				const assignments = [...assigned]
					.filter(([key]) => key.startsWith(`${bookingId}:`))
					.map(([key, roomId]) => ({
						date: key.slice(bookingId.length + 1),
						roomId,
						roomName: roomId ? (names.get(roomId) ?? null) : null
					}))
					.sort((a, b) => (a.date < b.date ? -1 : 1))
					.slice(0, 400);
				return {
					eventId: String(r.event_id),
					bookingId,
					request: {
						mode: String(r.mode) === 'fixed' ? ('fixed' as const) : ('flexible' as const),
						roomId: r.fixed_room_id == null ? null : String(r.fixed_room_id),
						persons: Number(r.persons),
						featureIds: features
							.filter((f) => String(f.booking_id) === bookingId)
							.map((f) => String(f.feature_id))
					},
					assignments
				};
			});
		});
	}
} satisfies RoomsService;
