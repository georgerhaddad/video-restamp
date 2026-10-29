<script lang="ts">
	import type { Item } from '$lib/ui/items';
	import { detailRows, formatBytes, restampedFilename, summarize, verdict } from '$lib/ui/describe';

	let { item, onremove }: { item: Item; onremove: (id: number) => void } = $props();

	const kind = $derived.by((): 'queued' | 'processing' | 'error' | ReturnType<typeof verdict> => {
		if (item.state === 'done' && item.analysis) return verdict(item.analysis);
		return item.state === 'done' ? 'error' : item.state;
	});

	const label = $derived(
		{
			queued: 'Waiting',
			processing: 'Processing',
			error: 'Error',
			fine: 'Looks fine',
			fixable: 'Fixed',
			unsupported: "Can't fix"
		}[kind]
	);

	const summary = $derived(item.analysis ? summarize(item.analysis) : '');
	const rows = $derived(item.analysis ? detailRows(item.analysis) : []);
	const hasDetails = $derived(item.analysis && item.analysis.status !== 'unsupported');
</script>

<li class="card {kind}">
	<div class="head">
		<div class="meta">
			<span class="name" title={item.name}>{item.name}</span>
			<span class="size">{formatBytes(item.size)}</span>
		</div>
		<span class="badge {kind}">{label}</span>
		<button type="button" class="icon" onclick={() => onremove(item.id)} aria-label="Remove {item.name}">
			&times;
		</button>
	</div>

	{#if item.state === 'queued'}
		<p class="text muted">Waiting for the files before it.</p>
	{:else if item.state === 'processing'}
		<p class="text muted"><span class="spinner" aria-hidden="true"></span> Reading and analysing the file...</p>
	{:else if item.state === 'error'}
		<p class="text">Something went wrong: {item.error}</p>
	{:else if item.analysis}
		<p class="text">{summary}</p>

		{#if hasDetails}
			<details>
				<summary>Details</summary>
				<dl>
					{#each rows as row (row.label)}
						<dt>{row.label}</dt>
						<dd class:wrong={row.wrong}>{row.value}{row.wrong ? ' (wrong)' : ''}</dd>
					{/each}
				</dl>
			</details>
		{/if}

		{#if item.url}
			<div class="result">
				<!-- svelte-ignore a11y_media_has_caption -->
				<video src={item.url} controls preload="metadata" aria-label="Preview of {restampedFilename(item.name)}"></video>
				<a class="button primary" href={item.url} download={restampedFilename(item.name)}>
					Download {restampedFilename(item.name)}
				</a>
			</div>
		{/if}
	{/if}
</li>

<style>
	.card {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 16px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		list-style: none;
	}

	.head {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.meta {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}

	.name {
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.size {
		font-size: 0.8rem;
		color: var(--muted);
	}

	.badge {
		flex: none;
		font-size: 0.75rem;
		padding: 3px 10px;
		border-radius: 999px;
		background: var(--surface-hover);
		color: var(--muted);
		border: 1px solid var(--border);
	}

	.badge.fixable {
		background: var(--ok-bg);
		color: var(--ok-fg);
		border-color: transparent;
	}

	.badge.unsupported,
	.badge.error {
		background: var(--bad-bg);
		color: var(--bad-fg);
		border-color: transparent;
	}

	.icon {
		flex: none;
		width: 30px;
		height: 30px;
		border-radius: 50%;
		border: none;
		background: transparent;
		color: var(--muted);
		font: inherit;
		font-size: 1.3rem;
		line-height: 1;
		cursor: pointer;
	}

	.icon:hover {
		background: var(--surface-hover);
		color: var(--fg);
	}

	.text {
		margin: 0;
		line-height: 1.5;
		font-size: 0.92rem;
		overflow-wrap: anywhere;
	}

	.muted {
		color: var(--muted);
	}

	.spinner {
		display: inline-block;
		width: 0.8em;
		height: 0.8em;
		margin-right: 4px;
		border: 2px solid var(--border);
		border-top-color: var(--fg);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.spinner {
			animation-duration: 3s;
		}
	}

	details summary {
		cursor: pointer;
		font-size: 0.85rem;
		color: var(--muted);
		width: fit-content;
		border-radius: 6px;
	}

	details summary:hover {
		color: var(--fg);
	}

	dl {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 4px 20px;
		margin: 10px 0 0;
		font-size: 0.82rem;
	}

	dt {
		color: var(--muted);
	}

	dd {
		margin: 0;
	}

	dd.wrong {
		color: var(--bad-fg);
	}

	.result {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	video {
		width: 100%;
		max-height: 420px;
		border-radius: 10px;
		background: #000;
	}

	.button {
		align-self: flex-start;
		max-width: 100%;
		overflow-wrap: anywhere;
	}
</style>
