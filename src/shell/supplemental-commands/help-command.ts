import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';

const COMMAND_CATEGORIES = new Map<string, string[]>([
  ['File operations', ['ls', 'cat', 'head', 'tail', 'wc', 'touch', 'mkdir', 'rm', 'cp', 'mv', 'ln', 'chmod', 'stat', 'readlink']],
  ['Text processing', ['grep', 'sed', 'awk', 'sort', 'uniq', 'cut', 'tr', 'tee', 'diff']],
  ['Search', ['find', 'rg']],
  ['Navigation & paths', ['pwd', 'basename', 'dirname', 'tree', 'du', 'cd']],
  ['Archives', ['zip', 'unzip', 'pdftk', 'pdf']],
  ['Media', ['convert', 'magick']],
  ['Environment & shell', ['echo', 'printf', 'env', 'printenv', 'export', 'alias', 'unalias', 'history', 'clear', 'true', 'false', 'bash', 'sh', 'commands']],
  ['Data processing', ['xargs', 'jq', 'base64', 'date']],
  ['Network', ['curl', 'wget', 'html-to-markdown']],
  ['Version control', ['git']],
  ['Languages', ['node', 'python', 'python3', 'sqlite3']],
  ['Skills', ['skill', 'upskill']],
  ['Browser & UI', ['open', 'webhook']],
  ['Filesystem', ['mount']],
]);

function formatHelp(commands: string[]): string {
  const lines: string[] = [];
  const available = new Set(commands);

  lines.push('Available commands:\n');

  const uncategorized: string[] = [];

  for (const [category, cmds] of COMMAND_CATEGORIES) {
    const present = cmds.filter(cmd => available.has(cmd));
    if (present.length > 0) {
      lines.push(`  ${category}:`);
      lines.push(`    ${present.join(', ')}\n`);
      for (const cmd of present) {
        available.delete(cmd);
      }
    }
  }

  for (const cmd of available) {
    uncategorized.push(cmd);
  }

  if (uncategorized.length > 0) {
    lines.push('  Other:');
    lines.push(`    ${uncategorized.sort().join(', ')}\n`);
  }

  lines.push("Use '<command> --help' for details on a specific command.");

  return lines.join('\n') + '\n';
}

export function createCommandsCommand(): Command {
  return defineCommand('commands', async (args, ctx) => {
    if (args.includes('--help') || args.includes('-h')) {
      return {
        stdout: `commands - display available commands

Usage: commands [command]

Options:
  -h, --help    Show this help message

If a command name is provided, shows help for that command.
Otherwise, lists all available commands.

Note: This is an enhanced version of 'help' that shows all custom commands.
`,
        stderr: '',
        exitCode: 0,
      };
    }

    // If a specific command is requested, show its help
    if (args.length > 0 && ctx.exec) {
      const cmd = args[0];
      return ctx.exec(`${cmd} --help`, { cwd: ctx.cwd });
    }

    // Get all registered commands
    const commands = ctx.getRegisteredCommands?.() ?? [];
    return {
      stdout: formatHelp(commands),
      stderr: '',
      exitCode: 0,
    };
  });
}
