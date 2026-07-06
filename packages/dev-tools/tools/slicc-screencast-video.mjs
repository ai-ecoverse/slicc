// slicc-screencast-video.mjs — best-effort frame → video assembly.
//
// The frames + manifest.json written by slicc-screencast.mjs are the source of
// truth (their timestamps are the real capture times). This helper is a
// convenience that stitches the JPEG/PNG sequence into a single file for quick
// human review. It never blocks the recording: any failure is surfaced to the
// caller, which keeps the frames regardless.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolve an ffmpeg binary: PATH first, then Playwright's bundled ffmpeg
 * (installed alongside its browsers). Returns the executable path or null.
 */
export function resolveFfmpeg({ env = process.env } = {}) {
  const onPath = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  if (onPath.status === 0) return 'ffmpeg';
  const cache =
    env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== '0'
      ? env.PLAYWRIGHT_BROWSERS_PATH
      : join(homedir(), '.cache', 'ms-playwright');
  if (!existsSync(cache)) return null;
  for (const dir of readdirSync(cache).filter((d) => d.startsWith('ffmpeg-'))) {
    for (const bin of ['ffmpeg-linux', 'ffmpeg-mac', 'ffmpeg-win64.exe', 'ffmpeg']) {
      const p = join(cache, dir, bin);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/** Last few stderr lines, trimmed — enough to explain an ffmpeg failure. */
function tailErr(res) {
  return (res.stderr || '').split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 300);
}

/** Read the ordered frame files into one Buffer for `image2pipe` stdin. */
function concatFrames(dir, frames, ext) {
  const buffers = frames.map(({ name, seq }) =>
    readFileSync(join(dir, name ?? `frame-${String(seq).padStart(6, '0')}.${ext}`))
  );
  return Buffer.concat(buffers);
}

/**
 * Assemble frames into a video. Codec order: webm (VP8) → mp4 (h264) → gif —
 * VP8/webm is first because it's the ONLY encoder in Playwright's bundled
 * ffmpeg. Two input strategies are tried per codec: the `image2` file-sequence
 * demuxer (full ffmpeg builds, low memory), then an `image2pipe` stdin feed
 * (works with Playwright's stripped ffmpeg, which lacks the `image2` demuxer).
 * Returns the output path, or throws.
 */
export async function assembleVideo(opts, frames, { ffmpeg = resolveFfmpeg() } = {}) {
  if (!ffmpeg) throw new Error('no ffmpeg found (PATH or Playwright cache)');
  if (!frames || frames.length === 0) throw new Error('no frames to assemble');
  const ext = opts.format === 'png' ? 'png' : 'jpeg';
  const pattern = join(opts.out, `frame-%06d.${ext}`);
  const fps = String(opts.fps || 10);
  const codecs = [
    ['screencast.webm', ['-c:v', 'libvpx', '-b:v', '1M', '-pix_fmt', 'yuv420p']],
    ['screencast.mp4', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p']],
    ['screencast.gif', []],
  ];
  let lastErr = '';

  // Strategy A — file-sequence input (image2 demuxer).
  for (const [name, codecArgs] of codecs) {
    const outFile = join(opts.out, name);
    const args = [
      '-y',
      '-framerate',
      fps,
      '-start_number',
      '1',
      '-i',
      pattern,
      ...codecArgs,
      outFile,
    ];
    const res = spawnSync(ffmpeg, args, { encoding: 'utf8' });
    if (res.status === 0 && existsSync(outFile)) return outFile;
    lastErr = tailErr(res);
  }

  // Strategy B — piped input (image2pipe demuxer) for stripped ffmpeg builds.
  // The concatenated JPEG/PNG bytes are an MJPEG/APNG stream on stdin; the
  // build must be told the input codec (`-c:v mjpeg|png`) and read `pipe:0`
  // explicitly (Playwright's ffmpeg lacks the `-`/`fd:` shorthands).
  const inCodec = ext === 'png' ? 'png' : 'mjpeg';
  const input = concatFrames(opts.out, frames, ext);
  for (const [name, codecArgs] of codecs) {
    const outFile = join(opts.out, name);
    const args = [
      '-y',
      '-f',
      'image2pipe',
      '-c:v',
      inCodec,
      '-framerate',
      fps,
      '-i',
      'pipe:0',
      ...codecArgs,
      outFile,
    ];
    const res = spawnSync(ffmpeg, args, { input, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
    if (res.status === 0 && existsSync(outFile)) return outFile;
    lastErr = tailErr(res);
  }
  throw new Error(`all strategies failed: ${lastErr}`);
}
