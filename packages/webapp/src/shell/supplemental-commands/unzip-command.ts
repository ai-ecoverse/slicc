import { unzipSync } from 'fflate';
import type { Command, CommandContext } from 'just-bash';
import { defineCommand } from 'just-bash';
import { dirname, ensureWithinRoot } from './shared.js';

type CommandResult = { stdout: string; stderr: string; exitCode: number };

function unzipHelp(): CommandResult {
  return {
    stdout: 'usage: unzip <archive.zip> [-d <destination>]\n',
    stderr: '',
    exitCode: 0,
  };
}

type ParsedArgs =
  | { kind: 'ok'; archive: string; destination: string }
  | { kind: 'error'; result: CommandResult };

function parseUnzipArgs(args: string[]): ParsedArgs {
  let destination = '.';
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-d') {
      destination = args[i + 1] ?? '';
      i++;
      continue;
    }
    if (arg.startsWith('-')) {
      return {
        kind: 'error',
        result: { stdout: '', stderr: `unzip: unsupported option ${arg}\n`, exitCode: 1 },
      };
    }
    positional.push(arg);
  }

  if (positional.length < 1) {
    return {
      kind: 'error',
      result: { stdout: '', stderr: 'unzip: expected archive path\n', exitCode: 1 },
    };
  }

  return { kind: 'ok', archive: positional[0], destination: destination || '.' };
}

/**
 * Write one archive entry to `outputRoot`. Returns `true` when a file was
 * written, `false` when the entry is a directory placeholder (skipped), or a
 * `CommandResult` when the entry's resolved path escapes `outputRoot`.
 */
async function extractEntry(
  ctx: CommandContext,
  outputRoot: string,
  entry: string,
  content: Uint8Array
): Promise<boolean | CommandResult> {
  const normalized = entry.replace(/\\/g, '/');
  if (!normalized || normalized.endsWith('/')) return false;

  const outputPath = ctx.fs.resolvePath(outputRoot, normalized);
  if (!ensureWithinRoot(outputRoot, outputPath)) {
    return { stdout: '', stderr: `unzip: blocked suspicious path ${entry}\n`, exitCode: 1 };
  }

  const parent = dirname(outputPath);
  if (parent !== '/') await ctx.fs.mkdir(parent, { recursive: true });
  await ctx.fs.writeFile(outputPath, content);
  return true;
}

export function createUnzipCommand(): Command {
  return defineCommand('unzip', async (args, ctx) => {
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
      return unzipHelp();
    }

    const parsed = parseUnzipArgs(args);
    if (parsed.kind === 'error') return parsed.result;

    const archivePath = ctx.fs.resolvePath(ctx.cwd, parsed.archive);
    const outputRoot = ctx.fs.resolvePath(ctx.cwd, parsed.destination);
    await ctx.fs.mkdir(outputRoot, { recursive: true });

    const archiveBytes = await ctx.fs.readFileBuffer(archivePath);
    const files = unzipSync(archiveBytes);

    let extracted = 0;
    for (const [entry, content] of Object.entries(files)) {
      const written = await extractEntry(ctx, outputRoot, entry, content);
      if (written === true) {
        extracted++;
      } else if (written !== false) {
        return written;
      }
    }

    return {
      stdout: `extracted ${extracted} file(s) to ${outputRoot}\n`,
      stderr: '',
      exitCode: 0,
    };
  });
}
