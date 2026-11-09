/** Gemeinsame Hilfen der Seiten (nur Browser-taugliche Importe). */
import { ApiClientError } from '$lib/sdk/client';
import { addDays, formatDateDe } from '$lib/sdk/dates';
import type { Feature, Group, PlanConflict, Room, SwapOption } from '../schemas';

export interface RoomsMeta {
	features: Feature[];
	rooms: Room[];
	groups: Group[];
	today: string;
	horizonEnd: string;
	lockDays: number;
	bufferMinutes: number;
	eventsAvailable: boolean;
}

const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const WEEKDAYS_LONG = [
	'Montag',
	'Dienstag',
	'Mittwoch',
	'Donnerstag',
	'Freitag',
	'Samstag',
	'Sonntag'
];

export function weekdayIndex(date: string): number {
	const [y, m, d] = date.split('-').map(Number);
	const day = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
	return day === 0 ? 6 : day - 1;
}

export const weekdayShort = (date: string) => WEEKDAYS[weekdayIndex(date)]!;
export const weekdayLong = (date: string) => WEEKDAYS_LONG[weekdayIndex(date)]!;
export const WEEKDAY_SHORT = WEEKDAYS;

/** „Di, 10.11.2026“ */
export const dayLabel = (date: string) => `${weekdayShort(date)}, ${formatDateDe(date)}`;

export const mondayOf = (date: string) => addDays(date, -weekdayIndex(date));

export const isDate = (v: string | null | undefined): v is string =>
	!!v && /^\d{4}-\d{2}-\d{2}$/.test(v);

export const toMinutes = (t: string) => {
	const [h, m] = t.split(':');
	return Number(h) * 60 + Number(m);
};

/** Farbe einer Gruppe bzw. neutrale Farbe ohne Gruppe (CSS-Wert) */
export const groupColor = (color: string | null | undefined) =>
	color ?? 'var(--color-muted-foreground)';

/** Getönter Hintergrund + Randfarbe für einen Termin-Block (Gruppenfarbe) */
export function blockStyle(color: string | null | undefined): string {
	const c = groupColor(color);
	return `background-color: color-mix(in oklab, ${c} 14%, var(--color-background)); border-left-color: ${c};`;
}

/** „Heizaufwand 3 / 10“ */
export const heatLabel = (level: number) => `Heizaufwand ${level} / 10`;

/** Heizpunkte (Stufe × Stunden × 100) als Stufen-Stunden, z. B. „12,5 h·Stufe“ */
export const heatHours = (points: number) =>
	`${(points / 100).toLocaleString('de-DE', { maximumFractionDigits: 1 })} Stufen-Stunden`;

/** Fehlermeldung und ggf. Planungskonflikte aus einer API-Antwort */
export function errorInfo(e: unknown, fallback: string) {
	if (e instanceof ApiClientError) {
		const details = e.details as
			| { code?: string; conflicts?: PlanConflict[] }
			| { path?: (string | number)[]; message?: string }[]
			| undefined;
		const conflicts = !Array.isArray(details) && details?.conflicts ? details.conflicts : [];
		const swapOptions =
			!Array.isArray(details) && details && 'swapOptions' in details
				? ((details as { swapOptions?: SwapOption[] }).swapOptions ?? [])
				: [];
		const code = !Array.isArray(details) && details?.code ? details.code : e.code;
		const fields: Record<string, string> = {};
		if (Array.isArray(details)) {
			for (const d of details) if (d.path?.length) fields[String(d.path[0])] ??= d.message ?? '';
		}
		return { message: e.message || fallback, conflicts, fields, swapOptions, code };
	}
	return {
		message: fallback,
		conflicts: [] as PlanConflict[],
		fields: {} as Record<string, string>,
		swapOptions: [] as SwapOption[],
		code: 'unknown'
	};
}
