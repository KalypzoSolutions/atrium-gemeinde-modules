/**
 * Datenschutz und Wartung:
 * - `onUserDeleted`: Buchungen sind Gemeindedaten und bleiben. Eigentum geht an die löschende Person
 *   (`transferTo`; ohne sie bleibt es, und nur `edit-all` verwaltet die Buchungen). Zuordnungs-Spalten
 *   (`created_by`, `updated_by`) werden `NULL`.
 * - `resetAreas`/`resetUsers`: Admin-Reset (Buchungen bzw. alles).
 * - `subjectExport`: eigene bzw. angelegte Buchungen der Person.
 */
import { sql } from 'drizzle-orm';
import {
	type DataSubject,
	type ModuleDefinition,
	moduleDb,
	type ModuleSubjectExport,
	type ResetArea,
	rowsOf,
	toIsoOrNull
} from '$lib/sdk/server';
import { MODULE_ID } from './schemas';

export const onUserDeleted: ModuleDefinition['onUserDeleted'] = async (
	tx,
	{ userId, transferTo }
) => {
	if (transferTo) {
		await tx.execute(sql`UPDATE bookings SET owner_id = ${transferTo} WHERE owner_id = ${userId}`);
	}
	await tx.execute(sql`UPDATE bookings SET created_by = NULL WHERE created_by = ${userId}`);
	await tx.execute(
		sql`UPDATE booking_exceptions SET updated_by = NULL WHERE updated_by = ${userId}`
	);
	await tx.execute(sql`UPDATE room_blocks SET created_by = NULL WHERE created_by = ${userId}`);
};

export const resetAreas: ResetArea[] = [
	{
		id: 'bookings',
		label: 'Raumbuchungen',
		description:
			'Löscht alle Buchungen, abgesagte Termine und Raumzuweisungen. Räume, Merkmale und Sperrzeiten bleiben. ' +
			'Termine im Modul „Termine“ verlieren ihren gebuchten Raum.',
		tables: ['assignments', 'booking_exceptions', 'booking_features', 'bookings']
	},
	{
		id: 'all',
		label: 'Räume und Buchungen',
		description: 'Löscht alle Räume, Merkmale, Sperrzeiten und Buchungen.',
		tables: [
			'assignments',
			'booking_exceptions',
			'booking_features',
			'bookings',
			'room_blocks',
			'room_features',
			'rooms',
			'features'
		],
		implies: [{ area: 'rooms:bookings', reason: 'Buchungen brauchen Räume' }],
		rebuild: true
	}
];

export const resetUsers: ModuleDefinition['resetUsers'] = async (tx, keepUserId) => {
	await tx.execute(
		sql`UPDATE bookings SET owner_id = ${keepUserId} WHERE owner_id <> ${keepUserId}`
	);
	await tx.execute(
		sql`UPDATE bookings SET created_by = ${keepUserId}
			WHERE created_by IS NOT NULL AND created_by <> ${keepUserId}`
	);
	await tx.execute(
		sql`UPDATE booking_exceptions SET updated_by = ${keepUserId}
			WHERE updated_by IS NOT NULL AND updated_by <> ${keepUserId}`
	);
	await tx.execute(
		sql`UPDATE room_blocks SET created_by = ${keepUserId}
			WHERE created_by IS NOT NULL AND created_by <> ${keepUserId}`
	);
};

async function run({ userId }: DataSubject): Promise<Record<string, unknown> | null> {
	if (!userId) return null;
	const rows = await moduleDb(MODULE_ID).transaction((tx) =>
		rowsOf(
			tx,
			sql`SELECT b.id, b.title, b.description, b.mode, b.persons,
					to_char(b.starts_on, 'YYYY-MM-DD') AS starts_on, b.starts_at, b.ends_at,
					b.recurrence IS NOT NULL AS recurring, b.event_id, b.owner_id, b.created_by,
					b.created_at, b.updated_at
				FROM bookings b WHERE b.owner_id = ${userId} OR b.created_by = ${userId}
				ORDER BY b.starts_on, b.id`
		)
	);
	if (!rows.length) return null;
	return {
		bookings: rows.map((r) => ({
			id: String(r.id),
			title: String(r.title),
			description: r.description == null ? null : String(r.description),
			mode: String(r.mode),
			persons: Number(r.persons),
			startsOn: String(r.starts_on),
			startsAt: String(r.starts_at),
			endsAt: String(r.ends_at),
			recurring: r.recurring === true,
			eventId: r.event_id == null ? null : String(r.event_id),
			isOwner: r.owner_id === userId,
			createdByPerson: r.created_by === userId,
			createdAt: toIsoOrNull(r.created_at),
			updatedAt: toIsoOrNull(r.updated_at)
		}))
	};
}

export const subjectExport: ModuleSubjectExport = { run };
