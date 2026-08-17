import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';

const HELP = `Usage: unlink FILE
Remove FILE. Symbolic links are removed without following their target.
`;

export function createUnlinkCommand(): Command {
  return defineCommand('unlink', async (args, ctx) => {
    if (args.includes('--help')) return { stdout: HELP, stderr: '', exitCode: 0 };
    if (args.length !== 1 || args[0].startsWith('-')) {
      return {
        stdout: '',
        stderr: args.length === 0 ? 'unlink: missing operand\n' : 'unlink: extra operand\n',
        exitCode: 1,
      };
    }
    const path = ctx.fs.resolvePath(ctx.cwd, args[0]);
    try {
      const stat = ctx.fs.lstat ? await ctx.fs.lstat(path) : await ctx.fs.stat(path);
      if (stat.isDirectory && !stat.isSymbolicLink) {
        return {
          stdout: '',
          stderr: `unlink: cannot unlink '${args[0]}': Is a directory\n`,
          exitCode: 1,
        };
      }
      await ctx.fs.rm(path, { recursive: false, force: false });
      return { stdout: '', stderr: '', exitCode: 0 };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { stdout: '', stderr: `unlink: cannot unlink '${args[0]}': ${detail}\n`, exitCode: 1 };
    }
  });
}
