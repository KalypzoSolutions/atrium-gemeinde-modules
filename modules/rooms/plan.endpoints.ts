/**
 * Stammdaten für die Oberfläche und Gesamtoptimierung durch die Raumverwaltung (Vorschau + Ausführen) sowie der
 * tägliche Job (Planungszeitraum verlängern, nachoptimieren).
 */
import {
	type AnyApiEndpoint,
	addDays,
	core,
	defineEndpoint,
	type ModuleJob,
	moduleDb,
	type RequestContext
} from '$lib/sdk/server';
import { loadFeatures, loadGroups, loadRooms } from './data';
import { expireSwaps } from './swaps.service';
import { eventsService } from './events-link';
import { notifyPlanChanges, notifySwap } from './notify';
import {
	allPlanDates,
	computePlan,
	horizonEnd,
	loadPlanContext,
	lockPlanning,
	replan,
	type PlanOutcome
} from './planning.service';
import { MODULE_ID, PERM_MANAGE, PERM_VIEW, planInput, type PlanPreview } from './schemas';

const tags = ['Modul: rooms'];

function preview(o: PlanOutcome, from: string, to: string): PlanPreview {
	return {
		from,
		to,
		moves: o.moves.slice(0, 500),
		unassigned: o.unassigned.slice(0, 200).map((u) => ({
			date: u.date,
			reason: `${u.title}: ${u.reason}`,
			busyRoomIds: u.busyRoomIds
		})),
		costBefore: o.heatingBefore,
		costAfter: o.heatingAfter
	};
}

/** Gesamtoptimierung des Zeitraums (gesperrte Termine bleiben) */
export async function runOptimization(
	ctx: RequestContext,
	input: { from?: string; days: number },
	write: boolean
): Promise<PlanPreview> {
	const pc = await loadPlanContext();
	const from = input.from && input.from > pc.today ? input.from : pc.today;
	const last = addDays(from, input.days - 1);
	const to = last < horizonEnd(pc) ? last : horizonEnd(pc);
	const dates = allPlanDates(pc, from, to);
	const outcome = await moduleDb(MODULE_ID).transaction(async (tx) => {
		if (!write) return computePlan(tx, pc, { dates });
		await lockPlanning(tx);
		return replan(tx, pc, { dates });
	});
	if (write) await notifyPlanChanges(ctx, outcome);
	return preview(outcome, from, to);
}

export const planEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/meta',
		summary: 'Merkmale, Räume und Planungseinstellungen für die Oberfläche',
		tags,
		permission: PERM_VIEW,
		handler: async () => {
			const pc = await loadPlanContext();
			const eventsAvailable = (await eventsService()) !== null;
			const data = await moduleDb(MODULE_ID).transaction(async (tx) => ({
				features: await loadFeatures(tx),
				rooms: await loadRooms(tx),
				groups: await loadGroups(tx)
			}));
			return {
				...data,
				today: pc.today,
				horizonEnd: horizonEnd(pc),
				lockDays: pc.settings.lockDays,
				bufferMinutes: pc.settings.bufferMinutes,
				eventsAvailable
			};
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/plan/preview',
		summary: 'Gesamtoptimierung als Vorschau (nichts wird gespeichert)',
		tags,
		permission: PERM_MANAGE,
		body: planInput,
		handler: async ({ ctx, body }) => runOptimization(ctx, body, false)
	}),
	defineEndpoint({
		method: 'POST',
		path: '/plan/run',
		summary: 'Gesamtoptimierung ausführen (Betroffene werden benachrichtigt)',
		tags,
		permission: PERM_MANAGE,
		body: planInput,
		handler: async ({ ctx, body }) => {
			const result = await runOptimization(ctx, body, true);
			await core.audit.logFromContext(ctx, 'rooms.plan.optimized', {
				metadata: { from: result.from, to: result.to, moved: result.moves.length }
			});
			return result;
		}
	})
];

export const replanJob: ModuleJob = {
	id: 'replan',
	summary: 'Planungszeitraum verlängern und Raumzuweisungen nachoptimieren',
	schedule: 'daily',
	run: async (ctx) => {
		const pc = await loadPlanContext();
		const outcome = await moduleDb(MODULE_ID).transaction(async (tx) => {
			await lockPlanning(tx);
			return replan(tx, pc, { dates: allPlanDates(pc) });
		});
		await notifyPlanChanges(ctx, outcome);
		const expired = await moduleDb(MODULE_ID).transaction((tx) => expireSwaps(tx, ctx, pc.today));
		for (const s of expired) await notifySwap(ctx, s, 'expired');
		return `${expired.length} Tauschanfragen abgelaufen, ${outcome.entries.length} Termine geplant, ${outcome.moves.length} verlegt, ${outcome.unassigned.length} ohne Raum`;
	}
};
