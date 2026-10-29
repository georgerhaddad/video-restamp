import { describe, expect, it } from 'vitest';
import { parseAudioSpecificConfig } from '../src/lib/restamp/aac';

const hex = (text: string) => Uint8Array.from(text.match(/../g)!.map((byte) => parseInt(byte, 16)));

describe('AudioSpecificConfig', () => {
	it('reads AAC-LC', () => {
		expect(parseAudioSpecificConfig(hex('1210'))).toEqual({
			profile: 'AAC-LC',
			coreSampleRate: 44100,
			coreSamplesPerFrame: 1024,
			sbrSampleRate: undefined,
			sbrExcluded: false
		});
	});

	it('reads the sync extension saying "no SBR" (as ffmpeg writes)', () => {
		expect(parseAudioSpecificConfig(hex('121056e500'))).toMatchObject({ profile: 'AAC-LC', sbrExcluded: true });
	});

	it('reads explicit SBR (the TikTok config)', () => {
		expect(parseAudioSpecificConfig(hex('2b920800'))).toEqual({
			profile: 'HE-AAC',
			coreSampleRate: 22050,
			coreSamplesPerFrame: 1024,
			sbrSampleRate: 44100,
			sbrExcluded: false
		});
	});

	it('reads explicit PS (HE-AACv2)', () => {
		// AOT 29, 22050 Hz, mono, extension 44100 Hz, core AOT 2
		expect(parseAudioSpecificConfig(hex('eb8a0800'))).toMatchObject({ profile: 'HE-AACv2', coreSampleRate: 22050, sbrSampleRate: 44100 });
	});

	it('reads backward-compatible SBR signalling', () => {
		// AAC-LC 22050 Hz stereo, then sync extension 0x2b7, AOT 5, sbrPresent, 44100 Hz
		expect(parseAudioSpecificConfig(hex('139056e5a0'))).toMatchObject({ profile: 'HE-AAC', coreSampleRate: 22050, sbrSampleRate: 44100 });
	});

	it('leaves implicit SBR undecided (decided later from the mdhd timescale)', () => {
		expect(parseAudioSpecificConfig(hex('1390'))).toMatchObject({ profile: 'AAC-LC', coreSampleRate: 22050, sbrSampleRate: undefined, sbrExcluded: false });
	});

	it('reads the 960-sample frame length', () => {
		expect(parseAudioSpecificConfig(hex('1214')).coreSamplesPerFrame).toBe(960);
	});

	it('rejects other object types and truncated configs', () => {
		expect(() => parseAudioSpecificConfig(hex('f8a000'))).toThrow(/object type 37/); // escape: 32 + 5
		expect(() => parseAudioSpecificConfig(hex('ba88'))).toThrow(/object type 23/); // AAC-LD
		expect(() => parseAudioSpecificConfig(hex('12'))).toThrow(/truncated/);
	});
});
