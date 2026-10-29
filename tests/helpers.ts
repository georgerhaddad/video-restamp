// Shared test helpers: fixtures and ffmpeg/ffprobe wrappers.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES = fileURLToPath(new URL('../fixtures', import.meta.url));

export function fixture(name: string): Uint8Array {
	return new Uint8Array(readFileSync(join(FIXTURES, name)));
}

export function fixturePath(name: string): string {
	return join(FIXTURES, name);
}

/**
 * A real affected TikTok (HEVC + HE-AAC). It's a third-party video, so it isn't committed
 * (see .gitignore); tests that use it run only when a copy is placed in fixtures/.
 */
export const REAL_WORLD = 'real-world-heaac-hevc.mp4';
export const hasRealWorld = existsSync(join(FIXTURES, REAL_WORLD));
if (!hasRealWorld) console.warn(`fixtures/${REAL_WORLD} not present (it isn't committed): skipping real-world cases`);

/** `[REAL_WORLD]` when the file is present, else `[]`: for building test lists. */
export const realWorld = (): string[] => (hasRealWorld ? [REAL_WORLD] : []);

export const hasFfmpeg =
	spawnSync('ffprobe', ['-version']).status === 0 && spawnSync('ffmpeg', ['-version']).status === 0;

let tempDir: string | undefined;
export function writeTemp(name: string, data: Uint8Array): string {
	tempDir ??= mkdtempSync(join(tmpdir(), 'restamp-test-'));
	const path = join(tempDir, name);
	writeFileSync(path, data);
	return path;
}

export interface ProbedStream {
	index: number;
	codec_type: 'video' | 'audio';
	duration: string;
	avg_frame_rate: string;
	r_frame_rate: string;
	nb_frames: string;
}

export function probeStreams(path: string): ProbedStream[] {
	const json = execFileSync(
		'ffprobe',
		['-v', 'error', '-show_entries', 'stream=index,codec_type,duration,avg_frame_rate,r_frame_rate,nb_frames', '-of', 'json', path],
		{ encoding: 'utf8' }
	);
	return JSON.parse(json).streams;
}

/** Per stream, the size and MD5 of every packet, in decode order (from ffmpeg's framemd5 muxer). */
export function packetHashes(path: string): Map<number, string[]> {
	const text = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-map', '0', '-c', 'copy', '-f', 'framemd5', '-'], {
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024
	});
	const streams = new Map<number, string[]>();
	for (const line of text.split('\n')) {
		if (!line.trim() || line.startsWith('#')) continue;
		// stream_index, dts, pts, duration, size, hash
		const columns = line.split(',').map((column) => column.trim());
		const stream = Number(columns[0]);
		if (!streams.has(stream)) streams.set(stream, []);
		streams.get(stream)!.push(`${columns[4]} ${columns[5]}`);
	}
	return streams;
}

/** Decodes every stream fully; returns whatever ffmpeg reports at the error level. */
export function decodeErrors(path: string): string {
	const result = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'null', '-'], { encoding: 'utf8' });
	return `${result.stderr}${result.status === 0 ? '' : `\nexit status ${result.status}`}`.trim();
}

/** Deterministic pseudo-random numbers (mulberry32), so fuzz failures are reproducible. */
export function random(seed: number): () => number {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Fast byte comparison (vitest's toEqual walks typed arrays element by element). */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
}

export function probeFormatDuration(path: string): number {
	const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], { encoding: 'utf8' });
	return Number(out.trim());
}

export interface Packet {
	pts: number; // seconds
	dts: number;
	duration: number;
}

/** Per stream index, every packet's timestamps in decode (file) order, as ffprobe reports them. */
export function probePackets(path: string): Map<number, Packet[]> {
	const text = execFileSync(
		'ffprobe',
		['-v', 'error', '-show_entries', 'packet=stream_index,pts_time,dts_time,duration_time', '-of', 'csv=p=0', path],
		{ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
	);
	const streams = new Map<number, Packet[]>();
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const [stream, pts, dts, duration] = line.split(',');
		const index = Number(stream);
		if (!streams.has(index)) streams.set(index, []);
		streams.get(index)!.push({ pts: Number(pts), dts: Number(dts), duration: Number(duration) });
	}
	return streams;
}

/** Indices sorted by presentation time (ties by decode order). */
export function presentationOrder(packets: Packet[]): number[] {
	return packets.map((_, i) => i).sort((a, b) => packets[a].pts - packets[b].pts || a - b);
}
