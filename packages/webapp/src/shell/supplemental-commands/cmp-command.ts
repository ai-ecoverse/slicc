/** Byte-for-byte file comparison compatible with the common `cmp` surface. */

import type { Command, CommandContext } from 'just-bash';
import { defineCommand } from 'just-bash';
import { stdinAsLatin1 } from '../just-bash-compat.js';

type Result = { stdout: string; stderr: string; exitCode: number };

export function createCmpCommand(): Command {
  return defineCommand('cmp', async (args, ctx) => {
    const quiet = args.some((arg) => arg === '-s' || arg === '--quiet' || arg === '--silent');
    const files = args.filter((arg) => !['-s', '--quiet', '--silent'].includes(arg));
    if (files.length !== 2 || files.some((arg) => arg.startsWith('-') && arg !== '-')) {
      return {
        stdout: '',
        stderr: 'cmp: usage: cmp [-s|--quiet|--silent] FILE1 FILE2\n',
        exitCode: 2,
      };
    }
    const first = await readInput(ctx, files[0]);
    if ('error' in first) return first.error;
    const second = await readInput(ctx, files[1]);
    if ('error' in second) return second.error;
    const difference = firstDifference(first.bytes, second.bytes);
    if (!difference) return { stdout: '', stderr: '', exitCode: 0 };
    if (quiet) return { stdout: '', stderr: '', exitCode: 1 };
    if (difference.eof) {
      const shorter = first.bytes.length < second.bytes.length ? files[0] : files[1];
      return {
        stdout: '',
        stderr: `cmp: EOF on ${shorter} after byte ${difference.byte - 1}, line ${difference.line}\n`,
        exitCode: 1,
      };
    }
    return {
      stdout: `${files[0]} ${files[1]} differ: byte ${difference.byte}, line ${difference.line}\n`,
      stderr: '',
      exitCode: 1,
    };
  });
}

async function readInput(
  ctx: CommandContext,
  name: string
): Promise<{ bytes: Uint8Array } | { error: Result }> {
  if (name === '-') {
    const input = stdinAsLatin1(ctx.stdin);
    return { bytes: Uint8Array.from(input, (char) => char.charCodeAt(0) & 0xff) };
  }
  try {
    return { bytes: await ctx.fs.readFileBuffer(ctx.fs.resolvePath(ctx.cwd, name)) };
  } catch {
    return {
      error: {
        stdout: '',
        stderr: `cmp: ${name}: No such file or directory\n`,
        exitCode: 2,
      },
    };
  }
}

function firstDifference(
  first: Uint8Array,
  second: Uint8Array
): { byte: number; line: number; eof: boolean } | null {
  const length = Math.min(first.length, second.length);
  let line = 1;
  for (let index = 0; index < length; index++) {
    if (first[index] !== second[index]) return { byte: index + 1, line, eof: false };
    if (first[index] === 10) line++;
  }
  return first.length === second.length ? null : { byte: length + 1, line, eof: true };
}
