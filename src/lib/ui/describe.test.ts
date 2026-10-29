import { describe, expect, it } from 'vitest';
import type { Analysis } from '$lib/restamp/types';
import {
	detailRows,
	formatBytes,
	formatFps,
	formatSeconds,
	restampedFilename,
	summarize,
	verdict
} from './describe';

type Known = Extract<Analysis, { status: 'ok' | 'broken' | 'suspect' }>;

function make(over: {
	status?: Known['status'];
	real?: number;
	factor?: number;
	v?: Partial<Known['video']>;
	a?: Partial<Known['audio']>;
}): Known {
	return {
		status: over.status ?? 'broken',
		realSeconds: over.real ?? 15.6,
		speedFactor: over.factor ?? 2,
		video: {
			codec: 'avc1',
			frames: 936,
			claimedSeconds: 31.2,
			labelledFps: 30,
			realFps: 60,
			needsFix: true,
			...over.v
		},
		audio: {
			codec: 'mp4a',
			profile: 'AAC-LC',
			sampleRate: 44100,
			claimedSeconds: 15.6,
			needsFix: false,
			...over.a
		}
	};
}

describe('formatters', () => {
	it('formats seconds', () => {
		expect(formatSeconds(15.64)).toBe('15.6 s');
		expect(formatSeconds(59.97)).toBe('1 min 0 s');
		expect(formatSeconds(125.4)).toBe('2 min 5 s');
	});
	it('formats fps without noise', () => {
		expect(formatFps(30)).toBe('30');
		expect(formatFps(29.97)).toBe('29.97');
		expect(formatFps(23.976)).toBe('23.98');
	});
	it('formats bytes', () => {
		expect(formatBytes(500)).toBe('500 B');
		expect(formatBytes(1536)).toBe('1.5 KB');
		expect(formatBytes(300 * 1024 * 1024)).toBe('300 MB');
	});
	it('builds the output filename', () => {
		expect(restampedFilename('clip.MOV')).toBe('clip_restamped.mp4');
		expect(restampedFilename('a.b.mp4')).toBe('a.b_restamped.mp4');
		expect(restampedFilename('noext')).toBe('noext_restamped.mp4');
	});
});

describe('summarize', () => {
	it('explains a video that played too slow', () => {
		expect(summarize(make({}))).toBe(
			'60 fps footage was labelled as 30 fps, so it played 2x too slow. Fixed length: 15.6 s (was 31.2 s).'
		);
	});
	it('handles fractional factors', () => {
		const s = summarize(make({ factor: 1.25, v: { labelledFps: 24, realFps: 30 } }));
		expect(s).toContain('played 1.25x too slow');
	});
	it('handles footage that played too fast', () => {
		const s = summarize(make({ factor: 0.5, v: { labelledFps: 60, realFps: 30 } }));
		expect(s).toContain('played 2x too fast');
	});
	it('mentions audio when both tracks were wrong', () => {
		const s = summarize(make({ a: { needsFix: true } }));
		expect(s).toContain('audio timestamps were off too');
	});
	it('says so when only the audio needed fixing', () => {
		const s = summarize(
			make({
				factor: 1,
				v: { needsFix: false, claimedSeconds: 15.6 },
				a: { needsFix: true, claimedSeconds: 20 }
			})
		);
		expect(s).toMatch(/^Only the audio needed fixing/);
		expect(s).toContain('(was 20.0 s)');
	});
	it('reports files that look fine', () => {
		const a = make({
			status: 'ok',
			factor: 1,
			v: { needsFix: false, realFps: 30, labelledFps: 30 }
		});
		expect(summarize(a)).toBe('Looks fine, nothing to fix. 15.6 s at 30 fps.');
		expect(verdict(a)).toBe('fine');
	});
	it('passes the reason through for unsupported files', () => {
		const a: Analysis = { status: 'unsupported', reason: 'Fragmented MP4 is not supported.' };
		expect(summarize(a)).toBe('Fragmented MP4 is not supported.');
		expect(verdict(a)).toBe('unsupported');
		expect(detailRows(a)).toEqual([
			{ label: 'Reason', value: 'Fragmented MP4 is not supported.' }
		]);
	});
});

describe('suspect files', () => {
	const suspect = (factor: number) =>
		make({ status: 'suspect', factor, real: 6, v: { claimedSeconds: 6 * factor, labelledFps: 24 }, a: { claimedSeconds: 6 } });

	it('explains why it was not fixed', () => {
		const a = suspect(2.5);
		expect(verdict(a)).toBe('suspect');
		expect(summarize(a)).toBe(
			'The video claims to be 2.5x longer than its audio, but the audio timing looks normal. It may be a stretched video, or one whose audio is simply shorter.'
		);
	});
	it('handles video shorter than its audio', () => {
		expect(summarize(suspect(0.8))).toMatch(/^The video claims to be 1\.25x shorter than its audio.*audio is simply longer\.$/);
	});
	it('says what happened when fixed anyway', () => {
		expect(summarize(suspect(2.5), true)).toMatch(/Fixed anyway: the video now plays at 60 fps and lasts 6\.0 s, like the audio\.$/);
	});
	it('does not flag either track as wrong', () => {
		expect(detailRows(suspect(2.5)).some((row) => row.wrong)).toBe(false);
	});
});

describe('detailRows', () => {
	it('lists raw numbers and flags the wrong ones', () => {
		const rows = detailRows(make({}));
		const get = (l: string) => rows.find((r) => r.label === l)!;
		expect(get('Video frames').value).toBe('936');
		expect(get('Labelled frame rate')).toMatchObject({ value: '30 fps', wrong: true });
		expect(get('Real frame rate').value).toBe('60 fps');
		expect(get('Audio profile').value).toBe('AAC-LC');
		expect(get('Audio length (claimed)').wrong).toBe(false);
	});
});
