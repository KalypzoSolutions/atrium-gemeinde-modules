/**
 * Buchungen und Belegung. Sehen dürfen alle mit `rooms.booking.view` (Belegungsplan der Gemeinde), anlegen alle mit
 * `rooms.booking.create` (fest gebucht nur mit `rooms.booking.fix`), ändern/löschen die Eigentümer*in oder
 * `rooms.booking.edit-all`. Buchungen aus dem Termine-Modul (`managedByEvent`) werden nur dort geändert.
 *
 * Jede Änderung plant die betroffenen Tage in derselben Transaktion neu. Findet die neue/geänderte Buchung keinen
 * Raum, antwortet die API mit 409 (`details.code = ROOMS_NO_ROOM`, `details.conflicts`) und nichts wird gespeichert.
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import {
	type AnyApiEndpoint,
	addDays,
	core,
	daysBetween,
	defineEndpoint,
	errors,
	moduleDb,
	rowsOf,
	type RequestContext
} from '$lib/sdk/server';
import {
	availabilityOf,
	buildDetail,
	countBeyondHorizon,
	finishDetail,
	listOccurrences,
	noRoomError,
	swapOptionsFor,
	requireEditable,
	requireFixPermission,
	toWrite,
	validateSpec,
	virtualBooking,
	withOwnerNames,
	type BookingSpec
} from './bookings.service';
import { insertBooking, loadBooking, updateBooking } from './data';
import { eventTitle, eventVisible, searchEvents } from './events-link';
import { notifyPlanChanges } from './notify';
import { isOccurrence } from './recurrence';
import {
	computePlan,
	loadPlanContext,
	lockPlanning,
	plannedDates,
	replan
} from './planning.service';
import {
	MAX_WINDOW_DAYS,
	MODULE_ID,
	PERM_CREATE,
	PERM_VIEW,
	availabilityInput,
	bookingInput,
	idParams,
	myQuery,
	occurrenceParams,
	occurrencesQuery
} from './schemas';

const tags = ['Modul: rooms'];

async function checkEvent(ctx: RequestContext, eventId: string | null): Promise<void> {
	if (eventId && !(await eventVisible(ctx, eventId))) {
		throw errors.validation([{ path: ['eventId'], message: 'Termin nicht gefunden' }]);
	}
}

export const bookingEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/occurrences',
		summary: 'Belegung: alle Termine im Zeitraum mit zugewiesenem Raum',
		tags,
		permission: PERM_VIEW,
		query: occurrencesQuery,
		handler: async ({ ctx, query }) => {
			if (query.to < query.from) throw errors.badRequest('Ende liegt vor dem Beginn');
			if (daysBetween(query.from, query.to) > MAX_WINDOW_DAYS) {
				throw errors.badRequest(`Höchstens ${MAX_WINDOW_DAYS} Tage je Abfrage`);
			}
			const raw = await moduleDb(MODULE_ID).transaction((tx) => listOccurrences(tx, ctx, query));
			return withOwnerNames(ctx, raw);
		}
	}),

	defineEndpoint({
		method: 'GET',
		path: '/my/upcoming',
		summary: 'Eigene kommende Termine (Dashboard)',
		tags,
		permission: PERM_VIEW,
		query: myQuery,
		handler: async ({ ctx, query }) => {
			const pc = await loadPlanContext();
			const raw = await moduleDb(MODULE_ID).transaction((tx) =>
				listOccurrences(tx, ctx, { from: pc.today, to: addDays(pc.today, 60), mine: true })
			);
			return withOwnerNames(ctx, raw.slice(0, query.limit));
		}
	}),

	defineEndpoint({
		method: 'GET',
		path: '/events/search',
		summary: 'Termine aus dem Modul „Termine“ zum Verknüpfen suchen',
		tags,
		permission: PERM_VIEW,
		query: z.object({ q: z.string().trim().max(100).default('') }),
		handler: async ({ ctx, query }) => searchEvents(ctx, query.q)
	}),

	defineEndpoint({
		method: 'POST',
		path: '/availability',
		summary: 'Probelauf: welchen Raum bekäme diese Buchung (nichts wird gespeichert)',
		tags,
		permission: PERM_CREATE,
		body: availabilityInput,
		handler: async ({ ctx, body }) => {
			await requireFixPermission(ctx, body);
			const pc = await loadPlanContext();
			const id = body.bookingId ?? crypto.randomUUID();
			const spec: BookingSpec = body;
			return moduleDb(MODULE_ID).transaction(async (tx) => {
				const existing = body.bookingId ? await loadBooking(tx, body.bookingId) : null;
				if (body.bookingId) requireEditable(ctx, existing);
				await validateSpec(tx, pc, spec, {
					isNew: !existing,
					previousStartsOn: existing?.startsOn
				});
				const virtual = virtualBooking(id, existing?.ownerId ?? ctx.userId ?? 'system', spec);
				if (existing) virtual.cancelled = existing.cancelled;
				const dates = new Set([
					...plannedDates(virtual, pc),
					...(existing ? plannedDates(existing, pc) : [])
				]);
				const outcome = await computePlan(tx, pc, {
					dates,
					subjectIds: new Set([id]),
					overlay: [virtual]
				});
				return availabilityOf(tx, pc, outcome, virtual, countBeyondHorizon(pc, spec));
			});
		}
	}),

	defineEndpoint({
		method: 'GET',
		path: '/bookings/:id',
		summary: 'Buchung mit kommenden Terminen',
		tags,
		permission: PERM_VIEW,
		params: idParams,
		handler: async ({ ctx, params }) => {
			const pc = await loadPlanContext();
			const raw = await moduleDb(MODULE_ID).transaction(async (tx) => {
				const b = await loadBooking(tx, params.id);
				if (!b) throw errors.notFound('Buchung nicht gefunden');
				return buildDetail(tx, ctx, pc, b);
			});
			return finishDetail(ctx, raw, eventTitle);
		}
	}),

	defineEndpoint({
		method: 'POST',
		path: '/bookings',
		summary: 'Buchung anlegen (Raum wird sofort zugewiesen)',
		tags,
		permission: PERM_CREATE,
		body: bookingInput,
		handler: async ({ ctx, body }) => {
			const ownerId = ctx.userId;
			if (!ownerId) throw errors.badRequest('Buchungen können nur von Benutzern angelegt werden');
			await requireFixPermission(ctx, body);
			await checkEvent(ctx, body.eventId);
			const pc = await loadPlanContext();
			const id = crypto.randomUUID();
			const { raw, outcome } = await moduleDb(MODULE_ID).transaction(async (tx) => {
				await lockPlanning(tx);
				await validateSpec(tx, pc, body, { isNew: true });
				await insertBooking(tx, id, ownerId, ownerId, toWrite(body));
				const b = (await loadBooking(tx, id))!;
				const outcome = await replan(tx, pc, {
					dates: plannedDates(b, pc),
					subjectIds: new Set([id]),
					reason: `Platz für „${body.title}“`,
					actorId: ctx.userId
				});
				if (outcome.subjectConflicts.length) {
					throw noRoomError(
						outcome.subjectConflicts,
						await swapOptionsFor(tx, pc, outcome, b, ownerId)
					);
				}
				return { raw: await buildDetail(tx, ctx, pc, b), outcome };
			});
			await core.audit.logFromContext(ctx, 'rooms.booking.created', {
				target: id,
				metadata: { mode: body.mode, recurring: !!body.recurrence, moved: outcome.moves.length }
			});
			await notifyPlanChanges(ctx, outcome);
			return finishDetail(ctx, raw, eventTitle);
		}
	}),

	defineEndpoint({
		method: 'PUT',
		path: '/bookings/:id',
		summary: 'Buchung ändern (ganze Serie; Neuplanung)',
		tags,
		permission: PERM_VIEW,
		params: idParams,
		body: bookingInput,
		handler: async ({ ctx, params, body }) => {
			await core.permissions.require(ctx, PERM_CREATE);
			await requireFixPermission(ctx, body);
			const pc = await loadPlanContext();
			const stored = await moduleDb(MODULE_ID).transaction(async (tx) =>
				requireEditable(ctx, await loadBooking(tx, params.id))
			);
			if (body.eventId !== stored.eventId) await checkEvent(ctx, body.eventId);
			const { raw, outcome } = await moduleDb(MODULE_ID).transaction(async (tx) => {
				await lockPlanning(tx);
				const before = requireEditable(ctx, await loadBooking(tx, params.id));
				await validateSpec(tx, pc, body, { isNew: false, previousStartsOn: before.startsOn });
				await updateBooking(tx, params.id, toWrite(body));
				const after = (await loadBooking(tx, params.id))!;
				const outcome = await replan(tx, pc, {
					dates: new Set([...plannedDates(before, pc), ...plannedDates(after, pc)]),
					subjectIds: new Set([params.id]),
					reason: `Platz für „${body.title}“`,
					actorId: ctx.userId
				});
				if (outcome.subjectConflicts.length) throw noRoomError(outcome.subjectConflicts);
				return { raw: await buildDetail(tx, ctx, pc, after), outcome };
			});
			await core.audit.logFromContext(ctx, 'rooms.booking.updated', {
				target: params.id,
				metadata: { mode: body.mode, recurring: !!body.recurrence, moved: outcome.moves.length }
			});
			await notifyPlanChanges(ctx, outcome);
			return finishDetail(ctx, raw, eventTitle);
		}
	}),

	defineEndpoint({
		method: 'DELETE',
		path: '/bookings/:id',
		summary: 'Buchung bzw. ganze Serie löschen (frei gewordene Räume werden neu verteilt)',
		tags,
		permission: PERM_VIEW,
		params: idParams,
		handler: async ({ ctx, params }) => {
			const pc = await loadPlanContext();
			const outcome = await moduleDb(MODULE_ID).transaction(async (tx) => {
				await lockPlanning(tx);
				const b = requireEditable(ctx, await loadBooking(tx, params.id));
				await tx.execute(sql`DELETE FROM bookings WHERE id = ${params.id}`);
				return replan(tx, pc, {
					dates: plannedDates(b, pc),
					reason: `Raum frei geworden („${b.title}“ gelöscht)`,
					actorId: ctx.userId
				});
			});
			await core.audit.logFromContext(ctx, 'rooms.booking.deleted', { target: params.id });
			await notifyPlanChanges(ctx, outcome);
			return { id: params.id, deleted: true };
		}
	}),

	defineEndpoint({
		method: 'PUT',
		path: '/bookings/:id/occurrences/:date',
		summary: 'Einzelnen Termin einer Buchung absagen',
		tags,
		permission: PERM_VIEW,
		params: occurrenceParams,
		handler: async ({ ctx, params }) => {
			const pc = await loadPlanContext();
			const { raw, outcome } = await moduleDb(MODULE_ID).transaction(async (tx) => {
				await lockPlanning(tx);
				const b = requireEditable(ctx, await loadBooking(tx, params.id));
				if (!isOccurrence(b.startsOn, b.recurrence, params.date)) {
					throw errors.notFound('Termin nicht gefunden');
				}
				await tx.execute(
					sql`INSERT INTO booking_exceptions (booking_id, occurrence_date, cancelled, updated_by)
						VALUES (${params.id}, ${params.date}::date, TRUE, ${ctx.userId})
						ON CONFLICT (booking_id, occurrence_date)
						DO UPDATE SET cancelled = TRUE, updated_by = EXCLUDED.updated_by, updated_at = now()`
				);
				const outcome = await replan(tx, pc, { dates: [params.date] });
				const after = (await loadBooking(tx, params.id))!;
				return { raw: await buildDetail(tx, ctx, pc, after), outcome };
			});
			await core.audit.logFromContext(ctx, 'rooms.booking.occurrence-cancelled', {
				target: params.id
			});
			await notifyPlanChanges(ctx, outcome);
			return finishDetail(ctx, raw, eventTitle);
		}
	}),

	defineEndpoint({
		method: 'DELETE',
		path: '/bookings/:id/occurrences/:date',
		summary: 'Abgesagten Termin wiederherstellen (braucht wieder einen Raum)',
		tags,
		permission: PERM_VIEW,
		params: occurrenceParams,
		handler: async ({ ctx, params }) => {
			const pc = await loadPlanContext();
			const { raw, outcome } = await moduleDb(MODULE_ID).transaction(async (tx) => {
				await lockPlanning(tx);
				requireEditable(ctx, await loadBooking(tx, params.id));
				const rows = await rowsOf(
					tx,
					sql`UPDATE booking_exceptions SET cancelled = FALSE, updated_by = ${ctx.userId}, updated_at = now()
						WHERE booking_id = ${params.id} AND occurrence_date = ${params.date}::date AND cancelled
						RETURNING booking_id`
				);
				if (!rows.length) throw errors.notFound('Termin ist nicht abgesagt');
				await tx.execute(
					sql`DELETE FROM booking_exceptions WHERE booking_id = ${params.id}
						AND occurrence_date = ${params.date}::date AND NOT cancelled AND pinned_room_id IS NULL`
				);
				const outcome = await replan(tx, pc, {
					dates: [params.date],
					subjectIds: new Set([params.id])
				});
				if (outcome.subjectConflicts.length) throw noRoomError(outcome.subjectConflicts);
				const after = (await loadBooking(tx, params.id))!;
				return { raw: await buildDetail(tx, ctx, pc, after), outcome };
			});
			await core.audit.logFromContext(ctx, 'rooms.booking.occurrence-restored', {
				target: params.id
			});
			await notifyPlanChanges(ctx, outcome);
			return finishDetail(ctx, raw, eventTitle);
		}
	})
];
