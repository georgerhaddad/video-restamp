import { describe, expect, it } from 'vitest';
import { analyze, restamp, type Analysis } from '../src/lib/restamp';
import { fixture } from './helpers';

function known(analysis: Analysis) {
	if (analysis.status === 'unsupported') throw new Error(`unexpectedly unsupported: ${analysis.reason}`);
	return analysis;
}

describe.each([
	{ name: 'ok-h264-aac.mp4', codec: 'avc1' },
	{ name: 'ok-hevc-aac.mp4', codec: 'hvc1' }
])('$name', ({ name, codec }) => {
	const data = fixture(name);

	it('is reported as ok', () => {
		const analysis = known(analyze(data));
		expect(analysis.status).toBe('ok');
		expect(analysis.speedFactor).toBeCloseTo(1, 2);
		expect(analysis.realSeconds).toBeCloseTo(6, 2);
		expect(analysis.video).toMatchObject({ codec, frames: 360, realFps: 60, needsFix: false });
		expect(analysis.video.labelledFps).toBeCloseTo(60, 1);
		expect(analysis.audio).toMatchObject({ codec: 'mp4a', profile: 'AAC-LC', sampleRate: 44100, needsFix: false });
		expect(analysis.audio.claimedSeconds).toBeCloseTo(6, 2);
	});

	it('is left alone', () => {
		expect(restamp(data).output).toBeNull();
	});
});

describe.each([
	{ name: 'broken-2x-h264-aac.mp4', codec: 'avc1' },
	{ name: 'broken-2x-hevc-aac.mp4', codec: 'hvc1' }
])('$name', ({ name, codec }) => {
	it('has both tracks stretched 2x', () => {
		const analysis = known(analyze(fixture(name)));
		expect(analysis.status).toBe('broken');
		expect(analysis.speedFactor).toBeCloseTo(2, 1);
		expect(analysis.realSeconds).toBeCloseTo(6, 2);
		expect(analysis.video).toMatchObject({ codec, frames: 360, realFps: 60, needsFix: true });
		expect(analysis.video.claimedSeconds).toBeCloseTo(12, 0);
		expect(analysis.video.labelledFps).toBeCloseTo(30, 0);
		expect(analysis.audio).toMatchObject({ profile: 'AAC-LC', sampleRate: 44100, needsFix: true });
		expect(analysis.audio.claimedSeconds).toBeCloseTo(12, 0);
	});
});

describe('broken-2.5x-video-only.mp4', () => {
	it('has only the video stretched', () => {
		const analysis = known(analyze(fixture('broken-2.5x-video-only.mp4')));
		expect(analysis.status).toBe('broken');
		expect(analysis.speedFactor).toBeCloseTo(2.5, 1);
		expect(analysis.realSeconds).toBeCloseTo(6, 2);
		expect(analysis.video).toMatchObject({ codec: 'avc1', frames: 360, realFps: 60, needsFix: true });
		expect(analysis.video.labelledFps).toBeCloseTo(24, 0);
		expect(analysis.audio.needsFix).toBe(false);
		expect(analysis.audio.claimedSeconds).toBeCloseTo(6, 2);
	});
});

describe('real-world-heaac-hevc.mp4', () => {
	it('is the TikTok case: 60 fps labelled 30, HE-AAC packets ~2x too long', () => {
		const analysis = known(analyze(fixture('real-world-heaac-hevc.mp4')));
		expect(analysis.status).toBe('broken');
		expect(analysis.speedFactor).toBeCloseTo(1.998, 3);
		// 338 packets x 2048 ticks, last one 1986, minus 5058 ticks of priming, at 44100 Hz
		expect(analysis.realSeconds).toBeCloseTo((337 * 2048 + 1986 - 5058) / 44100, 6);
		expect(analysis.video).toMatchObject({ codec: 'hvc1', frames: 934, realFps: 60, needsFix: true });
		expect(analysis.video.claimedSeconds).toBeCloseTo(31.133, 3);
		expect(analysis.video.labelledFps).toBeCloseTo(30, 6);
		expect(analysis.audio).toMatchObject({ codec: 'mp4a', profile: 'HE-AAC', sampleRate: 44100, needsFix: true });
		expect(analysis.audio.claimedSeconds).toBeCloseTo(31.09, 2);
	});
});
