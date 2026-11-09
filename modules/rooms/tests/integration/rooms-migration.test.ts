/** Upgrade 0001 → 0002: Heizkosten in Cent werden zum Heizaufwand 1–10 (2,50 € je Stufe), Bestand bleibt gültig. */
import { beforeAll, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
	migrateModuleRest,
	migrateModuleTo,
	moduleSql,
	registerModule,
	syncModules,
	useTestDatabase
} from '$testing';
import roomsModule from '$modules/rooms/module';

beforeAll(async () => {
	await useTestDatabase();
	registerModule(roomsModule);
	await syncModules();
});

it('leitet den Heizaufwand aus den alten Heizkosten ab', async () => {
	await migrateModuleTo('rooms', '0001_init');
	for (const [id, name, cents] of [
		['r1', 'Kirche', 2500],
		['r2', 'Saal', 900],
		['r3', 'Kapelle', 100],
		['r4', 'Ohne Angabe', 0],
		['r5', 'Palast', 99_000]
	] as const) {
		await moduleSql(
			'rooms',
			sql`INSERT INTO rooms (id, name, capacity, heating_cost_cents_per_hour) VALUES (${id}, ${name}, 10, ${cents})`
		);
	}
	await moduleSql(
		'rooms',
		sql`INSERT INTO bookings (id, title, owner_id, mode, fixed_room_id, persons, starts_on, starts_at, ends_at)
			VALUES ('b1', 'Alt fest', 'u1', 'fixed', 'r1', 5, '2026-11-20', '10:00', '11:00')`
	);
	await migrateModuleRest('rooms');
	const rows = await moduleSql('rooms', sql`SELECT id, heating_level FROM rooms ORDER BY id`);
	expect(rows.map((r) => [r.id, Number(r.heating_level)])).toEqual([
		['r1', 10],
		['r2', 4],
		['r3', 1],
		['r4', 5],
		['r5', 10]
	]);
	const [b] = await moduleSql('rooms', sql`SELECT mode, group_id FROM bookings WHERE id = 'b1'`);
	expect(b).toMatchObject({ mode: 'fixed', group_id: null });
	// neue Stufe erlaubt
	await moduleSql('rooms', sql`UPDATE bookings SET mode = 'similar' WHERE id = 'b1'`);
	await expect(
		moduleSql('rooms', sql`UPDATE rooms SET heating_level = 11 WHERE id = 'r1'`)
	).rejects.toThrow();
});
