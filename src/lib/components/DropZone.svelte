<script lang="ts">
	let { onfiles }: { onfiles: (files: File[]) => void } = $props();

	let dragging = $state(false);
	let depth = 0; // dragenter/dragleave fire for child elements too

	function pick(e: Event & { currentTarget: HTMLInputElement }) {
		const input = e.currentTarget;
		const files = Array.from(input.files ?? []);
		input.value = ''; // allow picking the same file again
		if (files.length) onfiles(files);
	}

	function enter(e: DragEvent) {
		e.preventDefault();
		depth++;
		dragging = true;
	}

	function leave() {
		depth = Math.max(0, depth - 1);
		if (depth === 0) dragging = false;
	}

	function over(e: DragEvent) {
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
	}

	function drop(e: DragEvent) {
		e.preventDefault();
		depth = 0;
		dragging = false;
		const files = Array.from(e.dataTransfer?.files ?? []);
		if (files.length) onfiles(files);
	}
</script>

<!-- A real <label> around a visually hidden <input>: keyboard, screen readers and click all work natively. -->
<label
	class="zone"
	class:dragging
	ondragenter={enter}
	ondragleave={leave}
	ondragover={over}
	ondrop={drop}
>
	<input
		class="sr-only"
		type="file"
		multiple
		accept="video/mp4,video/quicktime,.mp4,.mov,.m4v"
		onchange={pick}
	/>
	<span class="title">Drop videos here</span>
	<span class="hint">or click to choose files (.mp4, .mov, .m4v)</span>
</label>

<style>
	.zone {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 6px;
		padding: 44px 20px;
		text-align: center;
		cursor: pointer;
		border: 2px dashed var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		transition:
			border-color 0.15s,
			background 0.15s;
	}

	.zone:hover,
	.zone.dragging {
		border-color: var(--fg);
		background: var(--surface-hover);
	}

	.zone:focus-within {
		outline: 2px solid var(--focus);
		outline-offset: 3px;
	}

	.title {
		font-size: 1.1rem;
		font-weight: 500;
	}

	.hint {
		font-size: 0.85rem;
		color: var(--muted);
	}
</style>
