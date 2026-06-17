import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import { PLAYWRIGHT_COMMAND_NAMES } from './playwright-command.js';

const COMMAND_CATEGORIES = new Map<string, string[]>([
  [
    'File operations',
    [
      'ls',
      'cat',
      'head',
      'tail',
      'wc',
      'touch',
      'mkdir',
      'rm',
      'cp',
      'mv',
      'ln',
      'chmod',
      'stat',
      'readlink',
      'file',
      'rmdir',
      'rsync',
    ],
  ],
  [
    'Text processing',
    [
      'grep',
      'sed',
      'awk',
      'sort',
      'uniq',
      'cut',
      'tr',
      'tee',
      'diff',
      'column',
      'comm',
      'egrep',
      'fgrep',
      'expand',
      'unexpand',
      'fold',
      'join',
      'nl',
      'od',
      'paste',
      'rev',
      'split',
      'strings',
      'tac',
    ],
  ],
  ['Search', ['find', 'rg']],
  ['Navigation & paths', ['pwd', 'basename', 'dirname', 'tree', 'du', 'cd']],
  ['Archives', ['zip', 'unzip', 'pdftk', 'pdf', 'gunzip', 'gzip', 'zcat']],
  ['Media', ['convert', 'magick', 'ffmpeg', 'screencapture']],
  ['Audio', ['say', 'afplay', 'chime']],
  [
    'Environment & shell',
    [
      'echo',
      'printf',
      'env',
      'printenv',
      'export',
      'alias',
      'unalias',
      'history',
      'clear',
      'true',
      'false',
      'bash',
      'sh',
      'commands',
      'which',
      'uname',
      'man',
      'host',
      'oauth-token',
      'secret',
      'nuke',
      'models',
      'local-llm',
      'cost',
      'hostname',
      'whoami',
      'help',
      'sleep',
      'time',
      'timeout',
      'oauth-domain',
    ],
  ],
  ['Data processing', ['xargs', 'jq', 'base64', 'date', 'expr', 'seq']],
  ['Hashes', ['md5sum', 'sha1sum', 'sha256sum']],
  ['Network', ['curl', 'wget', 'dig', 'websocat', 'html-to-markdown']],
  ['Version control', ['git']],
  ['Languages', ['node', 'python', 'python3', 'sqlite3']],
  ['Build tools', ['tsc', 'esbuild', 'test', 'biome']],
  ['Packages', ['ipk', 'npm', 'i', 'ipx']],
  ['Skills', ['skill', 'upskill']],
  ['Browser & UI', ['serve', 'open', 'imgcat', ...PLAYWRIGHT_COMMAND_NAMES, 'sprinkle']],
  ['Clipboard', ['pbcopy', 'pbpaste', 'xclip', 'xsel']],
  ['Filesystem', ['mount', 'fswatch']],
  ['Scoops & agents', ['agent', 'mcp', 'webhook', 'crontask']],
  ['Process', ['ps', 'kill']],
]);

function formatHelp(
  commands: string[],
  jshCommands: string[] = [],
  workflowCommands: string[] = []
): string {
  const lines: string[] = [];
  const available = new Set(commands);

  // Dedup: jsh + workflow names are already in `commands` because they're registered
  // into builtinCommandNames. Remove them from the registered set to prevent duplication.
  for (const n of jshCommands) available.delete(n);
  for (const n of workflowCommands) available.delete(n);

  lines.push('Available commands:\n');

  const uncategorized: string[] = [];

  for (const [category, cmds] of COMMAND_CATEGORIES) {
    const present = cmds.filter((cmd) => available.has(cmd));
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

  if (jshCommands.length > 0) {
    lines.push('  User scripts (.jsh):');
    lines.push(`    ${jshCommands.sort().join(', ')}\n`);
  }

  if (workflowCommands.length > 0) {
    lines.push('  Workflows:');
    lines.push(`    ${workflowCommands.sort().join(', ')}\n`);
  }

  lines.push("Use '<command> --help' for details on a specific command.");

  return lines.join('\n') + '\n';
}

export interface CommandsCommandOptions {
  /** Function that returns discovered .jsh command names. */
  getJshCommands?: () => Promise<string[]>;
  getWorkflowCommands?: () => Promise<string[]>;
}

export function createCommandsCommand(options: CommandsCommandOptions = {}): Command {
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
    const jshCommands = (await options.getJshCommands?.()) ?? [];
    const workflowCommands = (await options.getWorkflowCommands?.()) ?? [];
    return {
      stdout: formatHelp(commands, jshCommands, workflowCommands),
      stderr: '',
      exitCode: 0,
    };
  });
}
