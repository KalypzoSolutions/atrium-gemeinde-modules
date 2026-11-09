/**
 * Verlegungen: Protokoll automatischer und manueller Raumwechsel einzelner Termine mit Widerspruchsfrist
 * (`OBJECTION_HOURS`). Die Eigentümer*in der Buchung kann innerhalb der Frist widersprechen; der Widerspruch landet
 * bei der Raumverwaltung („Zu erledigen“), die ihn per Drag & Drop löst oder als erledigt markiert.
 */
import { sql, type SQL } from 'drizzle-orm';
import { core, rowsOf, toIsoOrNull, type RequestContext, type Row, type Tx } from '$lib/sdk/server';
import { PERM_EDIT_ALL, PERM_MANAGE, type MoveInfo, type MoveKind } from './schemas';

const text = (v: unknown): string | null => (v == null || v === '' ? null : String(v));

const COLUMNS = sql`m.id, m.booking_id, to_char(m.occurrence_date, 'YYYY-MM-DD') AS d, m.from_room_id,
	fr.name AS from_name, m.to_room_id, tr.name AS to_name, m.kind, m.reason, m.created_at, m.objection_until,
	m.objected_at, m.objection_note, m.resolved_at, b.title, b.owner_id,
	(m.objection_until IS NOT NULL AND m.objection_until > now() AND m.objected_at IS NULL
		AND m.resolved_at IS NULL) AS objection_open`;

const FROM = sql`moves m JOIN bookings b ON b.id = m.booking_id
	LEFT JOIN rooms fr ON fr.id = m.from_room_id LEFT JOIN rooms tr ON tr.id = m.to_room_id`;

function toMove(r: Row, ctx: RequestContext): MoveInfo {
	const ownerId = String(r.owner_id);
	const open = r.objection_open === true || r.objection_open === 't';
	return {
		id: String(r.id),
		bookingId: String(r.booking_id),
		title: String(r.title),
		date: String(r.d),
		fromRoomId: text(r.from_room_id),
		fromRoomName: text(r.from_name),
		toRoomId: text(r.to_room_id),
		toRoomName: text(r.to_name),
		kind: String(r.kind) === 'manual' ? 'manual' : 'auto',
		reason: text(r.reason),
		createdAt: toIsoOrNull(r.created_at) ?? '',
		objectionUntil: toIsoOrNull(r.objection_until),
		objectedAt: toIsoOrNull(r.objected_at),
		objectionNote: text(r.objection_note),
		resolvedAt: toIsoOrNull(r.resolved_at),
		ownerId,
		canObject: open && (ownerId === ctx.userId || core.permissions.has(ctx, PERM_EDIT_ALL))
	};
}

/** Verlegungen (neueste zuerst) nach Buchung, Eigentümer*in oder offenen Widersprüchen */
export async function loadMovesFor(
	tx: Tx,
	ctx: RequestContext,
	filter: {
		bookingId?: string;
		ownerId?: string;
		from?: string;
		objected?: boolean;
		objectionOpen?: boolean;
		limit?: number;
	}
): Promise<MoveInfo[]> {
	const conds: SQL[] = [sql`TRUE`];
	if (filter.bookingId) conds.push(sql`m.booking_id = ${filter.bookingId}`);
	if (filter.ownerId) conds.push(sql`b.owner_id = ${filter.ownerId}`);
	if (filter.from) conds.push(sql`m.occurrence_date >= ${filter.from}::date`);
	if (filter.objected) conds.push(sql`m.objected_at IS NOT NULL AND m.resolved_at IS NULL`);
	if (filter.objectionOpen) {
		conds.push(sql`m.objection_until > now() AND m.objected_at IS NULL AND m.resolved_at IS NULL`);
	}
	const rows = await rowsOf(
		tx,
		sql`SELECT ${COLUMNS} FROM ${FROM} WHERE ${sql.join(conds, sql` AND `)}
			ORDER BY m.created_at DESC, m.id LIMIT ${filter.limit ?? 50}`
	);
	return rows.map((r) => toMove(r, ctx));
}

export async function loadMove(tx: Tx, ctx: RequestContext, id: string): Promise<MoveInfo | null> {
	const [row] = await rowsOf(tx, sql`SELECT ${COLUMNS} FROM ${FROM} WHERE m.id = ${id}`);
	return row ? toMove(row, ctx) : null;
}

/** Letzte Verlegung je Termin der letzten 14 Tage im Zeitraum (`bookingId:datum`) */
export async function recentMoves(
	tx: Tx,
	from: string,
	to: string
): Promise<
	Map<string, { id: string; fromRoomId: string | null; kind: MoveKind; objectionOpen: boolean }>
> {
	const rows = await rowsOf(
		tx,
		sql`SELECT DISTINCT ON (m.booking_id, m.occurrence_date) m.id, m.booking_id,
				to_char(m.occurrence_date, 'YYYY-MM-DD') AS d, m.from_room_id, m.kind,
				(m.objection_until IS NOT NULL AND m.objection_until > now() AND m.objected_at IS NULL
					AND m.resolved_at IS NULL) AS objection_open
			FROM moves m
			WHERE m.occurrence_date BETWEEN ${from}::date AND ${to}::date
				AND m.created_at > now() - interval '14 days'
			ORDER BY m.booking_id, m.occurrence_date, m.created_at DESC`
	);
	return new Map(
		rows.map((r) => [
			`${String(r.booking_id)}:${String(r.d)}`,
			{
				id: String(r.id),
				fromRoomId: text(r.from_room_id),
				kind: String(r.kind) === 'manual' ? 'manual' : 'auto',
				objectionOpen: r.objection_open === true || r.objection_open === 't'
			}
		])
	);
}

export async function objectMove(
	tx: Tx,
	id: string,
	userId: string | null,
	note: string | null
): Promise<void> {
	await tx.execute(
		sql`UPDATE moves SET objected_at = now(), objected_by = ${userId}, objection_note = ${note}
			WHERE id = ${id}`
	);
}

export async function resolveMove(tx: Tx, id: string, userId: string | null): Promise<void> {
	await tx.execute(
		sql`UPDATE moves SET resolved_at = now(), resolved_by = ${userId} WHERE id = ${id}`
	);
}

export const canManage = (ctx: RequestContext) =>
	ctx.actor.type === 'system' || core.permissions.has(ctx, PERM_MANAGE);
