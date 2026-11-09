// Demo-Daten für das Modul `rooms` (über die echte API, idempotent über Namen/Titel).
// Voraussetzung: Demo-Server läuft (`npm run demo`, http://127.0.0.1:4300).
// Aktiviert das Modul und legt typische Räume einer Kirchengemeinde mit Merkmalen sowie einige feste und
// flexible Buchungen (auch wöchentliche Dauertermine) an.

const BASE = 'http://127.0.0.1:4300';
const ORIGIN = 'http://localhost:4300';
const R = '/modules/rooms';

let cookie = '';
async function call(method, path, body, base = '/api/v1') {
	const res = await fetch(BASE + base + path, {
		method,
		headers: {
			'content-type': 'application/json',
			origin: ORIGIN,
			...(cookie ? { cookie } : {})
		},
		body: body ? JSON.stringify(body) : undefined
	});
	const set = res.headers.getSetCookie?.() ?? [];
	if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
	const json = await res.json().catch(() => null);
	if (res.status >= 400 && res.status !== 409) {
		console.warn(`${method} ${path} -> ${res.status}`, JSON.stringify(json?.error ?? json));
	}
	return { status: res.status, json };
}

const EMAIL = process.env.DEMO_EMAIL ?? 'admin@demo.test';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'Demo-Admin-2026!';

async function login() {
	for (let attempt = 0; attempt < 6; attempt++) {
		cookie = '';
		const r = await call(
			'POST',
			'/sign-in/email',
			{ email: EMAIL, password: PASSWORD },
			'/api/auth'
		);
		if (cookie && r.status < 400) return true;
		if (r.status === 401) return false;
		await new Promise((resolve) => setTimeout(resolve, 10_000));
	}
	return false;
}

if (!(await login())) throw new Error(`Login als ${EMAIL} fehlgeschlagen - läuft der Demo-Server?`);
console.log('Modul rooms aktivieren:', (await call('POST', '/modules/rooms/enable')).status);
// Neue Rechte gelten erst nach erneuter Anmeldung
await login();

const meta = (await call('GET', `${R}/meta`)).json?.data;
if (!meta) throw new Error('Modul rooms nicht erreichbar');

const features = new Map(meta.features.map((f) => [f.name, f.id]));
for (const name of ['Klavier', 'Orgel', 'Beamer', 'Ebenerdig', 'Küche', 'Kinderecke']) {
	if (features.has(name)) continue;
	const r = await call('POST', `${R}/features`, { name, icon: null });
	if (r.json?.data) features.set(name, r.json.data.id);
}

const ROOMS = [
	{ name: 'Kirche', capacity: 250, heat: 9, area: 400, f: ['Orgel', 'Klavier', 'Ebenerdig'] },
	{
		name: 'Gemeindesaal',
		capacity: 120,
		heat: 7,
		area: 160,
		f: ['Klavier', 'Beamer', 'Ebenerdig', 'Küche']
	},
	{
		name: 'Jugendraum',
		capacity: 25,
		heat: 3,
		area: 45,
		f: ['Beamer'],
		building: 'Untergeschoss'
	},
	{ name: 'Gruppenraum 1', capacity: 15, heat: 2, area: 25, f: ['Ebenerdig', 'Kinderecke'] },
	{ name: 'Gruppenraum 2', capacity: 12, heat: 2, area: 22, f: ['Ebenerdig'] },
	{ name: 'Kapelle', capacity: 30, heat: 3, area: 50, f: ['Klavier'] }
];
const rooms = new Map(meta.rooms.map((r) => [r.name, r.id]));
for (const r of ROOMS) {
	if (rooms.has(r.name)) continue;
	const res = await call('POST', `${R}/rooms`, {
		name: r.name,
		building: r.building ?? 'Gemeindehaus',
		description: null,
		capacity: r.capacity,
		areaM2: r.area,
		heatingLevel: r.heat,
		bookable: true,
		featureIds: r.f.map((x) => features.get(x)).filter(Boolean)
	});
	if (res.json?.data) rooms.set(r.name, res.json.data.id);
}

const addDays = (iso, n) => {
	const d = new Date(`${iso}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + n);
	return d.toISOString().slice(0, 10);
};
/** Nächster Wochentag (1 = Montag) ab `meta.today` + 4 Tage (außerhalb des Sperrfensters) */
const next = (weekday) => {
	let d = addDays(meta.today, 4);
	while (((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7) + 1 !== weekday) d = addDays(d, 1);
	return d;
};

// Gruppen mit Farbe und Vorrang (4 = Gottesdienst … 1 = Fremdnutzung)
const GROUPS = [
	{ name: 'Gottesdienst', color: '#0891b2', priority: 4 },
	{ name: 'Kirchenmusik', color: '#7c3aed', priority: 3 },
	{ name: 'Konfirmanden & Jugend', color: '#dc2626', priority: 3 },
	{ name: 'Gemeindegruppen', color: '#d97706', priority: 3 },
	{ name: 'Kita', color: '#16a34a', priority: 2 }
];
const groups = new Map((meta.groups ?? []).map((g) => [g.name, g.id]));
for (const g of GROUPS) {
	if (groups.has(g.name)) continue;
	const r = await call('POST', `${R}/groups`, g);
	if (r.json?.data) groups.set(g.name, r.json.data.id);
}

const weekly = (byWeekday) => ({ freq: 'weekly', interval: 1, byWeekday, end: { type: 'never' } });
const BOOKINGS = [
	{
		title: 'Gottesdienst',
		mode: 'fixed',
		group: 'Gottesdienst',
		room: 'Kirche',
		persons: 120,
		day: 7,
		from: '10:00',
		to: '11:30',
		rec: weekly([7])
	},
	{
		title: 'Kirchenchor',
		group: 'Kirchenmusik',
		mode: 'similar',
		room: 'Kapelle',
		persons: 28,
		f: ['Klavier'],
		day: 3,
		from: '19:30',
		to: '21:30',
		rec: weekly([3])
	},
	{
		title: 'Konfirmandenunterricht',
		group: 'Konfirmanden & Jugend',
		persons: 18,
		f: ['Beamer'],
		day: 2,
		from: '16:00',
		to: '17:30',
		rec: weekly([2])
	},
	{
		title: 'Seniorenkreis',
		group: 'Gemeindegruppen',
		mode: 'similar',
		room: 'Gruppenraum 1',
		persons: 14,
		f: ['Ebenerdig'],
		day: 4,
		from: '15:00',
		to: '17:00',
		rec: weekly([4])
	},
	{
		title: 'Krabbelgruppe',
		group: 'Kita',
		persons: 10,
		f: ['Kinderecke'],
		day: 1,
		from: '09:30',
		to: '11:00',
		rec: weekly([1, 5])
	},
	{
		title: 'Kirchenvorstand',
		group: 'Gemeindegruppen',
		persons: 9,
		day: 2,
		from: '19:30',
		to: '21:30',
		rec: { ...weekly([2]), interval: 4 }
	},
	{
		title: 'Gemeindefest – Vorbereitung',
		group: 'Gemeindegruppen',
		persons: 40,
		f: ['Küche'],
		day: 6,
		from: '10:00',
		to: '14:00',
		rec: null
	}
];

const existing =
	(await call('GET', `${R}/occurrences?from=${meta.today}&to=${addDays(meta.today, 60)}`)).json
		?.data ?? [];
const titles = new Set(existing.map((o) => o.title));
for (const b of BOOKINGS) {
	if (titles.has(b.title)) continue;
	const r = await call('POST', `${R}/bookings`, {
		title: b.title,
		description: null,
		mode: b.mode ?? 'flexible',
		roomId: b.room ? rooms.get(b.room) : null,
		persons: b.persons,
		featureIds: (b.f ?? []).map((x) => features.get(x)).filter(Boolean),
		startsOn: next(b.day),
		startsAt: b.from,
		endsAt: b.to,
		recurrence: b.rec,
		eventId: null,
		groupId: b.group ? (groups.get(b.group) ?? null) : null
	});
	console.log(`${b.title}: ${r.status}`);
}
console.log('Fertig: http://localhost:4300/modules/rooms');
