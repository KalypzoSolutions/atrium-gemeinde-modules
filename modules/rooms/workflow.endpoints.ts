/**
 * Raumplanung 2.0: Gruppen (Farbe, Vorrang), Drag & Drop der Raumverwaltung, Verlegungen mit Widerspruch und
 * Tauschanfragen für feste Buchungen. Jede Änderung plant in derselben Transaktion neu; Benachrichtigungen danach.
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import {
	type AnyApiEndpoint,
	core,
	defineEndpoint,
	errors,
	isUniqueViolation,
	moduleDb,
	num,
	rowsOf
} from '$lib/sdk/server';
import { loadPlanContext, lockPlanning } from './planning.service';
import { loadBooking, loadGroups } from './data';
import { canManage, loadMove, loadMovesFor, objectMove, resolveMove } from './moves.service';
import { notifyManualMove, notifyObjection, notifyPlanChanges, notifySwap } from './notify';
import { dropTargets, placeOccurrence, unpinOccurrence } from './placement.service';
import {
	MODULE_ID,
	PERM_CREATE,
	PERM_MANAGE,
	PERM_VIEW,
	groupInput,
	idParams,
	moveParams,
	objectionInput,
	occurrenceParams,
	placeInput,
	swapRequestInput
} from './schemas';
import {
	acceptSwap,
	createSwap,
	listSwaps,
	loadSwap,
	setSwapStatus,
	withRequesterNames
} from './swaps.service';

const tags = ['Modul: rooms'];

export const workflowEndpoints: AnyApiEndpoint[] = [
	// --- Gruppen -------------------------------------------------------------------------------
	defineEndpoint({
		method: 'GET',
		path: '/groups',
		summary: 'Gruppen mit Farbe und Vorrang',
		tags,
		permission: PERM_VIEW,
		handler: async () => moduleDb(MODULE_ID).transaction((tx) => loadGroups(tx))
	}),
	defineEndpoint({
		method: 'POST',
		path: '/groups',
		summary: 'Gruppe anlegen',
		tags,
		permission: PERM_MANAGE,
		body: groupInput,
		handler: async ({ ctx, body }) => {
			const id = crypto.randomUUID();
			try {
				await moduleDb(MODULE_ID).transaction(async (tx) => {
					await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('rooms:groups'))`);
					const [row] = await rowsOf(
						tx,
						sql`SELECT COALESCE(MAX(position), -1) + 1 AS p FROM groups`
					);
					await tx.execute(
						sql`INSERT INTO groups (id, name, color, priority, position)
							VALUES (${id}, ${body.name}, ${body.color}, ${body.priority}, ${num(row?.p)})`
					);
				});
			} catch (e) {
				if (isUniqueViolation(e)) throw errors.conflict('Diese Gruppe gibt es schon');
				throw e;
			}
			await core.audit.logFromContext(ctx, 'rooms.group.created', { target: id });
			const list = await moduleDb(MODULE_ID).transaction((tx) => loadGroups(tx));
			return list.find((g) => g.id === id)!;
		}
	}),
	defineEndpoint({
		method: 'PUT',
		path: '/groups/:id',
		summary: 'Gruppe ändern (Vorrang wirkt ab der nächsten Planung)',
		tags,
		permission: PERM_MANAGE,
		params: idParams,
		body: groupInput,
		handler: async ({ ctx, params, body }) => {
			try {
				await moduleDb(MODULE_ID).transaction(async (tx) => {
					const rows = await rowsOf(
						tx,
						sql`UPDATE groups SET name = ${body.name}, color = ${body.color}, priority = ${body.priority}
							WHERE id = ${params.id} RETURNING id`
					);
					if (!rows.length) throw errors.notFound('Gruppe nicht gefunden');
				});
			} catch (e) {
				if (isUniqueViolation(e)) throw errors.conflict('Diese Gruppe gibt es schon');
				throw e;
			}
			await core.audit.logFromContext(ctx, 'rooms.group.updated', { target: params.id });
			const list = await moduleDb(MODULE_ID).transaction((tx) => loadGroups(tx));
			return list.find((g) => g.id === params.id)!;
		}
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/groups/:id',
		summary: 'Gruppe löschen (Buchungen bleiben, ohne Gruppe)',
		tags,
		permission: PERM_MANAGE,
		params: idParams,
		handler: async ({ ctx, params }) => {
			await moduleDb(MODULE_ID).transaction(async (tx) => {
				const rows = await rowsOf(tx, sql`DELETE FROM groups WHERE id = ${params.id} RETURNING id`);
				if (!rows.length) throw errors.notFound('Gruppe nicht gefunden');
			});
			await core.audit.logFromContext(ctx, 'rooms.group.deleted', { target: params.id });
			return { id: params.id, deleted: true };
		}
	}),

	// --- Drag & Drop ---------------------------------------------------------------------------
	defineEndpoint({
		method: 'GET',
		path: '/bookings/:id/occurrences/:date/targets',
		summary: 'Drag & Drop: welche Räume für diesen Termin in Frage kommen (mit Grund)',
		tags,
		permission: PERM_MANAGE,
		params: occurrenceParams,
		handler: async ({ params }) => {
			const pc = await loadPlanContext();
			return moduleDb(MODULE_ID).transaction(async (tx) => {
				const b = await loadBooking(tx, params.id);
				if (!b) throw errors.notFound('Buchung nicht gefunden');
				return dropTargets(tx, pc, b, params.date);
			});
		}
	}),
	defineEndpoint({
		method: 'PUT',
		path: '/bookings/:id/occurrences/:date/room',
		summary: 'Drag & Drop: Termin (oder Serie ab hier) in einen Raum legen',
		tags,
		permission: PERM_MANAGE,
		params: occurrenceParams,
		body: placeInput,
		handler: async ({ ctx, params, body }) => {
			const pc = await loadPlanContext();
			const done = await moduleDb(MODULE_ID).transaction(async (tx) => {
				await lockPlanning(tx);
				const b = await loadBooking(tx, params.id);
				if (!b) throw errors.notFound('Buchung nicht gefunden');
				if (b.managedByEvent && body.scope === 'following') {
					throw errors.conflict(
						'Serien aus dem Termine-Modul nur dort ändern; einzelne Termine gehen'
					);
				}
				const res = await placeOccurrence(tx, ctx, pc, b, params.date, body);
				return { b, ...res };
			});
			await core.audit.logFromContext(ctx, 'rooms.booking.placed', {
				target: params.id,
				metadata: { scope: body.scope, moved: done.outcome.moves.length }
			});
			await notifyManualMove(ctx, {
				bookingId: done.b.id,
				title: done.b.title,
				ownerId: done.b.ownerId,
				date: params.date,
				toRoomName: done.outcome.roomNames.get(body.roomId) ?? null
			});
			await notifyPlanChanges(ctx, done.outcome);
			return {
				bookingId: params.id,
				date: params.date,
				roomId: body.roomId,
				fromRoomId: done.fromRoomId,
				moved: done.outcome.moves.length,
				unassigned: done.outcome.unassigned.length
			};
		}
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/bookings/:id/occurrences/:date/room',
		summary: 'Festlegung aufheben (der Planer verteilt den Termin wieder)',
		tags,
		permission: PERM_MANAGE,
		params: occurrenceParams,
		handler: async ({ ctx, params }) => {
			const pc = await loadPlanContext();
			const outcome = await moduleDb(MODULE_ID).transaction(async (tx) => {
				await lockPlanning(tx);
				const b = await loadBooking(tx, params.id);
				if (!b) throw errors.notFound('Buchung nicht gefunden');
				return unpinOccurrence(tx, ctx, pc, b, params.date);
			});
			await core.audit.logFromContext(ctx, 'rooms.booking.unpinned', { target: params.id });
			await notifyPlanChanges(ctx, outcome);
			return { bookingId: params.id, date: params.date, unpinned: true };
		}
	}),

	// --- Verlegungen ---------------------------------------------------------------------------
	defineEndpoint({
		method: 'GET',
		path: '/moves',
		summary:
			'Verlegungen: eigene (Widerspruch möglich) bzw. für die Verwaltung offene Widersprüche',
		tags,
		permission: PERM_VIEW,
		query: z.object({ scope: z.enum(['mine', 'objected']).default('mine') }),
		handler: async ({ ctx, query }) => {
			if (query.scope === 'objected') await core.permissions.require(ctx, PERM_MANAGE);
			const pc = await loadPlanContext();
			return moduleDb(MODULE_ID).transaction((tx) =>
				query.scope === 'objected'
					? loadMovesFor(tx, ctx, { objected: true })
					: loadMovesFor(tx, ctx, { ownerId: ctx.userId ?? '-', from: pc.today })
			);
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/moves/:id/object',
		summary: 'Einer Verlegung widersprechen (innerhalb der Frist)',
		tags,
		permission: PERM_VIEW,
		params: moveParams,
		body: objectionInput,
		handler: async ({ ctx, params, body }) => {
			const move = await moduleDb(MODULE_ID).transaction(async (tx) => {
				const m = await loadMove(tx, ctx, params.id);
				if (!m) throw errors.notFound('Verlegung nicht gefunden');
				if (!m.canObject) throw errors.conflict('Widerspruch ist nicht mehr möglich');
				await objectMove(tx, params.id, ctx.userId, body.note);
				return (await loadMove(tx, ctx, params.id))!;
			});
			await core.audit.logFromContext(ctx, 'rooms.move.objected', { target: move.bookingId });
			await notifyObjection(ctx, { ...move, note: body.note });
			return move;
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/moves/:id/resolve',
		summary: 'Widerspruch als erledigt markieren (Raumverwaltung)',
		tags,
		permission: PERM_MANAGE,
		params: moveParams,
		handler: async ({ ctx, params }) => {
			const move = await moduleDb(MODULE_ID).transaction(async (tx) => {
				if (!(await loadMove(tx, ctx, params.id)))
					throw errors.notFound('Verlegung nicht gefunden');
				await resolveMove(tx, params.id, ctx.userId);
				return (await loadMove(tx, ctx, params.id))!;
			});
			await core.audit.logFromContext(ctx, 'rooms.move.resolved', { target: move.bookingId });
			return move;
		}
	}),

	// --- Tauschanfragen ------------------------------------------------------------------------
	defineEndpoint({
		method: 'GET',
		path: '/swaps',
		summary: 'Tauschanfragen, die mich betreffen (Verwaltung: alle)',
		tags,
		permission: PERM_VIEW,
		query: z.object({ pending: z.enum(['0', '1']).optional() }),
		handler: async ({ ctx, query }) => {
			const raw = await moduleDb(MODULE_ID).transaction((tx) =>
				listSwaps(tx, ctx, { pendingOnly: query.pending === '1' })
			);
			return withRequesterNames(ctx, raw);
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/swaps',
		summary: 'Tauschanfrage an die Gruppe einer festen Buchung stellen',
		tags,
		permission: PERM_CREATE,
		body: swapRequestInput,
		handler: async ({ ctx, body }) => {
			if (!ctx.userId) throw errors.badRequest('Nur für angemeldete Personen');
			const pc = await loadPlanContext();
			const swap = await moduleDb(MODULE_ID).transaction(async (tx) => {
				await lockPlanning(tx);
				const id = await createSwap(tx, ctx, pc, body);
				return (await loadSwap(tx, ctx, id))!;
			});
			await core.audit.logFromContext(ctx, 'rooms.swap.requested', { target: swap.id });
			await notifySwap(ctx, swap, 'requested');
			return (await withRequesterNames(ctx, [swap]))[0]!;
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/swaps/:id/accept',
		summary: 'Tauschanfrage annehmen (Gruppe der festen Buchung oder Raumverwaltung)',
		tags,
		permission: PERM_VIEW,
		params: idParams,
		handler: async ({ ctx, params }) => {
			const pc = await loadPlanContext();
			const done = await moduleDb(MODULE_ID).transaction(async (tx) => {
				await lockPlanning(tx);
				const swap = await loadSwap(tx, ctx, params.id);
				if (!swap) throw errors.notFound('Anfrage nicht gefunden');
				if (!swap.canDecide) throw errors.forbidden('Diese Anfrage kannst du nicht entscheiden');
				const res = await acceptSwap(tx, ctx, pc, swap);
				return { ...res, swap: (await loadSwap(tx, ctx, params.id))! };
			});
			await core.audit.logFromContext(ctx, 'rooms.swap.accepted', { target: params.id });
			await notifySwap(ctx, done.swap, 'accepted');
			await notifyPlanChanges(ctx, done.outcome);
			return (await withRequesterNames(ctx, [done.swap]))[0]!;
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/swaps/:id/decline',
		summary: 'Tauschanfrage ablehnen',
		tags,
		permission: PERM_VIEW,
		params: idParams,
		handler: async ({ ctx, params }) => {
			const swap = await moduleDb(MODULE_ID).transaction(async (tx) => {
				const s = await loadSwap(tx, ctx, params.id);
				if (!s) throw errors.notFound('Anfrage nicht gefunden');
				if (!s.canDecide) throw errors.forbidden('Diese Anfrage kannst du nicht entscheiden');
				await setSwapStatus(tx, params.id, 'declined', ctx.userId);
				return (await loadSwap(tx, ctx, params.id))!;
			});
			await core.audit.logFromContext(ctx, 'rooms.swap.declined', { target: params.id });
			await notifySwap(ctx, swap, 'declined');
			return (await withRequesterNames(ctx, [swap]))[0]!;
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/swaps/:id/withdraw',
		summary: 'Eigene Tauschanfrage zurückziehen',
		tags,
		permission: PERM_VIEW,
		params: idParams,
		handler: async ({ ctx, params }) => {
			const swap = await moduleDb(MODULE_ID).transaction(async (tx) => {
				const s = await loadSwap(tx, ctx, params.id);
				if (!s || (s.requesterId !== ctx.userId && !canManage(ctx))) {
					throw errors.notFound('Anfrage nicht gefunden');
				}
				if (s.status !== 'pending') throw errors.conflict('Diese Anfrage ist schon entschieden');
				await setSwapStatus(tx, params.id, 'withdrawn', ctx.userId);
				return (await loadSwap(tx, ctx, params.id))!;
			});
			await core.audit.logFromContext(ctx, 'rooms.swap.withdrawn', { target: params.id });
			return (await withRequesterNames(ctx, [swap]))[0]!;
		}
	})
];
