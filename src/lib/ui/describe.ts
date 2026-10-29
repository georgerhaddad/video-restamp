// Turns an Analysis into plain-language text. No DOM, no framework: easy to port.
import type { Analysis } from '$lib/restamp/types';

type Known = Extract<Analysis, { status: 'ok' | 'broken' | 'suspect' }>;

export interface DetailRow {
	label: string;
	value: string;
	/** True when this value is the wrong one that the fix replaces. */
	wrong?: boolean;
}

function trimNumber(n: number, digits: number): string {
	return n.toFixed(digits).replace(/\.?0+$/, '');
}

/** "15.6 s", "2 min 5 s". */
export function formatSeconds(s: number): string {
	if (!Number.isFinite(s)) return '?';
	if (s < 59.95) return `${s.toFixed(1)} s`;
	const total = Math.round(s);
	const m = Math.floor(total / 60);
	return `${m} min ${total % 60} s`;
}

/** "30", "29.97". */
export function formatFps(fps: number): string {
	if (!Number.isFinite(fps)) return '?';
	return trimNumber(fps, 2);
}

/** "2x", "1.25x". */
export function formatFactor(f: number): string {
	return `${trimNumber(f, 2)}x`;
}

export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return '?';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let i = 0;
	let v = bytes;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return i === 0 ? `${v} B` : `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

/** "clip.MOV" -> "clip_restamped.mp4" */
export function restampedFilename(name: string): string {
	const base = name.replace(/\.[^./\\]+$/, '') || 'video';
	return `${base}_restamped.mp4`;
}

/** Short verdict, used for the card badge. */
export function verdict(a: Analysis): 'fine' | 'fixable' | 'suspect' | 'unsupported' {
	if (a.status === 'unsupported') return 'unsupported';
	if (a.status === 'suspect') return 'suspect';
	return a.status === 'ok' ? 'fine' : 'fixable';
}

function speedPhrase(a: Known): string {
	const f = a.speedFactor;
	return f >= 1 ? `${formatFactor(f)} too slow` : `${formatFactor(1 / f)} too fast`;
}

/**
 * The sentence(s) shown on the card. `forced` means a 'suspect' file was fixed anyway at
 * the user's request.
 */
export function summarize(a: Analysis, forced = false): string {
	if (a.status === 'unsupported') return a.reason;

	if (a.status === 'suspect') {
		const f = a.speedFactor;
		const text =
			f >= 1
				? `The video claims to be ${formatFactor(f)} longer than its audio, but the audio timing looks normal. It may be a stretched video, or one whose audio is simply shorter.`
				: `The video claims to be ${formatFactor(1 / f)} shorter than its audio, but the audio timing looks normal. It may be a sped-up video, or one whose audio is simply longer.`;
		if (!forced) return text;
		return `${text} Fixed anyway: the video now plays at ${formatFps(a.video.realFps)} fps and lasts ${formatSeconds(a.realSeconds)}, like the audio.`;
	}

	if (a.status === 'ok') {
		return `Looks fine, nothing to fix. ${formatSeconds(a.realSeconds)} at ${formatFps(a.video.realFps)} fps.`;
	}

	const { video, audio } = a;
	let what: string;
	let was: number;
	if (video.needsFix) {
		what = `${formatFps(video.realFps)} fps footage was labelled as ${formatFps(video.labelledFps)} fps, so it played ${speedPhrase(a)}.`;
		if (audio.needsFix) what += ' The audio timestamps were off too.';
		was = video.claimedSeconds;
	} else if (audio.needsFix) {
		what = `Only the audio needed fixing: its timestamps said ${formatSeconds(audio.claimedSeconds)}, but the real length is ${formatSeconds(a.realSeconds)}.`;
		was = audio.claimedSeconds;
	} else {
		what = 'The timestamps were inconsistent and have been corrected.';
		was = video.claimedSeconds;
	}
	return `${what} Fixed length: ${formatSeconds(a.realSeconds)} (was ${formatSeconds(was)}).`;
}

/** Raw numbers for the collapsible details section. */
export function detailRows(a: Analysis): DetailRow[] {
	if (a.status === 'unsupported') return [{ label: 'Reason', value: a.reason }];
	const { video, audio } = a;
	// For a 'suspect' file we don't know which track is wrong, so nothing is flagged.
	const sure = a.status === 'broken';
	return [
		{ label: 'Real length', value: formatSeconds(a.realSeconds) },
		{ label: 'Speed factor', value: formatFactor(a.speedFactor) },
		{ label: 'Video codec', value: video.codec },
		{ label: 'Video frames', value: String(video.frames) },
		{ label: 'Labelled frame rate', value: `${formatFps(video.labelledFps)} fps`, wrong: sure && video.needsFix },
		{ label: 'Real frame rate', value: `${formatFps(video.realFps)} fps` },
		{ label: 'Video length (claimed)', value: formatSeconds(video.claimedSeconds), wrong: sure && video.needsFix },
		{ label: 'Audio codec', value: audio.codec },
		{ label: 'Audio profile', value: audio.profile },
		{ label: 'Audio sample rate', value: `${audio.sampleRate} Hz` },
		{ label: 'Audio length (claimed)', value: formatSeconds(audio.claimedSeconds), wrong: sure && audio.needsFix }
	];
}
