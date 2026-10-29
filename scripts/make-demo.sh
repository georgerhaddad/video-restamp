#!/usr/bin/env bash
# Regenerates assets/demo/before-after.gif from the synthetic fixtures.
# Requires ffmpeg (with drawtext/libfreetype), Node >= 22.18 and pnpm.
#
# The test clip flashes white and beeps at the start of every real second. The GIF shows
# two panes playing side by side with a waveform of the audio underneath each:
#   left   the broken file's video on its own (stretched) timestamps
#   right  the same file after `pnpm restamp`
# The waveform is the real audio, which plays at real speed in both cases, with a moving
# playhead. On the right every flash lines up with a beep; on the left the footage runs at
# half speed, so it flashes every 2 s and the sync drifts.
#
# Override the font with FONT=/path/to/mono.ttf if the default is not found.
set -euo pipefail
cd "$(dirname "$0")/.."

SECONDS_SHOWN=5
FPS=20
PANE=256
WAVE=40
HEIGHT=$((38 + PANE + 6 + WAVE + 18)) # title, video, waveform, caption

# drawtext needs an explicit font file, with the drive colon escaped for the filter parser.
pick_font() {
	local candidate
	for candidate in \
		"${FONT:-}" \
		/c/Windows/Fonts/consola.ttf \
		/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf \
		/System/Library/Fonts/Menlo.ttc; do
		if [ -n "$candidate" ] && [ -f "$candidate" ]; then
			echo "$candidate"
			return
		fi
	done
	echo "no monospace font found; set FONT=/path/to/font.ttf" >&2
	exit 1
}
font_path="$(pick_font)"
case "$font_path" in
	/[a-z]/*) font_path="${font_path:1:1}:${font_path:2}" ;; # Git Bash /c/... -> c:/...
esac
font="${font_path/:/\\:}" # c:/... -> c\:/...

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
root="$(pwd)"
mkdir -p assets/demo

# 1. The fixed copy of the broken fixture.
pnpm -s restamp fixtures/broken-2x-h264-aac.mp4 "$work/fixed.mp4" > /dev/null

cd "$work"
cp "$root/fixtures/broken-2x-h264-aac.mp4" broken.mp4

# 2. Waveform of the real audio (the audio is the same in both panes).
ffmpeg -v error -y -t "$SECONDS_SHOWN" -i fixed.mp4 -vn \
	-filter_complex "aformat=channel_layouts=mono,showwavespic=s=${PANE}x${WAVE}:colors=0x7fd4ff:filter=peak:scale=lin,format=rgb24" \
	-frames:v 1 wave.png

# 3. Compose the two panes.
graph="
[0:v]fps=$FPS,scale=$PANE:$PANE:flags=lanczos,setsar=1,format=rgb24,
 pad=$PANE:$HEIGHT:0:38:color=0x141414,
 drawtext=fontfile='$font':fontsize=14:x=6:y=3:fontcolor=0xff8a80:text='BROKEN',
 drawtext=fontfile='$font':fontsize=11:x=6:y=21:fontcolor=0xcccccc:text='how a desktop player shows it'[lv];
[1:v]fps=$FPS,scale=$PANE:$PANE:flags=lanczos,setsar=1,format=rgb24,
 pad=$PANE:$HEIGHT:0:38:color=0x141414,
 drawtext=fontfile='$font':fontsize=14:x=6:y=3:fontcolor=0x8aff9a:text='RESTAMPED',
 drawtext=fontfile='$font':fontsize=11:x=6:y=21:fontcolor=0xcccccc:text='same file, header rewritten'[rv];
[2:v]split[wa][wb];
[3:v]fps=$FPS,split[pa][pb];
[wa][pa]overlay=x='t*($PANE-3)/$SECONDS_SHOWN':y=0:eval=frame[wa2];
[wb][pb]overlay=x='t*($PANE-3)/$SECONDS_SHOWN':y=0:eval=frame[wb2];
[lv][wa2]overlay=x=0:y=$((38 + PANE + 6)):eval=init[lw];
[rv][wb2]overlay=x=0:y=$((38 + PANE + 6)):eval=init[rw];
[lw]drawtext=fontfile='$font':fontsize=11:x=6:y=h-16:fontcolor=0xcccccc:text='audio, real speed'[lt];
[rw]drawtext=fontfile='$font':fontsize=11:x=6:y=h-16:fontcolor=0xcccccc:text='audio, real speed'[rt];
[lt]pad=iw+12:ih:0:0:color=0x141414[lp];
[lp][rt]hstack=inputs=2,split[g1][g2];
[g1]palettegen=max_colors=64:stats_mode=full[pal];
[g2][pal]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle
"
graph="$(echo "$graph" | tr -d '\n')"

ffmpeg -v error -y \
	-t "$SECONDS_SHOWN" -i broken.mp4 \
	-t "$SECONDS_SHOWN" -i fixed.mp4 \
	-loop 1 -framerate $FPS -t "$SECONDS_SHOWN" -i wave.png \
	-f lavfi -t "$SECONDS_SHOWN" -i "color=c=0xffd23f:s=3x${WAVE}:r=$FPS" \
	-filter_complex "$graph" \
	-t "$SECONDS_SHOWN" -loop 0 "$root/assets/demo/before-after.gif"

ls -l "$root/assets/demo/before-after.gif"
