/**
 * Benachrichtigungen nach einer Umplanung (immer NACH der Transaktion; wirft nie):
 * - `booking-moved`: Eigentümer*in einer Buchung, deren Termin in einen anderen Raum verlegt wurde,
 * - `booking-unassigned`: Eigentümer*in und Raumverwaltung, wenn ein Termin keinen Raum mehr hat.
 * Die handelnde Person bekommt nichts. Je Buchung eine Nachricht (mehrere Termine gebündelt).
 */
import { bestEffort, core, formatDateDe, type RequestContext } from '$lib/sdk/server';
import type { PlanOutcome } from './planning.service';
import { MODULE_ID, NOTIFY_MOVED, NOTIFY_UNASSIGNED, PERM_MANAGE } from './schemas';

const link = (bookingId: string) => `/modules/rooms?booking=${encodeURIComponent(bookingId)}`;

function dateList(dates: string[]): string {
	const shown = dates.slice(0, 5).map((d) => formatDateDe(d));
	return dates.length > 5 ? `${shown.join(', ')} … (${dates.length} Termine)` : shown.join(', ');
}

export async function notifyPlanChanges(
	ctx: RequestContext,
	outcome: Pick<PlanOutcome, 'moves' | 'unassigned'>
): Promise<void> {
	if (!outcome.moves.length && !outcome.unassigned.length) return;
	await bestEffort(
		'rooms.notify.plan',
		async () => {
			const items = [];
			const moved = new Map<string, typeof outcome.moves>();
			for (const m of outcome.moves) {
				if (!m.toRoomId || m.ownerId === ctx.userId) continue;
				const list = moved.get(m.bookingId) ?? [];
				list.push(m);
				moved.set(m.bookingId, list);
			}
			for (const [bookingId, list] of moved) {
				const first = list[0]!;
				const rooms = [...new Set(list.map((m) => m.toRoomName ?? 'anderer Raum'))].join(', ');
				items.push({
					type: NOTIFY_MOVED,
					userIds: [first.ownerId],
					title: `Raum geändert: ${first.title}`,
					body: `Neuer Raum: ${rooms} – am ${dateList(list.map((m) => m.date))}.`,
					link: link(bookingId)
				});
			}
			if (outcome.unassigned.length) {
				const managers = await core.permissions.usersWith(PERM_MANAGE);
				const byBooking = new Map<string, typeof outcome.unassigned>();
				for (const u of outcome.unassigned) {
					const list = byBooking.get(u.bookingId) ?? [];
					list.push(u);
					byBooking.set(u.bookingId, list);
				}
				for (const [bookingId, list] of byBooking) {
					const first = list[0]!;
					const userIds = [...new Set([first.ownerId, ...managers])].filter(
						(id) => id !== ctx.userId
					);
					if (!userIds.length) continue;
					items.push({
						type: NOTIFY_UNASSIGNED,
						userIds,
						title: `Kein Raum mehr: ${first.title}`,
						body: `Für ${dateList(list.map((u) => u.date))} ist kein passender Raum frei. ${first.reason}`,
						link: link(bookingId)
					});
				}
			}
			if (items.length) await core.notifications.send(ctx, MODULE_ID, items);
		},
		{ ctx }
	);
}
