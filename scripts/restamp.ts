// Command-line wrapper: pnpm restamp [--force] <in.mp4> [out.mp4]
// Prints the analysis and, if the file is broken, writes the fixed copy
// (default: <name>_restamped.mp4 next to the input). --force also fixes a 'suspect' file.
//
// Runs on Node's built-in type stripping (on by default since Node 22.18). The library
// uses extensionless relative imports, as Vite and SvelteKit expect, so we teach Node's
// resolver to try '.ts' before loading it.

import { readFileSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { basename, dirname, extname, join } from 'node:path';

registerHooks({
	resolve(specifier, context, nextResolve) {
		try {
			return nextResolve(specifier, context);
		} catch (error) {
			if (specifier.startsWith('.') && context.parentURL?.endsWith('.ts')) {
				return nextResolve(`${specifier}.ts`, context);
			}
			throw error;
		}
	}
});

const { restamp } = await import('../src/lib/restamp/index.ts');

const args = process.argv.slice(2);
const force = args.includes('--force');
const [input, outputArg] = args.filter((arg) => arg !== '--force');
if (!input) {
	console.error('usage: pnpm restamp [--force] <in.mp4> [out.mp4]');
	process.exit(2);
}

const { analysis, output } = restamp(new Uint8Array(readFileSync(input)), { force });

if (analysis.status === 'unsupported') {
	console.log(`unsupported: ${analysis.reason}`);
	process.exit(1);
}

const { video, audio } = analysis;
const seconds = (value: number) => `${value.toFixed(3)} s`;
console.log(`status:   ${analysis.status}`);
console.log(`length:   ${seconds(analysis.realSeconds)} real, speed factor ${analysis.speedFactor.toFixed(3)}`);
console.log(
	`video:    ${video.codec}, ${video.frames} frames, claims ${seconds(video.claimedSeconds)} at ${video.labelledFps.toFixed(2)} fps, ` +
		`really ${Number(video.realFps.toFixed(3))} fps${video.needsFix ? ' (needs fix)' : ''}`
);
console.log(
	`audio:    ${audio.codec} ${audio.profile} ${audio.sampleRate} Hz, claims ${seconds(audio.claimedSeconds)}${audio.needsFix ? ' (needs fix)' : ''}`
);

if (output) {
	const outPath = outputArg ?? join(dirname(input), `${basename(input, extname(input))}_restamped${extname(input) || '.mp4'}`);
	writeFileSync(outPath, output);
	console.log(`wrote:    ${outPath}`);
} else if (analysis.status === 'suspect') {
	console.log("not fixed: the audio timing looks normal, so the video may be stretched or the audio may just be");
	console.log('          shorter or longer than the video. Run with --force to make the video match the audio.');
} else {
	console.log('nothing to fix');
}
