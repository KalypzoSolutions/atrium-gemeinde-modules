/**
 * Globale Suche (Befehlspalette): Räume nach Name/Gebäude und Buchungen nach Titel. Sichtbar für alle mit
 * `rooms.booking.view` (die Belegung ist gemeindeöffentlich); Buchungen mit nächstem kommenden Termin.
 */
import { sql } from 'drizzle-orm';
import {
	addDays,
	moduleDb,
	type ModuleSearchProvider,
	rowsOf,
	type SearchHit,
	todayBerlin
} from '$lib/sdk/server';
import { formatDateDe } from '$lib/sdk/dates';
import { loadBooking } from './data';
import { expandDates } from './recurrence';
import { MODULE_ID, PERM_VIEW } from './schemas';

const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export const roomsSearch: ModuleSearchProvider = {
	permission: PERM_VIEW,
	async run(_ctx, query, limit) {
		const p = like(query);
		const today = todayBerlin();
		return moduleDb(MODULE_ID).transaction(async (tx) => {
			const rooms = await rowsOf(
				tx,
				sql`SELECT id, name, building, capacity FROM rooms
					WHERE name ILIKE ${p} OR building ILIKE ${p}
					ORDER BY position, lower(name) LIMIT ${limit}`
			);
			const hits: SearchHit[] = rooms.map((r) => ({
				id: `room:${String(r.id)}`,
				title: String(r.name),
				subtitle: [r.building ? String(r.building) : null, `${Number(r.capacity)} Plätze`]
					.filter(Boolean)
					.join(' · '),
				href: `/modules/rooms?room=${encodeURIComponent(String(r.id))}`,
				icon: 'house',
				type: 'Raum'
			}));
			const bookings = await rowsOf(
				tx,
				sql`SELECT id FROM bookings WHERE title ILIKE ${p}
					AND (recurrence_until IS NULL OR recurrence_until >= ${today}::date)
					AND (recurrence IS NOT NULL OR starts_on >= ${today}::date)
					ORDER BY starts_on LIMIT ${limit}`
			);
			for (const row of bookings) {
				const b = await loadBooking(tx, String(row.id));
				if (!b) continue;
				const next = expandDates(b.startsOn, b.recurrence, today, addDays(today, 366), 50).find(
					(d) => !b.cancelled.has(d)
				);
				if (!next) continue;
				hits.push({
					id: `booking:${b.id}`,
					title: b.title,
					subtitle: `${formatDateDe(next)}, ${b.startsAt}–${b.endsAt} Uhr${b.recurrence ? ' · Serie' : ''}`,
					href: `/modules/rooms?date=${next}&booking=${encodeURIComponent(b.id)}`,
					icon: 'calendar',
					type: 'Raumbuchung'
				});
			}
			return hits.slice(0, limit);
		});
	}
};
