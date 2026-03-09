import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';

export function createWhichCommand(): Command {
  return defineCommand('which', async (args, ctx) => {
    if (args.includes('--help') || args.includes('-h')) {
      return {
        stdout: `which - locate a command

Usage: which <command> [command...]

Prints the path of the given command(s).
  - Built-in commands resolve to /usr/bin/<name>
  - .jsh scripts resolve to their actual VFS path

Exit code 0 if all commands found, 1 if any not found.
`,
        stderr: '',
        exitCode: 0,
      };
    }

    if (args.length === 0) {
      return {
        stdout: '',
        stderr: 'which: missing argument\n',
        exitCode: 1,
      };
    }

    const registeredCommands = ctx.getRegisteredCommands?.() ?? [];
    const builtinSet = new Set(registeredCommands);

    const stdoutLines: string[] = [];
    let allFound = true;

    for (const name of args) {
      if (builtinSet.has(name)) {
        stdoutLines.push(`/usr/bin/${name}`);
      } else {
        // Not a built-in — check for .jsh files on VFS
        const jshPath = await findJshFile(name, ctx.fs);
        if (jshPath) {
          stdoutLines.push(jshPath);
        } else {
          allFound = false;
        }
      }
    }

    return {
      stdout: stdoutLines.length > 0 ? stdoutLines.join('\n') + '\n' : '',
      stderr: '',
      exitCode: allFound ? 0 : 1,
    };
  });
}

/**
 * Recursively search VFS for a .jsh file matching the given command name.
 * Returns the first match found, or null if none.
 */
async function findJshFile(
  commandName: string,
  fs: { exists(path: string): Promise<boolean>; readdir?(path: string): Promise<string[]>; stat?(path: string): Promise<{ isDirectory: boolean }> },
): Promise<string | null> {
  const targetFilename = `${commandName}.jsh`;

  async function walk(dir: string): Promise<string | null> {
    let entries: string[];
    try {
      entries = await fs.readdir!(dir);
    } catch {
      return null;
    }

    for (const entry of entries) {
      const fullPath = dir === '/' ? `/${entry}` : `${dir}/${entry}`;

      if (entry === targetFilename) {
        return fullPath;
      }

      try {
        const s = await fs.stat!(fullPath);
        if (s.isDirectory) {
          const found = await walk(fullPath);
          if (found) return found;
        }
      } catch {
        // Skip entries we can't stat
      }
    }

    return null;
  }

  // Only walk if readdir and stat are available
  if (!fs.readdir || !fs.stat) return null;
  return walk('/');
}
