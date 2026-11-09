<script lang="ts">
	// Belegungsplan: Woche (Räume × Tage, Standard), Tag (Räume × Uhrzeit), „Meine Buchungen“. Termine in Gruppenfarbe,
	// verlegte gestrichelt, ohne Raum rot. Die Raumverwaltung verschiebt Termine per Drag & Drop: beim Anfassen werden
	// alle Räume geprüft (grün = passt, schraffiert = Grund), Ablegen nur auf passende Räume am selben Tag.
	// Auf dem Handy werden Woche und Tag zur Liste.
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Info from '@lucide/svelte/icons/info';
	import Pin from '@lucide/svelte/icons/pin';
	import Plus from '@lucide/svelte/icons/plus';
	import Repeat from '@lucide/svelte/icons/repeat';
	import Settings from '@lucide/svelte/icons/settings';
	import Check from '@lucide/svelte/icons/check';
	import X from '@lucide/svelte/icons/x';
	import { apiFetch, can } from '$lib/sdk/client';
	import { addDays, formatDateDe } from '$lib/sdk/dates';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import * as Tabs from '$lib/components/ui/tabs';
	import {
		EmptyState,
		ErrorState,
		LoadingState,
		PageHeader,
		toastWithUndo
	} from '$lib/components/layout';
	import { PERM_CREATE, PERM_MANAGE, type DropTarget, type Occurrence } from '../schemas';
	import BookingDialog from './BookingDialog.svelte';
	import HeatMeter from './HeatMeter.svelte';
	import SwapDialog from './SwapDialog.svelte';
	import {
		WEEKDAY_SHORT,
		blockStyle,
		dayLabel,
		errorInfo,
		groupColor,
		isDate,
		mondayOf,
		toMinutes,
		type RoomsMeta
	} from './helpers';

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
		params.get('view') === 'day' ? 'day' : params.get('view') === 'mine' ? 'mine' : 'week'
	);
	const today = $derived(meta?.today ?? '');
	const date = $derived(isDate(params.get('date')) ? params.get('date')! : today);
	const roomFilter = $derived(params.get('room'));
	const groupFilter = $derived(params.get('group'));

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
	const reload = () => {
		reloadKey++;
	};

	$effect(() => {
		const r = range;
		void reloadKey;
		if (!r) return;
		const q = new URLSearchParams({ from: r.from, to: r.to });
		if (view === 'mine') q.set('mine', '1');
		if (groupFilter) q.set('groupId', groupFilter);
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
	const unassigned = $derived(items.filter((o) => o.planned && !o.roomId));
	const autoMoved = $derived(items.filter((o) => o.moved && o.moved.kind === 'auto'));
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
	const cell = (roomId: string, d: string) =>
		items.filter((o) => o.roomId === roomId && o.date === d);

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

	// --- Drag & Drop (Raumverwaltung) ------------------------------------------------------
	type Drag = { occ: Occurrence; targets: Map<string, DropTarget> | null };
	let drag = $state<Drag | null>(null);
	let pending = $state<{ occ: Occurrence; roomId: string } | null>(null);
	let pendingScope = $state<'one' | 'following'>('one');
	let placeOpen = $state(false);
	let placeBusy = $state(false);
	let placeError = $state('');

	const draggable = (o: Occurrence) => canManage && o.planned && o.date >= today;

	async function startDrag(e: DragEvent, o: Occurrence) {
		if (!draggable(o)) {
			e.preventDefault();
			return;
		}
		e.dataTransfer?.setData('text/plain', o.key);
		if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
		drag = { occ: o, targets: null };
		try {
			const list = await apiFetch<DropTarget[]>(
				`/modules/rooms/bookings/${o.bookingId}/occurrences/${o.date}/targets`
			);
			if (drag?.occ.key === o.key) {
				drag = { occ: o, targets: new Map(list.map((t) => [t.roomId, t])) };
			}
		} catch {
			drag = null;
		}
	}

	const targetIn = (d: Drag | null, roomId: string, day: string): DropTarget | null =>
		d && d.occ.date === day ? (d.targets?.get(roomId) ?? null) : null;

	function over(e: DragEvent, roomId: string, d: string) {
		if (targetIn(drag, roomId, d)?.ok) {
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		}
	}

	function drop(e: DragEvent, roomId: string, d: string) {
		e.preventDefault();
		const current = drag;
		drag = null;
		if (!current || !targetIn(current, roomId, d)?.ok) return;
		pending = { occ: current.occ, roomId };
		pendingScope = 'one';
		placeError = '';
		if (current.occ.recurring || current.occ.mode === 'fixed') placeOpen = true;
		else void place();
	}

	const roomName = (id: string | null) => meta?.rooms.find((r) => r.id === id)?.name ?? 'Raum';

	async function place() {
		const p = pending;
		if (!p) return;
		const scope = pendingScope;
		placeBusy = true;
		placeError = '';
		const url = `/modules/rooms/bookings/${p.occ.bookingId}/occurrences/${p.occ.date}/room`;
		try {
			await apiFetch(url, {
				method: 'PUT',
				body: JSON.stringify({ roomId: p.roomId, scope, confirmFixed: true })
			});
			placeOpen = false;
			pending = null;
			reload();
			const from = p.occ.roomId;
			toastWithUndo({
				message: `„${p.occ.title}“ → ${roomName(p.roomId)} verschoben. Die Gruppe wird benachrichtigt.`,
				undo: async () => {
					if (from) {
						await apiFetch(url, {
							method: 'PUT',
							body: JSON.stringify({ roomId: from, scope, confirmFixed: true })
						});
					}
				},
				onundone: reload
			});
		} catch (err) {
			placeError = errorInfo(err, 'Verschieben fehlgeschlagen.').message;
			placeOpen = true;
		} finally {
			placeBusy = false;
		}
	}

	// --- Dialoge ---------------------------------------------------------------------------
	let dialogOpen = $state(false);
	let dialogBooking = $state<string | null>(null);
	let dialogDate = $state<string | null>(null);
	let dialogInitial = $state<{
		startsOn?: string;
		startsAt?: string;
		roomId?: string | null;
	} | null>(null);
	let swapOpen = $state(false);
	let swapId = $state<string | null>(null);

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
		dialogInitial = { startsOn: date && date >= today ? date : today, ...initial };
		dialogOpen = true;
	}

	function gridClick(e: MouseEvent, roomId: string) {
		if (!canCreate || e.target !== e.currentTarget || drag) return;
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const minutes = hours.start + Math.floor((e.clientY - rect.top) / PX_PER_MIN / 30) * 30;
		const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
		const mm = String(minutes % 60).padStart(2, '0');
		newBooking({ startsOn: date, startsAt: `${hh}:${mm}`, roomId });
	}

	// Deep-Links `?booking=<id>` und `?swap=<id>` (Suche, Benachrichtigung, Dashboard)
	$effect(() => {
		const id = params.get('booking');
		const swap = params.get('swap');
		if (!meta) return;
		if (id) {
			dialogBooking = id;
			dialogDate = isDate(params.get('date')) ? params.get('date') : null;
			dialogInitial = null;
			dialogOpen = true;
			setParams({ booking: null });
		} else if (swap) {
			swapId = swap;
			swapOpen = true;
			setParams({ swap: null });
		}
	});

	function step(dir: number) {
		setParams({ date: addDays(date, view === 'week' ? 7 * dir : dir) });
	}

	const groupOptions = $derived((meta?.groups ?? []).map((g) => ({ value: g.id, label: g.name })));
	const roomOptions = $derived((meta?.rooms ?? []).map((r) => ({ value: r.id, label: r.name })));
	const dayNumber = (d: string) => Number(d.slice(8, 10));
	const HATCH =
		'bg-[repeating-linear-gradient(135deg,var(--color-muted)_0_6px,transparent_6px_12px)]';
	const SCOPES = [
		{ v: 'one', l: 'Nur diesen Termin', h: 'Die anderen Termine bleiben, wo sie sind.' },
		{ v: 'following', l: 'Diesen und alle folgenden', h: 'Der Raum wird zum Wunschraum der Serie.' }
	] as const;
</script>

{#snippet chip(o: Occurrence, compact = false)}
	<button
		type="button"
		draggable={draggable(o)}
		ondragstart={(e) => startDrag(e, o)}
		ondragend={() => (drag = null)}
		onclick={() => openBooking(o)}
		class={[
			'flex h-full w-full min-w-0 flex-col items-start rounded-[5px] border-l-[3px] px-1.5 py-1 text-left text-xs leading-tight',
			'hover:brightness-95 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
			draggable(o) && 'cursor-grab active:cursor-grabbing',
			o.moved && 'outline-1 -outline-offset-1 outline-warning outline-dashed',
			drag?.occ.key === o.key && 'opacity-40'
		]}
		style={blockStyle(o.roomId ? o.groupColor : 'var(--color-destructive)')}
		title="{o.title}, {o.startsAt}–{o.endsAt}, {o.persons} Personen{o.groupName
			? ` · ${o.groupName}`
			: ''}"
	>
		<span class="flex w-full min-w-0 items-start gap-1 font-semibold">
			{#if o.recurring}<Repeat class="mt-px size-3 shrink-0" aria-label="Serie" />{/if}
			{#if o.pinned}<Pin class="mt-px size-3 shrink-0" aria-label="festgelegt" />{/if}
			<span class="[overflow-wrap:anywhere]">{o.title}</span>
		</span>
		<span class="text-[11px] text-muted-foreground">
			{o.startsAt}–{o.endsAt}{compact ? '' : ` · ${o.persons} P.`}{o.mode === 'fixed'
				? ' · fest'
				: ''}
			{#if o.moved}<span class="text-warning"> · verlegt</span>{/if}
			{#if !o.roomId}<span class="text-destructive"> · ohne Raum</span>{/if}
		</span>
	</button>
{/snippet}

{#snippet dropHint(t: DropTarget | null)}
	{#if t && !t.current}
		<span
			class={[
				'pointer-events-none absolute inset-x-1 bottom-1 z-10 flex items-center gap-1 rounded-md border px-1.5 py-1 text-[11px] leading-tight',
				t.ok
					? 'border-success-border bg-success-muted font-semibold text-success'
					: 'bg-background text-muted-foreground'
			]}
		>
			{#if t.ok}<Check class="size-3 shrink-0" />{:else}<X class="size-3 shrink-0" />{/if}
			{t.label}
		</span>
	{/if}
{/snippet}

{#snippet dayList(d: string, list: Occurrence[])}
	<section>
		<h2 class="mb-1 text-sm font-semibold">
			<button
				type="button"
				class="hover:underline"
				onclick={() => setParams({ view: 'day', date: d })}
			>
				{dayLabel(d)}
			</button>
		</h2>
		{#if list.length}
			<ul class="divide-y rounded-lg border">
				{#each list as o (o.key)}
					<li>
						<button
							type="button"
							class="grid w-full grid-cols-[3.25rem_1fr] gap-3 px-3 py-2.5 text-left text-sm hover:bg-muted"
							onclick={() => openBooking(o)}
						>
							<span class="text-xs leading-tight text-muted-foreground tabular-nums">
								{o.startsAt}<br />{o.endsAt}
							</span>
							<span
								class="min-w-0 border-l-[3px] pl-2"
								style:border-left-color={groupColor(
									o.roomId ? o.groupColor : 'var(--color-destructive)'
								)}
							>
								<span class="flex items-center gap-1 font-semibold">
									{#if o.recurring}<Repeat class="size-3.5 shrink-0" aria-label="Serie" />{/if}
									<span class="truncate">{o.title}</span>
								</span>
								<span class="block text-xs text-muted-foreground">
									<span class={o.roomId ? '' : 'font-medium text-destructive'}>
										{o.roomName ?? (o.planned ? 'Ohne Raum' : 'Raum folgt')}
									</span>
									· {o.persons} Pers.{o.groupName ? ` · ${o.groupName}` : ''}
									{#if o.moved}<span class="text-warning"> · verlegt</span>{/if}
									{#if view !== 'mine'}
										· {o.ownerName}{/if}
								</span>
							</span>
						</button>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="text-sm text-muted-foreground">Keine Buchungen</p>
		{/if}
	</section>
{/snippet}

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
		<div class="flex flex-wrap items-center justify-between gap-2">
			<div class="flex flex-wrap items-center gap-2">
				<Tabs.Root value={view} onValueChange={(v) => setParams({ view: v === 'week' ? null : v })}>
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
			</div>
			<div class="flex flex-wrap items-center gap-2">
				{#if groupOptions.length}
					<SelectField
						label="Gruppe"
						options={groupOptions}
						value={groupFilter}
						onchange={(v) => setParams({ group: v })}
						emptyLabel="Alle Gruppen"
						placeholder="Alle Gruppen"
						size="sm"
						class="w-44"
					/>
				{/if}
				{#if view !== 'mine'}
					<SelectField
						label="Raum"
						options={roomOptions}
						value={roomFilter}
						onchange={(v) => setParams({ room: v })}
						emptyLabel="Alle Räume"
						placeholder="Alle Räume"
						size="sm"
						class="w-40"
					/>
				{/if}
			</div>
		</div>

		{#if view !== 'mine' && (autoMoved.length || unassigned.length)}
			<div
				class="flex gap-2 rounded-md border border-info-border bg-info-muted px-3 py-2.5 text-sm"
				role="status"
			>
				<Info class="mt-0.5 size-4 shrink-0 text-info" aria-hidden="true" />
				<p>
					{#if autoMoved.length}
						<b>
							{autoMoved.length}
							{autoMoved.length === 1 ? 'Termin' : 'Termine'} automatisch verlegt
						</b>
						– {[...new Set(autoMoved.map((o) => o.title))].slice(0, 3).join(', ')}
						{autoMoved.length === 1 ? 'ist' : 'sind'} in einen anderen Raum umgezogen, weil eine andere
						Gruppe den Raum brauchte.
					{/if}
					{#if unassigned.length}
						<b class="text-destructive">{unassigned.length} ohne Raum:</b>
						{#each unassigned.slice(0, 4) as o, i (o.key)}
							{i ? ', ' : ''}<button type="button" class="underline" onclick={() => openBooking(o)}
								>{o.title} ({formatDateDe(o.date)})</button
							>
						{/each}
					{/if}
				</p>
			</div>
		{/if}

		{#if loadError}
			<ErrorState message={loadError} onretry={reload} />
		{:else if loading && !items.length}
			<LoadingState />
		{:else if view === 'week'}
			<!-- Desktop/Tablet: Räume × Tage -->
			<div class="hidden overflow-x-auto rounded-lg border sm:block">
				<div class="grid min-w-[880px] grid-cols-[170px_repeat(7,minmax(0,1fr))]">
					<div class="border-b bg-sidebar px-2 py-2 text-xs font-medium text-muted-foreground">
						Raum
					</div>
					{#each weekDays as d, i (d)}
						<button
							type="button"
							class="border-b border-l bg-sidebar py-1.5 text-center text-xs font-medium text-muted-foreground hover:bg-muted"
							onclick={() => setParams({ view: 'day', date: d })}
						>
							{WEEKDAY_SHORT[i]}
							<b
								class={[
									'mx-auto mt-0.5 grid size-7 place-items-center rounded-full text-[15px] text-foreground',
									d === today && 'bg-primary text-primary-foreground'
								]}>{dayNumber(d)}</b
							>
						</button>
					{/each}
					{#each visibleRooms as room (room.id)}
						<div class="grid content-start gap-0.5 border-b px-2.5 py-2">
							<b class="text-sm font-semibold">{room.name}</b>
							<span class="text-xs text-muted-foreground">
								{room.capacity} Plätze · Heizaufwand {room.heatingLevel}{room.bookable
									? ''
									: ' · nicht buchbar'}
							</span>
							<HeatMeter level={room.heatingLevel} class="mt-1" />
						</div>
						{#each weekDays as d (d)}
							{@const t = targetIn(drag, room.id, d)}
							<div
								role="group"
								aria-label="{room.name}, {dayLabel(d)}"
								class={[
									'relative grid min-h-20 content-start gap-1 border-b border-l p-1',
									d === today && 'bg-primary/[0.03]',
									t?.ok && 'bg-success-muted ring-2 ring-success-border ring-inset',
									t && !t.ok && !t.current && HATCH,
									drag && drag.occ.date !== d && 'opacity-50'
								]}
								ondragover={(e) => over(e, room.id, d)}
								ondrop={(e) => drop(e, room.id, d)}
							>
								{#each cell(room.id, d) as o (o.key)}
									{@render chip(o, true)}
								{/each}
								{#if t && !t.current}<div class="h-8"></div>{/if}
								{@render dropHint(t)}
							</div>
						{/each}
					{/each}
				</div>
			</div>
			<div class="hidden flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground sm:flex">
				{#each meta.groups as g (g.id)}
					<span class="inline-flex items-center gap-1.5">
						<span class="size-2.5 rounded-sm" style:background-color={groupColor(g.color)}></span>
						{g.name}
					</span>
				{/each}
				<span class="inline-flex items-center gap-1.5">
					<span class="size-2.5 rounded-sm bg-destructive"></span>ohne Raum
				</span>
				<span class="text-warning">- - verlegt</span>
				{#if canManage}<span>Termine lassen sich per Drag &amp; Drop in andere Räume ziehen.</span
					>{/if}
			</div>
			<!-- Handy: Liste je Tag -->
			<div class="space-y-4 sm:hidden">
				{#each weekDays as d (d)}
					{@render dayList(d, byDate.get(d) ?? [])}
				{/each}
			</div>
		{:else if view === 'day'}
			<div class="hidden overflow-x-auto rounded-lg border sm:block">
				<div class="flex min-w-full">
					<div class="sticky left-0 z-20 w-14 shrink-0 border-r bg-background">
						<div class="h-14 border-b"></div>
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
						{@const t = targetIn(drag, room.id, date)}
						<div class="min-w-44 flex-1 border-r last:border-r-0">
							<div
								class={[
									'flex h-14 flex-col justify-center gap-0.5 border-b bg-sidebar px-2',
									t?.ok && 'shadow-[inset_0_-3px_0_var(--color-success)]'
								]}
							>
								<span class="truncate text-sm font-semibold" title={room.name}>{room.name}</span>
								<span class="text-xs text-muted-foreground">
									{room.capacity} Plätze · Heizaufwand {room.heatingLevel}
								</span>
							</div>
							<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
							<div
								class={[
									'relative',
									canCreate && room.bookable && !drag && 'cursor-copy',
									!room.bookable && 'bg-muted/50',
									t?.ok && 'bg-success-muted',
									t && !t.ok && !t.current && HATCH
								]}
								style:height="{(hours.end - hours.start) * PX_PER_MIN}px"
								onclick={(e) => room.bookable && gridClick(e, room.id)}
								ondragover={(e) => over(e, room.id, date)}
								ondrop={(e) => drop(e, room.id, date)}
							>
								{#each hours.list as h (h)}
									<div
										class="pointer-events-none absolute inset-x-0 border-t border-dashed border-border/60"
										style:top="{(h * 60 - hours.start) * PX_PER_MIN}px"
									></div>
								{/each}
								{#each cell(room.id, date) as o (o.key)}
									<div
										class="absolute inset-x-1 overflow-hidden rounded-[5px] shadow-sm"
										style:top="{(toMinutes(o.startsAt) - hours.start) * PX_PER_MIN + 2}px"
										style:height="{Math.max(
											24,
											(toMinutes(o.endsAt) - toMinutes(o.startsAt)) * PX_PER_MIN - 4
										)}px"
									>
										{@render chip(o)}
									</div>
								{/each}
								{@render dropHint(t)}
							</div>
						</div>
					{/each}
				</div>
			</div>
			{#if canCreate || canManage}
				<p class="hidden text-xs text-muted-foreground sm:block">
					{canCreate ? 'Klick auf eine freie Stelle bucht diesen Raum zu dieser Uhrzeit.' : ''}
					{canManage ? 'Termine lassen sich per Drag & Drop in andere Räume ziehen.' : ''}
				</p>
			{/if}
			<div class="sm:hidden">{@render dayList(date, byDate.get(date) ?? [])}</div>
		{:else}
			{@const days = [...byDate.keys()]}
			{#if !days.length}
				<EmptyState
					title="Keine eigenen Buchungen"
					description="In den nächsten 90 Tagen hast du nichts gebucht."
				/>
			{:else}
				<div class="space-y-4">
					{#each days as d (d)}
						{@render dayList(d, byDate.get(d) ?? [])}
					{/each}
				</div>
			{/if}
		{/if}
	</div>

	{#if canCreate}
		<Button
			class="fixed right-[max(1rem,env(safe-area-inset-right))] bottom-[max(1rem,env(safe-area-inset-bottom))] z-30 size-12 rounded-full shadow-lg sm:hidden"
			aria-label="Raum buchen"
			onclick={() => newBooking()}
		>
			<Plus class="size-5" />
		</Button>
	{/if}

	<BookingDialog
		bind:open={dialogOpen}
		bookingId={dialogBooking}
		date={dialogDate}
		initial={dialogInitial}
		{meta}
		onsaved={reload}
	/>
	<SwapDialog bind:open={swapOpen} {swapId} onchanged={reload} />

	<Dialog.Root bind:open={placeOpen}>
		<Dialog.Content class="sm:max-w-md">
			<Dialog.Header>
				<Dialog.Title>
					{pending?.occ.mode === 'fixed' ? 'Feste Buchung verschieben?' : 'Serie verschieben'}
				</Dialog.Title>
				<Dialog.Description>
					„{pending?.occ.title}“ von {pending?.occ.roomName ?? 'ohne Raum'} nach {roomName(
						pending?.roomId ?? null
					)} am {pending ? formatDateDe(pending.occ.date) : ''}. Die Gruppe wird benachrichtigt.
				</Dialog.Description>
			</Dialog.Header>
			{#if pending?.occ.recurring}
				<div class="grid gap-2" role="radiogroup" aria-label="Umfang">
					{#each SCOPES as opt (opt.v)}
						<button
							type="button"
							role="radio"
							aria-checked={pendingScope === opt.v}
							class={[
								'rounded-lg border p-3 text-left text-sm',
								pendingScope === opt.v
									? 'border-primary bg-primary/5 ring-1 ring-primary'
									: 'hover:bg-muted'
							]}
							onclick={() => (pendingScope = opt.v)}
						>
							<b class="block">{opt.l}</b><span class="text-muted-foreground">{opt.h}</span>
						</button>
					{/each}
				</div>
			{/if}
			{#if placeError}<p class="text-sm text-destructive" role="alert">{placeError}</p>{/if}
			<Dialog.Footer>
				<Button variant="outline" onclick={() => ((placeOpen = false), (pending = null))}>
					Abbrechen
				</Button>
				<Button disabled={placeBusy} onclick={place}>
					{placeBusy ? 'Verschiebt …' : 'Verschieben'}
				</Button>
			</Dialog.Footer>
		</Dialog.Content>
	</Dialog.Root>
{/if}
