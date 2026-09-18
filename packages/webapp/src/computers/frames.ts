import type { ComputerFrame } from '@slicc/shared-ts';
import { scratchDir, type TmpDirEnv } from '../shell/tmpdir-env.js';
import { encodeRgbaFrame, type RgbaFrame } from './encode-frame.js';

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

export function frozenFramePath(tmp: string, name: string, seq: number): string {
  return `${tmp.replace(/\/$/u, '')}/computer/${name}/${seq}.jpg`;
}

export function frozenFrameLine(path: string): string {
  return `${FROZEN_FRAME_PREFIX}${path}`;
}

export function computerTargetLine(id: string): string {
  return `${COMPUTER_TARGET_PREFIX}${id}`;
}

export async function writeFrozenFrame(opts: WriteFrozenFrameOpts): Promise<string> {
  const dir = `${scratchDir(opts.env).replace(/\/$/u, '')}/computer/${opts.name}`;
  const path = `${dir}/${opts.seq}.jpg`;
  const resolvedDir = opts.fs.resolvePath(opts.cwd, dir);
  const resolvedPath = opts.fs.resolvePath(opts.cwd, path);
  await opts.fs.mkdir(resolvedDir, { recursive: true });
  await opts.fs.writeFile(resolvedPath, opts.frame.bytes);
  return resolvedPath;
}

export async function jpegFromRgba(frame: RgbaFrame): Promise<Uint8Array> {
  return encodeRgbaFrame(frame, 'image/jpeg', 0.55);
}
