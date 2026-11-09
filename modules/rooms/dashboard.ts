/**
 * Übersicht: eigene Raumbuchungen in „Diese Woche“ (Art `room`) und für die Raumverwaltung Termine ohne Raum
 * in „Zu erledigen“.
 */
import { addDays, moduleDb, type ModuleDashboardSources } from '$lib/sdk/server';
import type { DashboardAgendaItem, DashboardTodo } from '$lib/sdk/types/dashboard';
import { listOccurrences } from './bookings.service';
import { MODULE_ID, PERM_MANAGE, PERM_VIEW } from './schemas';

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
		permission: PERM_MANAGE,
		async run(ctx, { today, limit }) {
			const items = await moduleDb(MODULE_ID).transaction((tx) =>
				listOccurrences(tx, ctx, { from: today, to: addDays(today, 60), unassigned: true })
			);
			return items.slice(0, limit).map((o): DashboardTodo => ({
				id: `rooms:${o.key}`,
				title: `Kein Raum: ${o.title}`,
				detail: `${o.startsAt}–${o.endsAt} Uhr, ${o.persons} Personen`,
				due: o.date,
				severity: o.date <= addDays(today, 7) ? 'due' : 'info',
				action: { label: 'Lösen', href: href(o.bookingId, o.date) }
			}));
		}
	}
};
