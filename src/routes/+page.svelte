<script lang="ts">
	import { tick } from 'svelte';
	import { restamp } from '$lib/restamp';
	import DropZone from '$lib/components/DropZone.svelte';
	import ResultCard from '$lib/components/ResultCard.svelte';
	import { verdict } from '$lib/ui/describe';
	import type { Item } from '$lib/ui/items';

	let items = $state<Item[]>([]);
	let announcement = $state('');

	// Files live outside reactive state; they are released as soon as they are processed.
	const pending = new Map<number, File>();
	let nextId = 0;
	let running = false;

	function addFiles(list: File[]) {
		for (const file of list) {
			const id = nextId++;
			pending.set(id, file);
			items.push({ id, name: file.name, size: file.size, state: 'queued' });
		}
		void run();
	}

	/** Let the browser paint the "processing" state before blocking the thread. */
	async function yieldToUi() {
		await tick();
		await new Promise((resolve) => setTimeout(resolve, 30));
	}

	const alive = (id: number) => items.some((i) => i.id === id);

	async function run() {
		if (running) return;
		running = true;
		try {
			for (;;) {
				const item = items.find((i) => i.state === 'queued');
				if (!item) break;
				const id = item.id;
				const file = pending.get(id);
				pending.delete(id);
				item.state = 'processing';
				announcement = `Processing ${item.name}`;
				await yieldToUi();

				try {
					if (!file) throw new Error('File is no longer available.');
					const data = new Uint8Array(await file.arrayBuffer());
					await yieldToUi();
					const result = restamp(data);
					let url: string | undefined;
					if (result.analysis.status === 'broken') {
						if (!result.output) throw new Error('No fixed file was produced.');
						if (alive(id)) {
							url = URL.createObjectURL(new Blob([result.output as BlobPart], { type: 'video/mp4' }));
						}
					}
					if (alive(id)) {
						item.analysis = result.analysis;
						item.url = url;
						item.state = 'done';
						announcement = `${item.name}: ${outcomeWord(item)}`;
					}
				} catch (e) {
					if (alive(id)) {
						item.error = e instanceof Error ? e.message : String(e);
						item.state = 'error';
						announcement = `${item.name}: error. ${item.error}`;
					}
				}
			}
		} finally {
			running = false;
		}
	}

	function outcomeWord(item: Item): string {
		if (!item.analysis) return 'done';
		const v = verdict(item.analysis);
		return v === 'fine' ? 'looks fine, nothing to fix' : v === 'fixable' ? 'fixed, ready to download' : "can't fix";
	}

	function remove(id: number) {
		const item = items.find((i) => i.id === id);
		if (item?.url) URL.revokeObjectURL(item.url);
		pending.delete(id);
		items = items.filter((i) => i.id !== id);
	}

	function clearAll() {
		for (const item of items) if (item.url) URL.revokeObjectURL(item.url);
		pending.clear();
		items = [];
		announcement = 'List cleared';
	}

	// Free object URLs if the page is torn down.
	$effect(() => () => {
		for (const item of items) if (item.url) URL.revokeObjectURL(item.url);
	});

	// Dropping a file outside the drop zone should not navigate the tab to the video.
	function ignoreDrag(e: DragEvent) {
		e.preventDefault();
	}
</script>

<svelte:window ondragover={ignoreDrag} ondrop={ignoreDrag} />

<main>
	<header>
		<h1>video-restamp</h1>
		<p class="lead">
			Fixes videos where the footage plays in slow motion but the audio plays normally.
		</p>
		<p class="private">Files never leave your device. Everything runs in this tab.</p>
	</header>

	<DropZone onfiles={addFiles} />

	{#if items.length > 0}
		<section aria-label="Results">
			<div class="toolbar">
				<h2>{items.length} {items.length === 1 ? 'file' : 'files'}</h2>
				<button type="button" class="button" onclick={clearAll}>Clear list</button>
			</div>
			<ul>
				{#each items as item (item.id)}
					<ResultCard {item} onremove={remove} />
				{/each}
			</ul>
		</section>
	{/if}

	<footer>
		<h2>How it works</h2>
		<p>
			Some phones and screen recorders write the wrong timestamps into the MP4 header, so the
			footage is stretched (for example 60 fps footage labelled as 30 fps) while the audio keeps
			its normal speed. video-restamp rewrites only the timestamp tables in the header. The video
			and audio data are never re-encoded, so the quality is identical.
		</p>
	</footer>

	<div class="sr-only" role="status" aria-live="polite">{announcement}</div>
</main>

<style>
	main {
		max-width: 680px;
		margin: 0 auto;
		padding: 56px 20px 48px;
		display: flex;
		flex-direction: column;
		gap: 32px;
	}

	header h1 {
		margin: 0 0 12px;
		font-size: 1.6rem;
		font-weight: 600;
	}

	header p {
		margin: 0;
	}

	.lead {
		line-height: 1.6;
	}

	header .private {
		margin-top: 6px;
		font-size: 0.85rem;
		color: var(--muted);
	}

	section {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	.toolbar h2 {
		margin: 0;
		font-size: 0.95rem;
		font-weight: 500;
		color: var(--muted);
	}

	ul {
		display: flex;
		flex-direction: column;
		gap: 14px;
		margin: 0;
		padding: 0;
	}

	footer {
		font-size: 0.8rem;
		line-height: 1.6;
		color: var(--muted);
	}

	footer h2 {
		margin: 0 0 6px;
		font-size: 0.85rem;
		font-weight: 500;
		color: var(--fg);
	}

	footer p {
		margin: 0;
	}
</style>
