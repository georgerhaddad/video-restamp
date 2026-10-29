<img src="assets/icon.svg" width="64" height="64" alt="">

# video-restamp

Fixes MP4 videos whose timestamps are stretched, so that the footage plays in slow motion while the audio plays at normal speed. It rewrites a few tables in the file header and does not re-encode anything.

![Before and after: on the left the broken file flashes every 2 seconds and drifts away from the beeps; on the right the restamped file flashes in step with each beep.](assets/demo/before-after.gif)

The test clip flashes white and beeps at the start of every second. The waveform under each pane is the audio, which plays at real speed in both. The broken video runs at half speed, so it flashes every 2 seconds and falls out of step with the beeps. After restamping, every flash lines up with a beep. (GIF built from `fixtures/broken-2x-h264-aac.mp4`; see [Development](#development).)

## The problem

Some videos, seen so far on TikTok (in its own player and in its downloads), carry stretched timestamps. The typical case is 60 fps footage labelled as 30 fps, with the timestamps of the audio packets stretched about 2x as well.

What you see:

- On a desktop player the footage plays in slow motion, usually at about half speed, while the audio sounds normal.
- The picture and the sound drift apart as the clip goes on.
- The same file often looks fine on a phone.

Why: a desktop player plays the audio at its real speed, because the audio decoder produces samples at a fixed rate regardless of the timestamps. It then follows the video timestamps for the picture, which are stretched, so the video lags behind. Many phone players seem to cope with the same file, but we have not looked into why. We have also not confirmed why the stretching happens on the platform side; this section describes what we have observed.

## Use it

### Web app

Everything runs in the browser tab. Files are read locally and never uploaded.

```sh
pnpm install
pnpm dev
```

Open the address Vite prints, drop in one or more `.mp4`, `.mov` or `.m4v` files, and download the fixed copy (`<name>_restamped.mp4`). Files that are already fine are reported and left alone; files that can't be fixed get a reason.

To build a static site that you can host anywhere:

```sh
pnpm build      # writes the site to build/
pnpm preview    # optional: serve build/ locally
```

### Command line

Needs Node 22.18 or newer (it runs the TypeScript directly) and the dependencies from `pnpm install`.

```sh
pnpm restamp in.mp4 [out.mp4]
```

It prints what it found and, if the file is broken, writes the fixed copy. Without `out.mp4` the output is `<name>_restamped.mp4` next to the input. If the file is already fine nothing is written. If it can't be handled the reason is printed and the exit code is 1.

```
$ pnpm restamp fixtures/real-world-heaac-hevc.mp4 fixed.mp4
status:   broken
length:   15.581 s real, speed factor 1.998
video:    hvc1, 934 frames, claims 31.133 s at 30.00 fps, really 60 fps (needs fix)
audio:    mp4a HE-AAC 44100 Hz, claims 31.090 s (needs fix)
wrote:    fixed.mp4
```

The "speed factor" is the length the video timestamps claim divided by the real length. 1 means fine, 2 means the footage plays twice too slowly.

### As a library

The core is `src/lib/restamp/` (TypeScript, no dependencies). `analyze(bytes)` reports, `restamp(bytes)` reports and returns a fixed copy when the file is broken. Neither throws; unsupported input comes back as `{ status: 'unsupported', reason }`. The contract is in `src/lib/restamp/types.ts`.

## How it works

An MP4 stores the compressed audio and video in one `mdat` box and describes it, including every sample's timestamp, in the `moov` header. Only the header is wrong in an affected file, so only the header is rewritten.

1. **The true length comes from the audio.** An AAC packet always decodes to a fixed number of samples (1024, or 960), and that can't be stretched. The packet count times the samples per packet, divided by the sample rate, is the real length. The tool reads the AAC configuration (`esds`) to get the sample rate and samples per packet, including HE-AAC with implicit or explicit SBR, where the output rate is double the core rate but a packet still lasts the same time.
2. **The true frame rate follows from that.** Real fps is the video frame count divided by the real length. If it is within 1.5% of 24, 25, 30, 48, 50, 60, 90, 100 or 120 it is snapped to that rate, otherwise the measured value is used. Only whole-number rates are in the list: 29.97 versus 30 is a 0.1% difference, finer than a length measured to the nearest audio packet can resolve on a short clip.
3. **Broken or not.** A track is broken if its claimed length differs from the real length by more than 2%, or (audio) its packets don't each last the expected time. If neither track is off, the file is reported as fine and no output is produced.
4. **What gets rewritten.** Video: every frame gets a duration of exactly 1/fps (`stts`), composition offsets (`ctts`) and `cslg` are recomputed so the frame order is preserved, and the media duration (`mdhd`), edit list (`elst`), track duration (`tkhd`) and movie duration (`mvhd`) follow. If the media timescale isn't a multiple of the frame rate it is raised to the least common multiple, so there is a single uniform `stts` entry and no drift. Audio: every packet gets its exact duration, except that a shorter final packet is kept, with the same header fields updated. A single normal-speed edit list (encoder-delay trimming) is kept and remapped.
5. **Where the new header goes.** Nothing else in the file moves, so every chunk offset (`stco`/`co64`) stays valid.
   - If the new `moov` fits where the old one was, it is written there and any slack becomes a `free` box. The file size and all offsets are unchanged. This is the usual case, because the new tables are smaller.
   - Otherwise, if the old `moov` is the last box, it is replaced and the file shrinks or grows.
   - Otherwise the new `moov` is appended at the end and the old one is turned into a `free` box. The file grows, and a fast-start layout (header first) is lost.
6. **Lossless.** No frame or audio sample is decoded, re-encoded or touched; the `mdat` bytes stay at the same offsets. The tests check with ffmpeg that the packets in the output are byte-identical to the input.

### Real-world example

`fixtures/real-world-heaac-hevc.mp4` is an affected TikTok file (HEVC video, HE-AAC audio) with identifying metadata blanked. Numbers from `pnpm restamp` and `ffprobe`:

| | Before | After |
| --- | --- | --- |
| Length (ffprobe, container) | 31.133 s | 15.581 s |
| Audio length | 31.090 s | 15.581 s |
| Video length | 31.133 s | 15.567 s |
| Frame rate (ffprobe) | 30 fps | 60 fps |
| Video frames | 934 | 934 |
| File size | 6,763,387 bytes | 6,763,387 bytes |

The video is 14 ms shorter than the audio because 934 frames at exactly 60 fps is 15.567 s, while the audio length implies 59.94 fps. That is the cost of snapping to whole-number rates.

## Limitations

The real length is taken from the audio, so the audio has to be there and has to be trustworthy.

- **Audio length is the reference.** If a file's audio is genuinely shorter or longer than its video, that can't be told apart from stretched video. The tool will "fix" it by changing the video speed. It refuses only when the implied frame rate falls outside 1 to 240 fps.
- **AAC audio only.** The file needs a video track and an AAC audio track (Main, LC, SSR, LTP, with or without SBR/PS). Files with no audio track, other audio codecs (MP3, Opus, AC-3 and so on), other AAC object types, an empty track, or more than one audio sample description are reported as unsupported. Only the first video and first audio track are used; other tracks are not retimed.
- **Unfragmented MP4/MOV only.** Fragmented MP4 (`moof`/`mvex`), files with no `moov`, or more than one, are unsupported.
- **Edit lists.** None, or a single edit at normal speed, are handled. Multi-segment edit lists, empty edits and edits that change the rate are unsupported.
- **Frame rate is made constant.** Every video frame gets the same duration, so variable-frame-rate footage becomes constant-rate in the output. Rates that aren't whole numbers snap to the nearest whole-number rate (59.94 becomes 60, 29.97 becomes 30, 23.976 becomes 24).
- **Precision is one audio packet.** The real length is known to the nearest AAC packet (about 23 ms at 44.1 kHz), so short clips have a larger relative error.
- **Some audio timescales can't be corrected.** If the audio needs fixing and its media timescale isn't a whole multiple of its sample rate, or the audio track has composition offsets (AAC never needs them), the file is reported as unsupported rather than guessed at.
- **Whole file in memory.** The file is read into memory, and so is the output copy. Very large files are limited by the browser or Node heap.
- **A file that is already right is left alone.** A claimed length within 2% of the real one counts as fine.

## Development

Requires Node 22.18 or newer and pnpm 9 or newer. `ffmpeg`/`ffprobe` on PATH are optional for the tests and needed for fixtures and the demo.

```sh
pnpm install
pnpm dev        # dev server
pnpm check      # svelte-check and type checking
pnpm test       # vitest
pnpm build      # static site in build/
```

`pnpm test` runs the library and UI-text tests. The output checks (decodes without errors, packets byte-identical, expected timestamps) use ffprobe and ffmpeg when they are on PATH.

Layout:

- `src/lib/restamp/`: the library. `index.ts` is the entry, `types.ts` the contract.
- `src/routes`, `src/lib/components`, `src/lib/ui`: the web app.
- `scripts/restamp.ts`: the CLI.
- `fixtures/`: test files. The synthetic ones are made by `scripts/make-fixtures.sh` (needs ffmpeg with libx264 and libx265): a test pattern that flashes white and beeps at the start of every second, plus broken copies made by stretching timestamps with `-itsscale`. `real-world-heaac-hevc.mp4` is a real affected file.
- `assets/demo/`: the README demo.

Regenerate the fixtures and the demo GIF (Git Bash, or any POSIX shell with ffmpeg):

```sh
bash scripts/make-fixtures.sh
bash scripts/make-demo.sh
```

`make-demo.sh` runs the CLI on `fixtures/broken-2x-h264-aac.mp4`, builds a waveform of the audio, and composes the two panes into `assets/demo/before-after.gif`. It looks for a monospace font on Windows, Linux and macOS; set `FONT=/path/to/font.ttf` to override.

### Stack

SvelteKit 2, Svelte 5, Vite 7, `adapter-static`, pnpm and IBM Plex Mono, the same stack as the web app of [cobalt](https://github.com/imputnet/cobalt). That is deliberate: the library is dependency-free and the UI follows the same conventions, so the core could later be proposed upstream to cobalt as a contribution without a rewrite.

## License

No license has been chosen yet. Until one is added, all rights are reserved. Note that cobalt is licensed under AGPL-3.0, which matters if the code is meant to be contributed upstream.
