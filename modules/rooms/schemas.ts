/**
 * API-Vertrag des Moduls „Räume“: Zod-Eingaben, DTO-Typen und Konstanten. Wird von Server UND Oberfläche
 * genutzt – daher keine Server-Importe.
 */
import { z } from 'zod';

export const MODULE_ID = 'rooms';

export const PERM_VIEW = 'rooms.booking.view';
export const PERM_CREATE = 'rooms.booking.create';
export const PERM_FIX = 'rooms.booking.fix';
export const PERM_EDIT_ALL = 'rooms.booking.edit-all';
export const PERM_MANAGE = 'rooms.room.manage';
export const PERM_SETTINGS = 'rooms.settings.manage';

export const NOTIFY_MOVED = 'booking-moved';
export const NOTIFY_UNASSIGNED = 'booking-unassigned';
export const NOTIFY_SWAP = 'swap-request';
export const NOTIFY_SWAP_ANSWER = 'swap-answer';
export const NOTIFY_OBJECTION = 'move-objected';

/** Einstellungsschlüssel */
export const SETTING = {
	horizonDays: 'rooms.horizonDays',
	lockDays: 'rooms.lockDays',
	bufferMinutes: 'rooms.bufferMinutes',
	warmGapMinutes: 'rooms.warmGapMinutes',
	oversizeCents: 'rooms.weight.oversizeCents',
	moveCents: 'rooms.weight.moveCents',
	seriesCents: 'rooms.weight.seriesCents',
	warmPercent: 'rooms.weight.warmPercent'
} as const;

export const SETTING_DEFAULTS = {
	horizonDays: 180,
	lockDays: 3,
	bufferMinutes: 15,
	warmGapMinutes: 60,
	oversizeCents: 10,
	moveCents: 100,
	seriesCents: 150,
	warmPercent: 50
} as const;

export type PlanningSettings = { -readonly [K in keyof typeof SETTING_DEFAULTS]: number };

/** Höchstzahl Vorkommen je Abfrage (Belegungsplan) */
export const MAX_OCCURRENCES = 3000;
/** Höchstzahl Tage je Abfrage */
export const MAX_WINDOW_DAYS = 400;

// --- Grundtypen --------------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const dateString = z.string().regex(DATE_RE, 'Datum im Format JJJJ-MM-TT');
export const timeString = z.string().regex(TIME_RE, 'Uhrzeit im Format HH:MM');

export const idParams = z.object({ id: z.uuid() });
export const occurrenceParams = z.object({ id: z.uuid(), date: dateString });

/** Minuten seit Mitternacht für `HH:MM` */
export function toMinutes(time: string): number {
	const [h, m] = time.split(':');
	return Number(h) * 60 + Number(m);
}

// --- Wiederholung ------------------------------------------------------------------------------

/**
 * Wöchentliche Wiederholung – Teilmenge des Formats im Modul `events` (`freq: 'weekly'`), damit Serien von dort
 * 1:1 übernommen werden können. `byWeekday` nach ISO (1 = Montag … 7 = Sonntag); ohne Angabe gilt der Wochentag
 * des ersten Termins.
 */
export const recurrenceRule = z
	.object({
		freq: z.literal('weekly'),
		interval: z.number().int().min(1).max(52).default(1),
		byWeekday: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),
		end: z
			.discriminatedUnion('type', [
				z.object({ type: z.literal('never') }),
				z.object({ type: z.literal('until'), date: dateString }),
				z.object({ type: z.literal('count'), count: z.number().int().min(1).max(500) })
			])
			.default({ type: 'never' })
	})
	.strict();

export type RecurrenceRule = z.infer<typeof recurrenceRule>;

// --- Merkmale ----------------------------------------------------------------------------------

export const featureInput = z.object({
	name: z.string().trim().min(1, 'Name fehlt').max(60),
	icon: z.string().trim().max(60).nullable().default(null)
});
export type FeatureInput = z.infer<typeof featureInput>;

export interface Feature {
	id: string;
	name: string;
	icon: string | null;
	position: number;
	/** Anzahl Räume mit diesem Merkmal */
	roomCount: number;
}

// --- Räume -------------------------------------------------------------------------------------

export const roomInput = z.object({
	name: z.string().trim().min(1, 'Name fehlt').max(100),
	building: z.string().trim().max(100).nullable().default(null),
	description: z.string().trim().max(2000).nullable().default(null),
	capacity: z.number().int().min(1, 'Mindestens 1 Person').max(5000),
	areaM2: z.number().min(0).max(100000).nullable().default(null),
	/** Heizaufwand 1 (kaum, schnell warm) bis 10 (sehr hoch, z. B. Kirchenschiff) – Grundlage der Optimierung */
	heatingLevel: z.number().int().min(1, 'Stufe 1 bis 10').max(10, 'Stufe 1 bis 10').default(5),
	bookable: z.boolean().default(true),
	featureIds: z.array(z.uuid()).max(100).default([])
});
export type RoomInput = z.infer<typeof roomInput>;

export interface Room {
	id: string;
	name: string;
	building: string | null;
	description: string | null;
	capacity: number;
	areaM2: number | null;
	/** Heizaufwand 1–10 */
	heatingLevel: number;
	bookable: boolean;
	position: number;
	featureIds: string[];
}

export const blockInput = z
	.object({
		startsOn: dateString,
		endsOn: dateString,
		reason: z.string().trim().max(200).nullable().default(null)
	})
	.refine((b) => b.endsOn >= b.startsOn, {
		message: 'Ende liegt vor dem Beginn',
		path: ['endsOn']
	});
export type BlockInput = z.infer<typeof blockInput>;

export const blockParams = z.object({ id: z.uuid(), blockId: z.uuid() });

export interface RoomBlock {
	id: string;
	roomId: string;
	startsOn: string;
	endsOn: string;
	reason: string | null;
}

// --- Buchungen ---------------------------------------------------------------------------------

/**
 * Wie beweglich eine Buchung ist: `fixed` = genau dieser Raum, nie verlegen; `similar` = „Raum wie dieser“
 * (Wunschraum, zieht nur um, wenn eine andere Gruppe ihn braucht); `flexible` = irgendein passender Raum.
 */
export const bookingMode = z.enum(['fixed', 'similar', 'flexible']);
export type BookingMode = z.infer<typeof bookingMode>;

export const BOOKING_MODE_LABELS: Record<BookingMode, string> = {
	fixed: 'Nur dieser Raum',
	similar: 'Raum wie dieser',
	flexible: 'Nach Anforderungen'
};

export const BOOKING_MODE_HINTS: Record<BookingMode, string> = {
	fixed: 'Wird nie verlegt · eigenes Recht',
	similar: 'Wunschraum, sonst gleichwertig',
	flexible: 'Hauptsache passend'
};

/** Braucht die Stufe einen (Wunsch-)Raum? */
export const needsRoom = (mode: BookingMode) => mode !== 'flexible';

/** Punkte je Heizstufe und Stunde (Planer-Einheit) */
export const HEAT_POINTS_PER_LEVEL = 100;

// --- Gruppen -----------------------------------------------------------------------------------

/** Vorrang: 4 = Gottesdienst und Kasualien … 1 = Fremdnutzung */
export const GROUP_PRIORITIES = [4, 3, 2, 1] as const;
export const GROUP_PRIORITY_LABELS: Record<number, string> = {
	4: 'Gottesdienst und Kasualien',
	3: 'Regelmäßige Gruppen',
	2: 'Einmalige Veranstaltungen',
	1: 'Fremdnutzung'
};
/** Vorrang ohne Gruppe */
export const DEFAULT_PRIORITY = 2;

export const groupInput = z.object({
	name: z.string().trim().min(1, 'Name fehlt').max(80),
	color: z
		.string()
		.regex(/^#[0-9a-f]{6}$/, 'Farbe als #rrggbb')
		.nullable()
		.default(null),
	priority: z.number().int().min(1).max(4).default(3)
});
export type GroupInput = z.infer<typeof groupInput>;

export interface Group {
	id: string;
	name: string;
	color: string | null;
	priority: number;
	position: number;
	bookingCount: number;
}

/** Raum-Anforderung ohne Zeitangaben (gemeinsam mit dem Termine-Modul) */
export const roomRequest = z
	.object({
		mode: bookingMode,
		roomId: z.uuid().nullable().default(null),
		persons: z.number().int().min(1, 'Mindestens 1 Person').max(5000),
		featureIds: z.array(z.uuid()).max(50).default([])
	})
	.refine((r) => !needsRoom(r.mode) || !!r.roomId, {
		message: 'Bitte einen Raum wählen',
		path: ['roomId']
	});
export type RoomRequest = z.infer<typeof roomRequest>;

const bookingFields = z.object({
	title: z.string().trim().min(1, 'Titel fehlt').max(200),
	description: z.string().trim().max(4000).nullable().default(null),
	mode: bookingMode,
	roomId: z.uuid().nullable().default(null),
	persons: z.number().int().min(1, 'Mindestens 1 Person').max(5000),
	featureIds: z.array(z.uuid()).max(50).default([]),
	startsOn: dateString,
	startsAt: timeString,
	endsAt: timeString,
	recurrence: recurrenceRule.nullable().default(null),
	/** Verweis auf einen Termin im Modul `events` (nur Verknüpfung, Zeiten bleiben eigene) */
	eventId: z.string().min(1).max(100).nullable().default(null),
	/** Gruppe (Farbe, Vorrang) */
	groupId: z.uuid().nullable().default(null)
});

/** Prüfungen, die für Buchungen und Termine-Kopplung gleich sind */
export function checkBookingShape(
	b: {
		mode: BookingMode;
		roomId: string | null;
		startsOn: string;
		startsAt: string;
		endsAt: string;
		recurrence: RecurrenceRule | null;
	},
	ctx: z.RefinementCtx
): void {
	if (needsRoom(b.mode) && !b.roomId) {
		ctx.addIssue({ code: 'custom', message: 'Bitte einen Raum wählen', path: ['roomId'] });
	}
	if (b.endsAt <= b.startsAt) {
		ctx.addIssue({
			code: 'custom',
			message: 'Ende muss nach dem Beginn liegen (am selben Tag)',
			path: ['endsAt']
		});
	}
	if (b.recurrence?.end.type === 'until' && b.recurrence.end.date < b.startsOn) {
		ctx.addIssue({
			code: 'custom',
			message: 'Serienende liegt vor dem ersten Termin',
			path: ['recurrence', 'end', 'date']
		});
	}
}

export const bookingInput = bookingFields.superRefine(checkBookingShape);
export type BookingInput = z.infer<typeof bookingInput>;

/** Probelauf: wie `bookingInput`, optional die ID der Buchung, die ersetzt würde */
export const availabilityInput = bookingFields
	.extend({ bookingId: z.uuid().nullable().default(null) })
	.superRefine(checkBookingShape);
export type AvailabilityInput = z.infer<typeof availabilityInput>;

export const occurrencesQuery = z.object({
	from: dateString,
	to: dateString,
	roomId: z.uuid().optional(),
	mine: z
		.enum(['0', '1'])
		.optional()
		.transform((v) => v === '1'),
	unassigned: z
		.enum(['0', '1'])
		.optional()
		.transform((v) => v === '1'),
	groupId: z.uuid().optional()
});

export const myQuery = z.object({
	limit: z.coerce.number().int().min(1).max(50).default(5)
});

/** Ein Vorkommen einer Buchung mit zugewiesenem Raum */
export interface Occurrence {
	/** `bookingId:datum` */
	key: string;
	bookingId: string;
	date: string;
	title: string;
	startsAt: string;
	endsAt: string;
	mode: BookingMode;
	persons: number;
	featureIds: string[];
	roomId: string | null;
	roomName: string | null;
	/** Schon geplant (innerhalb des Planungszeitraums); sonst folgt die Zuweisung später */
	planned: boolean;
	recurring: boolean;
	ownerId: string;
	ownerName: string | null;
	mine: boolean;
	canEdit: boolean;
	eventId: string | null;
	/** Über das Termine-Modul angelegt und gepflegt */
	managedByEvent: boolean;
	groupId: string | null;
	groupName: string | null;
	groupColor: string | null;
	/** Von Hand in diesen Raum gelegt (Drag & Drop) */
	pinned: boolean;
	/** Zuletzt verlegt (innerhalb der letzten 14 Tage), sonst `null` */
	moved: {
		moveId: string;
		fromRoomName: string | null;
		kind: MoveKind;
		objectionOpen: boolean;
	} | null;
}

export interface BookingDetail {
	id: string;
	title: string;
	description: string | null;
	mode: BookingMode;
	roomId: string | null;
	persons: number;
	featureIds: string[];
	startsOn: string;
	startsAt: string;
	endsAt: string;
	recurrence: RecurrenceRule | null;
	eventId: string | null;
	eventTitle: string | null;
	managedByEvent: boolean;
	ownerId: string;
	ownerName: string | null;
	canEdit: boolean;
	cancelledDates: string[];
	groupId: string | null;
	groupName: string | null;
	/** Kommende Vorkommen (höchstens 30) */
	upcoming: {
		date: string;
		roomId: string | null;
		roomName: string | null;
		cancelled: boolean;
		pinned: boolean;
	}[];
	/** Verlegungen der kommenden Termine (neueste zuerst) */
	moves: MoveInfo[];
}

// --- Verlegungen -------------------------------------------------------------------------------

export type MoveKind = 'auto' | 'manual';

/** Widerspruchsfrist nach einer Verlegung (Stunden) */
export const OBJECTION_HOURS = 48;
/** Höchstzahl automatischer Verlegungen je Buchung in 30 Tagen (danach bleibt sie, wo sie ist) */
export const MAX_AUTO_MOVES = 2;

export interface MoveInfo {
	id: string;
	bookingId: string;
	title: string;
	date: string;
	fromRoomId: string | null;
	fromRoomName: string | null;
	toRoomId: string | null;
	toRoomName: string | null;
	kind: MoveKind;
	reason: string | null;
	createdAt: string;
	objectionUntil: string | null;
	objectedAt: string | null;
	objectionNote: string | null;
	resolvedAt: string | null;
	ownerId: string;
	/** Die aufrufende Person darf noch widersprechen */
	canObject: boolean;
}

export const moveParams = z.object({ id: z.uuid() });
export const objectionInput = z.object({
	note: z.string().trim().max(500).nullable().default(null)
});

/** Drag & Drop: Termin in einen anderen Raum legen */
export const placeInput = z.object({
	roomId: z.uuid(),
	/** `one` = nur dieser Termin, `following` = dieser und alle folgenden (Wunschraum der Serie) */
	scope: z.enum(['one', 'following']).default('one'),
	/** Feste Buchungen nur mit ausdrücklicher Bestätigung */
	confirmFixed: z.boolean().default(false)
});
export type PlaceInput = z.infer<typeof placeInput>;

/** Prüfung je Raum beim Ziehen */
export interface DropTarget {
	roomId: string;
	ok: boolean;
	/** Kurzer Grund, z. B. „Belegt 19:30–21:30“ oder „Passt genau (12 / 12)“ */
	label: string;
	/** Aktueller Raum des Termins */
	current: boolean;
}

// --- Tauschanfragen ----------------------------------------------------------------------------

export type SwapStatus = 'pending' | 'accepted' | 'declined' | 'expired' | 'withdrawn';

export const SWAP_STATUS_LABELS: Record<SwapStatus, string> = {
	pending: 'offen',
	accepted: 'angenommen',
	declined: 'abgelehnt',
	expired: 'abgelaufen',
	withdrawn: 'zurückgezogen'
};

/** Tage, die die angefragte Gruppe zum Antworten hat (höchstens bis zum Vortag des Termins) */
export const SWAP_ANSWER_DAYS = 7;

export interface SwapInfo {
	id: string;
	status: SwapStatus;
	date: string;
	startsAt: string;
	endsAt: string;
	/** Was die anfragende Gruppe vorhat */
	requestTitle: string;
	requestPersons: number;
	requesterId: string;
	requesterName: string | null;
	/** Die feste Buchung, die weichen soll */
	targetBookingId: string;
	targetTitle: string;
	targetOwnerId: string;
	roomId: string;
	roomName: string | null;
	proposedRoomId: string | null;
	proposedRoomName: string | null;
	message: string | null;
	dueOn: string;
	createdAt: string;
	/** Die aufrufende Person darf entscheiden (Eigentümer*in der festen Buchung oder Verwaltung) */
	canDecide: boolean;
	resultBookingId: string | null;
}

/** Mögliche Tauschpartner bei „kein Raum frei“ */
export interface SwapOption {
	date: string;
	targetBookingId: string;
	targetTitle: string;
	roomId: string;
	roomName: string;
	proposedRoomId: string;
	proposedRoomName: string;
}

export const swapRequestInput = z.object({
	targetBookingId: z.uuid(),
	date: dateString,
	roomId: z.uuid(),
	message: z.string().trim().max(500).nullable().default(null),
	/** Die gewünschte Buchung (nur einmalig, ohne Wiederholung) */
	booking: z.lazy(() => bookingInput)
});
export type SwapRequestInput = z.infer<typeof swapRequestInput>;

// --- Planung -----------------------------------------------------------------------------------

export interface PlanMove {
	bookingId: string;
	title: string;
	date: string;
	fromRoomId: string | null;
	fromRoomName: string | null;
	toRoomId: string | null;
	toRoomName: string | null;
	ownerId: string;
}

export interface PlanConflict {
	date: string;
	reason: string;
	/** Räume, die die Anforderungen erfüllen, aber belegt sind */
	busyRoomIds: string[];
}

/** Raumvorschlag im Buchungsdialog (erster Termin) */
export interface RoomCandidate {
	roomId: string;
	name: string;
	capacity: number;
	heatingLevel: number;
	featureIds: string[];
	/** `best` = zugewiesen, `ok` = passt und frei, `busy` = passt, aber belegt, `unsuitable` = passt nicht */
	status: 'best' | 'ok' | 'busy' | 'unsuitable';
	reason: string;
}

export interface AvailabilityResult {
	ok: boolean;
	/** Zugewiesener Raum je Datum (erste 60 Termine) */
	assignments: { date: string; roomId: string | null; roomName: string | null }[];
	/** Andere Buchungen, die dafür in einen anderen Raum verlegt würden */
	moves: PlanMove[];
	conflicts: PlanConflict[];
	/** Termine außerhalb des Planungszeitraums (werden später geplant) */
	beyondHorizon: number;
	/** Räume für den ersten Termin mit Begründung */
	candidates: RoomCandidate[];
	/** Kein Raum frei: feste Buchungen, die tauschen könnten */
	swapOptions: SwapOption[];
}

export interface PlanPreview {
	from: string;
	to: string;
	moves: PlanMove[];
	unassigned: PlanConflict[];
	/** Heizaufwand vorher/nachher (Stufe × Stunden × 100, abzüglich „schon warm“) */
	costBefore: number;
	costAfter: number;
}

export const planInput = z
	.object({
		from: dateString.optional(),
		days: z.number().int().min(1).max(366).default(60)
	})
	.strict();

export const ROOMS_NO_ROOM = 'ROOMS_NO_ROOM';
