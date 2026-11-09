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
	/** Geschätzte Heizkosten je Stunde in Cent – Grundlage der Optimierung */
	heatingCostCentsPerHour: z.number().int().min(0).max(1_000_000).default(0),
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
	heatingCostCentsPerHour: number;
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

export const bookingMode = z.enum(['fixed', 'flexible']);
export type BookingMode = z.infer<typeof bookingMode>;

export const BOOKING_MODE_LABELS: Record<BookingMode, string> = {
	fixed: 'Raum festgelegt',
	flexible: 'Nach Anforderungen'
};

/** Raum-Anforderung ohne Zeitangaben (gemeinsam mit dem Termine-Modul) */
export const roomRequest = z
	.object({
		mode: bookingMode,
		roomId: z.uuid().nullable().default(null),
		persons: z.number().int().min(1, 'Mindestens 1 Person').max(5000),
		featureIds: z.array(z.uuid()).max(50).default([])
	})
	.refine((r) => r.mode !== 'fixed' || !!r.roomId, {
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
	eventId: z.string().min(1).max(100).nullable().default(null)
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
	if (b.mode === 'fixed' && !b.roomId) {
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
		.transform((v) => v === '1')
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
	/** Kommende Vorkommen (höchstens 30) */
	upcoming: { date: string; roomId: string | null; roomName: string | null; cancelled: boolean }[];
}

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

export interface AvailabilityResult {
	ok: boolean;
	/** Zugewiesener Raum je Datum (erste 60 Termine) */
	assignments: { date: string; roomId: string | null; roomName: string | null }[];
	/** Andere Buchungen, die dafür in einen anderen Raum verlegt würden */
	moves: PlanMove[];
	conflicts: PlanConflict[];
	/** Termine außerhalb des Planungszeitraums (werden später geplant) */
	beyondHorizon: number;
}

export interface PlanPreview {
	from: string;
	to: string;
	moves: PlanMove[];
	unassigned: PlanConflict[];
	/** Geschätzte Heizkosten in Cent vorher/nachher */
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
