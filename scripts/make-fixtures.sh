#!/usr/bin/env bash
# Regenerates the synthetic fixtures in fixtures/. Requires ffmpeg with libx264 and libx265.
# The clip flashes white and beeps at the start of every second, so sync is easy to judge.
set -euo pipefail
cd "$(dirname "$0")/../fixtures"

src="-f lavfi -i testsrc2=size=480x480:rate=60:duration=6 -f lavfi -i aevalsrc=if(lt(mod(t\,1)\,0.1)\,0.5*sin(2*PI*880*t)\,0):s=44100:d=6"
flash="drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='lt(mod(t,1),0.1)'"
common="-shortest -c:a aac -b:a 128k -ac 2 -map_metadata -1 -fflags +bitexact -movflags +faststart"

# Correct files (must be left alone by the fixer).
ffmpeg -v error -y $src -vf "$flash" -c:v libx264 -preset medium -crf 30 -bf 3 $common ok-h264-aac.mp4
ffmpeg -v error -y $src -vf "$flash" -c:v libx265 -preset medium -crf 32 -tag:v hvc1 -x265-params log-level=error:bframes=4 $common ok-hevc-aac.mp4

# Broken: video and audio timestamps both stretched 2x (the TikTok bug).
ffmpeg -v error -y -itsscale 2 -i ok-h264-aac.mp4 -c copy -map_metadata -1 -fflags +bitexact broken-2x-h264-aac.mp4
ffmpeg -v error -y -itsscale 2 -i ok-hevc-aac.mp4 -c copy -tag:v hvc1 -map_metadata -1 -fflags +bitexact broken-2x-hevc-aac.mp4

# Broken: only video stretched 2.5x (60 fps footage labelled as 24 fps), audio correct.
ffmpeg -v error -y -itsscale 2.5 -i ok-h264-aac.mp4 -i ok-h264-aac.mp4 -map 0:v -map 1:a -c copy -map_metadata -1 -fflags +bitexact broken-2.5x-video-only.mp4
