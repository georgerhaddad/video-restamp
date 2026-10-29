import { describe, expect, it } from 'vitest';
import { analyze, restamp, type Analysis } from '../src/lib/restamp';
import { fixture } from './helpers';

type Known = Extract<Analysis, { status: 'ok' | 'broken' | 'suspect' }>;

interface Expected {
	name: string;
	status: Known['status'];
	speedFactor: number; // to 2 decimal places
	realSeconds: number; // to 2 decimal places
	realFps: number; // to 2 decimal places
	videoNeedsFix: boolean;
	audioNeedsFix: boolean;
	extra?: (analysis: Known) => void;
}

const expectations: Expected[] = [
	// Correct files, including imperfect ones that must not be mistaken for stretched.
	{ name: 'ok-h264-aac.mp4', status: 'ok', speedFactor: 1, realSeconds: 6, realFps: 60, videoNeedsFix: false, audioNeedsFix: false },
	{ name: 'ok-hevc-aac.mp4', status: 'ok', speedFactor: 1, realSeconds: 6, realFps: 60, videoNeedsFix: false, audioNeedsFix: false },
	{ name: 'ok-tiny.mp4', status: 'ok', speedFactor: 1, realSeconds: 6, realFps: 60, videoNeedsFix: false, audioNeedsFix: false },
	{
		name: 'ok-trimmed.mp4', // frames hidden by the edit list don't count
		status: 'ok',
		speedFactor: 1,
		realSeconds: 4.5,
		realFps: 60,
		videoNeedsFix: false,
		audioNeedsFix: false,
		extra: (a) => expect(a.video.claimedSeconds).toBeCloseTo(4.5, 3)
	},
	{ name: 'ok-audio-gap.mp4', status: 'ok', speedFactor: 1, realSeconds: 6, realFps: 60, videoNeedsFix: false, audioNeedsFix: false },
	{ name: 'ok-no-editlist.mp4', status: 'ok', speedFactor: 0.99, realSeconds: 6.03, realFps: 60, videoNeedsFix: false, audioNeedsFix: false },
	{
		name: 'ok-vfr.mp4', // 182 frames at 60 fps, 88 at 30: average 45.38
		status: 'ok',
		speedFactor: 1,
		realSeconds: 6,
		realFps: 45.38,
		videoNeedsFix: false,
		audioNeedsFix: false
	},
	{
		name: 'ok-5994.mp4',
		status: 'ok',
		speedFactor: 1,
		realSeconds: 60,
		realFps: 59.94,
		videoNeedsFix: false,
		audioNeedsFix: false,
		extra: (a) => expect(a.video.labelledFps).toBeCloseTo(60000 / 1001, 2)
	},

	// Audio and video stretched alike: fixed.
	{ name: 'broken-2x-h264-aac.mp4', status: 'broken', speedFactor: 2, realSeconds: 6, realFps: 60, videoNeedsFix: true, audioNeedsFix: true },
	{ name: 'broken-2x-hevc-aac.mp4', status: 'broken', speedFactor: 2, realSeconds: 6, realFps: 60, videoNeedsFix: true, audioNeedsFix: true },
	// Not constant-rate, so not snapped: the corrected average is reported.
	{ name: 'broken-2x-vfr.mp4', status: 'broken', speedFactor: 1.99, realSeconds: 6, realFps: 45.29, videoNeedsFix: true, audioNeedsFix: true },
	// Snapping to 60 would end 60 ms before the audio, so the exact factor is used: the video
	// (60.01 s at 59.94 in the original) is made to end with the audio (60.00 s).
	{ name: 'broken-2x-5994.mp4', status: 'broken', speedFactor: 2, realSeconds: 59.99, realFps: 59.96, videoNeedsFix: true, audioNeedsFix: true },
	{
		name: 'real-world-heaac-hevc.mp4',
		status: 'broken',
		speedFactor: 2,
		realSeconds: 15.56,
		realFps: 60,
		videoNeedsFix: true,
		audioNeedsFix: true,
		extra: (a) => {
			// 338 packets: 337 of 2048 ticks, the last (1986, stretched ~1.99x) scaled to 997,
			// minus 5058 ticks of priming, at 44100 Hz: 15.5582 s, which the audio edit (scaled
			// and capped, in the movie's milliseconds) rounds to 15.558 s.
			expect((337 * 2048 + 997 - 5058) / 44100).toBeCloseTo(15.5582, 4);
			expect(a.realSeconds).toBeCloseTo(15.558, 6);
			expect(a.video).toMatchObject({ codec: 'hvc1', frames: 934 });
			expect(a.video.labelledFps).toBeCloseTo(30, 6);
			expect(a.video.claimedSeconds).toBeCloseTo(31.133, 3);
			expect(a.audio).toMatchObject({ codec: 'mp4a', profile: 'HE-AAC', sampleRate: 44100 });
			expect(a.audio.claimedSeconds).toBeCloseTo(31.09, 3);
		}
	},

	// Audio timed right, video length doesn't match: ambiguous.
	{
		name: 'broken-2.5x-video-only.mp4',
		status: 'suspect',
		speedFactor: 2.5,
		realSeconds: 6,
		realFps: 60,
		videoNeedsFix: true,
		audioNeedsFix: false,
		extra: (a) => expect(a.video.labelledFps).toBeCloseTo(24, 1)
	},
	{ name: 'suspect-audio-shorter.mp4', status: 'suspect', speedFactor: 1.2, realSeconds: 5, realFps: 72, videoNeedsFix: true, audioNeedsFix: false },
	{ name: 'suspect-audio-longer.mp4', status: 'suspect', speedFactor: 0.83, realSeconds: 6, realFps: 50, videoNeedsFix: true, audioNeedsFix: false }
];

describe.each(expectations)('$name', (expected) => {
	const data = fixture(expected.name);

	it(`is ${expected.status}`, () => {
		const analysis = analyze(data);
		if (analysis.status === 'unsupported') throw new Error(`unexpectedly unsupported: ${analysis.reason}`);
		expect(analysis.status).toBe(expected.status);
		expect(analysis.speedFactor).toBeCloseTo(expected.speedFactor, 1);
		expect(Math.abs(analysis.speedFactor - expected.speedFactor)).toBeLessThan(0.01);
		expect(Math.abs(analysis.realSeconds - expected.realSeconds)).toBeLessThan(0.01);
		expect(Math.abs(analysis.video.realFps - expected.realFps)).toBeLessThan(0.01);
		expect(analysis.video.needsFix).toBe(expected.videoNeedsFix);
		expect(analysis.audio.needsFix).toBe(expected.audioNeedsFix);
		expected.extra?.(analysis);
	});

	if (expected.status === 'ok') {
		it('is left alone, even when forced', () => {
			expect(restamp(data).output).toBeNull();
			expect(restamp(data, { force: true }).output).toBeNull();
		});
	} else if (expected.status === 'suspect') {
		it('is only fixed when forced', () => {
			expect(restamp(data).output).toBeNull();
			expect(restamp(data, { force: true }).output).toBeInstanceOf(Uint8Array);
		});
	} else {
		it('is fixed', () => {
			expect(restamp(data).output).toBeInstanceOf(Uint8Array);
		});
	}
});

describe('unsupported-two-audio.mp4', () => {
	it('is refused, since the second audio track would keep its stretched timing', () => {
		const analysis = analyze(fixture('unsupported-two-audio.mp4'));
		expect(analysis).toMatchObject({ status: 'unsupported' });
		if (analysis.status === 'unsupported') expect(analysis.reason).toMatch(/one video and one audio track/);
	});
});
