import { describe, expect, it } from 'vitest';
import {
	describeRecurrence,
	expandDates,
	isOccurrence,
	isoWeekday,
	lastOccurrence
} from '$modules/rooms/recurrence';
import { recurrenceRule, type RecurrenceRule } from '$modules/rooms/schemas';

const rule = (r: Partial<RecurrenceRule> = {}): RecurrenceRule =>
	recurrenceRule.parse({ freq: 'weekly', ...r });

describe('Wiederholung', () => {
	it('Wochentage nach ISO', () => {
		expect(isoWeekday('2026-11-09')).toBe(1); // Montag
		expect(isoWeekday('2026-11-15')).toBe(7); // Sonntag
	});

	it('wöchentlich am Wochentag des Starts', () => {
		expect(expandDates('2026-11-10', rule(), '2026-11-01', '2026-11-30')).toEqual([
			'2026-11-10',
			'2026-11-17',
			'2026-11-24'
		]);
	});

	it('mehrere Wochentage und Intervall', () => {
		const r = rule({ interval: 2, byWeekday: [2, 4] });
		expect(expandDates('2026-11-10', r, '2026-11-01', '2026-12-10')).toEqual([
			'2026-11-10',
			'2026-11-12',
			'2026-11-24',
			'2026-11-26',
			'2026-12-08',
			'2026-12-10'
		]);
	});

	it('Wochentag vor dem Start in der ersten Woche zählt nicht', () => {
		const r = rule({ byWeekday: [1, 3] });
		expect(expandDates('2026-11-11', r, '2026-11-01', '2026-11-17')).toEqual([
			'2026-11-11',
			'2026-11-16'
		]);
	});

	it('Ende nach Datum und Anzahl', () => {
		const until = rule({ end: { type: 'until', date: '2026-11-24' } });
		expect(expandDates('2026-11-10', until, '2026-11-01', '2027-01-01')).toHaveLength(3);
		const count = rule({ end: { type: 'count', count: 2 } });
		expect(expandDates('2026-11-10', count, '2026-11-01', '2027-01-01')).toEqual([
			'2026-11-10',
			'2026-11-17'
		]);
		// `count` zählt ab dem ersten Termin, auch wenn das Fenster später beginnt
		expect(expandDates('2026-11-10', count, '2026-11-15', '2027-01-01')).toEqual(['2026-11-17']);
	});

	it('Fenster weit nach dem Start (übersprungene Wochen)', () => {
		const r = rule({ interval: 3 });
		const dates = expandDates('2026-01-06', r, '2026-11-01', '2026-12-31');
		expect(dates.every((d) => isoWeekday(d) === 2)).toBe(true);
		for (const d of dates) expect(isOccurrence('2026-01-06', r, d)).toBe(true);
		expect(isOccurrence('2026-01-06', r, '2026-01-13')).toBe(false);
	});

	it('einmalig ohne Regel', () => {
		expect(expandDates('2026-11-10', null, '2026-11-01', '2026-11-30')).toEqual(['2026-11-10']);
		expect(expandDates('2026-11-10', null, '2026-11-11', '2026-11-30')).toEqual([]);
	});

	it('letztes Vorkommen', () => {
		expect(lastOccurrence('2026-11-10', rule())).toBeNull();
		expect(lastOccurrence('2026-11-10', null)).toBe('2026-11-10');
		expect(lastOccurrence('2026-11-10', rule({ end: { type: 'until', date: '2026-11-29' } }))).toBe(
			'2026-11-24'
		);
		expect(lastOccurrence('2026-11-10', rule({ end: { type: 'count', count: 3 } }))).toBe(
			'2026-11-24'
		);
	});

	it('Beschreibung', () => {
		expect(describeRecurrence(rule({ byWeekday: [2, 4] }), '2026-11-10')).toBe(
			'Jede Woche Dienstag und Donnerstag'
		);
		expect(
			describeRecurrence(rule({ interval: 2, end: { type: 'count', count: 5 } }), '2026-11-10')
		).toBe('Alle 2 Wochen Dienstag, 5 Termine');
	});
});
