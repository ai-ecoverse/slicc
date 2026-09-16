/**
 * TTY hints for supplemental commands. just-bash does not expose isatty(3),
 * so commands default to interactive (TTY) behaviour and opt into a pipe
 * when tests — or future interpreter plumbing — set these flags, or when
 * stdin already carries a one-shot byte buffer.
 */

import type { ByteString } from '../just-bash-compat.js';
import { stdinAsLatin1 } from '../just-bash-compat.js';

export interface StdioTtyHints {
  stdin: ByteString;
  stdoutIsTTY?: boolean;
  stdinIsTTY?: boolean;
}

/** stdout is a TTY unless the context explicitly says otherwise. */
export function stdoutIsTty(ctx: StdioTtyHints): boolean {
  if (typeof ctx.stdoutIsTTY === 'boolean') return ctx.stdoutIsTTY;
  return true;
}

/**
 * stdin is a TTY unless the context says otherwise. A non-empty one-shot
 * stdin buffer is treated as a pipe so `producer | hear` works without a
 * flag; an explicit `stdinIsTTY: false` covers the empty-pipe case.
 *
 * Pass `stdinByteLength` when the caller already converted stdin so this
 * does not probe `ctx.stdin` a second time.
 */
export function stdinIsTty(ctx: StdioTtyHints, stdinByteLength?: number): boolean {
  if (typeof ctx.stdinIsTTY === 'boolean') return ctx.stdinIsTTY;
  if (stdinByteLength !== undefined) return stdinByteLength === 0;
  return stdinAsLatin1(ctx.stdin).length === 0;
}
