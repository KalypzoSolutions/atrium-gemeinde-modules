<script lang="ts">
	// Belegungsplan: Tag (Räume × Uhrzeit), Woche (Liste je Tag), „Meine Buchungen“. Klick auf einen Termin öffnet
	// die Buchung, Klick auf eine freie Stelle im Tagesraster bucht diesen Raum zu dieser Uhrzeit (mit Recht).
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Plus from '@lucide/svelte/icons/plus';
	import Repeat from '@lucide/svelte/icons/repeat';
	import Settings from '@lucide/svelte/icons/settings';
	import { apiFetch, can } from '$lib/sdk/client';
	import { addDays, formatDateDe } from '$lib/sdk/dates';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Tabs from '$lib/components/ui/tabs';
	import { EmptyState, ErrorState, LoadingState, PageHeader } from '$lib/components/layout';
	import { PERM_CREATE, PERM_MANAGE, type Occurrence } from '../schemas';
	import BookingDialog from './BookingDialog.svelte';
	import { dayLabel, errorInfo, isDate, mondayOf, toMinutes, type RoomsMeta } from './helpers';

	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const canCreate = $derived(can(permissions, PERM_CREATE));
	const canManage = $derived(can(permissions, PERM_MANAGE));

	// --- Stammdaten ------------------------------------------------------------------------
	let meta = $state<RoomsMeta | null>(null);
	let metaError = $state('');
	async function loadMeta() {
		metaError = '';
		try {
			meta = await apiFetch<RoomsMeta>('/modules/rooms/meta');
		} catch (e) {
			metaError = errorInfo(e, 'Räume konnten nicht geladen werden.').message;
		}
	}
	$effect(() => {
		void loadMeta();
	});

	// --- Zustand aus der URL ---------------------------------------------------------------
	const params = $derived(page.url.searchParams);
	const view = $derived<'day' | 'week' | 'mine'>(
		params.get('view') === 'week' ? 'week' : params.get('view') === 'mine' ? 'mine' : 'day'
	);
	const today = $derived(meta?.today ?? '');
	const date = $derived(isDate(params.get('date')) ? params.get('date')! : today);
	const roomFilter = $derived(params.get('room'));

	function setParams(values: Record<string, string | null>) {
		const url = new URL(page.url);
		for (const [k, v] of Object.entries(values)) {
			if (v) url.searchParams.set(k, v);
			else url.searchParams.delete(k);
		}
		void goto(url, { keepFocus: true, noScroll: true, replaceState: true });
	}

	const range = $derived.by(() => {
		if (!date) return null;
		if (view === 'week') {
			const from = mondayOf(date);
			return { from, to: addDays(from, 6) };
		}
		if (view === 'mine') return { from: today, to: addDays(today, 90) };
		return { from: date, to: date };
	});

	// --- Belegung laden --------------------------------------------------------------------
	let items = $state<Occurrence[]>([]);
	let loading = $state(true);
	let loadError = $state('');
	let reloadKey = $state(0);

	$effect(() => {
		const r = range;
		void reloadKey;
		if (!r) return;
		const q = new URLSearchParams({ from: r.from, to: r.to });
		if (view === 'mine') q.set('mine', '1');
		let cancelled = false;
		loading = true;
		loadError = '';
		apiFetch<Occurrence[]>(`/modules/rooms/occurrences?${q}`)
			.then((list) => {
				if (!cancelled) items = list;
			})
			.catch((e) => {
				if (!cancelled) loadError = errorInfo(e, 'Belegung konnte nicht geladen werden.').message;
			})
			.finally(() => {
				if (!cancelled) loading = false;
			});
		return () => {
			cancelled = true;
		};
	});

	const visibleRooms = $derived(
		(meta?.rooms ?? []).filter((r) => !roomFilter || r.id === roomFilter)
	);
	const unassigned = $derived(items.filter((o) => !o.roomId));

	// --- Tagesraster -----------------------------------------------------------------------
	const PX_PER_MIN = 1;
	const hours = $derived.by(() => {
		let start = 7 * 60;
		let end = 22 * 60;
		for (const o of items) {
			start = Math.min(start, Math.floor(toMinutes(o.startsAt) / 60) * 60);
			end = Math.max(end, Math.ceil(toMinutes(o.endsAt) / 60) * 60);
		}
		return {
			start,
			end,
			list: Array.from({ length: (end - start) / 60 }, (_, i) => start / 60 + i)
		};
	});

	// --- Dialog ----------------------------------------------------------------------------
	let dialogOpen = $state(false);
	let dialogBooking = $state<string | null>(null);
	let dialogDate = $state<string | null>(null);
	let dialogInitial = $state<{
		startsOn?: string;
		startsAt?: string;
		roomId?: string | null;
	} | null>(null);

	function openBooking(o: Occurrence) {
		dialogBooking = o.bookingId;
		dialogDate = o.date;
		dialogInitial = null;
		dialogOpen = true;
	}

	function newBooking(
		initial: { startsOn?: string; startsAt?: string; roomId?: string | null } = {}
	) {
		dialogBooking = null;
		dialogDate = null;
		dialogInitial = { startsOn: date || today, ...initial };
		dialogOpen = true;
	}

	function gridClick(e: MouseEvent, roomId: string) {
		if (!canCreate || e.target !== e.currentTarget) return;
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const minutes = hours.start + Math.floor((e.clientY - rect.top) / PX_PER_MIN / 30) * 30;
		const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
		const mm = String(minutes % 60).padStart(2, '0');
		newBooking({ startsOn: date, startsAt: `${hh}:${mm}`, roomId });
	}

	// Deep-Link `?booking=<id>` (Suche, Benachrichtigung, Dashboard)
	$effect(() => {
		const id = params.get('booking');
		if (!id || !meta) return;
		dialogBooking = id;
		dialogDate = isDate(params.get('date')) ? params.get('date') : null;
		dialogInitial = null;
		dialogOpen = true;
		setParams({ booking: null });
	});

	const weekDays = $derived(
		range && view === 'week' ? Array.from({ length: 7 }, (_, i) => addDays(range.from, i)) : []
	);
	const byDate = $derived.by(() => {
		const map = new Map<string, Occurrence[]>();
		for (const o of items) {
			if (roomFilter && o.roomId !== roomFilter) continue;
			const list = map.get(o.date) ?? [];
			list.push(o);
			map.set(o.date, list);
		}
		return map;
	});

	function step(dir: number) {
		setParams({ date: addDays(date, view === 'week' ? 7 * dir : dir) });
	}
</script>

<PageHeader title="Räume" description="Belegungsplan und Raumbuchung">
	{#snippet actions()}
		{#if canManage}
			<Button variant="outline" href="/modules/rooms/admin">
				<Settings class="size-4" aria-hidden="true" /> Verwaltung
			</Button>
		{/if}
		{#if canCreate && meta}
			<Button onclick={() => newBooking()}>
				<Plus class="size-4" aria-hidden="true" /> Raum buchen
			</Button>
		{/if}
	{/snippet}
</PageHeader>

{#if metaError}
	<ErrorState message={metaError} onretry={loadMeta} />
{:else if !meta}
	<LoadingState />
{:else if !meta.rooms.length}
	<EmptyState
		title="Noch keine Räume"
		description={canManage
			? 'Lege zuerst Räume und ihre Merkmale in der Verwaltung an.'
			: 'Die Raumverwaltung hat noch keine Räume angelegt.'}
	>
		{#if canManage}<Button href="/modules/rooms/admin">Räume anlegen</Button>{/if}
	</EmptyState>
{:else}
	<div class="space-y-4">
		<div class="flex flex-wrap items-center gap-2">
			<Tabs.Root value={view} onValueChange={(v) => setParams({ view: v === 'day' ? null : v })}>
				<Tabs.List>
					<Tabs.Trigger value="day">Tag</Tabs.Trigger>
					<Tabs.Trigger value="week">Woche</Tabs.Trigger>
					<Tabs.Trigger value="mine">Meine Buchungen</Tabs.Trigger>
				</Tabs.List>
			</Tabs.Root>
			{#if view !== 'mine'}
				<div class="flex items-center gap-1">
					<Button size="icon" variant="outline" aria-label="Zurück" onclick={() => step(-1)}>
						<ChevronLeft class="size-4" />
					</Button>
					<Input
						type="date"
						class="w-40"
						value={date}
						aria-label="Datum"
						onchange={(e) =>
							isDate(e.currentTarget.value) && setParams({ date: e.currentTarget.value })}
					/>
					<Button size="icon" variant="outline" aria-label="Weiter" onclick={() => step(1)}>
						<ChevronRight class="size-4" />
					</Button>
					{#if date !== today}
						<Button variant="ghost" onclick={() => setParams({ date: null })}>Heute</Button>
					{/if}
				</div>
				<span class="text-sm text-muted-foreground">
					{view === 'week' && range
						? `${formatDateDe(range.from)} – ${formatDateDe(range.to)}`
						: dayLabel(date)}
				</span>
			{/if}
			{#if roomFilter}
				<Badge variant="secondary" class="gap-1">
					{meta.rooms.find((r) => r.id === roomFilter)?.name ?? 'Raum'}
					<button
						type="button"
						aria-label="Filter entfernen"
						onclick={() => setParams({ room: null })}>×</button
					>
				</Badge>
			{/if}
		</div>

		{#if loadError}
			<ErrorState
				message={loadError}
				onretry={() => {
					reloadKey++;
				}}
			/>
		{:else if loading && !items.length}
			<LoadingState />
		{:else if view === 'day'}
			{#if unassigned.length}
				<div
					class="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
					role="status"
				>
					<p class="font-medium">Ohne Raum</p>
					<ul class="mt-1 space-y-1">
						{#each unassigned as o (o.key)}
							<li>
								<button type="button" class="hover:underline" onclick={() => openBooking(o)}>
									{o.startsAt}–{o.endsAt}
									{o.title} ({o.persons} Pers.)
								</button>
							</li>
						{/each}
					</ul>
				</div>
			{/if}
			<div class="overflow-x-auto rounded-md border">
				<div class="flex min-w-full">
					<div class="sticky left-0 z-10 w-14 shrink-0 border-r bg-background">
						<div class="h-12 border-b"></div>
						<div class="relative" style:height="{(hours.end - hours.start) * PX_PER_MIN}px">
							{#each hours.list as h (h)}
								<div
									class={[
										'absolute right-1 text-xs text-muted-foreground',
										h * 60 > hours.start && '-translate-y-1/2'
									]}
									style:top="{(h * 60 - hours.start) * PX_PER_MIN}px"
								>
									{String(h).padStart(2, '0')}:00
								</div>
							{/each}
						</div>
					</div>
					{#each visibleRooms as room (room.id)}
						<div class="min-w-44 flex-1 border-r last:border-r-0">
							<div class="flex h-12 flex-col justify-center border-b px-2">
								<span class="truncate text-sm font-medium" title={room.name}>{room.name}</span>
								<span class="text-xs text-muted-foreground">
									{room.capacity} Plätze{room.bookable ? '' : ' · nicht buchbar'}
								</span>
							</div>
							<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
							<div
								class={[
									'relative',
									canCreate && room.bookable && 'cursor-copy',
									!room.bookable && 'bg-muted/50'
								]}
								style:height="{(hours.end - hours.start) * PX_PER_MIN}px"
								onclick={(e) => room.bookable && gridClick(e, room.id)}
							>
								{#each hours.list as h (h)}
									<div
										class="pointer-events-none absolute inset-x-0 border-t border-dashed border-border/60"
										style:top="{(h * 60 - hours.start) * PX_PER_MIN}px"
									></div>
								{/each}
								{#each items.filter((o) => o.roomId === room.id) as o (o.key)}
									<button
										type="button"
										class={[
											'absolute inset-x-1 flex flex-col items-start justify-start overflow-hidden rounded-md border px-1.5 py-1 text-left text-xs shadow-sm',
											o.mine ? 'border-primary/50 bg-primary/15' : 'bg-card hover:bg-muted'
										]}
										style:top="{(toMinutes(o.startsAt) - hours.start) * PX_PER_MIN}px"
										style:height="{Math.max(
											22,
											(toMinutes(o.endsAt) - toMinutes(o.startsAt)) * PX_PER_MIN
										)}px"
										onclick={() => openBooking(o)}
										title="{o.title}, {o.startsAt}–{o.endsAt}, {o.persons} Personen"
									>
										<span class="flex items-center gap-1 font-medium">
											{#if o.recurring}<Repeat class="size-3 shrink-0" aria-label="Serie" />{/if}
											<span class="truncate">{o.title}</span>
										</span>
										<span class="block truncate text-muted-foreground">
											{o.startsAt}–{o.endsAt} · {o.persons} P.{o.mode === 'fixed' ? ' · fest' : ''}
										</span>
									</button>
								{/each}
							</div>
						</div>
					{/each}
				</div>
			</div>
			{#if canCreate}
				<p class="text-xs text-muted-foreground">
					Tipp: Klick auf eine freie Stelle bucht diesen Raum zu dieser Uhrzeit.
				</p>
			{/if}
		{:else}
			{@const days = view === 'week' ? weekDays : [...byDate.keys()]}
			{#if !days.some((d) => byDate.get(d)?.length)}
				<EmptyState
					title={view === 'mine' ? 'Keine eigenen Buchungen' : 'Keine Buchungen in dieser Woche'}
					description={view === 'mine'
						? 'In den nächsten 90 Tagen hast du nichts gebucht.'
						: undefined}
				/>
			{:else}
				<div class="space-y-4">
					{#each days as d (d)}
						{@const list = byDate.get(d) ?? []}
						{#if list.length || view === 'week'}
							<section>
								<h2 class="mb-1 text-sm font-semibold">
									<button
										type="button"
										class="hover:underline"
										onclick={() => setParams({ view: null, date: d })}
									>
										{dayLabel(d)}
									</button>
								</h2>
								{#if list.length}
									<ul class="divide-y rounded-md border">
										{#each list as o (o.key)}
											<li>
												<button
													type="button"
													class="flex w-full flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-2 text-left text-sm hover:bg-muted"
													onclick={() => openBooking(o)}
												>
													<span class="w-24 shrink-0 tabular-nums text-muted-foreground">
														{o.startsAt}–{o.endsAt}
													</span>
													<span class="flex min-w-0 flex-1 items-center gap-1 font-medium">
														{#if o.recurring}<Repeat
																class="size-3.5 shrink-0"
																aria-label="Serie"
															/>{/if}
														<span class="truncate">{o.title}</span>
													</span>
													<span class={o.roomId ? '' : 'font-medium text-destructive'}>
														{o.roomName ?? (o.planned ? 'Ohne Raum' : 'Raum folgt')}
													</span>
													<span class="text-muted-foreground">{o.persons} Pers.</span>
													{#if view === 'week'}
														<span class="w-full text-xs text-muted-foreground sm:w-auto"
															>{o.ownerName}</span
														>
													{/if}
												</button>
											</li>
										{/each}
									</ul>
								{:else}
									<p class="text-sm text-muted-foreground">Keine Buchungen</p>
								{/if}
							</section>
						{/if}
					{/each}
				</div>
			{/if}
		{/if}
	</div>

	<BookingDialog
		bind:open={dialogOpen}
		bookingId={dialogBooking}
		date={dialogDate}
		initial={dialogInitial}
		{meta}
		onsaved={() => reloadKey++}
	/>
{/if}
