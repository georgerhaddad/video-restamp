<script lang="ts">
	import '@fontsource/ibm-plex-mono/400.css';
	import '@fontsource/ibm-plex-mono/500.css';
	import '@fontsource/ibm-plex-mono/600.css';
	import './layout.css';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href="/favicon.svg" />
	<title>video-restamp</title>
	<meta
		name="description"
		content="Fixes videos where the footage plays in slow motion but the audio plays normally. Runs locally in your browser."
	/>
</svelte:head>

{@render children()}
