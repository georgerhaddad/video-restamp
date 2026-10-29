// Computes corrected timing for a track: new sample durations, composition offsets,
// media duration and edit list. Nothing here touches the file; rewrite.ts writes it out.

import { UINT32_MAX, UnsupportedError } from './bytes';
import type { Track } from './movie';
import { readElst, toRuns, type CompositionShift, type DurationRun, type EditEntry, type OffsetRun } from './tables';

/** Corrected timing for one track. */
export interface Retimed {
	track: Track;
	timescale: number; // media timescale (mdhd); may differ from the original for video
	durations: DurationRun[]; // stts
	offsets: OffsetRun[] | null; // ctts, when the track has one
	compositionShift: CompositionShift | null; // cslg, when the track has one
	mediaDuration: number; // mdhd duration: sum of the sample durations
	edit: EditEntry | null; // the single edit list entry, when the track has one
	trackDuration: number; // tkhd duration, in the movie timescale
}

/**
 * Reads a track's edit list. We handle none, or a single normal-speed segment: that's what
 * muxers write to trim encoder delay (audio priming, or the B-frame reorder delay on video).
 */
export function readEdit(data: Uint8Array, track: Track, mediaDuration: number): EditEntry | null {
	if (!track.elst) return null;
	const { entries } = readElst(data, track.elst);
	if (entries.length === 0) return null;
	const kind = track.handler === 'vide' ? 'video' : 'audio';
	if (entries.length > 1) {
		throw new UnsupportedError(`The ${kind} track has a multi-part edit list, which isn't supported.`);
	}
	const [edit] = entries;
	if (edit.mediaTime < 0) {
		throw new UnsupportedError(`The ${kind} track's edit list contains only an empty edit.`);
	}
	if (edit.mediaTime >= mediaDuration) {
		throw new UnsupportedError(`The ${kind} track's edit list starts after the end of its media.`);
	}
	if (edit.rateInteger !== 1 || edit.rateFraction !== 0) {
		throw new UnsupportedError(`The ${kind} track's edit list changes the playback rate, which isn't supported.`);
	}
	return edit;
}

/**
 * How long a track plays: from the edit's start (media_time) to the end of its samples,
 * capped by the edit's duration. Without an edit list, the whole media duration.
 */
export function presentedSeconds(mediaDuration: number, edit: EditEntry | null, timescale: number, movieTimescale: number): number {
	const span = (mediaDuration - (edit?.mediaTime ?? 0)) / timescale;
	return edit ? Math.min(span, edit.segmentDuration / movieTimescale) : span;
}

export function sum(values: ArrayLike<number>): number {
	let total = 0;
	for (let i = 0; i < values.length; i++) total += values[i];
	return total;
}

/**
 * Audio: every packet lasts `packetDuration` ticks, except that a shorter final packet is
 * kept (muxers use it to trim the encoder's padding at the end).
 *
 * `packetDuration` may be fractional here (when the media timescale isn't a multiple of
 * the core sample rate); that's fine for measuring, and checked before writing.
 */
export function retimeAudio(
	track: Track,
	oldDurations: Float64Array,
	edit: EditEntry | null,
	packetDuration: number,
	movieTimescale: number
): Retimed {
	const timescale = track.mediaHeader.timescaleOrTrackId;
	const count = oldDurations.length;
	const durations = new Float64Array(count).fill(packetDuration);
	durations[count - 1] = Math.min(oldDurations[count - 1], packetDuration);
	const mediaDuration = sum(durations);

	let newEdit: EditEntry | null = null;
	if (edit) {
		// media_time is the priming to skip, in media ticks. Map it onto the new timeline
		// sample by sample: it usually falls inside the first, correctly timed, packets.
		const mediaTime = Math.round(mapTime(oldDurations, durations, edit.mediaTime));
		const oldSpan = sum(oldDurations) - edit.mediaTime;
		const newSpan = mediaDuration - mediaTime;
		newEdit = { ...edit, mediaTime, segmentDuration: newSegmentDuration(edit, oldSpan, newSpan, timescale, movieTimescale) };
	}

	return {
		track,
		timescale,
		durations: toRuns(durations).map(({ count, value }) => ({ count, delta: value })),
		offsets: null,
		compositionShift: null,
		mediaDuration,
		edit: newEdit,
		trackDuration: newEdit ? newEdit.segmentDuration : Math.round((mediaDuration * movieTimescale) / timescale)
	};
}

/**
 * Video: every frame lasts exactly 1/fps.
 *
 * Timescale: when the media timescale is a multiple of the frame rate (15360, 90000 and
 * 600 all are for 60 fps), a frame is a whole number of ticks and nothing else changes.
 * Otherwise we raise the timescale to the least common multiple of the two. That keeps a
 * single uniform stts entry and so has no drift at all, unlike rounding the frame duration,
 * and multiplies the timescale by a whole number so that existing tick values stay exact.
 * A repeating pattern of uneven durations would also avoid drift, but needs a table entry
 * per frame and makes players report a fractional frame rate. Every field measured in the
 * video media timescale (stts, ctts, cslg, mdhd, elst media_time) is rewritten anyway.
 *
 * When the measured rate isn't a standard one, there is no exact duration to aim for, so we
 * round to the nearest tick after scaling the timescale until a frame is at least 1000
 * ticks: the error is then under 0.05%, below the precision of the measurement itself.
 */
export function retimeVideo(
	track: Track,
	oldDurations: Float64Array,
	ctts: { version: number; offsets: Float64Array } | null,
	edit: EditEntry | null,
	fps: number,
	realSeconds: number,
	movieTimescale: number
): Retimed {
	const oldTimescale = track.mediaHeader.timescaleOrTrackId;
	const frames = oldDurations.length;
	let timescale: number;
	let frameDuration: number;
	if (Number.isInteger(fps)) {
		timescale = oldTimescale % fps === 0 ? oldTimescale : (oldTimescale / gcd(oldTimescale, fps)) * fps;
		frameDuration = timescale / fps;
	} else {
		const ticksPerFrame = (oldTimescale * realSeconds) / frames;
		timescale = oldTimescale * Math.max(1, Math.ceil(1000 / ticksPerFrame));
		frameDuration = Math.round((timescale * realSeconds) / frames);
	}
	if (timescale > UINT32_MAX || frameDuration < 1) {
		throw new UnsupportedError("The video track's timescale can't represent the corrected frame rate.");
	}

	const oldTotal = sum(oldDurations);
	const mediaDuration = frames * frameDuration;
	// Converts a span of old media ticks into new media ticks.
	const scale = mediaDuration / oldTotal;

	// Composition offsets (ctts) give each frame's presentation time relative to its decode
	// time. Scaling them by `scale` would only be exact if the old frame durations were
	// uniform, so instead we keep each frame's position in presentation order and place it
	// on the new frame grid. That preserves the order exactly and can't create duplicates.
	let offsets: OffsetRun[] | null = null;
	let compositionShift: CompositionShift | null = null;
	let shift = 0; // frames between decode and presentation of the first frame shown
	let oldFirstPresentation = 0;
	if (ctts) {
		const rank = presentationRanks(oldDurations, ctts.offsets);
		// The smallest shift that keeps every offset >= 0, i.e. presentation never before decode.
		let minimumShift = 0;
		for (let i = 0; i < frames; i++) minimumShift = Math.max(minimumShift, i - rank[i]);
		// Keep the old offsets' baseline: usually 0; negative with signed (version 1) offsets.
		let oldMinOffset = Infinity;
		oldFirstPresentation = Infinity;
		let decodeTime = 0;
		for (let i = 0; i < frames; i++) {
			oldMinOffset = Math.min(oldMinOffset, ctts.offsets[i]);
			oldFirstPresentation = Math.min(oldFirstPresentation, decodeTime + ctts.offsets[i]);
			decodeTime += oldDurations[i];
		}
		shift = minimumShift + Math.round((oldMinOffset * scale) / frameDuration);
		if (ctts.version === 0) shift = Math.max(shift, minimumShift); // version 0 is unsigned

		const newOffsets = new Float64Array(frames);
		for (let i = 0; i < frames; i++) newOffsets[i] = (rank[i] + shift - i) * frameDuration;
		offsets = toRuns(newOffsets).map(({ count, value }) => ({ count, offset: value }));

		let least = Infinity;
		let greatest = -Infinity;
		for (const offset of newOffsets) {
			least = Math.min(least, offset);
			greatest = Math.max(greatest, offset);
		}
		compositionShift = {
			compositionToDtsShift: Math.max(0, -least),
			leastDecodeToDisplayDelta: least,
			greatestDecodeToDisplayDelta: greatest,
			compositionStartTime: shift * frameDuration,
			compositionEndTime: (frames + shift) * frameDuration
		};
	}
	// Frames now present back to back from `firstPresentation` to `presentationEnd`.
	const firstPresentation = shift * frameDuration;
	const presentationEnd = (frames + shift) * frameDuration;

	let newEdit: EditEntry | null = null;
	if (edit) {
		// media_time normally equals the first presentation time (it hides the reorder delay).
		// Keep its distance from that point, scaled.
		const mediaTime = Math.max(0, firstPresentation + Math.round((edit.mediaTime - oldFirstPresentation) * scale));
		const oldSpan = oldTotal - (edit.mediaTime - oldFirstPresentation);
		const newSpan = presentationEnd - mediaTime;
		newEdit = { ...edit, mediaTime, segmentDuration: newSegmentDuration(edit, oldSpan, newSpan, timescale, movieTimescale) };
	}

	return {
		track,
		timescale,
		durations: [{ count: frames, delta: frameDuration }],
		offsets,
		compositionShift,
		mediaDuration,
		edit: newEdit,
		trackDuration: newEdit ? newEdit.segmentDuration : Math.round((mediaDuration * movieTimescale) / timescale)
	};
}

/**
 * The edit's new duration (movie timescale): the old one scaled like the media, so a
 * deliberate trim survives, but never past the end of the media. Muxers often write the
 * full media duration here without subtracting media_time, which would run past the end.
 */
function newSegmentDuration(edit: EditEntry, oldSpan: number, newSpan: number, timescale: number, movieTimescale: number): number {
	const available = Math.max(0, Math.round((newSpan * movieTimescale) / timescale));
	if (oldSpan <= 0) return available;
	return Math.max(0, Math.min(Math.round((edit.segmentDuration * newSpan) / oldSpan), available));
}

/** Maps a time on the old timeline to the same point (proportionally within its sample) on the new one. */
function mapTime(oldDurations: Float64Array, newDurations: Float64Array, time: number): number {
	let oldStart = 0;
	let newStart = 0;
	for (let i = 0; i < oldDurations.length; i++) {
		if (time < oldStart + oldDurations[i]) {
			return newStart + ((time - oldStart) * newDurations[i]) / oldDurations[i];
		}
		oldStart += oldDurations[i];
		newStart += newDurations[i];
	}
	return newStart;
}

/** For each frame (in decode order), its index in presentation order. */
function presentationRanks(durations: Float64Array, offsets: Float64Array): Uint32Array {
	const count = durations.length;
	const presentation = new Float64Array(count);
	let decodeTime = 0;
	for (let i = 0; i < count; i++) {
		presentation[i] = decodeTime + offsets[i];
		decodeTime += durations[i];
	}
	const order = Array.from({ length: count }, (_, i) => i);
	order.sort((a, b) => presentation[a] - presentation[b] || a - b);
	const rank = new Uint32Array(count);
	order.forEach((frame, position) => (rank[frame] = position));
	return rank;
}

function gcd(a: number, b: number): number {
	while (b) [a, b] = [b, a % b];
	return a;
}
