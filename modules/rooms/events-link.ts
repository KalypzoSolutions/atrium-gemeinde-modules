/**
 * Verknüpfung zum Modul `events` (optional): Termine suchen und beschreiben, um eine Buchung mit einem Termin zu
 * verbinden. Ohne aktives `events` liefern alle Funktionen leere Ergebnisse. Nur außerhalb von Transaktionen.
 */
import { core, type RequestContext } from '$lib/sdk/server';
import type { EventRefInfo, EventRefsService } from './peer-contracts';
import { MODULE_ID } from './schemas';

export async function eventsService(): Promise<EventRefsService | null> {
	return core.modules.useOptional<EventRefsService>('events', MODULE_ID);
}

export async function searchEvents(ctx: RequestContext, search: string): Promise<EventRefInfo[]> {
	const svc = await eventsService();
	return svc ? svc.searchEventRefs(ctx, { search, limit: 20 }) : [];
}

/** Titel eines sichtbaren Termins (sonst `null`) */
export async function eventTitle(ctx: RequestContext, id: string): Promise<string | null> {
	const svc = await eventsService();
	if (!svc) return null;
	const [ref] = await svc.describeEventRefs(ctx, [id]);
	return ref?.title ?? null;
}

/** Prüft, dass der Termin existiert und für `ctx` sichtbar ist (sonst `false`) */
export async function eventVisible(ctx: RequestContext, id: string): Promise<boolean> {
	return (await eventTitle(ctx, id)) !== null;
}
