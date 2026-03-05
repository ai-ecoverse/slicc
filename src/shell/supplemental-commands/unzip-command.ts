import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';
import { unzipSync } from 'fflate';
import { dirname, ensureWithinRoot } from './shared.js';

function unzipHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: 'usage: unzip <archive.zip> [-d <destination>]\n',
    stderr: '',
    exitCode: 0,
  };
}

export function createUnzipCommand(): Command {
  return defineCommand('unzip', async (args, ctx) => {
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
      return unzipHelp();
    }

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
          stdout: '',
          stderr: `unzip: unsupported option ${arg}\n`,
          exitCode: 1,
        };
      }
      positional.push(arg);
    }

    if (positional.length < 1) {
      return {
        stdout: '',
        stderr: 'unzip: expected archive path\n',
        exitCode: 1,
      };
    }

    const archivePath = ctx.fs.resolvePath(ctx.cwd, positional[0]);
    const outputRoot = ctx.fs.resolvePath(ctx.cwd, destination || '.');
    await ctx.fs.mkdir(outputRoot, { recursive: true });

    const archiveBytes = await ctx.fs.readFileBuffer(archivePath);
    const files = unzipSync(archiveBytes);

    let extracted = 0;
    for (const [entry, content] of Object.entries(files)) {
      const normalized = entry.replace(/\\/g, '/');
      if (!normalized || normalized.endsWith('/')) continue;

      const outputPath = ctx.fs.resolvePath(outputRoot, normalized);
      if (!ensureWithinRoot(outputRoot, outputPath)) {
        return {
          stdout: '',
          stderr: `unzip: blocked suspicious path ${entry}\n`,
          exitCode: 1,
        };
      }

      const parent = dirname(outputPath);
      if (parent !== '/') await ctx.fs.mkdir(parent, { recursive: true });
      await ctx.fs.writeFile(outputPath, content);
      extracted++;
    }

    return {
      stdout: `extracted ${extracted} file(s) to ${outputRoot}\n`,
      stderr: '',
      exitCode: 0,
    };
  });
}
