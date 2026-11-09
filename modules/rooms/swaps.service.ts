/**
 * Tauschanfragen: Eine Gruppe braucht an einem Tag einen Raum, den eine **feste** Buchung belegt. Statt zu
 * verdrängen, fragt sie die Gruppe der festen Buchung. Nimmt diese an, wird ihr Termin an diesem Tag in den
 * vorgeschlagenen gleichwertigen Raum gelegt und die anfragende Buchung angelegt. Antwortfrist: höchstens
 * `SWAP_ANSWER_DAYS`, spätestens der Vortag; danach verfällt die Anfrage (täglicher Job).
 * Nur einmalige Buchungen (keine Serien) können tauschen.
 */
import { sql } from 'drizzle-orm';
import {
	addDays,
	core,
	errors,
	rowsOf,
	toIsoOrNull,
	userLabel,
	type RequestContext,
	type Row,
	type Tx
} from '$lib/sdk/server';
import { toWrite, validateSpec, type BookingSpec } from './bookings.service';
import { insertBooking, insertMoves, loadAssignments, loadBooking, pinOccurrence } from './data';
import { overlaps } from './planner';
import { replan, type PlanContext, type PlanOutcome } from './planning.service';
import {
	PERM_MANAGE,
	SWAP_ANSWER_DAYS,
	toMinutes,
	type SwapInfo,
	type SwapRequestInput,
	type SwapStatus
} from './schemas';
import { bestTarget, dropTargets } from './placement.service';

const text = (v: unknown): string | null => (v == null || v === '' ? null : String(v));

export const canManageSwaps = (ctx: RequestContext) =>
	ctx.actor.type === 'system' || core.permissions.has(ctx, PERM_MANAGE);

const COLUMNS = sql`s.id, s.status, to_char(s.occurrence_date, 'YYYY-MM-DD') AS d, s.request, s.requester_id,
	s.target_booking_id, b.title AS target_title, b.owner_id AS target_owner, s.room_id, r.name AS room_name,
	s.proposed_room_id, pr.name AS proposed_name, s.message, to_char(s.due_on, 'YYYY-MM-DD') AS due_on,
	s.created_at, s.result_booking_id`;
const FROM = sql`swap_requests s JOIN bookings b ON b.id = s.target_booking_id
	JOIN rooms r ON r.id = s.room_id LEFT JOIN rooms pr ON pr.id = s.proposed_room_id`;

type RawSwap = Omit<SwapInfo, 'requesterName'>;

function toSwap(r: Row, ctx: RequestContext): RawSwap {
	const req = (typeof r.request === 'string' ? JSON.parse(r.request) : r.request) as BookingSpec;
	const targetOwner = String(r.target_owner);
	const status = String(r.status) as SwapStatus;
	return {
		id: String(r.id),
		status,
		date: String(r.d),
		startsAt: req.startsAt,
		endsAt: req.endsAt,
		requestTitle: req.title,
		requestPersons: req.persons,
		requesterId: String(r.requester_id),
		targetBookingId: String(r.target_booking_id),
		targetTitle: String(r.target_title),
		targetOwnerId: targetOwner,
		roomId: String(r.room_id),
		roomName: text(r.room_name),
		proposedRoomId: text(r.proposed_room_id),
		proposedRoomName: text(r.proposed_name),
		message: text(r.message),
		dueOn: String(r.due_on),
		createdAt: toIsoOrNull(r.created_at) ?? '',
		canDecide: status === 'pending' && (targetOwner === ctx.userId || canManageSwaps(ctx)),
		resultBookingId: text(r.result_booking_id)
	};
}

export async function withRequesterNames(
	ctx: RequestContext,
	list: RawSwap[]
): Promise<SwapInfo[]> {
	const users = await core.users.byIds(ctx, new Set(list.map((s) => s.requesterId)));
	return list.map((s) => ({ ...s, requesterName: userLabel(users, s.requesterId) }));
}

/** Anfragen, die die Person betreffen (gestellt, an sie gerichtet; Verwaltung: alle offenen) */
export async function listSwaps(
	tx: Tx,
	ctx: RequestContext,
	opts: { pendingOnly?: boolean; targetOwnerOnly?: boolean } = {}
): Promise<RawSwap[]> {
	const me = ctx.userId ?? '';
	const who = opts.targetOwnerOnly
		? sql`b.owner_id = ${me}`
		: canManageSwaps(ctx)
			? sql`TRUE`
			: sql`(s.requester_id = ${me} OR b.owner_id = ${me})`;
	const status = opts.pendingOnly ? sql`s.status = 'pending'` : sql`TRUE`;
	const rows = await rowsOf(
		tx,
		sql`SELECT ${COLUMNS} FROM ${FROM} WHERE ${who} AND ${status}
			ORDER BY (s.status = 'pending') DESC, s.occurrence_date, s.created_at DESC LIMIT 100`
	);
	return rows.map((r) => toSwap(r, ctx));
}

export async function loadSwap(tx: Tx, ctx: RequestContext, id: string): Promise<RawSwap | null> {
	const [row] = await rowsOf(tx, sql`SELECT ${COLUMNS} FROM ${FROM} WHERE s.id = ${id}`);
	return row ? toSwap(row, ctx) : null;
}

/** Anfrage stellen: prüft Ziel (feste Buchung belegt den Raum) und Ausweichraum */
export async function createSwap(
	tx: Tx,
	ctx: RequestContext,
	pc: PlanContext,
	input: SwapRequestInput
): Promise<string> {
	const spec = input.booking;
	if (spec.recurrence) throw errors.badRequest('Tauschen geht nur für einzelne Termine');
	if (spec.startsOn !== input.date) throw errors.badRequest('Datum passt nicht zur Buchung');
	await validateSpec(tx, pc, { ...spec, mode: 'flexible', roomId: null }, { isNew: true });
	const target = await loadBooking(tx, input.targetBookingId);
	if (!target || target.mode !== 'fixed' || target.cancelled.has(input.date)) {
		throw errors.notFound('Feste Buchung nicht gefunden');
	}
	if (target.ownerId === ctx.userId) throw errors.badRequest('Das ist deine eigene Buchung');
	const assigned = await loadAssignments(tx, input.date, input.date);
	if (assigned.get(`${target.id}:${input.date}`) !== input.roomId) {
		throw errors.badRequest('Die Buchung liegt an diesem Tag nicht in diesem Raum');
	}
	const slot = { start: toMinutes(spec.startsAt), end: toMinutes(spec.endsAt) };
	const targetSlot = { start: toMinutes(target.startsAt), end: toMinutes(target.endsAt) };
	if (!overlaps(slot, targetSlot, pc.settings.bufferMinutes)) {
		throw errors.badRequest('Die Buchung überschneidet sich nicht mit deinem Termin');
	}
	const alt = await bestTarget(tx, await dropTargets(tx, pc, target, input.date));
	if (!alt) throw errors.conflict('Für die feste Buchung gibt es keinen freien Ausweichraum');
	const dueOn = [addDays(pc.today, SWAP_ANSWER_DAYS), addDays(input.date, -1)].sort()[0]!;
	if (dueOn < pc.today) throw errors.badRequest('Zu kurzfristig für eine Tauschanfrage');
	const id = crypto.randomUUID();
	await tx.execute(
		sql`INSERT INTO swap_requests (id, requester_id, request, target_booking_id, occurrence_date, room_id,
				proposed_room_id, message, due_on)
			VALUES (${id}, ${ctx.userId}, ${JSON.stringify({ ...spec, mode: 'similar', roomId: input.roomId })}::jsonb,
				${target.id}, ${input.date}::date, ${input.roomId}, ${alt.roomId}, ${input.message}, ${dueOn}::date)`
	);
	return id;
}

/** Annehmen: feste Buchung weicht an diesem Tag aus, die anfragende Buchung wird angelegt */
export async function acceptSwap(
	tx: Tx,
	ctx: RequestContext,
	pc: PlanContext,
	swap: RawSwap
): Promise<{ outcome: PlanOutcome; bookingId: string }> {
	if (swap.status !== 'pending') throw errors.conflict('Diese Anfrage ist schon entschieden');
	const target = await loadBooking(tx, swap.targetBookingId);
	if (!target) throw errors.notFound('Feste Buchung nicht gefunden');
	const targets = await dropTargets(tx, pc, target, swap.date);
	const alt =
		targets.find((t) => t.roomId === swap.proposedRoomId && t.ok) ??
		(await bestTarget(tx, targets));
	if (!alt) throw errors.conflict('Der Ausweichraum ist inzwischen belegt');
	const [row] = await rowsOf(
		tx,
		sql`SELECT request, requester_id FROM swap_requests WHERE id = ${swap.id}`
	);
	const spec = (
		typeof row!.request === 'string' ? JSON.parse(row!.request) : row!.request
	) as BookingSpec;

	// 1. feste Buchung an diesem Tag in den Ausweichraum legen
	await tx.execute(
		sql`UPDATE assignments SET room_id = ${alt.roomId}, updated_at = now()
			WHERE booking_id = ${target.id} AND occurrence_date = ${swap.date}::date`
	);
	await pinOccurrence(tx, target.id, swap.date, alt.roomId, ctx.userId);
	await insertMoves(
		tx,
		[{ bookingId: target.id, date: swap.date, fromRoomId: swap.roomId, toRoomId: alt.roomId }],
		{
			kind: 'manual',
			reason: `Tausch mit „${spec.title}“ angenommen`,
			createdBy: ctx.userId,
			objectionHours: 0
		}
	);
	// 2. anfragende Buchung anlegen und in den frei gewordenen Raum legen
	const bookingId = crypto.randomUUID();
	await insertBooking(
		tx,
		bookingId,
		String(row!.requester_id),
		String(row!.requester_id),
		toWrite(spec)
	);
	await pinOccurrence(tx, bookingId, swap.date, swap.roomId, ctx.userId);
	const outcome = await replan(tx, pc, {
		dates: [swap.date],
		subjectIds: new Set([bookingId]),
		reason: `Tausch für „${spec.title}“`,
		actorId: ctx.userId
	});
	if (outcome.subjectConflicts.length)
		throw errors.conflict('Der Tausch geht inzwischen nicht mehr auf');
	await tx.execute(
		sql`UPDATE swap_requests SET status = 'accepted', decided_at = now(), decided_by = ${ctx.userId},
				result_booking_id = ${bookingId}, proposed_room_id = ${alt.roomId}
			WHERE id = ${swap.id}`
	);
	return { outcome, bookingId };
}

export async function setSwapStatus(
	tx: Tx,
	id: string,
	status: Exclude<SwapStatus, 'pending' | 'accepted'>,
	userId: string | null
): Promise<void> {
	await tx.execute(
		sql`UPDATE swap_requests SET status = ${status}, decided_at = now(), decided_by = ${userId}
			WHERE id = ${id} AND status = 'pending'`
	);
}

/** Abgelaufene Anfragen schließen; liefert sie (für Benachrichtigungen) */
export async function expireSwaps(tx: Tx, ctx: RequestContext, today: string): Promise<RawSwap[]> {
	const rows = await rowsOf(
		tx,
		sql`SELECT ${COLUMNS} FROM ${FROM} WHERE s.status = 'pending' AND s.due_on < ${today}::date`
	);
	if (rows.length) {
		await tx.execute(
			sql`UPDATE swap_requests SET status = 'expired', decided_at = now()
				WHERE status = 'pending' AND due_on < ${today}::date`
		);
	}
	return rows.map((r) => ({ ...toSwap(r, ctx), status: 'expired' as const }));
}
