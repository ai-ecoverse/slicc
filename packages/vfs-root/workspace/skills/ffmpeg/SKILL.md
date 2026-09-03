---
name: ffmpeg
description: |
  Use this when encoding, remuxing, filtering, or probing media with SLICC's
  `ffmpeg` / `ffprobe` shell commands. Covers the shared `@ffmpeg/core` ipk
  install, what the emulated `ffprobe` can and cannot do, and the Remotion-
  shaped channel / duration / container queries agents actually write.
allowed-tools: bash
---

# ffmpeg / ffprobe

Both commands have two engines behind one CLI:

- **mediabunny** (WebCodecs, hardware encoders, streams from disk): used
  automatically for one-input → one-output jobs whose every option it can
  express — remux, transcode to h264/hevc/vp8/vp9/av1 + aac/opus/mp3/vorbis/
  flac/pcm, `-ss/-t/-to` trims, `-vf crop,scale,fps` (written in that
  order; `transpose` only on its own), `-ac/-ar`, `-b:v/-b:a/-crf`,
  `-movflags +faststart`, `-metadata`. Needs no install. An explicit
  encoder always re-encodes; `-c copy` never does.
  `ffprobe` answers from its container index (typed fields, no wasm boot).
- **`@ffmpeg/core` wasm** (ipk-installed): everything else — lavfi sources,
  `-f concat`, filtergraphs (`drawtext`, `overlay`, `loudnorm`, …), analysis
  sinks (`-f null`), image/GIF output, codecs the browser lacks.

The choice is automatic and stderr says which engine ran. Force one with
`FFMPEG_ENGINE=wasm ffmpeg …` (byte-identical ffmpeg behaviour) or
`FFMPEG_ENGINE=mediabunny ffmpeg …` (fail instead of falling back, and see
why). Without an explicit `-c`, mediabunny copies streams the container can
hold rather than re-encoding them.

There is **no separate ffprobe binary**: on the wasm engine `ffprobe` runs
`ffmpeg -hide_banner -i <file>` with no output and parses the Input #N
banner. Unsupported options are rejected by name (never silently dropped).

## Install (wasm engine only)

```bash
ipk add -g @ffmpeg/core@0.12.10
```

Prefer `-g` so scoops and the cone share one copy. Follow the pinned
version printed by `ffmpeg --help` / `ffprobe --help` if it differs.
There is no CDN fallback. `ffmpeg -version` prints a `core:` line saying
which core is loaded.

**Multi-threaded core (opt-in, single-input jobs only).** On a
cross-origin-isolated leader (the hosted tab on current Chrome):

```bash
ipk add -g @ffmpeg/core-mt@0.12.10
FFMPEG_CORE=mt ffmpeg -i in.mp4 -c:v libx264 out.mp4
```

It uses several CPU cores for libx264 / libvpx and caps `-threads` and
`-filter_threads` for you (pass your own to override). It deadlocks on any
job with **more than one input** (ffmpeg's per-input demux threads), so such
jobs are refused on it — run them without `FFMPEG_CORE=mt`. The first
`ffmpeg` in a session decides which core stays loaded.

## ffprobe — what works

Useful Remotion-shaped probes:

```bash
# Audio channel count (select first audio stream)
ffprobe -v error -select_streams a:0 -show_entries stream=channels \
  -of default=nw=1:nk=1 clip.mp4

# Duration (seconds)
ffprobe -v error -show_entries format=duration \
  -of default=nw=1:nk=1 clip.mp4

# Full structured dump
ffprobe -v error -show_format -show_streams -of json clip.mp4

# CSV: section name prefix (real ffprobe `p`); csv=p=0 is values only
ffprobe -v error -show_entries stream=channels -of csv clip.mp4
# → stream,1
```

Fields (from mediabunny's index, or the wasm banner as fallback): format `filename` / `format_name` /
`duration` / `start_time` / `bit_rate`; per-stream `codec_type` /
`codec_name` / profile / resolution / fps / `sample_rate` / `channels` /
`channel_layout` / bit rates. Channel layouts with qualifiers
(`5.1(side)`) still resolve to a channel count.

## ffprobe — what does not work

Anything not listed in `ffprobe --help` exits non-zero. Examples that
fail on purpose: `-count_frames`, `-show_frames`, `-show_packets`,
packet-level writers. Do not invent flags — if a real-ffprobe recipe
uses an unsupported option, drop it or use `ffmpeg` itself.

## ffmpeg

Same core. Encode / remux / lavfi sources through the usual argv form:

```bash
ffmpeg -y -f lavfi -i testsrc=duration=1:size=320x240:rate=30 \
  -f lavfi -i sine=frequency=440:duration=1 \
  -c:v libx264 -pix_fmt yuv420p -c:a aac "$TMPDIR/clip.mp4"
```

See `ffmpeg --help` for the supported surface. Inputs are mounted lazily
(never copied into the wasm heap), so input size is bounded by disk; the
output is buffered in the wasm heap until the run ends, so keep a single
output under ~1.5 GB. A wasm trap recycles the shared instance — retry once.
