import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';
import { getPanelRpcClient } from '../../kernel/panel-rpc.js';

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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
      `usage: ${name} [-i|-o]\n\n` +
      '  -i        Force copy mode (read from stdin)\n' +
      '  -o        Force paste mode (write to stdout)\n' +
      '  (default) Auto-detect: stdin present = copy, no stdin = paste\n' +
      `  Example: echo hello | ${name}\n` +
      `  Example: ${name} -o > file.txt\n`,
    stderr: '',
    exitCode: 0,
  };
}

async function copyToClipboard(
  stdin: string,
  cmdName: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const hasLocal = !!globalThis.navigator?.clipboard;
  const panelRpc = !hasLocal ? getPanelRpcClient() : null;
  if (!hasLocal && !panelRpc) {
    return {
      stdout: '',
      stderr: `${cmdName}: clipboard API is unavailable\n`,
      exitCode: 1,
    };
  }

  try {
    if (hasLocal) {
      await navigator.clipboard.writeText(stdin);
    } else {
      await panelRpc!.call('clipboard-write-text', { text: stdin });
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  } catch (err) {
    return {
      stdout: '',
      stderr: `${cmdName}: failed to write to clipboard: ${formatError(err)}\n`,
      exitCode: 1,
    };
  }
}

async function pasteFromClipboard(
  cmdName: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const hasLocal = !!globalThis.navigator?.clipboard;
  const panelRpc = !hasLocal ? getPanelRpcClient() : null;
  if (!hasLocal && !panelRpc) {
    return {
      stdout: '',
      stderr: `${cmdName}: clipboard API is unavailable\n`,
      exitCode: 1,
    };
  }

  try {
    const text = hasLocal
      ? await navigator.clipboard.readText()
      : (await panelRpc!.call('clipboard-read-text', undefined)).text;
    // Return verbatim clipboard content without appending newline
    return { stdout: text, stderr: '', exitCode: 0 };
  } catch (err) {
    return {
      stdout: '',
      stderr: `${cmdName}: failed to read from clipboard: ${formatError(err)}\n`,
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
    // Explicit mode flags override auto-detection
    const forceInput = args.includes('-i');
    const forceOutput = args.includes('-o');
    if (forceInput && forceOutput) {
      return {
        stdout: '',
        stderr: `${name}: cannot use both -i and -o\n`,
        exitCode: 1,
      };
    }
    if (forceOutput) {
      return pasteFromClipboard(name);
    }
    if (forceInput || ctx.stdin.length > 0) {
      return copyToClipboard(ctx.stdin, name);
    }
    return pasteFromClipboard(name);
  });
}
