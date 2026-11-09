/**
 * Benachrichtigungen nach einer Umplanung (immer NACH der Transaktion; wirft nie):
 * - `booking-moved`: Eigentümer*in einer Buchung, deren Termin in einen anderen Raum verlegt wurde,
 * - `booking-unassigned`: Eigentümer*in und Raumverwaltung, wenn ein Termin keinen Raum mehr hat.
 * Die handelnde Person bekommt nichts. Je Buchung eine Nachricht (mehrere Termine gebündelt).
 */
import { bestEffort, core, formatDateDe, type RequestContext } from '$lib/sdk/server';
import type { PlanOutcome } from './planning.service';
import {
	MODULE_ID,
	NOTIFY_MOVED,
	NOTIFY_OBJECTION,
	NOTIFY_SWAP,
	NOTIFY_SWAP_ANSWER,
	NOTIFY_UNASSIGNED,
	PERM_MANAGE
} from './schemas';

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

/** Von der Raumverwaltung von Hand verschoben (Drag & Drop) */
export async function notifyManualMove(
	ctx: RequestContext,
	m: { bookingId: string; title: string; ownerId: string; date: string; toRoomName: string | null }
): Promise<void> {
	if (m.ownerId === ctx.userId) return;
	await bestEffort(
		'rooms.notify.manual-move',
		() =>
			core.notifications.send(ctx, MODULE_ID, [
				{
					type: NOTIFY_MOVED,
					userIds: [m.ownerId],
					title: `Raum geändert: ${m.title}`,
					body: `Die Raumverwaltung hat den Termin am ${formatDateDe(m.date)} nach ${m.toRoomName ?? 'einen anderen Raum'} gelegt. Widerspruch ist 48 Stunden lang möglich.`,
					link: link(m.bookingId)
				}
			]),
		{ ctx, target: m.bookingId }
	);
}

/** Widerspruch gegen eine Verlegung → Raumverwaltung */
export async function notifyObjection(
	ctx: RequestContext,
	m: { bookingId: string; title: string; date: string; note: string | null }
): Promise<void> {
	await bestEffort(
		'rooms.notify.objection',
		async () => {
			const managers = (await core.permissions.usersWith(PERM_MANAGE)).filter(
				(id) => id !== ctx.userId
			);
			if (!managers.length) return;
			await core.notifications.send(ctx, MODULE_ID, [
				{
					type: NOTIFY_OBJECTION,
					userIds: managers,
					title: `Widerspruch: ${m.title}`,
					body: `Gegen die Verlegung am ${formatDateDe(m.date)} wurde widersprochen.${m.note ? ` „${m.note}“` : ''}`,
					link: link(m.bookingId)
				}
			]);
		},
		{ ctx, target: m.bookingId }
	);
}

/** Tauschanfrage an die Gruppe der festen Buchung bzw. Antwort an die anfragende Person */
export async function notifySwap(
	ctx: RequestContext,
	s: {
		id: string;
		requesterId: string;
		targetOwnerId: string;
		requestTitle: string;
		targetTitle: string;
		date: string;
		roomName: string | null;
		proposedRoomName: string | null;
	},
	event: 'requested' | 'accepted' | 'declined' | 'expired'
): Promise<void> {
	const day = formatDateDe(s.date);
	const item =
		event === 'requested'
			? {
					type: NOTIFY_SWAP,
					userIds: [s.targetOwnerId],
					title: `Tauschanfrage: ${s.roomName ?? 'Raum'} am ${day}`,
					body: `„${s.requestTitle}“ bittet um ${s.roomName ?? 'euren Raum'}. Vorschlag für „${s.targetTitle}“: ${s.proposedRoomName ?? 'anderer Raum'}.`,
					link: `/modules/rooms?swap=${encodeURIComponent(s.id)}`
				}
			: {
					type: NOTIFY_SWAP_ANSWER,
					userIds: [s.requesterId],
					title:
						event === 'accepted'
							? `Tausch angenommen: ${s.roomName ?? 'Raum'} am ${day}`
							: event === 'declined'
								? `Tausch abgelehnt: ${s.roomName ?? 'Raum'} am ${day}`
								: `Tauschanfrage abgelaufen: ${s.roomName ?? 'Raum'} am ${day}`,
					body:
						event === 'accepted'
							? `„${s.requestTitle}“ ist gebucht.`
							: 'Wähle eine andere Uhrzeit oder einen anderen Raum.',
					link: `/modules/rooms?swap=${encodeURIComponent(s.id)}`
				};
	const userIds = item.userIds.filter((id) => id !== ctx.userId);
	if (!userIds.length) return;
	await bestEffort(
		'rooms.notify.swap',
		() => core.notifications.send(ctx, MODULE_ID, [{ ...item, userIds }]),
		{ ctx, target: s.id }
	);
}
