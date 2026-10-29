// Unit tests for the retiming paths the fixtures don't reach.

import { describe, expect, it } from 'vitest';
import type { Track } from '../src/lib/restamp/movie';
import { expandOffsets, totalDuration } from '../src/lib/restamp/tables';
import { retimeVideo } from '../src/lib/restamp/timing';
import { random } from './helpers';

// retimeVideo only reads the media timescale from the track.
const trackWithTimescale = (timescale: number) => ({ mediaHeader: { timescaleOrTrackId: timescale } }) as unknown as Track;

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

describe('retimeVideo', () => {
	it('keeps the timescale when it is a multiple of the frame rate', () => {
		const result = retimeVideo(trackWithTimescale(15360), new Float64Array(120).fill(512), null, null, 60, 2, 1000);
		expect(result.timescale).toBe(15360);
		expect(result.durations).toEqual([{ count: 120, delta: 256 }]);
	});

	it('raises the timescale to a common multiple instead of rounding', () => {
		const result = retimeVideo(trackWithTimescale(1000), new Float64Array(48).fill(83), null, null, 24, 2, 1000);
		expect(result.timescale).toBe(3000);
		expect(result.durations).toEqual([{ count: 48, delta: 125 }]);
		expect(result.trackDuration).toBe(2000);
	});

	it('gets within 0.05% for a non-standard measured rate', () => {
		const realSeconds = 1.7; // 100 frames: 58.8 fps
		const result = retimeVideo(trackWithTimescale(600), new Float64Array(100).fill(20), null, null, 100 / realSeconds, realSeconds, 1000);
		expect(result.timescale % 600).toBe(0);
		expect(result.durations[0].delta).toBeGreaterThanOrEqual(1000);
		const seconds = totalDuration(result.durations) / result.timescale;
		expect(Math.abs(seconds - realSeconds) / realSeconds).toBeLessThan(0.0005);
	});

	it('scales regular B-frame offsets exactly', () => {
		const offsets = Float64Array.from([2, 5, 2, 0, 1, 2, 5, 2, 0, 1], (frames) => frames * 512);
		const result = retimeVideo(trackWithTimescale(15360), new Float64Array(10).fill(512), { version: 0, offsets }, null, 60, 10 / 60, 1000);
		const newOffsets = expandOffsets(result.offsets!, 10);
		expect(Array.from(newOffsets)).toEqual(Array.from(offsets, (offset) => offset / 2));
	});

	it('preserves presentation order with irregular old durations', () => {
		const rng = random(7);
		const frames = 300;
		const durations = Float64Array.from({ length: frames }, () => 400 + Math.floor(rng() * 300));
		const starts: number[] = [];
		let time = 0;
		for (const duration of durations) {
			starts.push(time);
			time += duration;
		}
		// IBB-style reordering: in decode order, each reference frame comes before the two
		// frames shown before it. Presentation slot of decode index i:
		const slot = (i: number) => (i % 3 === 0 ? i + 2 : i - 1);
		const offsets = Float64Array.from(starts, (start, i) => starts[slot(i)] - start + 2000);
		const oldOrder = order(presentationTimes(durations, offsets));

		for (const version of [0, 1]) {
			const result = retimeVideo(trackWithTimescale(15360), durations, { version, offsets }, null, 30, frames / 30, 1000);
			const newOffsets = expandOffsets(result.offsets!, frames);
			const newTimes = presentationTimes(new Float64Array(frames).fill(512), newOffsets);
			expect(order(newTimes)).toEqual(oldOrder);
			expect(new Set(newTimes).size).toBe(frames);
			expect(Math.min(...newOffsets)).toBeGreaterThanOrEqual(0);
		}
	});

	it('keeps negative offsets in a signed (version 1) ctts and updates cslg', () => {
		// Decode order I0 P3 B1 B2 P6 B4 B5, offsets = presentation - decode index, first frame at 0.
		const offsets = Float64Array.from([0, 2, -1, -1, 2, -1, -1], (frames) => frames * 1000);
		const durations = new Float64Array(7).fill(1000);
		const result = retimeVideo(trackWithTimescale(30000), durations, { version: 1, offsets }, null, 60, 7 / 60, 1000);
		const newOffsets = Array.from(expandOffsets(result.offsets!, 7));
		expect(newOffsets).toEqual(Array.from(offsets, (offset) => offset / 2));
		expect(result.compositionShift).toEqual({
			compositionToDtsShift: 500,
			leastDecodeToDisplayDelta: -500,
			greatestDecodeToDisplayDelta: 1000,
			compositionStartTime: 0,
			compositionEndTime: 3500
		});
	});
});
