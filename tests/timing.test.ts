// Unit tests for the retiming paths the fixtures don't reach.

import { describe, expect, it } from 'vitest';
import type { Track } from '../src/lib/restamp/movie';
import { expandDurations, expandOffsets, totalDuration } from '../src/lib/restamp/tables';
import { retimeAudio, retimeVideo, type VideoTiming } from '../src/lib/restamp/timing';
import { random } from './helpers';

// The retime functions only read the media timescale from the track.
const track = (timescale: number) => ({ mediaHeader: { timescaleOrTrackId: timescale } }) as unknown as Track;

function video(timescale: number, durations: number[], offsets?: { version: number; values: number[] }): VideoTiming {
	return {
		timescale,
		mediaDuration: durations.reduce((a, b) => a + b, 0),
		durations: Float64Array.from(durations),
		offsets: offsets ? { version: offsets.version, values: Float64Array.from(offsets.values) } : null,
		edit: null
	};
}

function presentationTimes(durations: ArrayLike<number>, offsets: ArrayLike<number>): number[] {
	const times: number[] = [];
	let decode = 0;
	for (let i = 0; i < durations.length; i++) {
		times.push(decode + offsets[i]);
		decode += durations[i];
	}
	return times;
}

const order = (times: number[]) => times.map((_, i) => i).sort((a, b) => times[a] - times[b] || a - b);
const repeat = (value: number, count: number) => Array.from({ length: count }, () => value);

describe('retimeVideo', () => {
	it('keeps the timescale when it is a multiple of the snapped rate', () => {
		const result = retimeVideo(track(15360), video(15360, repeat(512, 120)), 0.5, 60, 1000);
		expect(result.timescale).toBe(15360);
		expect(result.durations).toEqual([{ count: 120, delta: 256 }]);
	});

	it('raises the timescale to a common multiple instead of rounding', () => {
		// 50 fps labelled at 1000 ticks/s, really 24 fps: 1000 / 24 isn't a whole number.
		const result = retimeVideo(track(1000), video(1000, repeat(20, 48)), 1000 / (24 * 20), 24, 1000);
		expect(result.timescale).toBe(3000);
		expect(result.durations).toEqual([{ count: 48, delta: 125 }]);
		expect(result.trackDuration).toBe(2000);
	});

	it('gives a snapped constant-rate clip a uniform last frame too', () => {
		const result = retimeVideo(track(15360), video(15360, [...repeat(512, 9), 256]), 0.5, 60, 1000);
		expect(result.durations).toEqual([{ count: 10, delta: 256 }]);
		expect(result.mediaDuration).toBe(2560);
	});

	it('gets within 1 ms of the exact length when the factor is arbitrary', () => {
		const ratio = 0.50123;
		const result = retimeVideo(track(600), video(600, repeat(20, 1800)), ratio, null, 1000);
		expect(result.timescale % 600).toBe(0);
		const seconds = totalDuration(result.durations) / result.timescale;
		expect(Math.abs(seconds - 60 * ratio)).toBeLessThan(0.001);
		expect(result.durations).toHaveLength(1); // still uniform
	});

	it('keeps variable frame rate: each duration is scaled, not made uniform', () => {
		const result = retimeVideo(track(15360), video(15360, [...repeat(512, 180), ...repeat(1024, 90)]), 0.5, null, 1000);
		expect(result.durations).toEqual([
			{ count: 180, delta: 256 },
			{ count: 90, delta: 512 }
		]);
	});

	it('scales B-frame offsets exactly', () => {
		const offsets = [2, 5, 2, 0, 1, 2, 5, 2, 0, 1].map((frames) => frames * 512);
		const result = retimeVideo(track(15360), video(15360, repeat(512, 10), { version: 0, values: offsets }), 0.5, 60, 1000);
		expect(Array.from(expandOffsets(result.offsets!.runs, 10))).toEqual(offsets.map((offset) => offset / 2));
		expect(result.offsets!.version).toBe(0);
	});

	it('preserves presentation order with irregular durations and an arbitrary factor', () => {
		const rng = random(7);
		const frames = 300;
		const durations = Array.from({ length: frames }, () => 400 + Math.floor(rng() * 300));
		const starts: number[] = [];
		let time = 0;
		for (const duration of durations) {
			starts.push(time);
			time += duration;
		}
		// IBB-style reordering: each reference frame is decoded before the two shown before it.
		const slot = (i: number) => (i % 3 === 0 ? i + 2 : i - 1);
		const offsets = starts.map((start, i) => starts[slot(i)] - start + 2000);
		const oldOrder = order(presentationTimes(durations, offsets));

		const result = retimeVideo(track(15360), video(15360, durations, { version: 0, values: offsets }), 0.4987, null, 1000);
		const newDurations = expandDurations(result.durations, frames);
		const newOffsets = expandOffsets(result.offsets!.runs, frames);
		const newTimes = presentationTimes(newDurations, newOffsets);
		expect(order(newTimes)).toEqual(oldOrder);
		expect(new Set(newTimes).size).toBe(frames);
		expect(Math.min(...newOffsets)).toBeGreaterThanOrEqual(0);
	});

	it('raises the timescale so close frames are not merged', () => {
		// Frames 1 tick apart, halved: at the same timescale they would collide.
		const result = retimeVideo(track(1000), video(1000, repeat(1, 10)), 0.5, null, 1000);
		expect(result.timescale).toBe(2000);
		expect(result.durations).toEqual([{ count: 10, delta: 1 }]);
	});

	it('keeps negative offsets in a signed (version 1) ctts and updates cslg', () => {
		// Decode order I0 P3 B1 B2 P6 B4 B5, offsets = presentation - decode index, first frame at 0.
		const offsets = [0, 2, -1, -1, 2, -1, -1].map((frames) => frames * 1000);
		const result = retimeVideo(track(30000), video(30000, repeat(1000, 7), { version: 1, values: offsets }), 0.5, 60, 1000);
		expect(Array.from(expandOffsets(result.offsets!.runs, 7))).toEqual(offsets.map((offset) => offset / 2));
		expect(result.offsets!.version).toBe(1);
		expect(result.compositionShift).toEqual({
			compositionToDtsShift: 500,
			leastDecodeToDisplayDelta: -500,
			greatestDecodeToDisplayDelta: 1000,
			compositionStartTime: 0,
			compositionEndTime: 3500
		});
	});

	it('switches to version 1 when a version 0 ctts held negative offsets', () => {
		const result = retimeVideo(track(30000), video(30000, repeat(1000, 3), { version: 0, values: [0, -1000, 0] }), 0.5, 60, 1000);
		expect(result.offsets!.version).toBe(1);
	});
});

describe('retimeAudio', () => {
	it('makes every packet its true length and scales the short last packet by the same stretch', () => {
		const old = Float64Array.from([...repeat(2048, 99), 1000]);
		const result = retimeAudio(track(44100), old, null, 1024, 1000);
		expect(result.durations).toEqual([
			{ count: 99, delta: 1024 },
			{ count: 1, delta: 500 }
		]);
	});

	it('caps the last packet at a full packet', () => {
		const old = Float64Array.from([...repeat(2048, 9), 4096]);
		const result = retimeAudio(track(44100), old, null, 1024, 1000);
		expect(result.durations).toEqual([{ count: 10, delta: 1024 }]);
	});

	it('maps the priming skipped by the edit list onto the new timeline', () => {
		const old = Float64Array.from(repeat(2048, 10));
		const edit = { segmentDuration: 400, mediaTime: 2048, rateInteger: 1, rateFraction: 0 };
		const result = retimeAudio(track(44100), old, edit, 1024, 1000);
		expect(result.edit!.mediaTime).toBe(1024);
		// 9 packets of 1024 remain after the priming: 209 ms; the old edit, scaled, says 200.
		expect(result.edit!.segmentDuration).toBe(200);
	});
});
