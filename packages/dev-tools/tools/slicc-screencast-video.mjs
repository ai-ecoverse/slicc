import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

function tailErr(res) {
  return (res.stderr || '').split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 300);
}

function concatFrames(dir, frames, ext) {
  const buffers = frames.map(({ name, seq }) =>
    readFileSync(join(dir, name ?? `frame-${String(seq).padStart(6, '0')}.${ext}`))
  );
  return Buffer.concat(buffers);
}

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
