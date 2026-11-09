import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	adminContext,
	apiCall,
	contextForEmail,
	createApiKey,
	createRole,
	createUser,
	deleteUser,
	disableModule,
	enableModule,
	listAudit,
	registerCoreApi,
	registerModule,
	setSetting,
	syncModules,
	useTestDatabase
} from '$testing';
import { setTodayForTests } from '$lib/sdk/dates';
import type { RequestContext } from '$lib/sdk/types';
import roomsModule from '$modules/rooms/module';
import { roomsService } from '$modules/rooms/refs.service';
import type {
	AvailabilityResult,
	BookingDetail,
	Feature,
	Occurrence,
	PlanPreview,
	Room
} from '$modules/rooms/schemas';

const B = '/modules/rooms';
/** Montag; Termine ab Do (12.11.) sind nicht gesperrt (lockDays 3) */
const TODAY = '2026-11-09';
const DAY = '2026-11-17';

const keys: Record<string, string> = {};
const rooms: Record<string, string> = {};
const features: Record<string, string> = {};
let admin: RequestContext;
let memberCtx: RequestContext;
let memberId: string;

async function call<T>(who: string, method: string, path: string, json?: unknown) {
	return apiCall<T>(keys[who]!, method, `${B}${path}`, json);
}

async function ok<T>(who: string, method: string, path: string, json?: unknown, status?: number) {
	const r = await call<T>(who, method, path, json);
	expect(r.status, JSON.stringify(r.body)).toBe(status ?? (method === 'POST' ? 201 : 200));
	return r.body.data as T;
}

const booking = (over: Record<string, unknown> = {}) => ({
	title: 'Hauskreis',
	description: null,
	mode: 'flexible',
	roomId: null,
	persons: 10,
	featureIds: [],
	startsOn: DAY,
	startsAt: '18:00',
	endsAt: '20:00',
	recurrence: null,
	eventId: null,
	...over
});

async function occurrences(from = DAY, to = DAY) {
	return ok<Occurrence[]>('admin', 'GET', `/occurrences?from=${from}&to=${to}`);
}

beforeAll(async () => {
	setTodayForTests(TODAY);
	await useTestDatabase();
	registerCoreApi();
	registerModule(roomsModule);
	await syncModules();
	admin = await adminContext('admin@example.test', 'correct-horse-battery');
	await enableModule(admin, 'rooms');
	admin = await contextForEmail('admin@example.test');
	keys.admin = (
		await createApiKey(admin, {
			name: 'admin',
			scopes: [
				'rooms.booking.view',
				'rooms.booking.create',
				'rooms.booking.fix',
				'rooms.booking.edit-all',
				'rooms.room.manage'
			]
		})
	).key;

	const memberPerms = ['core.api.manage', 'rooms.booking.view', 'rooms.booking.create'];
	const memberRole = await createRole(admin, { name: 'gemeinde', permissions: memberPerms });
	memberId = await createUser(admin, {
		name: 'Maria Muster',
		email: 'maria@example.test',
		password: 'a-long-enough-pw',
		roleIds: [memberRole]
	});
	memberCtx = await contextForEmail('maria@example.test');
	keys.member = (await createApiKey(memberCtx, { name: 'm', scopes: memberPerms })).key;

	const viewPerms = ['core.api.manage', 'rooms.booking.view'];
	const viewRole = await createRole(admin, { name: 'lesen', permissions: viewPerms });
	await createUser(admin, {
		name: 'Lea Lesend',
		email: 'lea@example.test',
		password: 'a-long-enough-pw',
		roleIds: [viewRole]
	});
	keys.viewer = (
		await createApiKey(await contextForEmail('lea@example.test'), { name: 'v', scopes: viewPerms })
	).key;
});

afterAll(() => setTodayForTests(null));

describe('Räume: Stammdaten', () => {
	it('legt Merkmale und Räume an', async () => {
		for (const name of ['Klavier', 'Beamer', 'Ebenerdig']) {
			const f = await ok<Feature>('admin', 'POST', '/features', { name, icon: null });
			features[name] = f.id;
		}
		expect((await call('admin', 'POST', '/features', { name: 'klavier' })).status).toBe(409);

		const defs = [
			['Kirche', 200, 10, ['Klavier']],
			['Gemeindesaal', 80, 6, ['Beamer', 'Klavier', 'Ebenerdig']],
			['Jugendraum', 20, 2, ['Beamer', 'Ebenerdig']],
			['Kapelle', 12, 1, ['Klavier']]
		] as const;
		for (const [name, capacity, heat, f] of defs) {
			const r = await ok<Room>('admin', 'POST', '/rooms', {
				name,
				building: 'Gemeindehaus',
				capacity,
				heatingLevel: heat,
				featureIds: f.map((x) => features[x])
			});
			rooms[name] = r.id;
			expect(r.featureIds).toHaveLength(f.length);
		}
		const list = await ok<Room[]>('viewer', 'GET', '/rooms');
		expect(list.map((r) => r.name)).toEqual(['Kirche', 'Gemeindesaal', 'Jugendraum', 'Kapelle']);
	});

	it('nur die Raumverwaltung ändert Räume', async () => {
		expect((await call('member', 'POST', '/rooms', { name: 'X', capacity: 1 })).status).toBe(403);
		const bad = await call('admin', 'POST', '/rooms', {
			name: 'Y',
			capacity: 5,
			featureIds: [crypto.randomUUID()]
		});
		expect(bad.status).toBe(422);
	});
});

describe('Räume: Buchen und automatische Zuweisung', () => {
	let flexId: string;

	it('weist den kleinsten passenden Raum zu', async () => {
		const d = await ok<BookingDetail>('member', 'POST', '/bookings', booking());
		flexId = d.id;
		expect(d.upcoming[0]).toMatchObject({ date: DAY, roomName: 'Kapelle' });
		expect(d.canEdit).toBe(true);
		expect(d.ownerName).toBe('Maria Muster');
	});

	it('beachtet Merkmale und Personenzahl', async () => {
		const d = await ok<BookingDetail>(
			'member',
			'POST',
			'/bookings',
			booking({ title: 'Chorprobe', persons: 30, featureIds: [features.Klavier] })
		);
		expect(d.upcoming[0]!.roomName).toBe('Gemeindesaal');
	});

	it('Probelauf zeigt Raum und Verlegungen, ohne zu speichern', async () => {
		const r = await ok<AvailabilityResult>(
			'admin',
			'POST',
			'/availability',
			booking({ mode: 'fixed', roomId: rooms.Kapelle, persons: 4, bookingId: null }),
			201
		);
		expect(r.ok).toBe(true);
		expect(r.assignments[0]!.roomName).toBe('Kapelle');
		expect(r.moves.map((m) => m.title)).toEqual(['Hauskreis']);
		const occ = await occurrences();
		expect(occ.find((o) => o.bookingId === flexId)!.roomName).toBe('Kapelle');
	});

	it('feste Buchung nur mit Recht', async () => {
		const r = await call(
			'member',
			'POST',
			'/bookings',
			booking({ mode: 'fixed', roomId: rooms.Kapelle })
		);
		expect(r.status).toBe(403);
	});

	it('feste Buchung verdrängt die flexible in den nächstbesten Raum', async () => {
		const fixed = await ok<BookingDetail>(
			'admin',
			'POST',
			'/bookings',
			booking({ title: 'Andacht', mode: 'fixed', roomId: rooms.Kapelle, persons: 4 })
		);
		expect(fixed.upcoming[0]!.roomName).toBe('Kapelle');
		const occ = await occurrences();
		expect(occ.find((o) => o.bookingId === flexId)!.roomName).toBe('Jugendraum');
	});

	it('kein Raum frei → 409 mit Begründung, nichts gespeichert', async () => {
		const before = (await occurrences()).length;
		const r = await call('member', 'POST', '/bookings', booking({ title: 'Riesig', persons: 500 }));
		expect(r.status).toBe(409);
		expect(r.body.error?.code).toBe('conflict');
		expect(r.body.error?.details).toMatchObject({ code: 'ROOMS_NO_ROOM' });
		expect((await occurrences()).length).toBe(before);
		// fester Raum mit zu vielen Personen → 422
		const tooMany = await call(
			'admin',
			'POST',
			'/bookings',
			booking({ mode: 'fixed', roomId: rooms.Kapelle, persons: 50 })
		);
		expect(tooMany.status).toBe(422);
	});

	it('Zugriff: lesen ja, fremd ändern nein', async () => {
		expect((await call('viewer', 'GET', `/bookings/${flexId}`)).status).toBe(200);
		const put = await call('viewer', 'PUT', `/bookings/${flexId}`, booking({ title: 'X' }));
		expect(put.status).toBe(403);
		const d = await ok<BookingDetail>('viewer', 'GET', `/bookings/${flexId}`);
		expect(d.canEdit).toBe(false);
		expect((await call('viewer', 'POST', '/bookings', booking())).status).toBe(403);
	});

	it('Löschen gibt den Raum frei – die flexible zieht zurück in die Kapelle', async () => {
		const occ = await occurrences();
		const andacht = occ.find((o) => o.title === 'Andacht')!;
		await ok('admin', 'DELETE', `/bookings/${andacht.bookingId}`);
		const after = await occurrences();
		expect(after.find((o) => o.bookingId === flexId)!.roomName).toBe('Kapelle');
	});
});

describe('Räume: Dauertermine', () => {
	let seriesId: string;

	it('wöchentliche Serie bleibt im selben Raum', async () => {
		const d = await ok<BookingDetail>(
			'member',
			'POST',
			'/bookings',
			booking({
				title: 'Konfirmandenunterricht',
				startsOn: '2026-11-18',
				startsAt: '16:00',
				endsAt: '17:30',
				persons: 15,
				recurrence: { freq: 'weekly', interval: 1, end: { type: 'count', count: 4 } }
			})
		);
		seriesId = d.id;
		expect(d.upcoming.map((u) => u.date)).toEqual([
			'2026-11-18',
			'2026-11-25',
			'2026-12-02',
			'2026-12-09'
		]);
		expect(new Set(d.upcoming.map((u) => u.roomName))).toEqual(new Set(['Jugendraum']));
	});

	it('einzelnen Termin absagen und wiederherstellen', async () => {
		const d = await ok<BookingDetail>(
			'member',
			'PUT',
			`/bookings/${seriesId}/occurrences/2026-11-25`
		);
		expect(d.cancelledDates).toEqual(['2026-11-25']);
		const occ = await occurrences('2026-11-18', '2026-12-09');
		expect(occ.filter((o) => o.bookingId === seriesId)).toHaveLength(3);
		const back = await ok<BookingDetail>(
			'member',
			'DELETE',
			`/bookings/${seriesId}/occurrences/2026-11-25`
		);
		expect(back.cancelledDates).toEqual([]);
		expect(back.upcoming.find((u) => u.date === '2026-11-25')!.roomName).toBe('Jugendraum');
		const bad = await call('member', 'PUT', `/bookings/${seriesId}/occurrences/2026-11-26`);
		expect(bad.status).toBe(404);
	});
});

describe('Räume: Sperrzeiten, Optimierung, Verwaltung', () => {
	it('Sperrzeit verlegt Termine bzw. lässt sie ohne Raum', async () => {
		const r = await ok<{ moved: number; unassigned: number }>(
			'admin',
			'POST',
			`/rooms/${rooms.Jugendraum}/blocks`,
			{ startsOn: '2026-12-02', endsOn: '2026-12-02', reason: 'Renovierung' }
		);
		expect(r.moved).toBeGreaterThan(0);
		const occ = await occurrences('2026-12-02', '2026-12-02');
		const konfi = occ.find((o) => o.title === 'Konfirmandenunterricht')!;
		expect(konfi.roomName).toBe('Gemeindesaal');
		const audit = await listAudit({ action: 'rooms.room.blocked' } as never);
		expect(JSON.stringify(audit)).not.toContain('Maria');
	});

	it('Gesamtoptimierung: Vorschau ändert nichts', async () => {
		const p = await ok<PlanPreview>('admin', 'POST', '/plan/preview', { days: 60 }, 201);
		expect(p.costAfter).toBeLessThanOrEqual(p.costBefore);
		expect((await call('member', 'POST', '/plan/preview', { days: 10 })).status).toBe(403);
	});

	it('Raum löschen macht feste Buchungen flexibel', async () => {
		const fixed = await ok<BookingDetail>(
			'admin',
			'POST',
			'/bookings',
			booking({
				title: 'Orgelstunde',
				startsOn: '2026-11-19',
				mode: 'fixed',
				roomId: rooms.Kirche,
				persons: 2
			})
		);
		await ok('admin', 'DELETE', `/rooms/${rooms.Kirche}`);
		const d = await ok<BookingDetail>('admin', 'GET', `/bookings/${fixed.id}`);
		expect(d.mode).toBe('flexible');
		expect(d.upcoming[0]!.roomName).toBe('Kapelle');
	});
});

describe('Räume: Kopplung mit dem Termine-Modul (RoomsService)', () => {
	const eventId = 'evt-1';
	const spec = (over: Record<string, unknown> = {}) => ({
		title: 'Gemeindefest-Vorbereitung',
		startsOn: '2026-11-20',
		startsAt: '19:00',
		endsAt: '21:00',
		endsOn: null,
		recurrence: null,
		cancelledDates: [],
		mode: 'flexible' as const,
		roomId: null,
		persons: 25,
		featureIds: [],
		...over
	});

	it('liefert Auswahl und prüft Probeläufe', async () => {
		const opts = await roomsService.roomOptions(memberCtx);
		expect(opts?.canBook).toBe(true);
		expect(opts?.canFix).toBe(false);
		const check = await roomsService.checkEventBooking(memberCtx, null, spec());
		expect(check).toMatchObject({ ok: true });
		const monthly = await roomsService.checkEventBooking(
			memberCtx,
			null,
			spec({ recurrence: { freq: 'monthly', interval: 1 } })
		);
		expect(monthly).toMatchObject({ ok: false, code: 'ROOMS_UNSUPPORTED' });
		const allDay = await roomsService.checkEventBooking(memberCtx, null, spec({ startsAt: null }));
		expect(allDay).toMatchObject({ ok: false, code: 'ROOMS_UNSUPPORTED' });
		const fixed = await roomsService.checkEventBooking(
			memberCtx,
			null,
			spec({ mode: 'fixed', roomId: rooms.Kapelle })
		);
		expect(fixed).toMatchObject({ ok: false, code: 'ROOMS_FORBIDDEN' });
	});

	it('legt die Buchung zum Termin an, ändert und entfernt sie', async () => {
		const r = await roomsService.syncEventBooking(memberCtx, eventId, spec());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.assignments[0]!.roomName).toBe('Gemeindesaal');
		// Über die Raum-API nicht änderbar
		const put = await call('member', 'PUT', `/bookings/${r.bookingId}`, booking());
		expect(put.status).toBe(409);

		// wöchentlich im Format von `events`
		const weekly = await roomsService.syncEventBooking(
			memberCtx,
			eventId,
			spec({
				persons: 8,
				recurrence: {
					freq: 'weekly',
					interval: 1,
					byWeekday: [5],
					end: { type: 'count', count: 3 }
				},
				cancelledDates: ['2026-11-27']
			})
		);
		expect(weekly).toMatchObject({ ok: true, bookingId: r.bookingId });
		const info = await roomsService.eventRooms(memberCtx, [eventId]);
		expect(info[0]!.request.persons).toBe(8);
		expect(info[0]!.assignments.map((a) => [a.date, a.roomName])).toEqual([
			['2026-11-20', 'Kapelle'],
			['2026-12-04', 'Kapelle']
		]);

		const full = await roomsService.syncEventBooking(memberCtx, eventId, spec({ persons: 900 }));
		expect(full).toMatchObject({ ok: false, code: 'ROOMS_NO_ROOM' });
		// unverändert
		expect((await roomsService.eventRooms(memberCtx, [eventId]))[0]!.request.persons).toBe(8);

		await roomsService.removeEventBooking(memberCtx, eventId);
		expect(await roomsService.eventRooms(memberCtx, [eventId])).toEqual([]);
	});
});

describe('Räume: Lebenszyklus', () => {
	it('Konto gelöscht → Buchungen gehen an die löschende Person', async () => {
		const d = await ok<BookingDetail>(
			'member',
			'POST',
			'/bookings',
			booking({ title: 'Bibelkreis', startsOn: '2026-11-24' })
		);
		await deleteUser(admin, memberId);
		const after = await ok<BookingDetail>('admin', 'GET', `/bookings/${d.id}`);
		expect(after.ownerId).toBe(admin.userId);
	});

	it('Einstellungen wirken (Planungszeitraum)', async () => {
		await setSetting(admin, 'rooms.horizonDays', 30);
		const r = await call('admin', 'POST', '/bookings', booking({ startsOn: '2027-01-20' }));
		expect(r.status).toBe(422);
		await setSetting(admin, 'rooms.horizonDays', 180);
	});

	it('deaktiviertes Modul → 404', async () => {
		await disableModule(admin, 'rooms');
		expect((await call('admin', 'GET', '/rooms')).status).toBe(404);
		await enableModule(admin, 'rooms');
	});
});
