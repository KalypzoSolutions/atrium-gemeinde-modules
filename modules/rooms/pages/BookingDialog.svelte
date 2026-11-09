<script lang="ts">
	// Buchung anlegen, ansehen, ändern: fester Raum oder Anforderungen (Personen, Merkmale), wöchentliche Serie,
	// optional mit einem Termin verknüpft. Live-Vorschau des zugewiesenen Raums über `POST /availability`.
	import { page } from '$app/state';
	import { untrack } from 'svelte';
	import CalendarDays from '@lucide/svelte/icons/calendar-days';
	import Repeat from '@lucide/svelte/icons/repeat';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import { apiFetch, can } from '$lib/sdk/client';
	import { formatDateDe } from '$lib/sdk/dates';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { MultiSelect } from '$lib/components/ui/multi-select';
	import { SelectField } from '$lib/components/ui/select-field';
	import { Textarea } from '$lib/components/ui/textarea';
	import {
		ChoiceChips,
		ConfirmDialog,
		ErrorState,
		FormField,
		LoadingState,
		NumberStepper
	} from '$lib/components/layout';
	import {
		BOOKING_MODE_LABELS,
		PERM_CREATE,
		PERM_FIX,
		type AvailabilityResult,
		type BookingDetail,
		type BookingMode,
		type PlanConflict,
		type RecurrenceRule
	} from '../schemas';
	import { describeRecurrence } from '../recurrence';
	import { WEEKDAY_SHORT, dayLabel, errorInfo, weekdayIndex, type RoomsMeta } from './helpers';

	let {
		open = $bindable(false),
		bookingId = null,
		date = null,
		initial = null,
		meta,
		onsaved
	}: {
		open?: boolean;
		/** Bestehende Buchung (sonst neu) */
		bookingId?: string | null;
		/** Angeklicktes Vorkommen (für „nur diesen Termin absagen“) */
		date?: string | null;
		/** Vorbelegung für neue Buchungen */
		initial?: { startsOn?: string; startsAt?: string; roomId?: string | null } | null;
		meta: RoomsMeta;
		onsaved?: () => void;
	} = $props();

	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const canCreate = $derived(can(permissions, PERM_CREATE));
	const canFix = $derived(can(permissions, PERM_FIX));

	// --- Formularzustand -------------------------------------------------------------------
	let loaded = $state<BookingDetail | null>(null);
	let loading = $state(false);
	let loadError = $state('');

	let title = $state('');
	let description = $state('');
	let mode = $state<BookingMode>('flexible');
	let roomId = $state<string | null>(null);
	let persons = $state(10);
	let featureIds = $state<string[]>([]);
	let startsOn = $state('');
	let startsAt = $state('18:00');
	let endsAt = $state('20:00');
	let repeat = $state(false);
	let interval = $state(1);
	let weekdays = $state<number[]>([]);
	let endType = $state<'never' | 'until' | 'count'>('never');
	let untilDate = $state('');
	let count = $state(10);
	let eventId = $state<string | null>(null);
	let eventTitle = $state<string | null>(null);

	let busy = $state(false);
	let error = $state('');
	let fieldErrors = $state<Record<string, string>>({});
	let conflicts = $state<PlanConflict[]>([]);
	let confirmDelete = $state(false);

	const editable = $derived(!loaded || loaded.canEdit);
	const isNew = $derived(!bookingId);
	const roomName = (id: string | null) =>
		meta.rooms.find((r) => r.id === id)?.name ?? 'Unbekannter Raum';
	const featureName = (id: string) => meta.features.find((f) => f.id === id)?.name ?? id;

	function reset() {
		loaded = null;
		error = '';
		loadError = '';
		fieldErrors = {};
		conflicts = [];
		title = '';
		description = '';
		mode = initial?.roomId && canFix ? 'fixed' : 'flexible';
		roomId = initial?.roomId ?? null;
		persons = 10;
		featureIds = [];
		startsOn = initial?.startsOn ?? meta.today;
		startsAt = initial?.startsAt ?? '18:00';
		endsAt = initial?.startsAt ? addHours(initial.startsAt, 2) : '20:00';
		repeat = false;
		interval = 1;
		weekdays = [];
		endType = 'never';
		untilDate = '';
		count = 10;
		eventId = null;
		eventTitle = null;
		preview = null;
	}

	function addHours(t: string, h: number): string {
		const [hh, mm] = t.split(':').map(Number);
		const v = Math.min(23 * 60 + 45, hh! * 60 + mm! + h * 60);
		return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
	}

	function fill(d: BookingDetail) {
		loaded = d;
		title = d.title;
		description = d.description ?? '';
		mode = d.mode;
		roomId = d.roomId;
		persons = d.persons;
		featureIds = [...d.featureIds];
		startsOn = d.startsOn;
		startsAt = d.startsAt;
		endsAt = d.endsAt;
		repeat = !!d.recurrence;
		interval = d.recurrence?.interval ?? 1;
		weekdays = d.recurrence?.byWeekday ?? [];
		endType = d.recurrence?.end.type ?? 'never';
		untilDate = d.recurrence?.end.type === 'until' ? d.recurrence.end.date : '';
		count = d.recurrence?.end.type === 'count' ? d.recurrence.end.count : 10;
		eventId = d.eventId;
		eventTitle = d.eventTitle;
	}

	async function load(id: string) {
		loading = true;
		loadError = '';
		try {
			fill(await apiFetch<BookingDetail>(`/modules/rooms/bookings/${id}`));
		} catch (e) {
			loadError = errorInfo(e, 'Buchung konnte nicht geladen werden.').message;
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		if (!open) return;
		const id = bookingId;
		untrack(() => {
			reset();
			if (id) void load(id);
		});
	});

	// --- Eingabe → API ---------------------------------------------------------------------
	const recurrence = $derived.by((): RecurrenceRule | null => {
		if (!repeat) return null;
		const end =
			endType === 'until' && untilDate
				? { type: 'until' as const, date: untilDate }
				: endType === 'count'
					? { type: 'count' as const, count: Math.max(1, count) }
					: { type: 'never' as const };
		return {
			freq: 'weekly',
			interval: Math.max(1, interval),
			byWeekday: weekdays.length ? [...weekdays].sort() : undefined,
			end
		};
	});

	const payload = $derived({
		title: title.trim(),
		description: description.trim() || null,
		mode,
		roomId: mode === 'fixed' ? roomId : null,
		persons,
		featureIds: mode === 'flexible' ? featureIds : [],
		startsOn,
		startsAt,
		endsAt,
		recurrence,
		eventId
	});

	function toggleWeekday(d: number) {
		weekdays = weekdays.includes(d) ? weekdays.filter((x) => x !== d) : [...weekdays, d];
	}

	// --- Vorschau --------------------------------------------------------------------------
	let preview = $state<AvailabilityResult | null>(null);
	let previewBusy = $state(false);
	let previewSeq = 0;

	$effect(() => {
		const body = JSON.stringify({ ...payload, title: payload.title || 'Vorschau', bookingId });
		if (!open || !editable || !canCreate || loading || !startsOn || endsAt <= startsAt) return;
		if (mode === 'fixed' && !roomId) return;
		const seq = ++previewSeq;
		const timer = setTimeout(async () => {
			previewBusy = true;
			try {
				const r = await apiFetch<AvailabilityResult>('/modules/rooms/availability', {
					method: 'POST',
					body
				});
				if (seq === previewSeq) preview = r;
			} catch {
				if (seq === previewSeq) preview = null;
			} finally {
				if (seq === previewSeq) previewBusy = false;
			}
		}, 400);
		return () => clearTimeout(timer);
	});

	/** „12× Kapelle, 2× Saal“ */
	const previewSummary = $derived.by(() => {
		if (!preview) return '';
		const counts = new Map<string, number>();
		for (const a of preview.assignments) {
			const k = a.roomName ?? 'ohne Raum';
			counts.set(k, (counts.get(k) ?? 0) + 1);
		}
		if (counts.size === 1 && preview.assignments.length === 1) return [...counts.keys()][0]!;
		return [...counts].map(([k, n]) => `${n}× ${k}`).join(', ');
	});

	// --- Termin verknüpfen -----------------------------------------------------------------
	let eventSearch = $state('');
	let eventHits = $state<{ id: string; title: string; startsOn: string }[]>([]);
	$effect(() => {
		const q = eventSearch.trim();
		if (!open || !meta.eventsAvailable || q.length < 2) {
			eventHits = [];
			return;
		}
		const timer = setTimeout(async () => {
			try {
				eventHits = await apiFetch(`/modules/rooms/events/search?q=${encodeURIComponent(q)}`);
			} catch {
				eventHits = [];
			}
		}, 300);
		return () => clearTimeout(timer);
	});

	// --- Speichern, Löschen, Absagen -------------------------------------------------------
	async function save(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = '';
		fieldErrors = {};
		conflicts = [];
		try {
			const saved = await apiFetch<BookingDetail>(
				isNew ? '/modules/rooms/bookings' : `/modules/rooms/bookings/${bookingId}`,
				{ method: isNew ? 'POST' : 'PUT', body: JSON.stringify(payload) }
			);
			fill(saved);
			onsaved?.();
			open = false;
		} catch (err) {
			const info = errorInfo(err, 'Speichern fehlgeschlagen.');
			error = info.message;
			fieldErrors = info.fields;
			conflicts = info.conflicts;
		} finally {
			busy = false;
		}
	}

	async function remove() {
		if (!bookingId) return;
		busy = true;
		try {
			await apiFetch(`/modules/rooms/bookings/${bookingId}`, { method: 'DELETE' });
			onsaved?.();
			open = false;
		} catch (err) {
			error = errorInfo(err, 'Löschen fehlgeschlagen.').message;
		} finally {
			busy = false;
		}
	}

	async function setOccurrence(d: string, cancel: boolean) {
		if (!bookingId) return;
		busy = true;
		error = '';
		conflicts = [];
		try {
			const r = await apiFetch<BookingDetail>(
				`/modules/rooms/bookings/${bookingId}/occurrences/${d}`,
				{
					method: cancel ? 'PUT' : 'DELETE'
				}
			);
			fill(r);
			onsaved?.();
		} catch (err) {
			const info = errorInfo(err, 'Änderung fehlgeschlagen.');
			error = info.message;
			conflicts = info.conflicts;
		} finally {
			busy = false;
		}
	}

	const modeOptions = $derived(
		(canFix || mode === 'fixed' ? (['flexible', 'fixed'] as const) : (['flexible'] as const)).map(
			(m) => ({ value: m, label: BOOKING_MODE_LABELS[m] })
		)
	);
	const roomOptions = $derived(
		meta.rooms
			.filter((r) => r.bookable || r.id === roomId)
			.map((r) => ({ value: r.id, label: `${r.name} (${r.capacity} Plätze)` }))
	);
	const featureOptions = $derived(meta.features.map((f) => ({ value: f.id, label: f.name })));
	const endOptions = [
		{ value: 'never', label: 'Ohne Ende' },
		{ value: 'until', label: 'Bis Datum' },
		{ value: 'count', label: 'Anzahl Termine' }
	];
	const startWeekday = $derived(startsOn ? weekdayIndex(startsOn) + 1 : 1);
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="flex max-h-[100dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
		<Dialog.Header class="border-b p-4 pr-12">
			<Dialog.Title>
				{isNew ? 'Raum buchen' : editable ? 'Buchung bearbeiten' : 'Buchung'}
			</Dialog.Title>
			<Dialog.Description>
				{#if isNew}
					Gib einen Raum oder deine Anforderungen an – das System wählt den kleinsten passenden
					Raum.
				{:else if loaded?.managedByEvent}
					Diese Buchung gehört zu einem Termin und wird im Modul „Termine“ bearbeitet.
				{:else if loaded}
					Gebucht von {loaded.ownerName ?? 'Unbekannt'}
				{/if}
			</Dialog.Description>
		</Dialog.Header>

		{#if loading}
			<div class="p-4"><LoadingState /></div>
		{:else if loadError}
			<div class="p-4">
				<ErrorState
					message={loadError}
					onretry={() => {
						if (bookingId) void load(bookingId);
					}}
				/>
			</div>
		{:else}
			<form id="booking-form" class="min-h-0 flex-1 space-y-5 overflow-y-auto p-4" onsubmit={save}>
				<fieldset disabled={!editable || busy} class="min-w-0 space-y-4">
					<FormField label="Titel *" id="rb-title" error={fieldErrors.title}>
						<Input id="rb-title" bind:value={title} required maxlength={200} />
					</FormField>
					<FormField label="Beschreibung" id="rb-desc" error={fieldErrors.description}>
						<Textarea id="rb-desc" bind:value={description} rows={2} maxlength={4000} />
					</FormField>

					<div class="grid gap-4 sm:grid-cols-3">
						<FormField label="Datum *" id="rb-date" error={fieldErrors.startsOn}>
							<Input
								id="rb-date"
								type="date"
								bind:value={startsOn}
								min={isNew ? meta.today : undefined}
								max={meta.horizonEnd}
								required
							/>
						</FormField>
						<FormField label="Beginn *" id="rb-start" error={fieldErrors.startsAt}>
							<Input id="rb-start" type="time" bind:value={startsAt} required step={300} />
						</FormField>
						<FormField label="Ende *" id="rb-end" error={fieldErrors.endsAt}>
							<Input id="rb-end" type="time" bind:value={endsAt} required step={300} />
						</FormField>
					</div>

					<ChoiceChips
						legend="Wie soll gebucht werden?"
						options={modeOptions}
						value={mode}
						onchange={(v) => (mode = v)}
					/>

					<div class="grid gap-4 sm:grid-cols-2">
						{#if mode === 'fixed'}
							<FormField label="Raum *" id="rb-room" error={fieldErrors.roomId}>
								<SelectField
									id="rb-room"
									label="Raum"
									options={roomOptions}
									value={roomId}
									onchange={(v) => (roomId = v)}
									placeholder="Raum wählen"
								/>
							</FormField>
						{/if}
						<FormField label="Personen *" id="rb-persons" error={fieldErrors.persons}>
							<NumberStepper
								id="rb-persons"
								label="Personen"
								bind:value={persons}
								min={1}
								max={5000}
								unit="Pers."
							/>
						</FormField>
						{#if mode === 'flexible'}
							<FormField
								label="Benötigt"
								id="rb-features"
								error={fieldErrors.featureIds}
								hint="z. B. Klavier, Beamer, ebenerdig"
							>
								<MultiSelect
									id="rb-features"
									label="Benötigte Merkmale"
									options={featureOptions}
									value={featureIds}
									onchange={(v) => (featureIds = v)}
									placeholder="Keine besonderen Anforderungen"
									emptyText="Keine Merkmale angelegt"
								/>
							</FormField>
						{/if}
					</div>

					<div class="space-y-3 rounded-md border p-3">
						<div class="flex items-center gap-2">
							<Checkbox id="rb-repeat" bind:checked={repeat} />
							<Label for="rb-repeat" class="flex items-center gap-1.5">
								<Repeat class="size-4" aria-hidden="true" /> Wöchentlich wiederholen (Dauertermin)
							</Label>
						</div>
						{#if repeat}
							<div class="space-y-3">
								<div
									class="flex flex-wrap items-center gap-1.5"
									role="group"
									aria-label="Wochentage"
								>
									{#each WEEKDAY_SHORT as label, i (label)}
										{@const d = i + 1}
										{@const active = weekdays.length ? weekdays.includes(d) : d === startWeekday}
										<Button
											type="button"
											size="sm"
											variant={active ? 'default' : 'outline'}
											aria-pressed={active}
											onclick={() => toggleWeekday(d)}
										>
											{label}
										</Button>
									{/each}
								</div>
								<div class="grid gap-4 sm:grid-cols-3">
									<FormField label="Alle … Wochen" id="rb-interval">
										<NumberStepper
											id="rb-interval"
											label="Intervall in Wochen"
											bind:value={interval}
											min={1}
											max={52}
										/>
									</FormField>
									<FormField label="Ende" id="rb-endtype">
										<SelectField
											id="rb-endtype"
											label="Serienende"
											options={endOptions}
											value={endType}
											onchange={(v) => (endType = (v ?? 'never') as typeof endType)}
										/>
									</FormField>
									{#if endType === 'until'}
										<FormField label="Bis" id="rb-until">
											<Input id="rb-until" type="date" bind:value={untilDate} min={startsOn} />
										</FormField>
									{:else if endType === 'count'}
										<FormField label="Anzahl" id="rb-count">
											<NumberStepper
												id="rb-count"
												label="Anzahl Termine"
												bind:value={count}
												min={1}
												max={500}
											/>
										</FormField>
									{/if}
								</div>
								{#if recurrence && startsOn}
									<p class="text-xs text-muted-foreground">
										{describeRecurrence(recurrence, startsOn)}
									</p>
								{/if}
							</div>
						{/if}
					</div>

					{#if meta.eventsAvailable && !loaded?.managedByEvent}
						<div class="space-y-2">
							<span class="text-sm font-medium">Verknüpfter Termin</span>
							{#if eventId}
								<div class="flex items-center gap-2">
									<Badge variant="secondary" class="gap-1">
										<CalendarDays class="size-3.5" aria-hidden="true" />
										{eventTitle ?? 'Termin'}
									</Badge>
									{#if editable}
										<Button
											type="button"
											size="sm"
											variant="ghost"
											onclick={() => ((eventId = null), (eventTitle = null))}
										>
											Lösen
										</Button>
									{/if}
								</div>
							{:else if editable}
								<Input
									bind:value={eventSearch}
									placeholder="Termin suchen (optional)"
									aria-label="Termin suchen"
								/>
								{#if eventHits.length}
									<ul class="divide-y rounded-md border text-sm">
										{#each eventHits as hit (hit.id)}
											<li>
												<button
													type="button"
													class="w-full px-3 py-2 text-left hover:bg-muted"
													onclick={() => {
														eventId = hit.id;
														eventTitle = hit.title;
														eventSearch = '';
													}}
												>
													{hit.title}
													<span class="text-muted-foreground">· {formatDateDe(hit.startsOn)}</span>
												</button>
											</li>
										{/each}
									</ul>
								{/if}
							{/if}
						</div>
					{/if}
				</fieldset>

				{#if editable && preview}
					<div
						class={[
							'rounded-md border p-3 text-sm',
							preview.ok
								? 'border-primary/30 bg-primary/5'
								: 'border-destructive/40 bg-destructive/5'
						]}
						aria-live="polite"
					>
						{#if preview.ok}
							<p>
								<span class="font-medium">Zugewiesen:</span>
								{previewSummary || '–'}
								{#if previewBusy}<span class="text-muted-foreground"> · prüft …</span>{/if}
							</p>
							{#if preview.moves.length}
								<p class="mt-1 text-muted-foreground">
									Dafür werden {preview.moves.length} andere Termine in einen anderen Raum verlegt (die
									Betroffenen werden benachrichtigt).
								</p>
							{/if}
							{#if preview.beyondHorizon}
								<p class="mt-1 text-muted-foreground">
									{preview.beyondHorizon} spätere Termine werden automatisch nachgeplant.
								</p>
							{/if}
						{:else}
							<p class="flex items-center gap-1.5 font-medium text-destructive">
								<TriangleAlert class="size-4" aria-hidden="true" /> Kein passender Raum frei
							</p>
							<ul class="mt-1 list-disc pl-5">
								{#each preview.conflicts.slice(0, 5) as c (c.date)}
									<li>{dayLabel(c.date)}: {c.reason}</li>
								{/each}
							</ul>
						{/if}
					</div>
				{/if}

				{#if error}
					<div
						class="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
						role="alert"
					>
						<p class="font-medium text-destructive">{error}</p>
						{#if conflicts.length > 1}
							<ul class="mt-1 list-disc pl-5">
								{#each conflicts.slice(0, 8) as c (c.date)}
									<li>{dayLabel(c.date)}: {c.reason}</li>
								{/each}
							</ul>
						{/if}
					</div>
				{/if}

				{#if loaded && !editable}
					<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
						<dt class="text-muted-foreground">Art</dt>
						<dd>
							{BOOKING_MODE_LABELS[loaded.mode]}{loaded.mode === 'fixed'
								? `: ${roomName(loaded.roomId)}`
								: ''}
						</dd>
						{#if loaded.featureIds.length}
							<dt class="text-muted-foreground">Benötigt</dt>
							<dd>{loaded.featureIds.map(featureName).join(', ')}</dd>
						{/if}
					</dl>
				{/if}

				{#if loaded?.upcoming.length}
					<div class="space-y-2">
						<h3 class="text-sm font-medium">Nächste Termine</h3>
						<ul class="divide-y rounded-md border text-sm">
							{#each loaded.upcoming as o (o.date)}
								<li class="flex items-center gap-2 px-3 py-2" class:bg-muted={o.date === date}>
									<span
										class={['min-w-0 flex-1', o.cancelled && 'text-muted-foreground line-through']}
									>
										{dayLabel(o.date)}
									</span>
									<span class="truncate text-muted-foreground">
										{o.cancelled
											? 'abgesagt'
											: (o.roomName ?? (o.date > meta.horizonEnd ? 'wird geplant' : 'ohne Raum'))}
									</span>
									{#if loaded.canEdit && loaded.recurrence}
										<Button
											type="button"
											size="sm"
											variant="ghost"
											disabled={busy}
											onclick={() => setOccurrence(o.date, !o.cancelled)}
										>
											{o.cancelled ? 'Wiederherstellen' : 'Absagen'}
										</Button>
									{/if}
								</li>
							{/each}
						</ul>
					</div>
				{/if}
			</form>
		{/if}

		<Dialog.Footer class="mx-0 mb-0 flex-wrap gap-2 border-t p-4">
			{#if loaded?.canEdit}
				<Button
					type="button"
					variant="outline"
					class="text-destructive sm:mr-auto"
					disabled={busy}
					onclick={() => (confirmDelete = true)}
				>
					{loaded.recurrence ? 'Serie löschen' : 'Löschen'}
				</Button>
			{/if}
			<Button type="button" variant="outline" onclick={() => (open = false)} disabled={busy}>
				{editable ? 'Abbrechen' : 'Schließen'}
			</Button>
			{#if editable && canCreate}
				<Button
					type="submit"
					form="booking-form"
					disabled={busy || loading || (preview !== null && !preview.ok)}
				>
					{busy ? 'Speichert …' : isNew ? 'Buchen' : 'Speichern'}
				</Button>
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<ConfirmDialog
	bind:open={confirmDelete}
	title={loaded?.recurrence ? 'Ganze Serie löschen?' : 'Buchung löschen?'}
	description="Der Raum wird wieder frei; andere Buchungen können dann in kleinere Räume umziehen."
	confirmLabel="Löschen"
	destructive
	onconfirm={remove}
/>
