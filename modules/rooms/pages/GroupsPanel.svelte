<script lang="ts">
	// Reiter „Gruppen“ der Raumverwaltung: Name, Farbe (Belegungsplan) und Vorrang (wer seltener umziehen muss).
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	import Trash from '@lucide/svelte/icons/trash-2';
	import { apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import { ColorPicker } from '$lib/components/ui/color-picker';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import { ConfirmDialog, EmptyState, FormField } from '$lib/components/layout';
	import { GROUP_PRIORITIES, GROUP_PRIORITY_LABELS, type Group } from '../schemas';
	import { errorInfo, groupColor } from './helpers';

	let { groups, onchanged }: { groups: Group[]; onchanged: () => void | Promise<void> } = $props();

	let open = $state(false);
	let editing = $state<Group | null>(null);
	let name = $state('');
	let color = $state<string | null>('#2563eb');
	let priority = $state('3');
	let busy = $state(false);
	let error = $state('');
	let confirmOpen = $state(false);
	let deleting = $state<Group | null>(null);

	const priorityOptions = GROUP_PRIORITIES.map((p) => ({
		value: String(p),
		label: `${p} · ${GROUP_PRIORITY_LABELS[p]}`
	}));

	function edit(g: Group | null) {
		editing = g;
		name = g?.name ?? '';
		color = g?.color ?? '#2563eb';
		priority = String(g?.priority ?? 3);
		error = '';
		open = true;
	}

	async function save(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = '';
		try {
			await apiFetch(editing ? `/modules/rooms/groups/${editing.id}` : '/modules/rooms/groups', {
				method: editing ? 'PUT' : 'POST',
				body: JSON.stringify({ name: name.trim(), color, priority: Number(priority) })
			});
			open = false;
			await onchanged();
		} catch (err) {
			error = errorInfo(err, 'Speichern fehlgeschlagen.').message;
		} finally {
			busy = false;
		}
	}

	async function remove() {
		if (!deleting) return;
		try {
			await apiFetch(`/modules/rooms/groups/${deleting.id}`, { method: 'DELETE' });
			await onchanged();
		} catch (err) {
			error = errorInfo(err, 'Löschen fehlgeschlagen.').message;
		}
	}
</script>

<div class="space-y-3">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<p class="max-w-prose text-sm text-muted-foreground">
			Gruppen färben den Belegungsplan. Der Vorrang entscheidet, wer bei Engpässen eher im Raum
			bleibt: Gottesdienste werden zuletzt verlegt, Fremdnutzungen zuerst.
		</p>
		<Button onclick={() => edit(null)}
			><Plus class="size-4" aria-hidden="true" /> Gruppe anlegen</Button
		>
	</div>
	{#if groups.length}
		<ul class="divide-y rounded-md border">
			{#each groups as g (g.id)}
				<li class="flex items-center gap-3 px-3 py-2.5 text-sm">
					<span
						class="size-3.5 shrink-0 rounded-sm"
						style:background-color={groupColor(g.color)}
						aria-hidden="true"
					></span>
					<span class="min-w-0 flex-1">
						<span class="block truncate font-medium">{g.name}</span>
						<span class="block text-xs text-muted-foreground">
							Vorrang {g.priority} · {GROUP_PRIORITY_LABELS[g.priority]}
						</span>
					</span>
					<span class="hidden text-muted-foreground sm:inline"
						>{g.bookingCount} {g.bookingCount === 1 ? 'Buchung' : 'Buchungen'}</span
					>
					<Button
						size="icon"
						variant="ghost"
						aria-label="{g.name} bearbeiten"
						onclick={() => edit(g)}
					>
						<Pencil class="size-4" />
					</Button>
					<Button
						size="icon"
						variant="ghost"
						aria-label="{g.name} löschen"
						onclick={() => ((deleting = g), (confirmOpen = true))}
					>
						<Trash class="size-4" />
					</Button>
				</li>
			{/each}
		</ul>
	{:else}
		<EmptyState
			title="Noch keine Gruppen"
			description="Zum Beispiel Gottesdienst, Kirchenchor, Konfirmanden, Seniorenkreis, Kita."
		/>
	{/if}
	{#if error && !open}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
</div>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>{editing ? 'Gruppe bearbeiten' : 'Gruppe anlegen'}</Dialog.Title>
			<Dialog.Description>Farbe für den Belegungsplan, Vorrang bei Engpässen.</Dialog.Description>
		</Dialog.Header>
		<form id="group-form" class="space-y-4" onsubmit={save}>
			<FormField label="Name *" id="group-name">
				<Input id="group-name" bind:value={name} maxlength={80} required />
			</FormField>
			<FormField label="Farbe" id="group-color">
				<ColorPicker label="Farbe der Gruppe" bind:value={color} />
			</FormField>
			<FormField label="Vorrang" id="group-priority" hint="4 = wird zuletzt verlegt">
				<SelectField
					id="group-priority"
					label="Vorrang"
					options={priorityOptions}
					value={priority}
					onchange={(v) => (priority = v ?? '3')}
				/>
			</FormField>
			{#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
		</form>
		<Dialog.Footer>
			<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
			<Button type="submit" form="group-form" disabled={busy || !name.trim()}>
				{busy ? 'Speichert …' : 'Speichern'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<ConfirmDialog
	bind:open={confirmOpen}
	title="Gruppe „{deleting?.name}“ löschen?"
	description="Die Buchungen bleiben erhalten, nur ohne Gruppe."
	confirmLabel="Löschen"
	destructive
	onconfirm={remove}
/>
