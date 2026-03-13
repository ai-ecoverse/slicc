import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';

function pbcopyHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: 'usage: pbcopy\n\n  Copy stdin to the clipboard.\n  Example: echo hello | pbcopy\n',
    stderr: '',
    exitCode: 0,
  };
}

function pbpasteHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: 'usage: pbpaste\n\n  Paste clipboard contents to stdout.\n',
    stderr: '',
    exitCode: 0,
  };
}

function clipboardAutoHelp(name: string): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout:
      `usage: ${name}\n\n` +
      '  When stdin is provided, copies stdin to the clipboard.\n' +
      '  When no stdin is provided, pastes clipboard contents to stdout.\n' +
      `  Example: echo hello | ${name}\n`,
    stderr: '',
    exitCode: 0,
  };
}

async function copyToClipboard(stdin: string, cmdName: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (!globalThis.navigator?.clipboard) {
    return {
      stdout: '',
      stderr: `${cmdName}: clipboard API is unavailable\n`,
      exitCode: 1,
    };
  }

  try {
    await navigator.clipboard.writeText(stdin);
    return { stdout: '', stderr: '', exitCode: 0 };
  } catch (err) {
    return {
      stdout: '',
      stderr: `${cmdName}: failed to write to clipboard: ${err}\n`,
      exitCode: 1,
    };
  }
}

async function pasteFromClipboard(cmdName: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (!globalThis.navigator?.clipboard) {
    return {
      stdout: '',
      stderr: `${cmdName}: clipboard API is unavailable\n`,
      exitCode: 1,
    };
  }

  try {
    const text = await navigator.clipboard.readText();
    return { stdout: text + '\n', stderr: '', exitCode: 0 };
  } catch (err) {
    return {
      stdout: '',
      stderr: `${cmdName}: failed to read from clipboard: ${err}\n`,
      exitCode: 1,
    };
  }
}

export function createPbcopyCommand(): Command {
  return defineCommand('pbcopy', async (args, ctx) => {
    if (args.includes('--help') || args.includes('-h')) {
      return pbcopyHelp();
    }
    return copyToClipboard(ctx.stdin, 'pbcopy');
  });
}

export function createPbpasteCommand(): Command {
  return defineCommand('pbpaste', async (args) => {
    if (args.includes('--help') || args.includes('-h')) {
      return pbpasteHelp();
    }
    return pasteFromClipboard('pbpaste');
  });
}

export function createClipboardAutoCommand(name: string): Command {
  return defineCommand(name, async (args, ctx) => {
    if (args.includes('--help') || args.includes('-h')) {
      return clipboardAutoHelp(name);
    }
    if (ctx.stdin.length > 0) {
      return copyToClipboard(ctx.stdin, name);
    }
    return pasteFromClipboard(name);
  });
}
