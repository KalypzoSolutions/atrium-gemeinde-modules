/**
 * Wöchentliche Wiederholung (reine Logik, ohne Server-Importe – auch in der Oberfläche nutzbar).
 * Serien werden in JS expandiert, nie in SQL. Wochen zählen ab dem Montag der Woche des ersten Termins;
 * `interval: 2` heißt „jede zweite Woche“. Vorkommen vor dem ersten Termin gibt es nicht.
 */
import { addDays, daysBetween } from '$lib/sdk/dates';
import type { RecurrenceRule } from './schemas';

/** Obergrenze für die Expansion (Schutz vor Endlosschleifen) */
export const MAX_EXPANSION = 2000;

/** ISO-Wochentag (1 = Montag … 7 = Sonntag) */
export function isoWeekday(date: string): number {
	const [y, m, d] = date.split('-').map(Number);
	const day = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
	return day === 0 ? 7 : day;
}

/** Montag der Woche */
export function mondayOf(date: string): string {
	return addDays(date, 1 - isoWeekday(date));
}

/** Wochentage der Regel (Standard: Wochentag des ersten Termins), aufsteigend */
export function weekdaysOf(rule: RecurrenceRule, startsOn: string): number[] {
	const list = rule.byWeekday?.length ? rule.byWeekday : [isoWeekday(startsOn)];
	return [...new Set(list)].sort((a, b) => a - b);
}

/**
 * Alle Vorkommen im Zeitraum `[from, to]` (inklusive). `count` zählt ab dem ersten Termin, auch wenn
 * `from` später liegt. Ohne Regel: nur `startsOn` (falls im Zeitraum).
 */
export function expandDates(
	startsOn: string,
	rule: RecurrenceRule | null,
	from: string,
	to: string,
	max = MAX_EXPANSION
): string[] {
	if (!rule) return startsOn >= from && startsOn <= to ? [startsOn] : [];
	const days = weekdaysOf(rule, startsOn);
	const until = rule.end.type === 'until' ? rule.end.date : null;
	const count = rule.end.type === 'count' ? rule.end.count : null;
	const last = until && until < to ? until : to;
	const out: string[] = [];
	let seen = 0;
	let week = mondayOf(startsOn);
	// Wochen ohne Treffer überspringen, solange `count` nicht mitgezählt werden muss
	if (count === null && from > startsOn) {
		const skipWeeks = Math.floor(daysBetween(week, mondayOf(from)) / 7);
		const aligned = skipWeeks - (skipWeeks % rule.interval);
		if (aligned > 0) week = addDays(week, aligned * 7);
	}
	for (let guard = 0; guard < 100_000; guard++) {
		if (week > last) break;
		for (const wd of days) {
			const date = addDays(week, wd - 1);
			if (date < startsOn) continue;
			if (date > last) break;
			seen++;
			if (count !== null && seen > count) return out;
			if (date >= from) {
				out.push(date);
				if (out.length >= max) return out;
			}
		}
		week = addDays(week, 7 * rule.interval);
	}
	return out;
}

/** Ist `date` ein Vorkommen der Serie? */
export function isOccurrence(startsOn: string, rule: RecurrenceRule | null, date: string): boolean {
	return expandDates(startsOn, rule, date, date).length === 1;
}

/**
 * Datum des letzten Vorkommens (`until`/`count`) oder `null` bei offenen Serien. Für die Spalte
 * `recurrence_until` (SQL-Vorfilter).
 */
export function lastOccurrence(startsOn: string, rule: RecurrenceRule | null): string | null {
	if (!rule) return startsOn;
	if (rule.end.type === 'never') return null;
	if (rule.end.type === 'until') {
		const dates = expandDates(startsOn, rule, rule.end.date, rule.end.date);
		if (dates.length) return dates[0]!;
		// letztes Vorkommen vor `until`: bis zu (interval × 7) Tage zurück suchen
		const back = expandDates(
			startsOn,
			rule,
			addDays(rule.end.date, -7 * rule.interval),
			rule.end.date
		);
		return back.at(-1) ?? startsOn;
	}
	const all = expandDates(startsOn, rule, startsOn, addDays(startsOn, 7 * rule.interval * 501));
	return all[Math.min(rule.end.count, all.length) - 1] ?? startsOn;
}

const WEEKDAY_NAMES = [
	'Montag',
	'Dienstag',
	'Mittwoch',
	'Donnerstag',
	'Freitag',
	'Samstag',
	'Sonntag'
];

/** Kurzbeschreibung, z. B. „Jede Woche Dienstag und Donnerstag, 10 Termine“ */
export function describeRecurrence(rule: RecurrenceRule, startsOn: string): string {
	const names = weekdaysOf(rule, startsOn).map((d) => WEEKDAY_NAMES[d - 1]!);
	const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} und ${names.at(-1)}` : names[0];
	const every = rule.interval === 1 ? 'Jede Woche' : `Alle ${rule.interval} Wochen`;
	const end =
		rule.end.type === 'until'
			? `, bis ${formatShort(rule.end.date)}`
			: rule.end.type === 'count'
				? `, ${rule.end.count} Termine`
				: '';
	return `${every} ${list}${end}`;
}

function formatShort(date: string): string {
	const [y, m, d] = date.split('-');
	return `${d}.${m}.${y}`;
}
