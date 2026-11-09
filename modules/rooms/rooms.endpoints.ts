/**
 * Merkmale, Räume und Sperrzeiten (Lesen: `rooms.booking.view`, Ändern: `rooms.room.manage`). Jede Änderung plant
 * den ganzen Planungszeitraum neu (in derselben Transaktion), Benachrichtigungen danach.
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
	rowsOf,
	type RequestContext,
	type Tx
} from '$lib/sdk/server';
import { existingFeatureIds, loadBlocks, loadFeatures, loadRoom, loadRooms } from './data';
import { notifyPlanChanges } from './notify';
import {
	allPlanDates,
	loadPlanContext,
	lockPlanning,
	replan,
	type PlanContext,
	type PlanOutcome
} from './planning.service';
import {
	MODULE_ID,
	PERM_MANAGE,
	PERM_VIEW,
	blockInput,
	blockParams,
	featureInput,
	idParams,
	roomInput,
	type RoomInput
} from './schemas';

const tags = ['Modul: rooms'];

/** Schreibende Transaktion mit Sperre + Neuplanung des ganzen Zeitraums */
async function changeAndReplan<T>(
	ctx: RequestContext,
	change: (tx: Tx, pc: PlanContext) => Promise<T>
): Promise<{ result: T; outcome: PlanOutcome }> {
	const pc = await loadPlanContext();
	try {
		const done = await moduleDb(MODULE_ID).transaction(async (tx) => {
			await lockPlanning(tx);
			const result = await change(tx, pc);
			const outcome = await replan(tx, pc, { dates: allPlanDates(pc) });
			return { result, outcome };
		});
		await notifyPlanChanges(ctx, done.outcome);
		return done;
	} catch (e) {
		if (isUniqueViolation(e)) throw errors.conflict('Dieser Name ist schon vergeben');
		throw e;
	}
}

async function nextPosition(tx: Tx, table: 'features' | 'rooms'): Promise<number> {
	await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`rooms:${table}`}))`);
	const rows = await rowsOf(
		tx,
		table === 'features'
			? sql`SELECT COALESCE(MAX(position), -1) + 1 AS p FROM features`
			: sql`SELECT COALESCE(MAX(position), -1) + 1 AS p FROM rooms`
	);
	return num(rows[0]?.p);
}

async function checkFeatures(tx: Tx, ids: readonly string[]): Promise<void> {
	const known = await existingFeatureIds(tx, ids);
	const issues = ids.flatMap((id, i) =>
		known.has(id) ? [] : [{ path: ['featureIds', i], message: 'Unbekanntes Merkmal' }]
	);
	if (issues.length) throw errors.validation(issues);
}

async function writeRoomFeatures(tx: Tx, roomId: string, ids: readonly string[]): Promise<void> {
	await tx.execute(sql`DELETE FROM room_features WHERE room_id = ${roomId}`);
	for (const f of new Set(ids)) {
		await tx.execute(sql`INSERT INTO room_features (room_id, feature_id) VALUES (${roomId}, ${f})`);
	}
}

const roomValues = (b: RoomInput) => sql`${b.name}, ${b.building}, ${b.description}, ${b.capacity},
	${b.areaM2}, ${b.heatingCostCentsPerHour}, ${b.bookable}`;

const summary = (o: PlanOutcome) => ({ moved: o.moves.length, unassigned: o.unassigned.length });

export const roomEndpoints: AnyApiEndpoint[] = [
	// --- Merkmale ------------------------------------------------------------------------------
	defineEndpoint({
		method: 'GET',
		path: '/features',
		summary: 'Merkmale (Klavier, Beamer, ebenerdig …)',
		tags,
		permission: PERM_VIEW,
		handler: async () => moduleDb(MODULE_ID).transaction((tx) => loadFeatures(tx))
	}),
	defineEndpoint({
		method: 'POST',
		path: '/features',
		summary: 'Merkmal anlegen',
		tags,
		permission: PERM_MANAGE,
		body: featureInput,
		handler: async ({ ctx, body }) => {
			const id = crypto.randomUUID();
			try {
				await moduleDb(MODULE_ID).transaction(async (tx) => {
					const position = await nextPosition(tx, 'features');
					await tx.execute(
						sql`INSERT INTO features (id, name, icon, position)
							VALUES (${id}, ${body.name}, ${body.icon}, ${position})`
					);
				});
			} catch (e) {
				if (isUniqueViolation(e)) throw errors.conflict('Dieses Merkmal gibt es schon');
				throw e;
			}
			await core.audit.logFromContext(ctx, 'rooms.feature.created', { target: id });
			const list = await moduleDb(MODULE_ID).transaction((tx) => loadFeatures(tx));
			return list.find((f) => f.id === id)!;
		}
	}),
	defineEndpoint({
		method: 'PUT',
		path: '/features/:id',
		summary: 'Merkmal umbenennen',
		tags,
		permission: PERM_MANAGE,
		params: idParams,
		body: featureInput,
		handler: async ({ ctx, params, body }) => {
			try {
				await moduleDb(MODULE_ID).transaction(async (tx) => {
					const rows = await rowsOf(
						tx,
						sql`UPDATE features SET name = ${body.name}, icon = ${body.icon}
							WHERE id = ${params.id} RETURNING id`
					);
					if (!rows.length) throw errors.notFound('Merkmal nicht gefunden');
				});
			} catch (e) {
				if (isUniqueViolation(e)) throw errors.conflict('Dieses Merkmal gibt es schon');
				throw e;
			}
			await core.audit.logFromContext(ctx, 'rooms.feature.updated', { target: params.id });
			const list = await moduleDb(MODULE_ID).transaction((tx) => loadFeatures(tx));
			return list.find((f) => f.id === params.id)!;
		}
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/features/:id',
		summary: 'Merkmal löschen (Räume und Anforderungen verlieren es; Neuplanung)',
		tags,
		permission: PERM_MANAGE,
		params: idParams,
		handler: async ({ ctx, params }) => {
			const { outcome } = await changeAndReplan(ctx, async (tx) => {
				const rows = await rowsOf(
					tx,
					sql`DELETE FROM features WHERE id = ${params.id} RETURNING id`
				);
				if (!rows.length) throw errors.notFound('Merkmal nicht gefunden');
			});
			await core.audit.logFromContext(ctx, 'rooms.feature.deleted', {
				target: params.id,
				metadata: summary(outcome)
			});
			return { id: params.id, deleted: true, ...summary(outcome) };
		}
	}),
	defineEndpoint({
		method: 'PUT',
		path: '/features-order',
		summary: 'Reihenfolge der Merkmale',
		tags,
		permission: PERM_MANAGE,
		body: z.object({ ids: z.array(z.uuid()).max(500) }),
		handler: async ({ ctx, body }) => {
			await moduleDb(MODULE_ID).transaction(async (tx) => {
				for (const [i, id] of body.ids.entries()) {
					await tx.execute(sql`UPDATE features SET position = ${i} WHERE id = ${id}`);
				}
			});
			await core.audit.logFromContext(ctx, 'rooms.feature.reordered', {});
			return moduleDb(MODULE_ID).transaction((tx) => loadFeatures(tx));
		}
	}),

	// --- Räume ---------------------------------------------------------------------------------
	defineEndpoint({
		method: 'GET',
		path: '/rooms',
		summary: 'Räume mit Merkmalen',
		tags,
		permission: PERM_VIEW,
		handler: async () => moduleDb(MODULE_ID).transaction((tx) => loadRooms(tx))
	}),
	defineEndpoint({
		method: 'POST',
		path: '/rooms',
		summary: 'Raum anlegen',
		tags,
		permission: PERM_MANAGE,
		body: roomInput,
		handler: async ({ ctx, body }) => {
			const id = crypto.randomUUID();
			const { result, outcome } = await changeAndReplan(ctx, async (tx) => {
				await checkFeatures(tx, body.featureIds);
				const position = await nextPosition(tx, 'rooms');
				await tx.execute(
					sql`INSERT INTO rooms (id, name, building, description, capacity, area_m2,
							heating_cost_cents_per_hour, bookable, position)
						VALUES (${id}, ${roomValues(body)}, ${position})`
				);
				await writeRoomFeatures(tx, id, body.featureIds);
				return (await loadRoom(tx, id))!;
			});
			await core.audit.logFromContext(ctx, 'rooms.room.created', {
				target: id,
				metadata: summary(outcome)
			});
			return result;
		}
	}),
	defineEndpoint({
		method: 'PUT',
		path: '/rooms-order',
		summary: 'Reihenfolge der Räume',
		tags,
		permission: PERM_MANAGE,
		body: z.object({ ids: z.array(z.uuid()).max(500) }),
		handler: async ({ ctx, body }) => {
			await moduleDb(MODULE_ID).transaction(async (tx) => {
				for (const [i, id] of body.ids.entries()) {
					await tx.execute(sql`UPDATE rooms SET position = ${i} WHERE id = ${id}`);
				}
			});
			await core.audit.logFromContext(ctx, 'rooms.room.reordered', {});
			return moduleDb(MODULE_ID).transaction((tx) => loadRooms(tx));
		}
	}),
	defineEndpoint({
		method: 'PUT',
		path: '/rooms/:id',
		summary: 'Raum ändern (Neuplanung)',
		tags,
		permission: PERM_MANAGE,
		params: idParams,
		body: roomInput,
		handler: async ({ ctx, params, body }) => {
			const { result, outcome } = await changeAndReplan(ctx, async (tx) => {
				await checkFeatures(tx, body.featureIds);
				const rows = await rowsOf(
					tx,
					sql`UPDATE rooms SET name = ${body.name}, building = ${body.building},
							description = ${body.description}, capacity = ${body.capacity},
							area_m2 = ${body.areaM2}, heating_cost_cents_per_hour = ${body.heatingCostCentsPerHour},
							bookable = ${body.bookable}, updated_at = now()
						WHERE id = ${params.id} RETURNING id`
				);
				if (!rows.length) throw errors.notFound('Raum nicht gefunden');
				await writeRoomFeatures(tx, params.id, body.featureIds);
				return (await loadRoom(tx, params.id))!;
			});
			await core.audit.logFromContext(ctx, 'rooms.room.updated', {
				target: params.id,
				metadata: summary(outcome)
			});
			return result;
		}
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/rooms/:id',
		summary: 'Raum löschen (feste Buchungen werden flexibel; Neuplanung)',
		tags,
		permission: PERM_MANAGE,
		params: idParams,
		handler: async ({ ctx, params }) => {
			const { outcome } = await changeAndReplan(ctx, async (tx) => {
				await tx.execute(
					sql`UPDATE bookings SET mode = 'flexible', fixed_room_id = NULL, updated_at = now()
						WHERE fixed_room_id = ${params.id}`
				);
				const rows = await rowsOf(tx, sql`DELETE FROM rooms WHERE id = ${params.id} RETURNING id`);
				if (!rows.length) throw errors.notFound('Raum nicht gefunden');
			});
			await core.audit.logFromContext(ctx, 'rooms.room.deleted', {
				target: params.id,
				metadata: summary(outcome)
			});
			return { id: params.id, deleted: true, ...summary(outcome) };
		}
	}),

	// --- Sperrzeiten ---------------------------------------------------------------------------
	defineEndpoint({
		method: 'GET',
		path: '/rooms/:id/blocks',
		summary: 'Sperrzeiten eines Raums',
		tags,
		permission: PERM_VIEW,
		params: idParams,
		handler: async ({ params }) =>
			moduleDb(MODULE_ID).transaction(async (tx) => {
				if (!(await loadRoom(tx, params.id))) throw errors.notFound('Raum nicht gefunden');
				return loadBlocks(tx, null, params.id);
			})
	}),
	defineEndpoint({
		method: 'POST',
		path: '/rooms/:id/blocks',
		summary: 'Raum für einen Zeitraum sperren (Neuplanung)',
		tags,
		permission: PERM_MANAGE,
		params: idParams,
		body: blockInput,
		handler: async ({ ctx, params, body }) => {
			const id = crypto.randomUUID();
			const { outcome } = await changeAndReplan(ctx, async (tx) => {
				if (!(await loadRoom(tx, params.id))) throw errors.notFound('Raum nicht gefunden');
				await tx.execute(
					sql`INSERT INTO room_blocks (id, room_id, starts_on, ends_on, reason, created_by)
						VALUES (${id}, ${params.id}, ${body.startsOn}::date, ${body.endsOn}::date,
							${body.reason}, ${ctx.userId})`
				);
			});
			await core.audit.logFromContext(ctx, 'rooms.room.blocked', {
				target: params.id,
				metadata: summary(outcome)
			});
			return {
				id,
				roomId: params.id,
				startsOn: body.startsOn,
				endsOn: body.endsOn,
				reason: body.reason,
				...summary(outcome)
			};
		}
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/rooms/:id/blocks/:blockId',
		summary: 'Sperrzeit aufheben (Neuplanung)',
		tags,
		permission: PERM_MANAGE,
		params: blockParams,
		handler: async ({ ctx, params }) => {
			const { outcome } = await changeAndReplan(ctx, async (tx) => {
				const rows = await rowsOf(
					tx,
					sql`DELETE FROM room_blocks WHERE id = ${params.blockId} AND room_id = ${params.id}
						RETURNING id`
				);
				if (!rows.length) throw errors.notFound('Sperrzeit nicht gefunden');
			});
			await core.audit.logFromContext(ctx, 'rooms.room.unblocked', {
				target: params.id,
				metadata: summary(outcome)
			});
			return { id: params.blockId, deleted: true, ...summary(outcome) };
		}
	})
];
