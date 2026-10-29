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
# Same bug with the moov first (faststart), the layout real downloads use.
ffmpeg -v error -y -itsscale 2 -i ok-hevc-aac.mp4 -c copy -tag:v hvc1 -map_metadata -1 -fflags +bitexact -movflags +faststart broken-2x-faststart.mp4

# Broken: only video stretched 2.5x (60 fps footage labelled as 24 fps), audio correct.
ffmpeg -v error -y -itsscale 2.5 -i ok-h264-aac.mp4 -i ok-h264-aac.mp4 -map 0:v -map 1:a -c copy -map_metadata -1 -fflags +bitexact broken-2.5x-video-only.mp4

# Small 64x64 clips for the cases that must not be mistaken for stretched files, and for
# harder broken ones. Same flash and beep every second; mono audio at a low bitrate.
tiny_video() { echo "-f lavfi -i testsrc2=size=64x64:rate=$1:duration=$2"; }
tiny_audio() { echo "-f lavfi -i aevalsrc=if(lt(mod(t\,1)\,0.1)\,0.5*sin(2*PI*880*t)\,0):s=44100:d=$1"; }
tiny="-vf $flash -c:v libx264 -preset veryfast -crf 35 -bf 3 -c:a aac -b:a 32k -ac 1 -map_metadata -1 -fflags +bitexact"

# Correct: the base clip, 6 s at 60 fps.
ffmpeg -v error -y $(tiny_video 60 6) $(tiny_audio 6) $tiny -movflags +faststart ok-tiny.mp4

# Correct but imperfect: must not be "fixed".
# Audio genuinely shorter / longer than the video. Ambiguous, so 'suspect'.
ffmpeg -v error -y $(tiny_video 60 6) $(tiny_audio 5) $tiny suspect-audio-shorter.mp4
ffmpeg -v error -y $(tiny_video 60 5) $(tiny_audio 6) $tiny suspect-audio-longer.mp4
# Cut without re-encoding: the edit lists hide the frames and audio before 1.5 s.
ffmpeg -v error -y -ss 1.5 -i ok-tiny.mp4 -c copy -map_metadata -1 -fflags +bitexact ok-trimmed.mp4
# A 0.5 s gap in the audio timestamps at 3 s (5.5 s of audio, so both tracks still end at 6 s).
ffmpeg -v error -y $(tiny_video 60 6) $(tiny_audio 5.5) $tiny tmp-gap-source.mp4
ffmpeg -v error -y -i tmp-gap-source.mp4 -c copy -bsf:a 'setts=ts=TS+if(gte(TS\,132300)\,22050\,0)' -map_metadata -1 -fflags +bitexact ok-audio-gap.mp4
rm tmp-gap-source.mp4
# No edit lists: the first audio packet's duration covers the encoder and B-frame delay.
ffmpeg -v error -y -i ok-tiny.mp4 -c copy -use_editlist 0 -map_metadata -1 -fflags +bitexact ok-no-editlist.mp4
# Variable frame rate: 3 s at 60 fps, then 3 s at 30 fps.
ffmpeg -v error -y $(tiny_video 60 6) $(tiny_audio 6) -fps_mode vfr \
	-vf "$flash,select='lt(t,3)+not(mod(n,2))'" -c:v libx264 -preset veryfast -crf 35 -bf 3 \
	-c:a aac -b:a 32k -ac 1 -map_metadata -1 -fflags +bitexact ok-vfr.mp4
# 60 s at 59.94 fps: long enough that snapping to 60 would end 60 ms before the audio.
ffmpeg -v error -y $(tiny_video 60000/1001 60) $(tiny_audio 60) $tiny ok-5994.mp4

# Broken: stretched 2x like the TikTok bug, but harder.
ffmpeg -v error -y -itsscale 2 -i ok-vfr.mp4 -c copy -map_metadata -1 -fflags +bitexact broken-2x-vfr.mp4
ffmpeg -v error -y -itsscale 2 -i ok-5994.mp4 -c copy -map_metadata -1 -fflags +bitexact broken-2x-5994.mp4
# A video timescale that isn't a multiple of 60 (37 ticks per stretched frame), so the fix
# has to raise it.
ffmpeg -v error -y -itsscale 2 -i ok-tiny.mp4 -c copy -video_track_timescale 1110 -map_metadata -1 -fflags +bitexact broken-2x-timescale-1110.mp4

# Unsupported: a second audio track would keep its old timing.
ffmpeg -v error -y -itsscale 2 -i ok-tiny.mp4 -map 0:v -map 0:a -map 0:a -c copy -map_metadata -1 -fflags +bitexact unsupported-two-audio.mp4
