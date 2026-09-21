import type { CommandContext } from 'just-bash';
import { stdinAsText } from '../../just-bash-compat.js';
import { stdinIsTty } from '../stdio-tty.js';

type Result = { stdout: string; stderr: string; exitCode: number };

export function fail(command: string, message: string): Result {
  const text = message.endsWith('\n') ? message : `${message}\n`;
  return { stdout: '', stderr: `${command}: ${text}`, exitCode: 1 };
}

export function ok(stdout: string): Result {
  return {
    stdout: stdout.endsWith('\n') || stdout === '' ? stdout : `${stdout}\n`,
    stderr: '',
    exitCode: 0,
  };
}

/** Read a flag path, or stdin when the path is `-`. */
export async function readArgText(ctx: CommandContext, spec: string): Promise<string> {
  if (spec === '-') return stdinAsText(ctx.stdin);
  const path = ctx.fs.resolvePath(ctx.cwd, spec);
  return ctx.fs.readFile(path);
}

/**
 * State or document text: an explicit `--state` / `--document`, otherwise
 * the pipe. A TTY with no flag is an error the caller reports.
 */
export async function readPipedOrFlag(
  ctx: CommandContext,
  flagValue: string | null
): Promise<string | null> {
  if (flagValue !== null) return readArgText(ctx, flagValue);
  if (stdinIsTty(ctx)) return null;
  return stdinAsText(ctx.stdin);
}
