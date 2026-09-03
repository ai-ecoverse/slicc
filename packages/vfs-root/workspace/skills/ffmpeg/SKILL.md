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

Both commands share one realm-scoped `@ffmpeg/core` wasm instance. There is
**no separate ffprobe binary** for this pin — `ffprobe` stages the input,
runs `ffmpeg -hide_banner -i <file>` with no output, parses the Input #N
banner, and formats a useful subset of fields. Unsupported options are
rejected by name (never silently dropped).

## Install

```bash
ipk add -g @ffmpeg/core@0.12.10
```

Prefer `-g` so scoops and the cone share one copy. Follow the pinned
version printed by `ffmpeg --help` / `ffprobe --help` if it differs.
There is no CDN fallback.

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

Fields sourced from the banner: format `filename` / `format_name` /
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

See `ffmpeg --help` for the supported surface. A wasm trap recycles the
shared instance — retry once; very large inputs may need smaller passes.
