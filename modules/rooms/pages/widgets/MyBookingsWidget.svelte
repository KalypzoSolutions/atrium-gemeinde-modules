<script lang="ts">
	// Dashboard-Kachel „Meine Raumbuchungen“: die nächsten fünf eigenen Termine mit Raum.
	import { onMount } from 'svelte';
	import House from '@lucide/svelte/icons/house';
	import { apiFetch } from '$lib/sdk/client';
	import type { DashboardWidgetProps } from '$lib/sdk/types/module-ui';
	import { DashboardCard } from '$lib/components/layout';
	import type { Occurrence } from '../../schemas';
	import { dayLabel, errorInfo } from '../helpers';

	let { onstatus }: DashboardWidgetProps = $props();

	let items = $state<Occurrence[]>([]);
	let loading = $state(true);
	let error = $state('');

	async function load() {
		loading = true;
		error = '';
		onstatus?.('loading');
		try {
			items = await apiFetch<Occurrence[]>('/modules/rooms/my/upcoming?limit=5');
			onstatus?.(items.length ? 'ready' : 'empty');
		} catch (e) {
			error = errorInfo(e, 'Buchungen konnten nicht geladen werden.').message;
			onstatus?.('error');
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void load();
	});
</script>

<DashboardCard
	title="Meine Raumbuchungen"
	icon={House}
	href="/modules/rooms?view=mine"
	{loading}
	{error}
	onretry={load}
	empty={!items.length}
	emptyText="Keine anstehenden Buchungen."
>
	<ul class="divide-y">
		{#each items as o (o.key)}
			<li class="py-2">
				<a
					href="/modules/rooms?date={o.date}&booking={o.bookingId}"
					class="block rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
				>
					<span class="block truncate text-sm font-medium">{o.title}</span>
					<span class="block text-xs text-muted-foreground">
						{dayLabel(o.date)}, {o.startsAt}–{o.endsAt} ·
						<span class={o.roomId ? '' : 'text-destructive'}>
							{o.roomName ?? (o.planned ? 'ohne Raum' : 'Raum folgt')}
						</span>
					</span>
				</a>
			</li>
		{/each}
	</ul>
</DashboardCard>
