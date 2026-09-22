/**
 * Frozen-frame JPEG writer. Every input verb ends by writing a small JPEG
 * to `$TMPDIR/computer/<name>/<seq>.jpg` and printing `screen: <path>`.
 *
 * The extension comes from the payload's magic bytes, so a backend that
 * hands back PNG despite `format: 'jpeg'` gets a `.png` name rather than a
 * file whose extension lies about its contents.
 */

import type { ComputerFrame } from '@slicc/shared-ts';
import { scratchDir, type TmpDirEnv } from '../shell/tmpdir-env.js';
import { encodeRgbaFrame, type RgbaFrame } from './encode-frame.js';
import { sniffFrameMime } from './frame-bytes.js';

export const FROZEN_FRAME_PREFIX = 'screen: ';
export const COMPUTER_TARGET_PREFIX = 'target: ';

export interface FrozenFrameFs {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
  writeFile(path: string, data: Uint8Array | string): Promise<unknown>;
  resolvePath(cwd: string, path: string): string;
}

export interface WriteFrozenFrameOpts {
  fs: FrozenFrameFs;
  cwd: string;
  env: TmpDirEnv;
  name: string;
  seq: number;
  frame: ComputerFrame;
}

/**
 * Extension for what the frame actually holds, read from the magic bytes and
 * never from `frame.mime`. An adapter that ignores `format: 'jpeg'` gets an
 * honest `.png` name instead of PNG bytes in a `.jpg` file (#3372).
 */
export function frozenFrameExtension(bytes: Uint8Array): 'jpg' | 'png' {
  return sniffFrameMime(bytes) === 'image/png' ? 'png' : 'jpg';
}

export function frozenFramePath(
  tmp: string,
  name: string,
  seq: number,
  ext: 'jpg' | 'png' = 'jpg'
): string {
  return `${tmp.replace(/\/$/u, '')}/computer/${name}/${seq}.${ext}`;
}

export function frozenFrameLine(path: string): string {
  return `${FROZEN_FRAME_PREFIX}${path}`;
}

export function computerTargetLine(id: string): string {
  return `${COMPUTER_TARGET_PREFIX}${id}`;
}

export async function writeFrozenFrame(opts: WriteFrozenFrameOpts): Promise<string> {
  const dir = `${scratchDir(opts.env).replace(/\/$/u, '')}/computer/${opts.name}`;
  const path = `${dir}/${opts.seq}.${frozenFrameExtension(opts.frame.bytes)}`;
  const resolvedDir = opts.fs.resolvePath(opts.cwd, dir);
  const resolvedPath = opts.fs.resolvePath(opts.cwd, path);
  await opts.fs.mkdir(resolvedDir, { recursive: true });
  await opts.fs.writeFile(resolvedPath, opts.frame.bytes);
  return resolvedPath;
}

/** Encode an RGBA snapshot as a small JPEG suitable for a frozen frame. */
export async function jpegFromRgba(frame: RgbaFrame): Promise<Uint8Array> {
  return encodeRgbaFrame(frame, 'image/jpeg', 0.55);
}
