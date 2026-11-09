/**
 * Lokale Spiegelung der Teile fremder Modul-Verträge, die `rooms` nutzt. Das Modul `events` liegt in einem anderen
 * Repository (`atrium-basic-modules`), ist nur `optionalDependencies` und wird zur Laufzeit über
 * `core.modules.useOptional(…)` geholt. Nur strukturelle Typen – bei Änderungen am Original-Vertrag hier nachziehen.
 */
import type { RequestContext } from '$lib/sdk/types';

/** `events`: `EventRefInfo` aus `$modules/events/contract` */
export interface EventRefInfo {
	id: string;
	title: string;
	startsOn: string;
	endsOn: string | null;
	color: string | null;
	recurring: boolean;
	onWebsite: boolean;
}

/** `events`: genutzter Ausschnitt von `EventRefsService` */
export interface EventRefsService {
	searchEventRefs(
		ctx: RequestContext,
		opts?: { search?: string; limit?: number }
	): Promise<EventRefInfo[]>;
	describeEventRefs(ctx: RequestContext, ids: readonly string[]): Promise<EventRefInfo[]>;
}
