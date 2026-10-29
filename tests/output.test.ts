import { describe, expect, it } from 'vitest';
import { analyze, restamp } from '../src/lib/restamp';
import { makeBox, makeFreeBox, readBoxes } from '../src/lib/restamp/boxes';
import { concatBytes } from '../src/lib/restamp/bytes';
import { inspect } from '../src/lib/restamp/detect';
import { readMovie, readTrack } from '../src/lib/restamp/movie';
import { buildMoov, placeMoov } from '../src/lib/restamp/rewrite';
import { decodeErrors, fixture, hasFfmpeg, packetHashes, probeStreams, sameBytes, writeTemp } from './helpers';

interface Case {
	label: string;
	input: Uint8Array;
	fix: (data: Uint8Array) => Uint8Array;
	inPlace: boolean; // expect the moov to be rewritten where it is, file size unchanged
}

function fixNormally(data: Uint8Array): Uint8Array {
	const { output, analysis } = restamp(data);
	if (!output) throw new Error(`expected a fix, got ${JSON.stringify(analysis)}`);
	return output;
}

/** Forces the fallback paths: makes the new moov 8 bytes bigger than the old one. */
function fixWithOversizedMoov(data: Uint8Array): Uint8Array {
	const { plan } = inspect(data);
	if (!plan) throw new Error('expected a plan');
	const moov = buildMoov(data, plan);
	const oldSize = plan.movie.moov.end - plan.movie.moov.start;
	const padding = makeFreeBox(Math.max(8, oldSize - moov.length + 8));
	const grown = makeBox('moov', concatBytes([moov.subarray(8), padding]));
	expect(grown.length).toBeGreaterThan(oldSize);
	return placeMoov(data, plan.movie, grown);
}

/** Replaces an 8-byte `free` box and the 8-byte mdat header after it with a 16-byte (64-bit) mdat header. */
function withLargeSizeMdat(data: Uint8Array): Uint8Array {
	const boxes = readBoxes(data, 0, data.length);
	const mdatIndex = boxes.findIndex((box) => box.type === 'mdat');
	const free = boxes[mdatIndex - 1];
	expect(free.type).toBe('free');
	expect(free.end - free.start).toBe(8);
	const out = data.slice();
	const view = new DataView(out.buffer);
	view.setUint32(free.start, 1);
	out.set([0x6d, 0x64, 0x61, 0x74], free.start + 4); // 'mdat'
	view.setBigUint64(free.start + 8, BigInt(boxes[mdatIndex].end - free.start));
	return out;
}

/** Sets the last top-level box's size to 0 ("extends to end of file"). */
function withOpenEndedLastBox(data: Uint8Array): Uint8Array {
	const boxes = readBoxes(data, 0, data.length);
	const last = boxes[boxes.length - 1];
	expect(last.type).toBe('mdat');
	const out = data.slice();
	new DataView(out.buffer).setUint32(last.start, 0);
	return out;
}

/** Changes the video media timescale so it's no longer a multiple of 60 (forcing a new timescale). */
function withVideoTimescale(data: Uint8Array, timescale: number): Uint8Array {
	const movie = readMovie(data);
	const video = readTrack(data, movie.tracks.find((track) => track.handler === 'vide')!);
	expect(data[video.mdhd.start + 8]).toBe(0); // version 0: timescale at payload + 12
	const out = data.slice();
	new DataView(out.buffer).setUint32(video.mdhd.start + 8 + 12, timescale);
	return out;
}

const cases: Case[] = [
	{ label: 'broken-2x-h264-aac', input: fixture('broken-2x-h264-aac.mp4'), fix: fixNormally, inPlace: true },
	{ label: 'broken-2x-hevc-aac', input: fixture('broken-2x-hevc-aac.mp4'), fix: fixNormally, inPlace: true },
	{ label: 'broken-2.5x-video-only', input: fixture('broken-2.5x-video-only.mp4'), fix: fixNormally, inPlace: true },
	{ label: 'real-world-heaac-hevc', input: fixture('real-world-heaac-hevc.mp4'), fix: fixNormally, inPlace: true },
	{
		label: '64-bit mdat size (broken-2x-h264-aac)',
		input: withLargeSizeMdat(fixture('broken-2x-h264-aac.mp4')),
		fix: fixNormally,
		inPlace: true
	},
	{
		label: 'video timescale 12800 (broken-2x-h264-aac)',
		input: withVideoTimescale(fixture('broken-2x-h264-aac.mp4'), 12800),
		fix: fixNormally,
		inPlace: true
	},
	{
		label: 'fallback: moov first, appended at end, size-0 mdat (real-world)',
		input: withOpenEndedLastBox(fixture('real-world-heaac-hevc.mp4')),
		fix: fixWithOversizedMoov,
		inPlace: false
	},
	{
		label: 'fallback: moov last, replaced (broken-2x-hevc-aac)',
		input: fixture('broken-2x-hevc-aac.mp4'),
		fix: fixWithOversizedMoov,
		inPlace: false
	}
];

describe.each(cases)('$label', ({ input, fix, inPlace }) => {
	const before = input.slice();
	const analysis = analyze(input);
	if (analysis.status !== 'broken') throw new Error(`expected broken, got ${JSON.stringify(analysis)}`);
	const output = fix(input);

	it('does not modify the input', () => {
		expect(sameBytes(input, before)).toBe(true);
	});

	it('keeps all media data at the same offsets', () => {
		for (const box of readBoxes(input, 0, input.length).filter((box) => box.type === 'mdat')) {
			const payloadStart = box.start + box.headerSize;
			expect(sameBytes(output.subarray(payloadStart, box.end), input.subarray(payloadStart, box.end))).toBe(true);
		}
		if (inPlace) {
			expect(output.length).toBe(input.length);
			const moov = readMovie(input).moov;
			expect(sameBytes(output.subarray(0, moov.start), input.subarray(0, moov.start))).toBe(true);
			expect(sameBytes(output.subarray(moov.end), input.subarray(moov.end))).toBe(true);
		}
		// Still a well-formed file with exactly one moov.
		const top = readBoxes(output, 0, output.length);
		expect(top.filter((box) => box.type === 'moov')).toHaveLength(1);
		expect(top[top.length - 1].end).toBe(output.length);
	});

	it('is idempotent', () => {
		const again = analyze(output);
		expect(again.status).toBe('ok');
		expect(restamp(output).output).toBeNull();
	});

	describe.skipIf(!hasFfmpeg)('verified with ffprobe/ffmpeg', () => {
		const slug = input.length + '-' + Math.random().toString(36).slice(2, 8);
		const inPath = writeTemp(`in-${slug}.mp4`, input);
		const outPath = writeTemp(`out-${slug}.mp4`, output);

		it('has matching durations and a 60 fps video stream', () => {
			const streams = probeStreams(outPath);
			const video = streams.find((stream) => stream.codec_type === 'video')!;
			const audio = streams.find((stream) => stream.codec_type === 'audio')!;
			const videoSeconds = Number(video.duration);
			const audioSeconds = Number(audio.duration);
			console.info(
				`ffprobe: video ${video.duration} s, ${video.nb_frames} frames, avg_frame_rate ${video.avg_frame_rate}, ` +
					`r_frame_rate ${video.r_frame_rate}; audio ${audio.duration} s, ${audio.nb_frames} packets ` +
					`(real length ${analysis.realSeconds.toFixed(6)} s)`
			);
			expect(Math.abs(videoSeconds - analysis.realSeconds) / analysis.realSeconds).toBeLessThan(0.01);
			expect(Math.abs(audioSeconds - analysis.realSeconds) / analysis.realSeconds).toBeLessThan(0.01);
			expect(Math.abs(videoSeconds - audioSeconds) / audioSeconds).toBeLessThan(0.01);
			const [num, den] = video.avg_frame_rate.split('/').map(Number);
			expect(num / den).toBe(60);
		});

		it('decodes without errors', () => {
			expect(decodeErrors(outPath)).toBe('');
		});

		it('has byte-identical packets', () => {
			const original = packetHashes(inPath);
			const fixed = packetHashes(outPath);
			expect(fixed.size).toBe(2);
			expect(fixed).toEqual(original);
		});
	});
});

if (!hasFfmpeg) {
	console.warn('ffmpeg/ffprobe not found on PATH: skipping the ffprobe verification tests.');
}
