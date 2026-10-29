import { describe, expect, it } from 'vitest';
import { analyze, restamp, type Analysis, type RestampOptions } from '../src/lib/restamp';
import { makeBox, makeFreeBox, readBoxes } from '../src/lib/restamp/boxes';
import { concatBytes } from '../src/lib/restamp/bytes';
import { inspect } from '../src/lib/restamp/detect';
import { readMovie } from '../src/lib/restamp/movie';
import { buildMoov, placeMoov } from '../src/lib/restamp/rewrite';
import {
	decodeErrors,
	fixture,
	fixturePath,
	hasFfmpeg,
	packetHashes,
	presentationOrder,
	probeFormatDuration,
	probePackets,
	probeStreams,
	sameBytes,
	writeTemp,
	type Packet
} from './helpers';

type Known = Extract<Analysis, { status: 'ok' | 'broken' | 'suspect' }>;

interface Case {
	label: string;
	input: Uint8Array;
	fix: (data: Uint8Array) => Uint8Array;
	inPlace: boolean; // the moov is rewritten where it is, file size unchanged
	fps: number | null; // exact avg_frame_rate expected (the rate snapped to), or null if not snapped
	audioRetimed: boolean; // audio packets rewritten to their true duration, or left as they were
	reference?: string; // a correct fixture the output should match, frame for frame
	// ffprobe's video stream duration is the sum of the frame durations, which for this input
	// was already off from its presented length (the reference itself is 50 ms off its audio).
	// Then only the presented span (from packet timestamps) is held to the tight tolerance.
	looseStreamDuration?: boolean;
}

function fixWith(options: RestampOptions = {}) {
	return (data: Uint8Array): Uint8Array => {
		const { output, analysis } = restamp(data, options);
		if (!output) throw new Error(`expected a fix, got ${JSON.stringify(analysis)}`);
		return output;
	};
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

const normal = fixWith();
const forced = fixWith({ force: true });

const cases: Case[] = [
	{ label: 'broken-2x-h264-aac', input: fixture('broken-2x-h264-aac.mp4'), fix: normal, inPlace: true, fps: 60, audioRetimed: true },
	{ label: 'broken-2x-hevc-aac', input: fixture('broken-2x-hevc-aac.mp4'), fix: normal, inPlace: true, fps: 60, audioRetimed: true },
	{ label: 'real-world-heaac-hevc', input: fixture('real-world-heaac-hevc.mp4'), fix: normal, inPlace: true, fps: 60, audioRetimed: true },
	{
		label: 'broken-2x-vfr',
		input: fixture('broken-2x-vfr.mp4'),
		fix: normal,
		inPlace: true,
		fps: null,
		audioRetimed: true,
		reference: 'ok-vfr.mp4',
		looseStreamDuration: true
	},
	{ label: 'broken-2x-5994', input: fixture('broken-2x-5994.mp4'), fix: normal, inPlace: true, fps: null, audioRetimed: true },
	{
		label: 'forced: broken-2.5x-video-only',
		input: fixture('broken-2.5x-video-only.mp4'),
		fix: forced,
		inPlace: true,
		fps: 60,
		audioRetimed: false
	},
	{
		label: 'forced: suspect-audio-shorter',
		input: fixture('suspect-audio-shorter.mp4'),
		fix: forced,
		inPlace: true,
		fps: 72,
		audioRetimed: false
	},
	{
		label: '64-bit mdat size (broken-2x-h264-aac)',
		input: withLargeSizeMdat(fixture('broken-2x-h264-aac.mp4')),
		fix: normal,
		inPlace: true,
		fps: 60,
		audioRetimed: true
	},
	{
		label: 'broken-2x-timescale-1110 (timescale must double)',
		input: fixture('broken-2x-timescale-1110.mp4'),
		fix: normal,
		inPlace: true,
		fps: 60,
		audioRetimed: true
	},
	{
		label: 'fallback: moov first, appended at end, size-0 mdat (real-world)',
		input: withOpenEndedLastBox(fixture('real-world-heaac-hevc.mp4')),
		fix: fixWithOversizedMoov,
		inPlace: false,
		fps: 60,
		audioRetimed: true
	},
	{
		label: 'fallback: moov last, replaced (broken-2x-hevc-aac)',
		input: fixture('broken-2x-hevc-aac.mp4'),
		fix: fixWithOversizedMoov,
		inPlace: false,
		fps: 60,
		audioRetimed: true
	}
];

const relative = (packets: Packet[]) => {
	const first = Math.min(...packets.map((packet) => packet.pts));
	return packets.map((packet) => packet.pts - first);
};

const span = (packets: Packet[]) =>
	Math.max(...packets.map((p) => p.pts + p.duration)) - Math.min(...packets.map((p) => p.pts));

describe.each(cases)('$label', ({ input, fix, inPlace, fps, audioRetimed, reference, looseStreamDuration }) => {
	const before = input.slice();
	const analysis = analyze(input) as Known;
	if (analysis.status !== 'broken' && analysis.status !== 'suspect') {
		throw new Error(`expected broken or suspect, got ${JSON.stringify(analysis)}`);
	}
	const output = fix(input);
	// Where the fix should be exact: within a frame (at the new rate) or 20 ms.
	const tolerance = Math.max(1 / analysis.video.realFps, 0.02);

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
		const top = readBoxes(output, 0, output.length);
		expect(top.filter((box) => box.type === 'moov')).toHaveLength(1);
		expect(top[top.length - 1].end).toBe(output.length);
	});

	it('is idempotent: the output analyses as ok', () => {
		expect(analyze(output).status).toBe('ok');
		expect(restamp(output, { force: true }).output).toBeNull();
	});

	describe.skipIf(!hasFfmpeg)('verified with ffprobe/ffmpeg', () => {
		const slug = input.length + '-' + Math.random().toString(36).slice(2, 8);
		const inPath = writeTemp(`in-${slug}.mp4`, input);
		const outPath = writeTemp(`out-${slug}.mp4`, output);
		const streams = probeStreams(outPath);
		const video = streams.find((stream) => stream.codec_type === 'video')!;
		const audio = streams.find((stream) => stream.codec_type === 'audio')!;

		const before = probePackets(inPath);
		const after = probePackets(outPath);
		const videoIndex = video.index;
		const audioIndex = audio.index;

		it('lasts the real length: video, audio and container', () => {
			const real = analysis.realSeconds;
			const videoSeconds = Number(video.duration);
			const audioSeconds = Number(audio.duration);
			const formatSeconds = probeFormatDuration(outPath);
			const presentedSeconds = span(after.get(videoIndex)!);
			console.info(
				`ffprobe: video ${video.duration} s (presented ${presentedSeconds.toFixed(6)} s), ${video.nb_frames} frames, ` +
					`avg_frame_rate ${video.avg_frame_rate}; audio ${audio.duration} s, ${audio.nb_frames} packets; ` +
					`format ${formatSeconds} s (real length ${real.toFixed(6)} s, tolerance ${(tolerance * 1000).toFixed(1)} ms)`
			);
			const videoTolerance = looseStreamDuration ? 0.01 * real : tolerance;
			expect(Math.abs(videoSeconds - real)).toBeLessThanOrEqual(videoTolerance);
			expect(Math.abs(videoSeconds - audioSeconds)).toBeLessThanOrEqual(videoTolerance);
			expect(Math.abs(presentedSeconds - real)).toBeLessThanOrEqual(tolerance);
			expect(Math.abs(audioSeconds - real)).toBeLessThanOrEqual(tolerance);
			expect(Math.abs(formatSeconds - real)).toBeLessThanOrEqual(tolerance);
		});

		if (fps) {
			it(`plays at exactly ${fps} fps`, () => {
				const [num, den] = video.avg_frame_rate.split('/').map(Number);
				expect(num / den).toBe(fps);
			});
		}

		it('decodes without errors', () => {
			expect(decodeErrors(outPath)).toBe('');
		});

		it('has byte-identical packets in the same decode order', () => {
			const original = packetHashes(inPath);
			const fixed = packetHashes(outPath);
			expect(fixed.size).toBe(2);
			expect(fixed).toEqual(original);
		});

		it('keeps the video presentation order, with every timestamp scaled by one factor', () => {
			const old = before.get(videoIndex)!;
			const fixed = after.get(videoIndex)!;
			expect(fixed.length).toBe(old.length);
			expect(presentationOrder(fixed)).toEqual(presentationOrder(old));
			expect(new Set(fixed.map((packet) => packet.pts)).size).toBe(fixed.length);
			const oldTimes = relative(old);
			const newTimes = relative(fixed);
			const factor = Math.max(...newTimes) / Math.max(...oldTimes);
			const worst = Math.max(...newTimes.map((time, i) => Math.abs(time - oldTimes[i] * factor)));
			expect(worst).toBeLessThan(0.0015); // ffprobe prints microseconds; ticks round to < 0.1 ms
		});

		if (audioRetimed) {
			it('gives every audio packet its true duration', () => {
				const packets = after.get(audioIndex)!;
				const nominal = packets[1].duration;
				for (const packet of packets.slice(1, -1)) expect(packet.duration).toBeCloseTo(nominal, 6);
				expect(packets[packets.length - 1].duration).toBeLessThanOrEqual(nominal + 1e-6);
			});
		} else {
			it('leaves the audio timestamps alone', () => {
				expect(after.get(audioIndex)).toEqual(before.get(audioIndex));
			});
		}

		if (reference) {
			it(`matches ${reference} frame for frame (within a frame)`, () => {
				const referencePackets = probePackets(fixturePath(reference)).get(videoIndex)!;
				const expected = relative(referencePackets);
				const actual = relative(after.get(videoIndex)!);
				expect(actual.length).toBe(expected.length);
				const worst = Math.max(...actual.map((time, i) => Math.abs(time - expected[i])));
				// The fix makes the video end with the audio, while the reference's video ends a
				// little earlier than its audio. That stretch should be the only difference.
				const lengthDifference = Math.abs(span(after.get(videoIndex)!) - span(referencePackets));
				// The variable-rate switch: the first frame shown at or after 3 s.
				const switchFrame = expected.findIndex((time) => time >= 3 - 1e-6);
				console.info(
					`switch frame: ${actual[switchFrame].toFixed(6)} s (reference ${expected[switchFrame].toFixed(6)} s); ` +
						`worst difference ${(worst * 1000).toFixed(2)} ms, length difference ${(lengthDifference * 1000).toFixed(2)} ms`
				);
				expect(Math.abs(actual[switchFrame] - expected[switchFrame])).toBeLessThan(1 / 60);
				expect(worst).toBeLessThanOrEqual(lengthDifference + 0.001);
			});
		}
	});
});

if (!hasFfmpeg) {
	console.warn('ffmpeg/ffprobe not found on PATH: skipping the ffprobe verification tests.');
}
