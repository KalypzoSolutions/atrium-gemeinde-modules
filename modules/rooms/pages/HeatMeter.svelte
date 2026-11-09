<script lang="ts">
	// Heizaufwand 1–10 als zehnteilige Skala (gefüllte Segmente in der Warnfarbe).
	let { level, class: className = '' }: { level: number; class?: string } = $props();
</script>

<span
	class={['inline-flex w-full max-w-36 gap-0.5', className]}
	role="img"
	aria-label="Heizaufwand {level} von 10"
	title="Heizaufwand {level} von 10"
>
	{#each Array.from({ length: 10 }, (_, i) => i) as i (i)}
		<span class={['h-1.5 flex-1 rounded-[1px]', i < level ? 'bg-warning' : 'bg-muted']}></span>
	{/each}
</span>
