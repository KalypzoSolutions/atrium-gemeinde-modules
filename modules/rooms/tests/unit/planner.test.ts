import { describe, expect, it } from 'vitest';
import {
	planDay,
	REASON_BUSY,
	REASON_FIXED_UNAVAILABLE,
	REASON_NO_MATCH,
	type PlanRoom,
	type PlanSlot,
	type PlanWeights
} from '$modules/rooms/planner';

const W: PlanWeights = {
	bufferMinutes: 15,
	warmGapMinutes: 60,
	oversizeCents: 10,
	moveCents: 300,
	seriesCents: 150,
	warmPercent: 50
};

const PIANO = 'f-piano';
const BEAMER = 'f-beamer';

const room = (id: string, capacity: number, heat: number, featureIds: string[] = []): PlanRoom => ({
	id,
	capacity,
	featureIds,
	heatingCentsPerHour: heat,
	available: true
});

/** Kirche (groß, teuer), Saal, Gruppenraum, Kapelle (klein, Klavier) */
const ROOMS: PlanRoom[] = [
	room('kirche', 200, 2000, [PIANO]),
	room('saal', 80, 800, [BEAMER, PIANO]),
	room('gruppe', 20, 200, [BEAMER]),
	room('kapelle', 12, 100, [PIANO])
];

let n = 0;
const slot = (over: Partial<PlanSlot> = {}): PlanSlot => {
	const key = over.key ?? `b${++n}:2026-11-10`;
	return {
		key,
		bookingId: key.split(':')[0]!,
		start: 18 * 60,
		end: 20 * 60,
		persons: 10,
		featureIds: [],
		fixedRoomId: null,
		locked: false,
		currentRoomId: null,
		preferredRoomId: null,
		priority: 1,
		...over
	};
};

describe('planDay', () => {
	it('wählt den kleinsten passenden Raum', () => {
		const s = slot({ persons: 10 });
		const plan = planDay(ROOMS, [s], W);
		expect(plan.assignment.get(s.key)).toBe('kapelle');
		expect(plan.unplaced).toEqual([]);
	});

	it('beachtet Kapazität und Merkmale', () => {
		const big = slot({ persons: 15 });
		const beamer = slot({ persons: 5, featureIds: [BEAMER] });
		const both = slot({ persons: 30, featureIds: [BEAMER, PIANO] });
		const p1 = planDay(ROOMS, [big], W);
		expect(p1.assignment.get(big.key)).toBe('gruppe');
		const p2 = planDay(ROOMS, [beamer], W);
		expect(p2.assignment.get(beamer.key)).toBe('gruppe');
		const p3 = planDay(ROOMS, [both], W);
		expect(p3.assignment.get(both.key)).toBe('saal');
	});

	it('kein passender Raum → ohne Raum mit Grund', () => {
		const s = slot({ persons: 500 });
		const plan = planDay(ROOMS, [s], W);
		expect(plan.assignment.get(s.key)).toBeNull();
		expect(plan.unplaced).toEqual([{ key: s.key, reason: REASON_NO_MATCH, busyRoomIds: [] }]);
	});

	it('feste Buchung verdrängt eine flexible in den nächstbesten Raum', () => {
		const flexible = slot({ persons: 8, currentRoomId: 'kapelle' });
		const fixed = slot({ persons: 4, fixedRoomId: 'kapelle', priority: 0 });
		const plan = planDay(ROOMS, [flexible, fixed], W);
		expect(plan.assignment.get(fixed.key)).toBe('kapelle');
		expect(plan.assignment.get(flexible.key)).toBe('gruppe');
		expect(plan.unplaced).toEqual([]);
	});

	it('neue Buchung verdrängt nie gesperrte Termine', () => {
		const locked = slot({ persons: 8, currentRoomId: 'kapelle', locked: true });
		const fixed = slot({ persons: 4, fixedRoomId: 'kapelle', priority: 0 });
		const plan = planDay(ROOMS, [locked, fixed], W);
		expect(plan.assignment.get(locked.key)).toBe('kapelle');
		expect(plan.assignment.get(fixed.key)).toBeNull();
		expect(plan.unplaced[0]).toMatchObject({ key: fixed.key, reason: REASON_BUSY });
	});

	it('neue flexible Buchung verdrängt keine bestehende, wenn nichts mehr frei ist', () => {
		const rooms = [room('a', 10, 100), room('b', 10, 100)];
		const x = slot({ persons: 5, currentRoomId: 'a' });
		const y = slot({ persons: 5, currentRoomId: 'b' });
		const z = slot({ persons: 5, priority: 0 });
		const plan = planDay(rooms, [x, y, z], W);
		expect(plan.assignment.get(x.key)).toBe('a');
		expect(plan.assignment.get(y.key)).toBe('b');
		expect(plan.assignment.get(z.key)).toBeNull();
		expect(plan.unplaced[0]!.busyRoomIds.sort()).toEqual(['a', 'b']);
	});

	it('gesperrter fester Raum → Grund „gesperrt“', () => {
		const rooms = ROOMS.map((r) => (r.id === 'saal' ? { ...r, available: false } : r));
		const s = slot({ fixedRoomId: 'saal' });
		const plan = planDay(rooms, [s], W);
		expect(plan.unplaced[0]!.reason).toBe(REASON_FIXED_UNAVAILABLE);
	});

	it('beachtet den Puffer zwischen zwei Terminen', () => {
		const rooms = [room('klein', 10, 100), room('gross', 50, 1000)];
		const a = slot({ start: 600, end: 660, persons: 5 });
		const b = slot({ start: 670, end: 720, persons: 5 });
		const plan = planDay(rooms, [a, b], W);
		// 10 Minuten Abstand < 15 Minuten Puffer → nicht beide im kleinen Raum
		expect(new Set([plan.assignment.get(a.key), plan.assignment.get(b.key)])).toEqual(
			new Set(['klein', 'gross'])
		);
		const plan2 = planDay(rooms, [a, b], { ...W, bufferMinutes: 0 });
		expect(plan2.assignment.get(a.key)).toBe('klein');
		expect(plan2.assignment.get(b.key)).toBe('klein');
	});

	it('löst Engpässe per Rücksprung (eingeschränkte Termine zuerst)', () => {
		// x passt nur in den Saal (Beamer + 30 Personen), y passt überall ab 25 Plätzen
		const rooms = [room('saal', 40, 500, [BEAMER]), room('halle', 60, 900)];
		const y = slot({ persons: 25 });
		const x = slot({ persons: 30, featureIds: [BEAMER] });
		const plan = planDay(rooms, [y, x], W);
		expect(plan.assignment.get(x.key)).toBe('saal');
		expect(plan.assignment.get(y.key)).toBe('halle');
		expect(plan.unplaced).toEqual([]);
	});

	it('bleibt ohne Grund im bisherigen Raum (Wechsel-Strafe)', () => {
		// Gruppenraum minimal teurer als Kapelle – Wechsel lohnt nicht
		const rooms = [room('kapelle', 12, 100), room('gruppe', 12, 110)];
		const s = slot({ persons: 10, currentRoomId: 'gruppe' });
		expect(planDay(rooms, [s], W).assignment.get(s.key)).toBe('gruppe');
		// deutlich günstiger → Wechsel
		const rooms2 = [room('kapelle', 12, 100), room('gruppe', 12, 1000)];
		expect(planDay(rooms2, [s], W).assignment.get(s.key)).toBe('kapelle');
	});

	it('bevorzugt den Raum der Serie', () => {
		const rooms = [room('a', 12, 100), room('b', 12, 150)];
		const s = slot({ persons: 10, preferredRoomId: 'b' });
		expect(planDay(rooms, [s], W).assignment.get(s.key)).toBe('b');
	});

	it('„schon warm“: legt aufeinanderfolgende Termine in denselben Raum', () => {
		const rooms = [room('a', 20, 600), room('b', 20, 600)];
		const first = slot({ start: 600, end: 720, persons: 10, currentRoomId: 'a', locked: true });
		const second = slot({ start: 750, end: 840, persons: 10, preferredRoomId: null });
		// ohne Rabatt wären a und b gleich teuer; mit Rabatt gewinnt a
		const plan = planDay(rooms, [first, second], W);
		expect(plan.assignment.get(second.key)).toBe('a');
		expect(plan.heatingCost).toBe(1200 + 900 - 300);
	});

	it('Tausch-Verbesserung senkt die Kosten', () => {
		// a (5 P.) und b (15 P.) passen beide in den großen Raum, nur a in den kleinen
		const rooms = [room('klein', 8, 100), room('gross', 20, 300)];
		const a = slot({ persons: 5, currentRoomId: 'gross' });
		const b = slot({ persons: 15, start: 21 * 60, end: 22 * 60, currentRoomId: 'gross' });
		const plan = planDay(rooms, [a, b], { ...W, moveCents: 0 });
		expect(plan.assignment.get(a.key)).toBe('klein');
		expect(plan.assignment.get(b.key)).toBe('gross');
	});

	it('kommt mit vielen Terminen zurecht', () => {
		const rooms = Array.from({ length: 12 }, (_, i) => room(`r${i}`, 10 + i * 5, 100 + i * 50));
		const slots = Array.from({ length: 40 }, (_, i) =>
			slot({ start: (i % 10) * 60, end: (i % 10) * 60 + 50, persons: 5 + (i % 7) * 5 })
		);
		const t = Date.now();
		const plan = planDay(rooms, slots, W);
		expect(Date.now() - t).toBeLessThan(5000);
		expect(plan.unplaced.length).toBe(0);
	});
});
