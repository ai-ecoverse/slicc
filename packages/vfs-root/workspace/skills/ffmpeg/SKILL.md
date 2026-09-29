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

Two engines, one CLI:

- **mediabunny** (WebCodecs, no install): one-input → one-output remux/transcode (h264/hevc/vp8/vp9/av1 + aac/opus/mp3/vorbis/flac/pcm), `-ss/-t/-to`, `-vf crop,scale,fps` (`transpose` alone), `-ac/-ar`, `-b:v/-b:a/-crf`, `-movflags +faststart`, `-metadata`. Explicit encoder re-encodes; `-c copy` never does. `ffprobe` uses container index.
- **`@ffmpeg/core` wasm** (ipk): lavfi, `-f concat`, filtergraphs (`drawtext`, `overlay`, `loudnorm`), analysis sinks, image/GIF output, missing codecs.

Automatic selection; stderr names the engine. Force: `FFMPEG_ENGINE=wasm ffmpeg …` or `FFMPEG_ENGINE=mediabunny ffmpeg …` (no fallback). Without `-c`, mediabunny copies when possible.

No separate ffprobe binary on wasm — runs `ffmpeg -hide_banner -i <file>` and parses the banner. Unsupported options exit non-zero by name.

## Install (wasm only)

```bash
ipk add -g @ffmpeg/core@0.12.10
```

Prefer `-g`. Match version from `ffmpeg --help` / `ffprobe --help`. No CDN fallback. `ffmpeg -version` shows loaded core.

**Multi-threaded (opt-in, single-input only):**

```bash
ipk add -g @ffmpeg/core-mt@0.12.10
FFMPEG_CORE=mt ffmpeg -i in.mp4 -c:v libx264 out.mp4
```

Refuses multi-input jobs (deadlock risk). First `ffmpeg` in a session pins the core.

## ffprobe — works

```bash
ffprobe -v error -select_streams a:0 -show_entries stream=channels \
  -of default=nw=1:nk=1 clip.mp4
ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 clip.mp4
ffprobe -v error -show_format -show_streams -of json clip.mp4
ffprobe -v error -show_entries stream=channels -of csv clip.mp4   # → stream,1
```

Fields: format + stream codec/resolution/fps/channels (see `ffprobe --help`). Qualified layouts (`5.1(side)`) resolve to channel count.

## ffprobe — fails

Anything not in `ffprobe --help`: `-count_frames`, `-show_frames`, `-show_packets`, packet writers. Drop unsupported flags or use `ffmpeg`.

## ffmpeg

```bash
ffmpeg -y -f lavfi -i testsrc=duration=1:size=320x240:rate=30 \
  -f lavfi -i sine=frequency=440:duration=1 \
  -c:v libx264 -pix_fmt yuv420p -c:a aac "$TMPDIR/clip.mp4"
```

Inputs mount lazily; single output ~1.5 GB heap cap. Wasm trap → retry once. See `ffmpeg --help`.
