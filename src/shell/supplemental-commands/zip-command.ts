import { defineCommand } from 'just-bash';
import type { Command, CommandContext } from 'just-bash';
import { zipSync } from 'fflate';
import { basename, joinPath } from './shared.js';

async function addPathToZip(
  ctx: CommandContext,
  fsPath: string,
  zipPath: string,
  out: Record<string, Uint8Array>
): Promise<number> {
  const stat = await ctx.fs.stat(fsPath);
  if (stat.isFile) {
    out[zipPath] = await ctx.fs.readFileBuffer(fsPath);
    return 1;
  }
  const entries = await ctx.fs.readdir(fsPath);
  let added = 0;
  for (const name of entries) {
    const childFsPath = joinPath(fsPath, name);
    const childZipPath = zipPath ? `${zipPath}/${name}` : name;
    added += await addPathToZip(ctx, childFsPath, childZipPath, out);
  }
  return added;
}

function zipHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: 'usage: zip [-r] <archive.zip> <path> [path...]\n',
    stderr: '',
    exitCode: 0,
  };
}

export function createZipCommand(): Command {
  return defineCommand('zip', async (args, ctx) => {
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
      return zipHelp();
    }

    let recursive = false;
    const positional: string[] = [];
    for (const arg of args) {
      if (arg === '-r') {
        recursive = true;
        continue;
      }
      if (arg.startsWith('-')) {
        return {
          stdout: '',
          stderr: `zip: unsupported option ${arg}\n`,
          exitCode: 1,
        };
      }
      positional.push(arg);
    }

    if (positional.length < 2) {
      return {
        stdout: '',
        stderr: 'zip: expected archive path and at least one input path\n',
        exitCode: 1,
      };
    }

    const archivePath = ctx.fs.resolvePath(ctx.cwd, positional[0]);
    const inputs = positional.slice(1);
    const archiveEntries: Record<string, Uint8Array> = {};
    let fileCount = 0;

    for (const input of inputs) {
      const resolved = ctx.fs.resolvePath(ctx.cwd, input);
      const stat = await ctx.fs.stat(resolved);
      const entryRoot = input.startsWith('/') ? input.slice(1) : input.replace(/^\.\//, '');
      const entryPath = entryRoot || basename(resolved);
      if (stat.isDirectory && !recursive) {
        return {
          stdout: '',
          stderr: `zip: ${input} is a directory (use -r)\n`,
          exitCode: 1,
        };
      }
      fileCount += await addPathToZip(ctx, resolved, entryPath, archiveEntries);
    }

    if (fileCount === 0) {
      return {
        stdout: '',
        stderr: 'zip: nothing to do\n',
        exitCode: 1,
      };
    }

    const zipped = zipSync(archiveEntries);
    await ctx.fs.writeFile(archivePath, zipped);

    return {
      stdout: `created ${archivePath} (${fileCount} file(s))\n`,
      stderr: '',
      exitCode: 0,
    };
  });
}
