import type { ByteString } from '../just-bash-compat.js';
import { stdinAsLatin1 } from '../just-bash-compat.js';

export interface StdioTtyHints {
  stdin: ByteString;
  stdoutIsTTY?: boolean;
  stdinIsTTY?: boolean;
}

export function stdoutIsTty(ctx: StdioTtyHints): boolean {
  if (typeof ctx.stdoutIsTTY === 'boolean') return ctx.stdoutIsTTY;
  return true;
}

export function stdinIsTty(ctx: StdioTtyHints, stdinByteLength?: number): boolean {
  if (typeof ctx.stdinIsTTY === 'boolean') return ctx.stdinIsTTY;
  if (stdinByteLength !== undefined) return stdinByteLength === 0;
  return stdinAsLatin1(ctx.stdin).length === 0;
}
