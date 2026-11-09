<script lang="ts">
	// Tauschanfrage ansehen und beantworten (Gruppe der festen Buchung bzw. Raumverwaltung) oder zurückziehen.
	import ArrowLeftRight from '@lucide/svelte/icons/arrow-left-right';
	import { page } from '$app/state';
	import { apiFetch } from '$lib/sdk/client';
	import { formatDateDe } from '$lib/sdk/dates';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { ErrorState, LoadingState } from '$lib/components/layout';
	import { SWAP_STATUS_LABELS, type SwapInfo } from '../schemas';
	import { errorInfo, weekdayShort } from './helpers';

	let {
		open = $bindable(false),
		swapId,
		onchanged
	}: { open?: boolean; swapId: string | null; onchanged?: () => void } = $props();

	let swap = $state<SwapInfo | null>(null);
	let loading = $state(false);
	let error = $state('');
	let busy = $state(false);

	async function load(id: string) {
		loading = true;
		error = '';
		try {
			const list = await apiFetch<SwapInfo[]>('/modules/rooms/swaps');
			swap = list.find((s) => s.id === id) ?? null;
			if (!swap) error = 'Anfrage nicht gefunden.';
		} catch (e) {
			error = errorInfo(e, 'Anfrage konnte nicht geladen werden.').message;
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		if (open && swapId) void load(swapId);
	});

	async function act(action: 'accept' | 'decline' | 'withdraw') {
		if (!swap) return;
		busy = true;
		error = '';
		try {
			swap = await apiFetch<SwapInfo>(`/modules/rooms/swaps/${swap.id}/${action}`, {
				method: 'POST'
			});
			onchanged?.();
		} catch (e) {
			error = errorInfo(e, 'Das hat nicht geklappt.').message;
		} finally {
			busy = false;
		}
	}

	const mine = $derived(
		!!swap && swap.requesterId === (page.data.user as { id?: string } | null | undefined)?.id
	);
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2">
				<ArrowLeftRight class="size-5" aria-hidden="true" />
				Tauschanfrage{swap ? ` für ${swap.roomName ?? 'Raum'}` : ''}
			</Dialog.Title>
			<Dialog.Description>
				{#if swap}
					„{swap.requestTitle}“ ({swap.requestPersons} Personen) · {weekdayShort(swap.date)}, {formatDateDe(
						swap.date
					)},
					{swap.startsAt}–{swap.endsAt} · von {swap.requesterName ?? 'Unbekannt'}
				{/if}
			</Dialog.Description>
		</Dialog.Header>
		{#if loading}
			<LoadingState />
		{:else if swap}
			<div class="space-y-3 text-sm">
				<div class="grid items-stretch gap-2 sm:grid-cols-[1fr_auto_1fr]">
					<div class="rounded-md border p-3">
						<span class="text-xs text-muted-foreground">„{swap.targetTitle}“ heute</span>
						<b class="block">{swap.roomName}</b>
						<span class="text-xs text-muted-foreground">fest gebucht</span>
					</div>
					<ArrowLeftRight
						class="size-4 self-center justify-self-center text-muted-foreground"
						aria-hidden="true"
					/>
					<div class="rounded-md border border-primary bg-primary/5 p-3">
						<span class="text-xs text-muted-foreground">Vorschlag</span>
						<b class="block">{swap.proposedRoomName ?? 'anderer Raum'}</b>
						<span class="text-xs text-muted-foreground">gleiche Zeit, passt für euch</span>
					</div>
				</div>
				{#if swap.message}<p class="rounded-md bg-muted p-3">„{swap.message}“</p>{/if}
				<div class="flex flex-wrap items-center gap-2">
					<Badge variant={swap.status === 'pending' ? 'outline' : 'secondary'}>
						{SWAP_STATUS_LABELS[swap.status]}
					</Badge>
					{#if swap.status === 'pending'}
						<span class="text-xs text-muted-foreground">
							Antwort bis {formatDateDe(swap.dueOn)} · danach verfällt die Anfrage
						</span>
					{/if}
				</div>
			</div>
		{/if}
		{#if error}<ErrorState message={error} compact />{/if}
		<Dialog.Footer>
			{#if swap?.status === 'pending' && swap.canDecide}
				<Button
					variant="outline"
					class="text-destructive"
					disabled={busy}
					onclick={() => act('decline')}
				>
					Ablehnen
				</Button>
				<Button disabled={busy} onclick={() => act('accept')}>Tauschen</Button>
			{:else if swap?.status === 'pending' && mine}
				<Button variant="outline" disabled={busy} onclick={() => act('withdraw')}
					>Zurückziehen</Button
				>
			{:else}
				<Button variant="outline" onclick={() => (open = false)}>Schließen</Button>
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
