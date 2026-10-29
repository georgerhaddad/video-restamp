// Public contract between the restamp core and the UI. Keep this stable.

export interface VideoReport {
	codec: string; // sample entry fourcc, e.g. "avc1", "hvc1"
	frames: number;
	claimedSeconds: number; // what the file's timestamps say
	labelledFps: number; // frames / claimedSeconds
	realFps: number; // frames / real duration, snapped to a standard rate when close
	needsFix: boolean;
}

export interface AudioReport {
	codec: string; // e.g. "mp4a"
	profile: string; // e.g. "AAC-LC", "HE-AAC"
	sampleRate: number; // output sample rate
	claimedSeconds: number;
	needsFix: boolean;
}

export type Analysis =
	| { status: 'unsupported'; reason: string }
	| {
			status: 'ok' | 'broken';
			realSeconds: number; // true length, from the audio sample count
			speedFactor: number; // claimed video length / real length; 1 when fine, 2 = plays 2x too slow
			video: VideoReport;
			audio: AudioReport;
	  };

export interface RestampResult {
	analysis: Analysis;
	output: Uint8Array | null; // fixed file; null unless analysis.status === 'broken'
}
