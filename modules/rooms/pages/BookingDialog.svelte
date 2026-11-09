<script lang="ts">
	// Raum buchen in drei Schritten (Was · Wann · Raum). Oben fasst ein Satz die Buchung zusammen. Im dritten Schritt
	// wird die Stufe gewählt (Nach Anforderungen · Raum wie dieser · Nur dieser) und Raumvorschläge mit Begründung
	// angezeigt (`POST /availability`). Bestehende Buchungen: alle Schritte frei wählbar, dazu nächste Termine,
	// Verlegungen mit Widerspruch und für die Raumverwaltung „Verschieben nach …“.
	import { page } from '$app/state';
	import { untrack } from 'svelte';
	import CalendarDays from '@lucide/svelte/icons/calendar-days';
	import Check from '@lucide/svelte/icons/check';
	import Leaf from '@lucide/svelte/icons/leaf';
	import MoveRight from '@lucide/svelte/icons/move-right';
	import Repeat from '@lucide/svelte/icons/repeat';
	import ArrowLeftRight from '@lucide/svelte/icons/arrow-left-right';
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
		ConfirmDialog,
		ErrorState,
		FormField,
		LoadingState,
		NumberStepper,
		toastWithUndo
	} from '$lib/components/layout';
	import {
		BOOKING_MODE_HINTS,
		BOOKING_MODE_LABELS,
		PERM_CREATE,
		PERM_FIX,
		PERM_MANAGE,
		needsRoom,
		type AvailabilityResult,
		type BookingDetail,
		type BookingMode,
		type DropTarget,
		type PlanConflict,
		type RecurrenceRule,
		type RoomCandidate,
		type SwapOption
	} from '../schemas';
	import { describeRecurrence } from '../recurrence';
	import HeatMeter from './HeatMeter.svelte';
	import {
		WEEKDAY_SHORT,
		dayLabel,
		errorInfo,
		weekdayIndex,
		weekdayLong,
		type RoomsMeta
	} from './helpers';

	let {
		open = $bindable(false),
		bookingId = null,
		date = null,
		initial = null,
		meta,
		onsaved
	}: {
		open?: boolean;
		bookingId?: string | null;
		date?: string | null;
		initial?: { startsOn?: string; startsAt?: string; roomId?: string | null } | null;
		meta: RoomsMeta;
		onsaved?: () => void;
	} = $props();

	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const canCreate = $derived(can(permissions, PERM_CREATE));
	const canFix = $derived(can(permissions, PERM_FIX));
	const canManage = $derived(can(permissions, PERM_MANAGE));

	// --- Zustand ---------------------------------------------------------------------------
	type Step = 0 | 1 | 2;
	let step = $state<Step>(0);
	let loaded = $state<BookingDetail | null>(null);
	let loading = $state(false);
	let loadError = $state('');

	let title = $state('');
	let description = $state('');
	let groupId = $state<string | null>(null);
	let mode = $state<BookingMode>('similar');
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
	let swapOptions = $state<SwapOption[]>([]);
	let confirmDelete = $state(false);
	let swapSent = $state('');

	const editable = $derived(!loaded || loaded.canEdit);
	const isNew = $derived(!bookingId);
	const roomName = (id: string | null) => meta.rooms.find((r) => r.id === id)?.name ?? 'Raum';
	const featureName = (id: string) => meta.features.find((f) => f.id === id)?.name ?? id;
	const group = $derived(meta.groups.find((g) => g.id === groupId) ?? null);

	function addHours(t: string, h: number): string {
		const [hh, mm] = t.split(':').map(Number);
		const v = Math.min(23 * 60 + 45, hh! * 60 + mm! + h * 60);
		return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
	}

	function reset() {
		step = 0;
		loaded = null;
		error = '';
		loadError = '';
		fieldErrors = {};
		conflicts = [];
		swapOptions = [];
		swapSent = '';
		title = '';
		description = '';
		groupId = null;
		roomId = initial?.roomId ?? null;
		mode = initial?.roomId ? 'similar' : 'similar';
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
		targets = [];
		objecting = null;
	}

	function fill(d: BookingDetail) {
		loaded = d;
		title = d.title;
		description = d.description ?? '';
		groupId = d.groupId;
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
			step = 2;
			if (canManage && date) void loadTargets(id, date);
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
		roomId: needsRoom(mode) ? roomId : null,
		persons,
		featureIds,
		startsOn,
		startsAt,
		endsAt,
		recurrence,
		eventId,
		groupId
	});

	function toggleWeekday(d: number) {
		weekdays = weekdays.includes(d) ? weekdays.filter((x) => x !== d) : [...weekdays, d];
	}

	/** „Kirchenchor probt jeden Mittwoch von 19:30 bis 21:30 mit 35 Personen und braucht ein Klavier.“ */
	const sentence = $derived.by(() => {
		const who = group?.name ?? (title.trim() || 'Eure Gruppe');
		const when = repeat
			? recurrence
				? describeRecurrence(recurrence, startsOn || meta.today).replace(/^Jede Woche/, 'jeden')
				: ''
			: startsOn
				? `am ${weekdayLong(startsOn)}, ${formatDateDe(startsOn)}`
				: '';
		const needs = featureIds.length ? ` und braucht ${featureIds.map(featureName).join(', ')}` : '';
		return { who, what: group ? title.trim() : '', when, time: `${startsAt} bis ${endsAt}`, needs };
	});

	// --- Vorschau --------------------------------------------------------------------------
	let preview = $state<AvailabilityResult | null>(null);
	let previewBusy = $state(false);
	let previewSeq = 0;
	/** Wunschraum automatisch gesetzt (nicht vom Menschen gewählt) */
	let autoRoom = $state(true);

	$effect(() => {
		const wantsRoom = needsRoom(mode);
		const body = {
			...payload,
			title: payload.title || 'Vorschau',
			mode: wantsRoom && !roomId ? 'flexible' : mode,
			roomId: wantsRoom && roomId ? roomId : null,
			bookingId
		};
		if (!open || !editable || !canCreate || loading || !startsOn || endsAt <= startsAt) return;
		if (mode === 'fixed' && !canFix && loaded?.mode !== 'fixed') return;
		const seq = ++previewSeq;
		const timer = setTimeout(async () => {
			previewBusy = true;
			try {
				const r = await apiFetch<AvailabilityResult>('/modules/rooms/availability', {
					method: 'POST',
					body: JSON.stringify(body)
				});
				if (seq !== previewSeq) return;
				preview = r;
				// „Raum wie dieser“ ohne Auswahl: den empfohlenen Raum vorschlagen
				const best = r.candidates.find((c) => c.status === 'best');
				if (wantsRoom && !roomId && best) {
					roomId = best.roomId;
					autoRoom = true;
				}
			} catch {
				if (seq === previewSeq) preview = null;
			} finally {
				if (seq === previewSeq) previewBusy = false;
			}
		}, 350);
		return () => clearTimeout(timer);
	});

	function pickRoom(c: RoomCandidate) {
		if (c.status === 'unsuitable' || !editable) return;
		if (mode === 'flexible') mode = 'similar';
		roomId = c.roomId;
		autoRoom = false;
	}

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

	// --- Schritte --------------------------------------------------------------------------
	const stepValid = $derived([
		title.trim().length > 0 && persons >= 1,
		!!startsOn && endsAt > startsAt,
		!needsRoom(mode) || !!roomId
	]);
	const STEPS = ['Was', 'Wann', 'Raum'] as const;

	// --- Speichern, Löschen, Absagen -------------------------------------------------------
	async function save(e?: SubmitEvent) {
		e?.preventDefault();
		if (!isNew || step === 2) {
			busy = true;
			error = '';
			fieldErrors = {};
			conflicts = [];
			swapOptions = [];
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
				swapOptions = info.swapOptions;
				if (info.fields.title || info.fields.persons || info.fields.groupId) step = 0;
				else if (info.fields.startsOn || info.fields.endsAt || info.fields.startsAt) step = 1;
			} finally {
				busy = false;
			}
			return;
		}
		if (stepValid[step]) step = (step + 1) as Step;
	}

	async function requestSwap(o: SwapOption) {
		busy = true;
		error = '';
		try {
			await apiFetch('/modules/rooms/swaps', {
				method: 'POST',
				body: JSON.stringify({
					targetBookingId: o.targetBookingId,
					date: o.date,
					roomId: o.roomId,
					message: null,
					booking: { ...payload, mode: 'flexible', roomId: null }
				})
			});
			swapSent = `Anfrage an „${o.targetTitle}“ gesendet. Du bekommst Bescheid, sobald sie antworten.`;
			swapOptions = [];
		} catch (err) {
			error = errorInfo(err, 'Anfrage fehlgeschlagen.').message;
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
				{ method: cancel ? 'PUT' : 'DELETE' }
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

	// --- Widerspruch -----------------------------------------------------------------------
	let objecting = $state<string | null>(null);
	let objectionNote = $state('');
	async function object(moveId: string) {
		busy = true;
		try {
			await apiFetch(`/modules/rooms/moves/${moveId}/object`, {
				method: 'POST',
				body: JSON.stringify({ note: objectionNote.trim() || null })
			});
			objecting = null;
			objectionNote = '';
			if (bookingId) await load(bookingId);
		} catch (err) {
			error = errorInfo(err, 'Widerspruch fehlgeschlagen.').message;
		} finally {
			busy = false;
		}
	}

	// --- Verschieben nach … (Verwaltung, Tastatur-Alternative zu Drag & Drop) -----------------
	let targets = $state<DropTarget[]>([]);
	async function loadTargets(id: string, d: string) {
		try {
			targets = await apiFetch<DropTarget[]>(
				`/modules/rooms/bookings/${id}/occurrences/${d}/targets`
			);
		} catch {
			targets = [];
		}
	}
	const targetOptions = $derived(
		targets
			.filter((t) => t.ok)
			.map((t) => ({ value: t.roomId, label: `${roomName(t.roomId)} · ${t.label}` }))
	);
	async function moveTo(target: string | null) {
		if (!target || !bookingId || !date || !loaded) return;
		const from = loaded.upcoming.find((u) => u.date === date)?.roomId ?? null;
		busy = true;
		try {
			await apiFetch(`/modules/rooms/bookings/${bookingId}/occurrences/${date}/room`, {
				method: 'PUT',
				body: JSON.stringify({ roomId: target, scope: 'one', confirmFixed: true })
			});
			onsaved?.();
			toastWithUndo({
				message: `„${loaded.title}“ → ${roomName(target)} verschoben. Die Gruppe wird benachrichtigt.`,
				undo: async () => {
					if (from) {
						await apiFetch(`/modules/rooms/bookings/${bookingId}/occurrences/${date}/room`, {
							method: 'PUT',
							body: JSON.stringify({ roomId: from, scope: 'one', confirmFixed: true })
						});
					}
				},
				onundone: () => onsaved?.()
			});
			open = false;
		} catch (err) {
			error = errorInfo(err, 'Verschieben fehlgeschlagen.').message;
		} finally {
			busy = false;
		}
	}

	// --- Auswahllisten ---------------------------------------------------------------------
	const modes = $derived(
		(['flexible', 'similar', 'fixed'] as const).filter(
			(m) => m !== 'fixed' || canFix || loaded?.mode === 'fixed'
		)
	);
	const groupOptions = $derived(meta.groups.map((g) => ({ value: g.id, label: g.name })));
	const featureOptions = $derived(meta.features.map((f) => ({ value: f.id, label: f.name })));
	const endOptions = [
		{ value: 'never', label: 'Ohne Ende' },
		{ value: 'until', label: 'Bis Datum' },
		{ value: 'count', label: 'Anzahl Termine' }
	];
	const startWeekday = $derived(startsOn ? weekdayIndex(startsOn) + 1 : 1);
	const candidates = $derived(
		(preview?.candidates ?? []).map((c) =>
			needsRoom(mode) && roomId
				? { ...c, chosen: c.roomId === roomId }
				: { ...c, chosen: c.status === 'best' }
		)
	);
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="flex max-h-[100dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
		<Dialog.Header class="border-b p-4 pr-12">
			<Dialog.Title>
				{isNew ? 'Raum buchen' : editable ? 'Buchung bearbeiten' : 'Buchung'}
			</Dialog.Title>
			<Dialog.Description>
				{#if isNew}
					Das System schlägt den passenden Raum mit dem geringsten Heizaufwand vor.
				{:else if loaded?.managedByEvent}
					Gehört zu einem Termin und wird im Modul „Termine“ bearbeitet.
				{:else if loaded}
					Gebucht von {loaded.ownerName ?? 'Unbekannt'}{loaded.groupName
						? ` · ${loaded.groupName}`
						: ''}
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
			<form id="booking-form" class="min-h-0 flex-1 space-y-4 overflow-y-auto p-4" onsubmit={save}>
				{#if editable}
					<ol class="flex items-center gap-2" aria-label="Schritte">
						{#each STEPS as label, i (label)}
							{@const done = i < step || (!isNew && i !== step)}
							<li class="flex flex-1 items-center gap-2 last:flex-none">
								<button
									type="button"
									class={[
										'flex items-center gap-1.5 text-sm',
										i === step ? 'font-semibold' : 'text-muted-foreground'
									]}
									aria-current={i === step ? 'step' : undefined}
									disabled={isNew && i > step && !stepValid.slice(0, i).every(Boolean)}
									onclick={() => (step = i as Step)}
								>
									<span
										class={[
											'grid size-6 place-items-center rounded-full border text-xs font-semibold',
											i === step && 'border-2 border-primary text-primary',
											done && i !== step && 'border-primary bg-primary text-primary-foreground'
										]}
									>
										{#if done && i !== step}<Check class="size-3.5" />{:else}{i + 1}{/if}
									</span>
									{label}
								</button>
								{#if i < STEPS.length - 1}<span class="h-px flex-1 bg-border"></span>{/if}
							</li>
						{/each}
					</ol>
				{/if}

				<p class="rounded-md bg-muted px-3 py-2.5 text-[15px] leading-relaxed">
					<span class="rounded border bg-background px-1.5 font-semibold">{sentence.who}</span>
					{#if sentence.what}<span class="text-muted-foreground"> · {sentence.what}</span>{/if}
					{#if sentence.when}
						<span class="rounded border bg-background px-1.5 font-semibold">{sentence.when}</span>
					{/if}
					von <span class="rounded border bg-background px-1.5 font-semibold">{sentence.time}</span>
					mit
					<span class="rounded border bg-background px-1.5 font-semibold">{persons} Personen</span
					>{#if sentence.needs}{sentence.needs}{/if}.
				</p>

				<fieldset disabled={!editable || busy} class="min-w-0 space-y-4">
					{#if step === 0}
						<FormField label="Titel *" id="rb-title" error={fieldErrors.title}>
							<Input
								id="rb-title"
								bind:value={title}
								required
								maxlength={200}
								placeholder="z. B. Chorprobe"
							/>
						</FormField>
						<div class="grid gap-4 sm:grid-cols-2">
							<FormField label="Gruppe" id="rb-group" error={fieldErrors.groupId}>
								<SelectField
									id="rb-group"
									label="Gruppe"
									options={groupOptions}
									value={groupId}
									onchange={(v) => (groupId = v)}
									emptyLabel="Keine Gruppe"
									placeholder="Keine Gruppe"
								/>
							</FormField>
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
						</div>
						<FormField
							label="Was wird gebraucht?"
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
								placeholder="Nichts Besonderes"
								emptyText="Keine Merkmale angelegt"
							/>
						</FormField>
						<FormField label="Beschreibung" id="rb-desc" error={fieldErrors.description}>
							<Textarea id="rb-desc" bind:value={description} rows={2} maxlength={4000} />
						</FormField>
						{#if meta.eventsAvailable && !loaded?.managedByEvent}
							<div class="space-y-2">
								<span class="text-sm font-medium">Verknüpfter Termin</span>
								{#if eventId}
									<div class="flex items-center gap-2">
										<Badge variant="secondary" class="gap-1">
											<CalendarDays class="size-3.5" aria-hidden="true" />
											{eventTitle ?? 'Termin'}
										</Badge>
										<Button
											type="button"
											size="sm"
											variant="ghost"
											onclick={() => ((eventId = null), (eventTitle = null))}>Lösen</Button
										>
									</div>
								{:else}
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
														<span class="text-muted-foreground">· {formatDateDe(hit.startsOn)}</span
														>
													</button>
												</li>
											{/each}
										</ul>
									{/if}
								{/if}
							</div>
						{/if}
					{:else if step === 1}
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
								</div>
							{/if}
						</div>
					{:else}
						<div class="space-y-2">
							<span class="text-sm font-semibold">Wie wichtig ist euch der Raum?</span>
							<div class="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Stufe">
								{#each modes as m (m)}
									<button
										type="button"
										role="radio"
										aria-checked={mode === m}
										class={[
											'relative grid gap-0.5 rounded-lg border p-2.5 text-left text-sm transition-colors',
											mode === m
												? 'border-primary bg-primary/5 ring-1 ring-primary'
												: 'hover:bg-muted'
										]}
										onclick={() => (mode = m)}
									>
										<span class="font-semibold">{BOOKING_MODE_LABELS[m]}</span>
										<span class="text-muted-foreground">{BOOKING_MODE_HINTS[m]}</span>
										<span
											class={[
												'absolute top-3 right-3 size-3.5 rounded-full border bg-background',
												mode === m && 'border-4 border-primary'
											]}
										></span>
									</button>
								{/each}
							</div>
						</div>

						<div class="space-y-2">
							<span class="text-sm font-semibold">
								{mode === 'flexible' ? 'Raumvorschlag' : mode === 'similar' ? 'Wunschraum' : 'Raum'}
								{#if previewBusy}<span class="font-normal text-muted-foreground">
										· prüft …</span
									>{/if}
							</span>
							{#if fieldErrors.roomId}<p class="text-sm text-destructive">
									{fieldErrors.roomId}
								</p>{/if}
							<ul class="grid gap-2">
								{#each candidates as c (c.roomId)}
									<li>
										<button
											type="button"
											class={[
												'grid w-full grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2.5 text-left',
												c.chosen && 'border-primary ring-1 ring-primary',
												c.status === 'unsuitable' && 'cursor-not-allowed opacity-55',
												c.status !== 'unsuitable' && !c.chosen && 'hover:bg-muted'
											]}
											disabled={c.status === 'unsuitable'}
											aria-pressed={c.chosen}
											onclick={() => pickRoom(c)}
										>
											<span class="flex items-center gap-2 font-semibold">
												{c.name}
												{#if c.status === 'best'}<Badge>Empfohlen</Badge>{/if}
												{#if c.status === 'busy'}<Badge variant="outline">belegt</Badge>{/if}
											</span>
											<span class="w-28"><HeatMeter level={c.heatingLevel} /></span>
											<span class="text-sm text-muted-foreground">
												{c.capacity} Plätze{c.featureIds.length
													? ` · ${c.featureIds.map(featureName).join(', ')}`
													: ''}
											</span>
											<span class="text-right text-xs text-muted-foreground"
												>Stufe {c.heatingLevel}</span
											>
											<span
												class={[
													'col-span-2 flex items-center gap-1.5 text-sm',
													c.status === 'best' ? 'text-success' : 'text-muted-foreground'
												]}
											>
												{#if c.status === 'best'}<Leaf class="size-3.5" aria-hidden="true" />{/if}
												{c.reason}
											</span>
										</button>
									</li>
								{:else}
									<li class="text-sm text-muted-foreground">
										Raumvorschläge erscheinen, sobald Zeit und Bedarf feststehen.
									</li>
								{/each}
							</ul>
							{#if mode === 'similar' && roomId}
								<p class="text-xs text-muted-foreground">
									Ihr bleibt in {roomName(roomId)}, solange niemand anderes diesen Raum braucht.
									Sonst zieht ihr in einen gleichwertigen Raum um und bekommt Bescheid.
									{#if autoRoom}Wunschraum automatisch gewählt – zum Ändern einen anderen Raum
										antippen.{/if}
								</p>
							{/if}
						</div>

						{#if preview}
							{#if preview.ok}
								{#if preview.assignments.length > 1}
									<p class="text-sm">
										<span class="font-medium">Alle Termine:</span>
										{previewSummary}
										{#if preview.beyondHorizon}
											<span class="text-muted-foreground">
												· {preview.beyondHorizon} spätere werden nachgeplant</span
											>
										{/if}
									</p>
								{/if}
								{#if preview.moves.length}
									<div
										class="flex gap-2 rounded-md border border-warning-border bg-warning-muted p-3 text-sm"
									>
										<MoveRight class="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
										<p>
											Dafür {preview.moves.length === 1 ? 'zieht' : 'ziehen'}
											{[...new Set(preview.moves.map((m) => `„${m.title}“`))]
												.slice(0, 3)
												.join(', ')}
											in einen anderen Raum um. Die Gruppen werden benachrichtigt und können widersprechen.
										</p>
									</div>
								{/if}
							{:else}
								<div class="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
									<p class="flex items-center gap-1.5 font-medium text-destructive">
										<TriangleAlert class="size-4" aria-hidden="true" /> Kein passender Raum frei
									</p>
									<ul class="mt-1 list-disc pl-5">
										{#each preview.conflicts.slice(0, 5) as c (c.date)}
											<li>{dayLabel(c.date)}: {c.reason}</li>
										{/each}
									</ul>
								</div>
								{#if preview.swapOptions.length && isNew}
									{@render swaps(preview.swapOptions)}
								{/if}
							{/if}
						{/if}
					{/if}
				</fieldset>

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
					{#if swapOptions.length}{@render swaps(swapOptions)}{/if}
				{/if}
				{#if swapSent}
					<p
						class="rounded-md border border-success-border bg-success-muted p-3 text-sm"
						role="status"
					>
						{swapSent}
					</p>
				{/if}

				{#if loaded && (step === 2 || !editable)}
					{#if loaded.moves.length}
						<div class="space-y-2">
							<h3 class="text-sm font-semibold">Verlegungen</h3>
							<ul class="divide-y rounded-md border text-sm">
								{#each loaded.moves as m (m.id)}
									<li class="space-y-2 px-3 py-2">
										<div class="flex flex-wrap items-center gap-2">
											<span class="min-w-0 flex-1">
												{dayLabel(m.date)}: {m.fromRoomName ?? 'ohne Raum'} →
												<b>{m.toRoomName ?? 'ohne Raum'}</b>
												<span class="block text-xs text-muted-foreground">
													{m.kind === 'manual' ? 'Von der Raumverwaltung' : 'Automatisch'}{m.reason
														? ` · ${m.reason}`
														: ''}
												</span>
											</span>
											{#if m.objectedAt && !m.resolvedAt}
												<Badge variant="outline">Widerspruch eingelegt</Badge>
											{:else if m.canObject}
												<Button
													type="button"
													size="sm"
													variant="outline"
													onclick={() => (objecting = m.id)}
												>
													Widersprechen
												</Button>
											{/if}
										</div>
										{#if objecting === m.id}
											<div class="flex flex-wrap gap-2">
												<Input
													bind:value={objectionNote}
													maxlength={500}
													placeholder="Warum passt der Raum nicht? (optional)"
													aria-label="Begründung"
													class="min-w-48 flex-1"
												/>
												<Button type="button" size="sm" disabled={busy} onclick={() => object(m.id)}
													>Senden</Button
												>
												<Button
													type="button"
													size="sm"
													variant="ghost"
													onclick={() => (objecting = null)}>Abbrechen</Button
												>
											</div>
										{/if}
									</li>
								{/each}
							</ul>
						</div>
					{/if}
					{#if canManage && date && targetOptions.length}
						<FormField label="Termin am {formatDateDe(date)} verschieben nach …" id="rb-moveto">
							<SelectField
								id="rb-moveto"
								label="Verschieben nach"
								options={targetOptions}
								value={null}
								onchange={(v) => void moveTo(v)}
								placeholder="Raum wählen"
							/>
						</FormField>
					{/if}
					{#if loaded.upcoming.length}
						<div class="space-y-2">
							<h3 class="text-sm font-semibold">Nächste Termine</h3>
							<ul class="divide-y rounded-md border text-sm">
								{#each loaded.upcoming as o (o.date)}
									<li class="flex items-center gap-2 px-3 py-2" class:bg-muted={o.date === date}>
										<span
											class={[
												'min-w-0 flex-1',
												o.cancelled && 'text-muted-foreground line-through'
											]}
										>
											{dayLabel(o.date)}
										</span>
										<span class="truncate text-muted-foreground">
											{o.cancelled
												? 'abgesagt'
												: (o.roomName ??
													(o.date > meta.horizonEnd ? 'wird geplant' : 'ohne Raum'))}{o.pinned
												? ' · festgelegt'
												: ''}
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
			{:else if isNew && step > 0}
				<Button
					type="button"
					variant="outline"
					class="sm:mr-auto"
					onclick={() => (step = (step - 1) as Step)}
				>
					Zurück
				</Button>
			{/if}
			<Button type="button" variant="outline" onclick={() => (open = false)} disabled={busy}>
				{editable ? 'Abbrechen' : 'Schließen'}
			</Button>
			{#if editable && canCreate}
				{#if isNew && step < 2}
					<Button type="submit" form="booking-form" disabled={!stepValid[step]}>Weiter</Button>
				{:else}
					<Button
						type="submit"
						form="booking-form"
						disabled={busy ||
							loading ||
							!stepValid.every(Boolean) ||
							(preview !== null && !preview.ok)}
					>
						{busy ? 'Speichert …' : isNew ? 'Buchen' : 'Speichern'}
					</Button>
				{/if}
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

{#snippet swaps(options: SwapOption[])}
	<div class="space-y-2 rounded-md border p-3 text-sm">
		<p class="flex items-center gap-1.5 font-medium">
			<ArrowLeftRight class="size-4" aria-hidden="true" /> Tauschen?
		</p>
		<p class="text-muted-foreground">
			Diese festen Buchungen könnten in einen anderen Raum ausweichen. Du kannst die Gruppe fragen.
		</p>
		<ul class="divide-y rounded-md border">
			{#each options as o (o.targetBookingId + o.roomId)}
				<li class="flex flex-wrap items-center gap-2 px-3 py-2">
					<span class="min-w-0 flex-1">
						<b>{o.roomName}</b> · belegt von „{o.targetTitle}“
						<span class="block text-xs text-muted-foreground"
							>Vorschlag für sie: {o.proposedRoomName}</span
						>
					</span>
					<Button type="button" size="sm" disabled={busy} onclick={() => requestSwap(o)}
						>Anfragen</Button
					>
				</li>
			{/each}
		</ul>
	</div>
{/snippet}

<ConfirmDialog
	bind:open={confirmDelete}
	title={loaded?.recurrence ? 'Ganze Serie löschen?' : 'Buchung löschen?'}
	description="Der Raum wird wieder frei; andere Buchungen können dann in kleinere Räume umziehen."
	confirmLabel="Löschen"
	destructive
	onconfirm={remove}
/>
