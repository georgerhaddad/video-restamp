// Works out a file's real length from its audio and decides whether its timestamps are
// stretched. Only the moov headers are read; no media is decoded.

import { readAacConfig } from './aac';
import { UnsupportedError } from './bytes';
import { readMovie, readTrack, type Movie, type Track } from './movie';
import { expandDurations, expandOffsets, readCtts, readStts } from './tables';
import { presentedSeconds, readEdit, retimeAudio, retimeVideo, sum, type Retimed } from './timing';
import type { Analysis } from './types';

// How far a claimed length may be from the real one before we call it wrong.
const LENGTH_TOLERANCE = 0.02;

// Frame rates we snap to. Only whole numbers: 29.97 vs 30 is a 0.1% difference, finer than
// a length measured to the nearest audio packet can resolve on a short clip.
const STANDARD_FRAME_RATES = [24, 25, 30, 48, 50, 60, 90, 100, 120];
const FRAME_RATE_SNAP_TOLERANCE = 0.015;

// Outside this range the audio clearly doesn't span the video, so it can't tell us the speed.
const PLAUSIBLE_FRAME_RATES = { min: 1, max: 240 };

/** The corrected timing to write: null for a track that is already right. */
export interface Plan {
	movie: Movie;
	video: Retimed | null;
	audio: Retimed | null;
}

export interface Inspection {
	analysis: Analysis;
	plan: Plan | null; // set when analysis.status is 'broken'
}

export function inspect(data: Uint8Array): Inspection {
	try {
		return inspectOrThrow(data);
	} catch (error) {
		// Anything else is a bug or an input we didn't anticipate; still never throw at callers.
		const reason =
			error instanceof UnsupportedError ? error.message : "The file could not be read; it may be corrupt or use features we don't support.";
		return { analysis: { status: 'unsupported', reason }, plan: null };
	}
}

function inspectOrThrow(data: Uint8Array): Inspection {
	const movie = readMovie(data);
	const movieTimescale = movie.movieHeader.timescaleOrTrackId;

	const videoSummary = movie.tracks.find((track) => track.handler === 'vide');
	if (!videoSummary) throw new UnsupportedError('The file has no video track.');
	const audioSummary = movie.tracks.find((track) => track.handler === 'soun');
	if (!audioSummary) {
		throw new UnsupportedError("The file has no audio track, so its real length can't be worked out.");
	}
	const video = readTrack(data, videoSummary);
	const audio = readTrack(data, audioSummary);

	// Audio: the true length is the packet count times the samples each packet decodes to.
	if (audio.sampleCount === 0) throw new UnsupportedError('The audio track is empty.');
	if (audio.sampleEntries.length !== 1) {
		throw new UnsupportedError('The audio track has more than one sample description.');
	}
	const aac = readAacConfig(data, audio.sampleEntries[0]);
	const audioTimescale = audio.mediaHeader.timescaleOrTrackId;
	// A packet lasts coreSamplesPerFrame / coreSampleRate seconds whether or not SBR doubles
	// the output rate, so this also covers implicit SBR (mdhd timescale = 2x the core rate).
	const packetDuration = (aac.coreSamplesPerFrame * audioTimescale) / aac.coreSampleRate;
	const implicitSbr =
		aac.sbrSampleRate === undefined && !aac.sbrExcluded && aac.coreSampleRate <= 24000 && audioTimescale === 2 * aac.coreSampleRate;
	const outputSampleRate = aac.sbrSampleRate ?? (implicitSbr ? audioTimescale : aac.coreSampleRate);

	const audioDurations = expandDurations(readStts(data, audio.stts), audio.sampleCount);
	const audioEdit = readEdit(data, audio, sum(audioDurations));
	const claimedAudioSeconds = presentedSeconds(sum(audioDurations), audioEdit, audioTimescale, movieTimescale);
	const correctedAudio = retimeAudio(audio, audioDurations, audioEdit, packetDuration, movieTimescale);
	const realSeconds = presentedSeconds(correctedAudio.mediaDuration, correctedAudio.edit, audioTimescale, movieTimescale);
	if (!(realSeconds > 0)) throw new UnsupportedError('The audio track has no playable length.');

	// Video: what the timestamps claim, versus the frame count over the real length.
	const frames = video.sampleCount;
	if (frames === 0) throw new UnsupportedError('The video track has no frames.');
	const videoTimescale = video.mediaHeader.timescaleOrTrackId;
	const videoDurations = expandDurations(readStts(data, video.stts), frames);
	const videoEdit = readEdit(data, video, sum(videoDurations));
	const claimedVideoSeconds = sum(videoDurations) / videoTimescale;
	if (!(claimedVideoSeconds > 0)) throw new UnsupportedError('The video track has no length.');
	const measuredFps = frames / realSeconds;
	const realFps = snapFrameRate(measuredFps);

	const videoNeedsFix = isOff(claimedVideoSeconds, realSeconds);
	const audioNeedsFix = isOff(claimedAudioSeconds, realSeconds) || !hasPacketDuration(audioDurations, packetDuration);

	const analysis: Analysis = {
		status: videoNeedsFix || audioNeedsFix ? 'broken' : 'ok',
		realSeconds,
		speedFactor: claimedVideoSeconds / realSeconds,
		video: {
			codec: video.sampleEntries[0]?.type ?? 'unknown',
			frames,
			claimedSeconds: claimedVideoSeconds,
			labelledFps: frames / claimedVideoSeconds,
			realFps,
			needsFix: videoNeedsFix
		},
		audio: {
			codec: audio.sampleEntries[0].type,
			profile: implicitSbr ? 'HE-AAC' : aac.profile,
			sampleRate: outputSampleRate,
			claimedSeconds: claimedAudioSeconds,
			needsFix: audioNeedsFix
		}
	};
	if (analysis.status === 'ok') return { analysis, plan: null };

	let videoFix: Retimed | null = null;
	if (videoNeedsFix) {
		if (measuredFps < PLAUSIBLE_FRAME_RATES.min || measuredFps > PLAUSIBLE_FRAME_RATES.max) {
			throw new UnsupportedError(
				`The audio and video lengths are too far apart to work out the frame rate (it would be ${measuredFps.toFixed(1)} fps).`
			);
		}
		videoFix = retimeVideo(video, videoDurations, readVideoOffsets(data, video), videoEdit, realFps, realSeconds, movieTimescale);
	}
	if (audioNeedsFix) checkAudioFixable(audio, packetDuration);

	return { analysis, plan: { movie, video: videoFix, audio: audioNeedsFix ? correctedAudio : null } };
}

function isOff(claimed: number, real: number): boolean {
	return Math.abs(claimed - real) / real > LENGTH_TOLERANCE;
}

/** Whether every packet lasts the expected time, allowing a shorter last packet and 1 tick of rounding. */
function hasPacketDuration(durations: Float64Array, packetDuration: number): boolean {
	const last = durations.length - 1;
	for (let i = 0; i < last; i++) {
		if (Math.abs(durations[i] - packetDuration) > 1) return false;
	}
	return durations[last] <= packetDuration + 1;
}

function snapFrameRate(fps: number): number {
	let nearest = STANDARD_FRAME_RATES[0];
	for (const rate of STANDARD_FRAME_RATES) {
		if (Math.abs(fps - rate) < Math.abs(fps - nearest)) nearest = rate;
	}
	return Math.abs(fps - nearest) / nearest <= FRAME_RATE_SNAP_TOLERANCE ? nearest : fps;
}

function readVideoOffsets(data: Uint8Array, video: Track): { version: number; offsets: Float64Array } | null {
	if (!video.ctts) return null;
	const { version, runs } = readCtts(data, video.ctts);
	return { version, offsets: expandOffsets(runs, video.sampleCount) };
}

function checkAudioFixable(audio: Track, packetDuration: number): void {
	if (!Number.isInteger(packetDuration)) {
		throw new UnsupportedError("The audio track's timescale isn't a multiple of its sample rate, so its timestamps can't be corrected exactly.");
	}
	if (audio.ctts) {
		throw new UnsupportedError('The audio track has composition offsets, which AAC never needs; not touching it.');
	}
}
