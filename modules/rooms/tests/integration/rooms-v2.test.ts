/**
 * Raumplanung 2.0: „Raum wie dieser“, Verlegen wenn eine andere Gruppe den Raum braucht (mit Widerspruch),
 * Drag & Drop der Raumverwaltung, Tauschanfragen für feste Buchungen, Gruppen, Heizaufwand.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	adminContext,
	apiCall,
	contextForEmail,
	createApiKey,
	createRole,
	createUser,
	enableModule,
	registerCoreApi,
	registerModule,
	syncModules,
	useTestDatabase
} from '$testing';
import { setTodayForTests } from '$lib/sdk/dates';
import roomsModule from '$modules/rooms/module';
import type {
	AvailabilityResult,
	BookingDetail,
	DropTarget,
	Feature,
	Group,
	MoveInfo,
	Occurrence,
	Room,
	SwapInfo
} from '$modules/rooms/schemas';

const B = '/modules/rooms';
const DAY = '2026-11-18';
const keys: Record<string, string> = {};
const rooms: Record<string, string> = {};
const features: Record<string, string> = {};

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
	persons: 12,
	featureIds: [],
	startsOn: DAY,
	startsAt: '19:30',
	endsAt: '21:00',
	recurrence: null,
	eventId: null,
	groupId: null,
	...over
});
const roomOf = async (title: string, date = DAY) =>
	(await ok<Occurrence[]>('admin', 'GET', `/occurrences?from=${date}&to=${date}`)).find(
		(o) => o.title === title
	);

beforeAll(async () => {
	setTodayForTests('2026-11-09');
	await useTestDatabase();
	registerCoreApi();
	registerModule(roomsModule);
	await syncModules();
	let admin = await adminContext('admin@example.test', 'correct-horse-battery');
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
	const member = await createRole(admin, { name: 'gemeinde', permissions: memberPerms });
	await createUser(admin, {
		name: 'Maria Muster',
		email: 'maria@example.test',
		password: 'a-long-enough-pw',
		roleIds: [member]
	});
	keys.maria = (
		await createApiKey(await contextForEmail('maria@example.test'), {
			name: 'm',
			scopes: memberPerms
		})
	).key;
	const fixPerms = [...memberPerms, 'rooms.booking.fix'];
	const organist = await createRole(admin, { name: 'organist', permissions: fixPerms });
	await createUser(admin, {
		name: 'Paul Orgel',
		email: 'paul@example.test',
		password: 'a-long-enough-pw',
		roleIds: [organist]
	});
	keys.paul = (
		await createApiKey(await contextForEmail('paul@example.test'), { name: 'p', scopes: fixPerms })
	).key;

	for (const name of ['Klavier', 'Ebenerdig', 'Orgel']) {
		features[name] = (await ok<Feature>('admin', 'POST', '/features', { name, icon: null })).id;
	}
	const defs = [
		['Kirche', 200, 10, ['Klavier', 'Orgel']],
		['Gemeindesaal', 80, 6, ['Ebenerdig']],
		['Kapelle', 40, 3, ['Klavier']],
		['Gruppenraum', 15, 2, ['Ebenerdig']]
	] as const;
	for (const [name, capacity, heatingLevel, f] of defs) {
		const r = await ok<Room>('admin', 'POST', '/rooms', {
			name,
			capacity,
			heatingLevel,
			featureIds: f.map((x) => features[x])
		});
		rooms[name] = r.id;
		expect(r.heatingLevel).toBe(heatingLevel);
	}
	// Kirche am Mittwoch gesperrt → Klavier gibt es dann nur in der Kapelle
	await ok('admin', 'POST', `/rooms/${rooms.Kirche}/blocks`, {
		startsOn: DAY,
		endsOn: DAY,
		reason: 'Heizungswartung'
	});
});

afterAll(() => setTodayForTests(null));

describe('Gruppen', () => {
	it('legt Gruppen mit Farbe und Vorrang an', async () => {
		const g = await ok<Group>('admin', 'POST', '/groups', {
			name: 'Kirchenmusik',
			color: '#7c3aed',
			priority: 3
		});
		expect(g).toMatchObject({ name: 'Kirchenmusik', priority: 3, bookingCount: 0 });
		expect((await call('admin', 'POST', '/groups', { name: 'X', priority: 5 })).status).toBe(422);
		expect((await call('maria', 'POST', '/groups', { name: 'Y' })).status).toBe(403);
		expect((await call('admin', 'POST', '/groups', { name: 'kirchenmusik' })).status).toBe(409);
	});
});

describe('Raum wie dieser', () => {
	it('bleibt im Wunschraum, auch wenn ein günstigerer frei ist', async () => {
		const d = await ok<BookingDetail>(
			'maria',
			'POST',
			'/bookings',
			booking({ mode: 'similar', roomId: rooms.Kapelle })
		);
		expect(d.mode).toBe('similar');
		expect(d.upcoming[0]!.roomName).toBe('Kapelle');
	});

	it('Wunschraum muss die gewählten Merkmale haben (422)', async () => {
		const r = await call(
			'maria',
			'POST',
			'/bookings',
			booking({ mode: 'similar', roomId: rooms.Gruppenraum, featureIds: [features.Klavier] })
		);
		expect(r.status).toBe(422);
	});

	it('Probelauf zeigt Raumvorschläge mit Begründung', async () => {
		const r = await ok<AvailabilityResult>(
			'paul',
			'POST',
			'/availability',
			booking({
				title: 'Kirchenchor',
				persons: 35,
				featureIds: [features.Klavier],
				endsAt: '21:30'
			}),
			201
		);
		expect(r.ok).toBe(true);
		const byName = new Map(r.candidates.map((c) => [c.name, c]));
		expect(byName.get('Kapelle')?.status).toBe('best');
		expect(byName.get('Kirche')).toMatchObject({ status: 'unsuitable', reason: 'Gesperrt' });
		expect(byName.get('Gruppenraum')?.status).toBe('unsuitable');
		expect(r.moves.map((m) => m.title)).toEqual(['Hauskreis']);
	});

	it('zieht um, wenn eine andere Gruppe genau diesen Raum braucht', async () => {
		await ok(
			'paul',
			'POST',
			'/bookings',
			booking({
				title: 'Kirchenchor',
				persons: 35,
				featureIds: [features.Klavier],
				endsAt: '21:30'
			})
		);
		expect((await roomOf('Kirchenchor'))?.roomName).toBe('Kapelle');
		const hauskreis = await roomOf('Hauskreis');
		expect(hauskreis?.roomName).toBe('Gruppenraum');
		expect(hauskreis?.moved).toMatchObject({ kind: 'auto', objectionOpen: true });
	});

	it('die Gruppe kann widersprechen; die Verwaltung sieht und erledigt es', async () => {
		const mine = await ok<MoveInfo[]>('maria', 'GET', '/moves?scope=mine');
		expect(mine).toHaveLength(1);
		expect(mine[0]).toMatchObject({ toRoomName: 'Gruppenraum', canObject: true });
		expect(mine[0]!.reason).toContain('Kirchenchor');
		expect((await call('paul', 'POST', `/moves/${mine[0]!.id}/object`, {})).status).toBe(409);
		await ok('maria', 'POST', `/moves/${mine[0]!.id}/object`, { note: 'Zu eng' }, 201);
		expect((await call('maria', 'POST', `/moves/${mine[0]!.id}/object`, {})).status).toBe(409);
		expect((await call('maria', 'GET', '/moves?scope=objected')).status).toBe(403);
		const objected = await ok<MoveInfo[]>('admin', 'GET', '/moves?scope=objected');
		expect(objected[0]).toMatchObject({ objectionNote: 'Zu eng' });
		await ok('admin', 'POST', `/moves/${mine[0]!.id}/resolve`, undefined, 201);
		expect(await ok<MoveInfo[]>('admin', 'GET', '/moves?scope=objected')).toEqual([]);
	});
});

describe('Drag & Drop der Raumverwaltung', () => {
	it('prüft alle Räume mit Grund', async () => {
		const h = (await roomOf('Hauskreis'))!;
		const targets = await ok<DropTarget[]>(
			'admin',
			'GET',
			`/bookings/${h.bookingId}/occurrences/${DAY}/targets`
		);
		const t = new Map(targets.map((x) => [x.roomId, x]));
		expect(t.get(rooms.Gruppenraum!)).toMatchObject({ current: true, ok: false });
		expect(t.get(rooms.Kirche!)).toMatchObject({ ok: false, label: 'Gesperrt' });
		expect(t.get(rooms.Kapelle!)).toMatchObject({ ok: false, label: 'Belegt 19:30–21:30' });
		expect(t.get(rooms.Gemeindesaal!)).toMatchObject({ ok: true });
		expect(
			(await call('maria', 'GET', `/bookings/${h.bookingId}/occurrences/${DAY}/targets`)).status
		).toBe(403);
	});

	it('legt den Termin in einen passenden Raum und hält ihn dort fest', async () => {
		const h = (await roomOf('Hauskreis'))!;
		const url = `/bookings/${h.bookingId}/occurrences/${DAY}/room`;
		expect((await call('admin', 'PUT', url, { roomId: rooms.Kapelle })).status).toBe(422);
		await ok('admin', 'PUT', url, { roomId: rooms.Gemeindesaal });
		const after = (await roomOf('Hauskreis'))!;
		expect(after).toMatchObject({ roomName: 'Gemeindesaal', pinned: true });
		expect(after.moved?.kind).toBe('manual');
		// Planer verschiebt festgelegte Termine nicht (Optimierung)
		await ok('admin', 'POST', '/plan/run', { days: 30 }, 201);
		expect((await roomOf('Hauskreis'))?.roomName).toBe('Gemeindesaal');
		// Festlegung aufheben → wieder frei verteilt (Wunschraum Kapelle belegt → gleichwertig, günstigster)
		await ok('admin', 'DELETE', url);
		expect((await roomOf('Hauskreis'))?.pinned).toBe(false);
	});

	it('feste Buchungen nur mit Bestätigung', async () => {
		const fixed = await ok<BookingDetail>(
			'paul',
			'POST',
			'/bookings',
			booking({
				title: 'Andacht',
				mode: 'fixed',
				roomId: rooms.Kapelle,
				startsAt: '08:00',
				endsAt: '08:30',
				persons: 10
			})
		);
		const url = `/bookings/${fixed.id}/occurrences/${DAY}/room`;
		const r = await call('admin', 'PUT', url, { roomId: rooms.Gruppenraum });
		expect(r.status).toBe(409);
		expect(r.body.error?.details).toMatchObject({ code: 'ROOMS_CONFIRM_FIXED' });
		await ok('admin', 'PUT', url, { roomId: rooms.Gruppenraum, confirmFixed: true });
		expect((await roomOf('Andacht'))?.roomName).toBe('Gruppenraum');
	});
});

describe('Tauschanfragen', () => {
	const DATE = '2026-11-20';
	let swapId = '';

	it('kein Raum frei → Tauschpartner werden vorgeschlagen', async () => {
		await ok(
			'paul',
			'POST',
			'/bookings',
			booking({
				title: 'Orgelstunde',
				mode: 'fixed',
				roomId: rooms.Kirche,
				persons: 2,
				startsOn: DATE,
				startsAt: '10:00',
				endsAt: '11:00'
			})
		);
		const r = await call(
			'maria',
			'POST',
			'/bookings',
			booking({
				title: 'Trauung',
				persons: 120,
				startsOn: DATE,
				startsAt: '10:00',
				endsAt: '11:30'
			})
		);
		expect(r.status).toBe(409);
		const details = r.body.error?.details as {
			swapOptions: { targetTitle: string; proposedRoomId: string }[];
		};
		expect(details.swapOptions[0]).toMatchObject({ targetTitle: 'Orgelstunde' });
		expect(details.swapOptions[0]!.proposedRoomId).toBe(rooms.Gruppenraum);
	});

	it('Anfrage stellen, die Gruppe der festen Buchung nimmt an', async () => {
		const orgel = (await roomOf('Orgelstunde', DATE))!;
		const swap = await ok<SwapInfo>('maria', 'POST', '/swaps', {
			targetBookingId: orgel.bookingId,
			date: DATE,
			roomId: rooms.Kirche,
			message: 'Unsere Trauung, bitte!',
			booking: booking({
				title: 'Trauung',
				persons: 120,
				startsOn: DATE,
				startsAt: '10:00',
				endsAt: '11:30'
			})
		});
		swapId = swap.id;
		expect(swap).toMatchObject({ status: 'pending', canDecide: false, dueOn: '2026-11-16' });
		const forPaul = await ok<SwapInfo[]>('paul', 'GET', '/swaps?pending=1');
		expect(forPaul[0]).toMatchObject({
			id: swapId,
			canDecide: true,
			requesterName: 'Maria Muster'
		});
		expect((await call('maria', 'POST', `/swaps/${swapId}/accept`)).status).toBe(403);
		const done = await ok<SwapInfo>('paul', 'POST', `/swaps/${swapId}/accept`, undefined, 201);
		expect(done.status).toBe('accepted');
		expect((await roomOf('Trauung', DATE))?.roomName).toBe('Kirche');
		expect(await roomOf('Orgelstunde', DATE)).toMatchObject({
			roomName: 'Gruppenraum',
			pinned: true
		});
		expect((await call('paul', 'POST', `/swaps/${swapId}/decline`)).status).toBe(403);
	});
});
