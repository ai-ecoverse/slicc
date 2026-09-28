import type { ByteString } from '../just-bash-compat.js';
import { stdinAsLatin1 } from '../just-bash-compat.js';

export interface StdioTtyHints {
  stdin: ByteString;
  stdoutIsTTY?: boolean;
  stdinIsTTY?: boolean;
  env?: ReadonlyMap<string, string>;
}

export const STDIN_ISATTY_ENV = 'SLICC_STDIN_ISATTY';
export const STDOUT_ISATTY_ENV = 'SLICC_STDOUT_ISATTY';

function envHint(ctx: StdioTtyHints, name: string): boolean | undefined {
  const value = ctx.env?.get(name);
  return value === '0' ? false : value === '1' ? true : undefined;
}

export function stdoutIsTty(ctx: StdioTtyHints): boolean {
  if (typeof ctx.stdoutIsTTY === 'boolean') return ctx.stdoutIsTTY;
  return envHint(ctx, STDOUT_ISATTY_ENV) ?? true;
}

export function stdinIsTty(ctx: StdioTtyHints, stdinByteLength?: number): boolean {
  if (typeof ctx.stdinIsTTY === 'boolean') return ctx.stdinIsTTY;
  const hinted = envHint(ctx, STDIN_ISATTY_ENV);
  if (hinted !== undefined) return hinted;
  if (stdinByteLength !== undefined) return stdinByteLength === 0;
  return stdinAsLatin1(ctx.stdin).length === 0;
}
