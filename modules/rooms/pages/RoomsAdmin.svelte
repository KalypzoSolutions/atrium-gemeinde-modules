<script lang="ts">
	// Raumverwaltung: Räume (Kapazität, Fläche, Heizkosten, Merkmale, Sperrzeiten), Merkmale und Gesamtoptimierung
	// mit Vorschau. Recht `rooms.room.manage`.
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	import Trash from '@lucide/svelte/icons/trash-2';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import { apiFetch } from '$lib/sdk/client';
	import { formatDateDe } from '$lib/sdk/dates';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { MultiSelect } from '$lib/components/ui/multi-select';
	import { Switch } from '$lib/components/ui/switch';
	import * as Table from '$lib/components/ui/table';
	import * as Tabs from '$lib/components/ui/tabs';
	import { Textarea } from '$lib/components/ui/textarea';
	import {
		ConfirmDialog,
		EmptyState,
		ErrorState,
		FormField,
		LoadingState,
		MoneyInput,
		NumberStepper,
		PageHeader
	} from '$lib/components/layout';
	import type { Feature, PlanPreview, Room, RoomBlock } from '../schemas';
	import { dayLabel, errorInfo, euro, type RoomsMeta } from './helpers';

	let meta = $state<RoomsMeta | null>(null);
	let loadError = $state('');
	let tab = $state('rooms');

	async function load() {
		loadError = '';
		try {
			meta = await apiFetch<RoomsMeta>('/modules/rooms/meta');
		} catch (e) {
			loadError = errorInfo(e, 'Daten konnten nicht geladen werden.').message;
		}
	}
	$effect(() => {
		void load();
	});

	const featureName = (id: string) => meta?.features.find((f) => f.id === id)?.name ?? '?';
	const featureOptions = $derived(
		(meta?.features ?? []).map((f) => ({ value: f.id, label: f.name }))
	);

	// --- Raum-Dialog -----------------------------------------------------------------------
	let roomOpen = $state(false);
	let editing = $state<Room | null>(null);
	let rName = $state('');
	let rBuilding = $state('');
	let rDescription = $state('');
	let rCapacity = $state(20);
	let rArea = $state('');
	let rHeating = $state(0);
	let rBookable = $state(true);
	let rFeatures = $state<string[]>([]);
	let rBusy = $state(false);
	let rError = $state('');
	let rFields = $state<Record<string, string>>({});
	let notice = $state('');

	function openRoom(room: Room | null) {
		editing = room;
		rName = room?.name ?? '';
		rBuilding = room?.building ?? '';
		rDescription = room?.description ?? '';
		rCapacity = room?.capacity ?? 20;
		rArea = room?.areaM2 != null ? String(room.areaM2).replace('.', ',') : '';
		rHeating = room?.heatingCostCentsPerHour ?? 0;
		rBookable = room?.bookable ?? true;
		rFeatures = [...(room?.featureIds ?? [])];
		rError = '';
		rFields = {};
		blocks = [];
		if (room) void loadBlocks(room.id);
		roomOpen = true;
	}

	function changeNotice(r: { moved?: number; unassigned?: number }) {
		const parts = [];
		if (r.moved) parts.push(`${r.moved} Termine wurden verlegt`);
		if (r.unassigned) parts.push(`${r.unassigned} Termine haben keinen Raum mehr`);
		notice = parts.length ? `${parts.join(', ')} – die Betroffenen wurden benachrichtigt.` : '';
	}

	async function saveRoom(e: SubmitEvent) {
		e.preventDefault();
		rBusy = true;
		rError = '';
		rFields = {};
		const area = rArea.trim() ? Number(rArea.replace(',', '.')) : null;
		try {
			await apiFetch<Room>(
				editing ? `/modules/rooms/rooms/${editing.id}` : '/modules/rooms/rooms',
				{
					method: editing ? 'PUT' : 'POST',
					body: JSON.stringify({
						name: rName.trim(),
						building: rBuilding.trim() || null,
						description: rDescription.trim() || null,
						capacity: rCapacity,
						areaM2: area !== null && Number.isFinite(area) ? area : null,
						heatingCostCentsPerHour: rHeating,
						bookable: rBookable,
						featureIds: rFeatures
					})
				}
			);
			roomOpen = false;
			notice = '';
			await load();
		} catch (err) {
			const info = errorInfo(err, 'Speichern fehlgeschlagen.');
			rError = info.message;
			rFields = info.fields;
		} finally {
			rBusy = false;
		}
	}

	let deleteRoom = $state<Room | null>(null);
	let confirmRoom = $state(false);
	async function removeRoom() {
		if (!deleteRoom) return;
		try {
			const r = await apiFetch<{ moved: number; unassigned: number }>(
				`/modules/rooms/rooms/${deleteRoom.id}`,
				{ method: 'DELETE' }
			);
			changeNotice(r);
			await load();
		} catch (err) {
			notice = errorInfo(err, 'Löschen fehlgeschlagen.').message;
		}
	}

	// --- Sperrzeiten -----------------------------------------------------------------------
	let blocks = $state<RoomBlock[]>([]);
	let bFrom = $state('');
	let bTo = $state('');
	let bReason = $state('');
	let bError = $state('');

	async function loadBlocks(roomId: string) {
		try {
			blocks = await apiFetch<RoomBlock[]>(`/modules/rooms/rooms/${roomId}/blocks`);
		} catch {
			blocks = [];
		}
	}

	async function addBlock() {
		if (!editing || !bFrom) return;
		bError = '';
		try {
			const r = await apiFetch<{ moved: number; unassigned: number }>(
				`/modules/rooms/rooms/${editing.id}/blocks`,
				{
					method: 'POST',
					body: JSON.stringify({
						startsOn: bFrom,
						endsOn: bTo || bFrom,
						reason: bReason.trim() || null
					})
				}
			);
			changeNotice(r);
			bFrom = '';
			bTo = '';
			bReason = '';
			await loadBlocks(editing.id);
		} catch (err) {
			bError = errorInfo(err, 'Sperrzeit konnte nicht gespeichert werden.').message;
		}
	}

	async function removeBlock(b: RoomBlock) {
		try {
			const r = await apiFetch<{ moved: number; unassigned: number }>(
				`/modules/rooms/rooms/${b.roomId}/blocks/${b.id}`,
				{ method: 'DELETE' }
			);
			changeNotice(r);
			await loadBlocks(b.roomId);
		} catch (err) {
			bError = errorInfo(err, 'Sperrzeit konnte nicht gelöscht werden.').message;
		}
	}

	// --- Merkmale --------------------------------------------------------------------------
	let fName = $state('');
	let fError = $state('');
	let fEditing = $state<string | null>(null);
	let fEditName = $state('');
	let deleteFeature = $state<Feature | null>(null);
	let confirmFeature = $state(false);

	async function addFeature(e: SubmitEvent) {
		e.preventDefault();
		fError = '';
		try {
			await apiFetch('/modules/rooms/features', {
				method: 'POST',
				body: JSON.stringify({ name: fName.trim(), icon: null })
			});
			fName = '';
			await load();
		} catch (err) {
			fError = errorInfo(err, 'Merkmal konnte nicht angelegt werden.').message;
		}
	}

	async function renameFeature(f: Feature) {
		fError = '';
		try {
			await apiFetch(`/modules/rooms/features/${f.id}`, {
				method: 'PUT',
				body: JSON.stringify({ name: fEditName.trim(), icon: f.icon })
			});
			fEditing = null;
			await load();
		} catch (err) {
			fError = errorInfo(err, 'Umbenennen fehlgeschlagen.').message;
		}
	}

	async function removeFeature() {
		if (!deleteFeature) return;
		try {
			const r = await apiFetch<{ moved: number; unassigned: number }>(
				`/modules/rooms/features/${deleteFeature.id}`,
				{ method: 'DELETE' }
			);
			changeNotice(r);
			await load();
		} catch (err) {
			fError = errorInfo(err, 'Löschen fehlgeschlagen.').message;
		}
	}

	// --- Optimierung -----------------------------------------------------------------------
	let days = $state(60);
	let plan = $state<PlanPreview | null>(null);
	let planBusy = $state(false);
	let planError = $state('');
	let planDone = $state(false);

	async function runPlan(write: boolean) {
		planBusy = true;
		planError = '';
		try {
			plan = await apiFetch<PlanPreview>(`/modules/rooms/plan/${write ? 'run' : 'preview'}`, {
				method: 'POST',
				body: JSON.stringify({ days })
			});
			planDone = write;
		} catch (err) {
			planError = errorInfo(err, 'Planung fehlgeschlagen.').message;
		} finally {
			planBusy = false;
		}
	}
</script>

<PageHeader title="Raumverwaltung" description="Räume, Merkmale, Sperrzeiten und Optimierung">
	{#snippet actions()}
		<Button variant="outline" href="/modules/rooms">Zum Belegungsplan</Button>
	{/snippet}
</PageHeader>

{#if loadError}
	<ErrorState message={loadError} onretry={load} />
{:else if !meta}
	<LoadingState />
{:else}
	{#if notice}
		<p class="mb-4 rounded-md border bg-muted/40 p-3 text-sm" role="status">{notice}</p>
	{/if}
	<Tabs.Root bind:value={tab}>
		<Tabs.List>
			<Tabs.Trigger value="rooms">Räume ({meta.rooms.length})</Tabs.Trigger>
			<Tabs.Trigger value="features">Merkmale ({meta.features.length})</Tabs.Trigger>
			<Tabs.Trigger value="plan">Optimierung</Tabs.Trigger>
		</Tabs.List>

		<Tabs.Content value="rooms" class="space-y-3 pt-4">
			<div class="flex justify-end">
				<Button onclick={() => openRoom(null)}
					><Plus class="size-4" aria-hidden="true" /> Raum anlegen</Button
				>
			</div>
			{#if !meta.rooms.length}
				<EmptyState
					title="Noch keine Räume"
					description="Lege Räume mit Personenzahl, Heizkosten und Merkmalen an (z. B. Kirche, Gemeindesaal, Jugendraum)."
				/>
			{:else}
				<div class="overflow-x-auto rounded-md border">
					<Table.Root>
						<Table.Header>
							<Table.Row>
								<Table.Head>Raum</Table.Head>
								<Table.Head class="text-right">Plätze</Table.Head>
								<Table.Head class="text-right">Fläche</Table.Head>
								<Table.Head class="text-right">Heizkosten/h</Table.Head>
								<Table.Head>Merkmale</Table.Head>
								<Table.Head class="w-24"><span class="sr-only">Aktionen</span></Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each meta.rooms as room (room.id)}
								<Table.Row>
									<Table.Cell>
										<div class="font-medium">{room.name}</div>
										<div class="text-xs text-muted-foreground">
											{[room.building, room.bookable ? null : 'nicht buchbar']
												.filter(Boolean)
												.join(' · ')}
										</div>
									</Table.Cell>
									<Table.Cell class="text-right tabular-nums">{room.capacity}</Table.Cell>
									<Table.Cell class="text-right tabular-nums">
										{room.areaM2 != null ? `${room.areaM2.toLocaleString('de-DE')} m²` : '–'}
									</Table.Cell>
									<Table.Cell class="text-right tabular-nums"
										>{euro(room.heatingCostCentsPerHour)}</Table.Cell
									>
									<Table.Cell>
										<div class="flex flex-wrap gap-1">
											{#each room.featureIds as f (f)}<Badge variant="secondary"
													>{featureName(f)}</Badge
												>{/each}
										</div>
									</Table.Cell>
									<Table.Cell class="text-right">
										<Button
											size="icon"
											variant="ghost"
											aria-label="{room.name} bearbeiten"
											onclick={() => openRoom(room)}
										>
											<Pencil class="size-4" />
										</Button>
										<Button
											size="icon"
											variant="ghost"
											aria-label="{room.name} löschen"
											onclick={() => ((deleteRoom = room), (confirmRoom = true))}
										>
											<Trash class="size-4" />
										</Button>
									</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				</div>
				<p class="text-xs text-muted-foreground">
					Die Heizkosten je Stunde bestimmen, welcher Raum bevorzugt wird. Ohne Angabe gewinnt der
					Raum mit den wenigsten freien Plätzen.
				</p>
			{/if}
		</Tabs.Content>

		<Tabs.Content value="features" class="space-y-3 pt-4">
			<form class="flex flex-wrap items-end gap-2" onsubmit={addFeature}>
				<FormField label="Neues Merkmal" id="feature-name">
					<Input
						id="feature-name"
						bind:value={fName}
						maxlength={60}
						placeholder="z. B. Klavier"
						required
					/>
				</FormField>
				<Button type="submit" disabled={!fName.trim()}>Hinzufügen</Button>
			</form>
			{#if fError}<p class="text-sm text-destructive" role="alert">{fError}</p>{/if}
			{#if meta.features.length}
				<ul class="divide-y rounded-md border">
					{#each meta.features as f (f.id)}
						<li class="flex items-center gap-2 px-3 py-2 text-sm">
							{#if fEditing === f.id}
								<Input bind:value={fEditName} maxlength={60} class="max-w-xs" aria-label="Name" />
								<Button size="sm" onclick={() => renameFeature(f)} disabled={!fEditName.trim()}
									>Speichern</Button
								>
								<Button size="sm" variant="ghost" onclick={() => (fEditing = null)}
									>Abbrechen</Button
								>
							{:else}
								<span class="flex-1 font-medium">{f.name}</span>
								<span class="text-muted-foreground">{f.roomCount} Räume</span>
								<Button
									size="icon"
									variant="ghost"
									aria-label="{f.name} umbenennen"
									onclick={() => ((fEditing = f.id), (fEditName = f.name))}
								>
									<Pencil class="size-4" />
								</Button>
								<Button
									size="icon"
									variant="ghost"
									aria-label="{f.name} löschen"
									onclick={() => ((deleteFeature = f), (confirmFeature = true))}
								>
									<Trash class="size-4" />
								</Button>
							{/if}
						</li>
					{/each}
				</ul>
			{:else}
				<EmptyState
					title="Noch keine Merkmale"
					description="Merkmale beschreiben, was ein Raum bietet – z. B. Klavier, Beamer, ebenerdig, Küche."
				/>
			{/if}
		</Tabs.Content>

		<Tabs.Content value="plan" class="space-y-4 pt-4">
			<p class="max-w-prose text-sm text-muted-foreground">
				Verteilt alle flexiblen Buchungen neu, sodass möglichst kleine bzw. günstig zu heizende
				Räume belegt werden. Feste Buchungen und Termine in den nächsten {meta.lockDays} Tagen bleiben,
				wo sie sind. Neue Buchungen werden ohnehin sofort optimal geplant; das hier lohnt sich nach Absagen
				oder geänderten Räumen.
			</p>
			<div class="flex flex-wrap items-end gap-3">
				<FormField label="Zeitraum ab heute" id="plan-days">
					<NumberStepper
						id="plan-days"
						label="Tage"
						bind:value={days}
						min={1}
						max={366}
						unit="Tage"
					/>
				</FormField>
				<Button variant="outline" disabled={planBusy} onclick={() => runPlan(false)}
					>Vorschau</Button
				>
				{#if plan && !planDone && plan.moves.length}
					<Button disabled={planBusy} onclick={() => runPlan(true)}>
						{plan.moves.length} Änderungen übernehmen
					</Button>
				{/if}
			</div>
			{#if planError}<p class="text-sm text-destructive" role="alert">{planError}</p>{/if}
			{#if plan}
				<div class="space-y-3 rounded-md border p-3 text-sm">
					<p>
						{formatDateDe(plan.from)} – {formatDateDe(plan.to)}: Heizkosten
						<span class="tabular-nums">{euro(plan.costBefore)}</span>
						<ArrowRight class="inline size-3.5" aria-label="nach" />
						<span class="font-medium tabular-nums">{euro(plan.costAfter)}</span>
						{#if plan.costBefore > plan.costAfter}
							<Badge class="ml-1">− {euro(plan.costBefore - plan.costAfter)}</Badge>
						{/if}
					</p>
					{#if planDone}
						<p class="font-medium">Übernommen – die Betroffenen wurden benachrichtigt.</p>
					{/if}
					{#if plan.moves.length}
						<ul class="divide-y rounded-md border">
							{#each plan.moves.slice(0, 100) as m (m.bookingId + m.date)}
								<li class="flex flex-wrap gap-x-3 px-3 py-1.5">
									<span class="w-32 text-muted-foreground">{dayLabel(m.date)}</span>
									<span class="flex-1 font-medium">{m.title}</span>
									<span>{m.fromRoomName ?? 'ohne Raum'} → {m.toRoomName ?? 'ohne Raum'}</span>
								</li>
							{/each}
						</ul>
					{:else}
						<p class="text-muted-foreground">Die Belegung ist bereits optimal.</p>
					{/if}
					{#if plan.unassigned.length}
						<p class="font-medium text-destructive">Ohne Raum:</p>
						<ul class="list-disc pl-5">
							{#each plan.unassigned as u, i (i)}<li>{dayLabel(u.date)}: {u.reason}</li>{/each}
						</ul>
					{/if}
				</div>
			{/if}
		</Tabs.Content>
	</Tabs.Root>
{/if}

<Dialog.Root bind:open={roomOpen}>
	<Dialog.Content class="flex max-h-[100dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
		<Dialog.Header class="border-b p-4 pr-12">
			<Dialog.Title>{editing ? 'Raum bearbeiten' : 'Raum anlegen'}</Dialog.Title>
			<Dialog.Description>Änderungen werden sofort in die Planung übernommen.</Dialog.Description>
		</Dialog.Header>
		<form id="room-form" class="min-h-0 flex-1 space-y-4 overflow-y-auto p-4" onsubmit={saveRoom}>
			<div class="grid gap-4 sm:grid-cols-2">
				<FormField label="Name *" id="room-name" error={rFields.name}>
					<Input id="room-name" bind:value={rName} maxlength={100} required />
				</FormField>
				<FormField label="Gebäude" id="room-building" error={rFields.building}>
					<Input
						id="room-building"
						bind:value={rBuilding}
						maxlength={100}
						placeholder="z. B. Gemeindehaus"
					/>
				</FormField>
				<FormField label="Plätze *" id="room-capacity" error={rFields.capacity}>
					<NumberStepper
						id="room-capacity"
						label="Plätze"
						bind:value={rCapacity}
						min={1}
						max={5000}
					/>
				</FormField>
				<FormField label="Fläche (m²)" id="room-area" error={rFields.areaM2}>
					<Input id="room-area" bind:value={rArea} inputmode="decimal" placeholder="optional" />
				</FormField>
				<FormField
					label="Heizkosten je Stunde"
					id="room-heating"
					error={rFields.heatingCostCentsPerHour}
					hint="Schätzung genügt – dient dem Vergleich der Räume"
				>
					<MoneyInput id="room-heating" label="Heizkosten je Stunde" bind:cents={rHeating} />
				</FormField>
				<div class="flex items-center gap-2 self-end pb-2">
					<Switch id="room-bookable" bind:checked={rBookable} />
					<Label for="room-bookable">buchbar</Label>
				</div>
			</div>
			<FormField label="Merkmale" id="room-features">
				<MultiSelect
					id="room-features"
					label="Merkmale"
					options={featureOptions}
					value={rFeatures}
					onchange={(v) => (rFeatures = v)}
					placeholder="Keine"
					emptyText="Lege Merkmale im Reiter „Merkmale“ an"
				/>
			</FormField>
			<FormField label="Beschreibung" id="room-desc">
				<Textarea id="room-desc" bind:value={rDescription} rows={2} maxlength={2000} />
			</FormField>

			{#if editing}
				<div class="space-y-2 rounded-md border p-3">
					<h3 class="text-sm font-medium">Sperrzeiten</h3>
					{#if blocks.length}
						<ul class="space-y-1 text-sm">
							{#each blocks as b (b.id)}
								<li class="flex items-center gap-2">
									<span class="flex-1">
										{formatDateDe(b.startsOn)}{b.endsOn !== b.startsOn
											? ` – ${formatDateDe(b.endsOn)}`
											: ''}
										{#if b.reason}<span class="text-muted-foreground"> · {b.reason}</span>{/if}
									</span>
									<Button type="button" size="sm" variant="ghost" onclick={() => removeBlock(b)}
										>Aufheben</Button
									>
								</li>
							{/each}
						</ul>
					{:else}
						<p class="text-sm text-muted-foreground">Keine Sperrzeiten.</p>
					{/if}
					<div class="grid gap-2 sm:grid-cols-[1fr_1fr_2fr_auto] sm:items-end">
						<FormField label="Von" id="block-from"
							><Input id="block-from" type="date" bind:value={bFrom} /></FormField
						>
						<FormField label="Bis" id="block-to"
							><Input id="block-to" type="date" bind:value={bTo} min={bFrom} /></FormField
						>
						<FormField label="Grund" id="block-reason">
							<Input
								id="block-reason"
								bind:value={bReason}
								maxlength={200}
								placeholder="z. B. Renovierung"
							/>
						</FormField>
						<Button type="button" variant="outline" disabled={!bFrom} onclick={addBlock}
							>Sperren</Button
						>
					</div>
					{#if bError}<p class="text-sm text-destructive" role="alert">{bError}</p>{/if}
				</div>
			{/if}
			{#if rError}<p class="text-sm text-destructive" role="alert">{rError}</p>{/if}
		</form>
		<Dialog.Footer class="mx-0 mb-0 border-t p-4">
			<Button type="button" variant="outline" onclick={() => (roomOpen = false)}>Abbrechen</Button>
			<Button type="submit" form="room-form" disabled={rBusy}
				>{rBusy ? 'Speichert …' : 'Speichern'}</Button
			>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<ConfirmDialog
	bind:open={confirmRoom}
	title="Raum „{deleteRoom?.name}“ löschen?"
	description="Feste Buchungen dieses Raums werden zu flexiblen Buchungen und neu verteilt. Passt etwas nirgends mehr hin, werden die Betroffenen benachrichtigt."
	confirmLabel="Löschen"
	destructive
	onconfirm={removeRoom}
/>
<ConfirmDialog
	bind:open={confirmFeature}
	title="Merkmal „{deleteFeature?.name}“ löschen?"
	description="Räume und Buchungen verlieren dieses Merkmal; die Planung wird neu berechnet."
	confirmLabel="Löschen"
	destructive
	onconfirm={removeFeature}
/>
