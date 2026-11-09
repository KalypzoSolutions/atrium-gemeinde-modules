/**
 * Übersicht: eigene Raumbuchungen in „Diese Woche“ (Art `room`) und für die Raumverwaltung Termine ohne Raum
 * in „Zu erledigen“.
 */
import { addDays, formatDateDe, moduleDb, type ModuleDashboardSources } from '$lib/sdk/server';
import type { DashboardAgendaItem, DashboardTodo } from '$lib/sdk/types/dashboard';
import { listOccurrences } from './bookings.service';
import { canManage, loadMovesFor } from './moves.service';
import { MODULE_ID, PERM_VIEW } from './schemas';
import { listSwaps } from './swaps.service';

const href = (bookingId: string, date: string) =>
	`/modules/rooms?date=${date}&booking=${encodeURIComponent(bookingId)}`;

export const roomsDashboard: ModuleDashboardSources = {
	agendaKinds: [{ key: 'room', label: 'Raum', style: 'outline' }],
	agenda: {
		permission: PERM_VIEW,
		async run(ctx, { from, to }) {
			const items = await moduleDb(MODULE_ID).transaction((tx) =>
				listOccurrences(tx, ctx, { from, to, mine: true })
			);
			return items
				.filter((o) => !o.managedByEvent)
				.map((o): DashboardAgendaItem => ({
					id: `rooms:${o.key}`,
					kind: 'room',
					title: o.title,
					date: o.date,
					endDate: null,
					startTime: o.startsAt,
					endTime: o.endsAt,
					detail: o.roomName ?? (o.planned ? 'Ohne Raum' : 'Raum folgt'),
					href: href(o.bookingId, o.date)
				}));
		}
	},
	todos: {
		permission: PERM_VIEW,
		async run(ctx, { today, limit }) {
			const manager = canManage(ctx);
			const data = await moduleDb(MODULE_ID).transaction(async (tx) => ({
				unassigned: manager
					? await listOccurrences(tx, ctx, {
							from: today,
							to: addDays(today, 60),
							unassigned: true
						})
					: [],
				objected: manager ? await loadMovesFor(tx, ctx, { objected: true, limit }) : [],
				swaps: await listSwaps(tx, ctx, { pendingOnly: true, targetOwnerOnly: !manager }),
				myMoves: ctx.userId
					? await loadMovesFor(tx, ctx, { ownerId: ctx.userId, objectionOpen: true, limit })
					: []
			}));
			const todos: DashboardTodo[] = [];
			for (const s of data.swaps) {
				if (!s.canDecide) continue;
				todos.push({
					id: `rooms:swap:${s.id}`,
					title: `Tauschanfrage: ${s.roomName ?? 'Raum'}`,
					detail: `${formatDateDe(s.date)} · „${s.requestTitle}“ möchte den Raum von „${s.targetTitle}“`,
					due: s.dueOn,
					severity: 'due',
					action: { label: 'Antworten', href: `/modules/rooms?swap=${encodeURIComponent(s.id)}` }
				});
			}
			for (const m of data.myMoves) {
				todos.push({
					id: `rooms:move:${m.id}`,
					title: `${m.title} zieht um`,
					detail: `${formatDateDe(m.date)} · ${m.fromRoomName ?? 'ohne Raum'} → ${m.toRoomName ?? 'ohne Raum'}`,
					due: m.objectionUntil?.slice(0, 10) ?? null,
					severity: 'info',
					action: { label: 'Ansehen', href: href(m.bookingId, m.date) }
				});
			}
			for (const m of data.objected) {
				todos.push({
					id: `rooms:objection:${m.id}`,
					title: `Widerspruch: ${m.title}`,
					detail: `${formatDateDe(m.date)} · ${m.toRoomName ?? 'ohne Raum'}${m.objectionNote ? ` · „${m.objectionNote}“` : ''}`,
					due: m.date,
					severity: 'due',
					action: { label: 'Lösen', href: href(m.bookingId, m.date) }
				});
			}
			for (const o of data.unassigned) {
				todos.push({
					id: `rooms:${o.key}`,
					title: `Kein Raum: ${o.title}`,
					detail: `${o.startsAt}–${o.endsAt} Uhr, ${o.persons} Personen`,
					due: o.date,
					severity: o.date <= addDays(today, 7) ? 'due' : 'info',
					action: { label: 'Lösen', href: href(o.bookingId, o.date) }
				});
			}
			return todos.slice(0, limit);
		}
	}
};
