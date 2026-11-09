/**
 * Vertrag der Dienste, die `rooms` anderen Modulen anbietet (`ModuleDefinition.provides`). Erste Nutzerin: das
 * Termine-Modul `events` (Raum direkt am Termin buchen, Raum als Ort anzeigen).
 *
 * Abruf: `await core.modules.useOptional<RoomsService>('rooms', '<aufrufendes Modul>')` (Aufrufer führt `rooms` in
 * `optionalDependencies`). Nur AUSSERHALB offener Transaktionen aufrufen. Alle Methoden prüfen die Rechte von `ctx`
 * selbst (`rooms.booking.view`/`create`/`fix`); die Bearbeitungsrechte am Termin prüft der Aufrufer.
 */
import type { RequestContext } from '$lib/sdk/types';

export interface RoomOption {
	id: string;
	name: string;
	building: string | null;
	capacity: number;
	featureIds: string[];
}

export interface RoomOptions {
	features: { id: string; name: string }[];
	rooms: RoomOption[];
	/** Darf Räume buchen (`rooms.booking.create`) */
	canBook: boolean;
	/** Darf einen bestimmten Raum fest buchen (`rooms.booking.fix`) */
	canFix: boolean;
}

/** Raum-Anforderung am Termin */
export interface EventRoomRequest {
	mode: 'fixed' | 'flexible';
	/** Bei `fixed` Pflicht */
	roomId: string | null;
	persons: number;
	featureIds: string[];
}

export interface EventRoomSpec extends EventRoomRequest {
	title: string;
	/** JJJJ-MM-TT */
	startsOn: string;
	/** HH:MM – ohne Uhrzeit keine Raumbuchung */
	startsAt: string | null;
	endsAt: string | null;
	/** Mehrtägige Termine werden nicht unterstützt */
	endsOn: string | null;
	/**
	 * Wiederholungsregel im Format von `events` (`freq`, `interval`, `byWeekday`, `end`). Unterstützt: keine oder
	 * `freq: 'weekly'`.
	 */
	recurrence: unknown;
	/** Abgesagte Vorkommen (ursprüngliches Datum) */
	cancelledDates: string[];
}

export interface EventRoomAssignment {
	date: string;
	roomId: string | null;
	roomName: string | null;
}

export type EventRoomResult =
	| { ok: true; bookingId: string | null; assignments: EventRoomAssignment[] }
	| {
			ok: false;
			/** `ROOMS_NO_ROOM` (kein Raum frei), `ROOMS_UNSUPPORTED` (Termin passt nicht), `ROOMS_INVALID`, `ROOMS_FORBIDDEN` */
			code: 'ROOMS_NO_ROOM' | 'ROOMS_UNSUPPORTED' | 'ROOMS_INVALID' | 'ROOMS_FORBIDDEN';
			message: string;
			conflicts: { date: string; reason: string }[];
	  };

export interface EventRoomInfo {
	eventId: string;
	bookingId: string;
	request: EventRoomRequest;
	/** Zuweisungen im angefragten Zeitraum (bzw. die nächsten Termine) */
	assignments: EventRoomAssignment[];
}

export interface RoomsService {
	/** Auswahl für das Termin-Formular; `null` ohne `rooms.booking.view` */
	roomOptions(ctx: RequestContext): Promise<RoomOptions | null>;
	/** Probelauf (nichts wird gespeichert); `eventId` = bestehender Termin oder `null` */
	checkEventBooking(
		ctx: RequestContext,
		eventId: string | null,
		spec: EventRoomSpec
	): Promise<EventRoomResult>;
	/** Buchung zum Termin anlegen bzw. ersetzen */
	syncEventBooking(
		ctx: RequestContext,
		eventId: string,
		spec: EventRoomSpec
	): Promise<EventRoomResult>;
	/** Buchung zum Termin entfernen (still, wenn keine besteht) */
	removeEventBooking(ctx: RequestContext, eventId: string): Promise<void>;
	/** Raum-Anforderungen und zugewiesene Räume zu Terminen (nur mit `rooms.booking.view`, ≤ 500 IDs) */
	eventRooms(
		ctx: RequestContext,
		eventIds: readonly string[],
		window?: { from: string; to: string }
	): Promise<EventRoomInfo[]>;
}
