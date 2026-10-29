import { describe, expect, it } from 'vitest';
import { analyze, restamp, type Analysis } from '../src/lib/restamp';
import { makeBox } from '../src/lib/restamp/boxes';
import { concatBytes } from '../src/lib/restamp/bytes';
import { readMovie } from '../src/lib/restamp/movie';
import { fixture, random } from './helpers';

function expectUnsupported(analysis: Analysis): string {
	expect(analysis.status).toBe('unsupported');
	if (analysis.status !== 'unsupported') return '';
	expect(analysis.reason.length).toBeGreaterThan(10);
	return analysis.reason;
}

const ascii = (text: string) => new TextEncoder().encode(text);

describe('bad input', () => {
	it('rejects empty, tiny and non-MP4 buffers', () => {
		const rng = random(1);
		const noise = Uint8Array.from({ length: 4096 }, () => Math.floor(rng() * 256));
		for (const data of [
			new Uint8Array(0),
			new Uint8Array(7),
			new Uint8Array(4096),
			new Uint8Array(4096).fill(0xff),
			noise,
			ascii('<!doctype html><html><body>not a video</body></html>')
		]) {
			expect(() => restamp(data)).not.toThrow();
			expectUnsupported(restamp(data).analysis);
		}
	});

	it('explains what is wrong', () => {
		expect(expectUnsupported(analyze(ascii('GIF89a.......')))).toMatch(/MP4 or MOV/);
		const ftyp = makeBox('ftyp', ascii('isom\0\0\0\0isom'));
		expect(expectUnsupported(analyze(ftyp))).toMatch(/moov/);
		expect(expectUnsupported(analyze(concatBytes([ftyp, makeBox('moof', new Uint8Array(8))])))).toMatch(/Fragmented/);
	});

	it('rejects a file without audio', () => {
		const data = fixture('ok-h264-aac.mp4');
		const movie = readMovie(data);
		const audio = movie.tracks.find((track) => track.handler === 'soun')!;
		// Turn the audio trak into a free box.
		const out = data.slice();
		out.set(ascii('free'), audio.trak.start + 4);
		expect(expectUnsupported(analyze(out))).toMatch(/no audio track/);
	});

	describe.each(['real-world-heaac-hevc.mp4', 'broken-2x-h264-aac.mp4'])('truncated %s', (name) => {
		const data = fixture(name);
		it('returns unsupported at every cut point', () => {
			const rng = random(2);
			const cuts = [1, 8, 16, 31, 32, 33, 64, 500, data.length - 1, data.length - 8];
			for (let i = 0; i < 40; i++) cuts.push(Math.floor(rng() * data.length));
			for (const cut of cuts) {
				const result = restamp(data.subarray(0, cut));
				expect(result.output).toBeNull();
				expectUnsupported(result.analysis);
			}
		});
	});

	describe.each(['real-world-heaac-hevc.mp4', 'broken-2x-hevc-aac.mp4', 'ok-h264-aac.mp4', 'broken-2x-vfr.mp4', 'broken-2.5x-video-only.mp4'])('corrupted moov in %s', (name) => {
		const data = fixture(name);
		const { moov } = readMovie(data);
		it('never throws', () => {
			const rng = random(3);
			for (let i = 0; i < 300; i++) {
				const corrupt = data.slice();
				const flips = 1 + Math.floor(rng() * 8);
				for (let j = 0; j < flips; j++) {
					const at = moov.start + Math.floor(rng() * (moov.end - moov.start));
					corrupt[at] = Math.floor(rng() * 256);
				}
				const result = restamp(corrupt, { force: true });
				const { status } = result.analysis;
				expect(['ok', 'broken', 'suspect', 'unsupported']).toContain(status);
				if (status === 'broken' || status === 'suspect') expect(result.output).toBeInstanceOf(Uint8Array);
				else expect(result.output).toBeNull();
				// These reasons come from the catch-alls, so they would mean a bug rather than bad input.
				if (result.analysis.status === 'unsupported') {
					expect(result.analysis.reason).not.toMatch(/could not be read|couldn't be rewritten/);
				}
			}
		});
	});
});
