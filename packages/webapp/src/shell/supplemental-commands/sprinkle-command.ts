/**
 * `sprinkle` shell command — manage SHTML sprinkle panels.
 *
 * Usage:
 *   sprinkle list                  — list available .shtml sprinkles
 *   sprinkle open <name>           — open a sprinkle
 *   sprinkle close <name>          — close a sprinkle
 *   sprinkle refresh               — re-scan VFS for .shtml files
 *   sprinkle send <name> <json>    — push data to a sprinkle (agent -> sprinkle)
 *   sprinkle chat <html>           — show inline HTML in chat (Tool UI)
 *   echo "<html>" | sprinkle chat  — show piped HTML in chat
 */

import type { Command, CommandContext } from 'just-bash';
import { defineCommand } from 'just-bash';
import { showToolUIFromContext } from '../../tools/tool-ui.js';
import { stdinAsText } from '../just-bash-compat.js';
import type { SprinkleManagerHandle } from '../sprinkle-manager-handle.js';
import {
  clearSprinkleRoute,
  getAllSprinkleRoutes,
  getSprinkleRoute,
  setSprinkleRoute,
} from '../sprinkle-routes.js';

type Result = { stdout: string; stderr: string; exitCode: number };

function sprinkleHelp(): Result {
  return {
    stdout:
      'usage: sprinkle <subcommand> [args]\n\n' +
      '  list                  List available .shtml sprinkles\n' +
      '  open <name>           Open a sprinkle by name\n' +
      '  close <name>          Close an open sprinkle\n' +
      '  reload <name>         Reload an open sprinkle (re-read .shtml)\n' +
      '  refresh               Re-scan VFS for .shtml files\n' +
      '  send <name> <json>    Push data to a sprinkle\n' +
      '  route <name> --scoop <scoop>  Route lick events to a scoop instead of cone\n' +
      '  route <name> --clear          Clear routing (revert to cone)\n' +
      '  route                         List all sprinkle routes\n' +
      '  chat <html>           Show inline HTML in chat (Tool UI)\n' +
      '                        Use data-action="name" on buttons for callbacks\n' +
      '                        Pipe HTML: echo "<div>...</div>" | sprinkle chat\n',
    stderr: '',
    exitCode: 0,
  };
}

function getSprinkleManager(): SprinkleManagerHandle | null {
  const mgr = (globalThis as Record<string, unknown>).__slicc_sprinkleManager;
  return (mgr as SprinkleManagerHandle) ?? null;
}

async function handleChat(args: string[], ctx: CommandContext): Promise<Result> {
  let html = args.slice(1).join(' ');
  if (!html) {
    const stdinText = stdinAsText(ctx.stdin);
    if (stdinText) html = stdinText;
  }
  if (!html) {
    return { stdout: '', stderr: 'sprinkle chat: HTML content required\n', exitCode: 1 };
  }
  const result = await showToolUIFromContext({
    html,
    onAction: async (action, data) => ({ action, data }),
  });
  if (result === null) {
    return { stdout: '', stderr: 'sprinkle chat: not in tool execution context\n', exitCode: 1 };
  }
  return { stdout: JSON.stringify(result) + '\n', stderr: '', exitCode: 0 };
}

async function handleList(mgr: SprinkleManagerHandle): Promise<Result> {
  await mgr.refresh();
  const sprinkles = mgr.available();
  if (sprinkles.length === 0) {
    return { stdout: 'No .shtml sprinkles found.\n', stderr: '', exitCode: 0 };
  }
  const opened = new Set(mgr.opened());
  const lines = sprinkles.map((p) => {
    const status = opened.has(p.name) ? ' [open]' : '';
    return `  ${p.name}${status}  ${p.title}  (${p.path})`;
  });
  return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 };
}

async function handleOpen(mgr: SprinkleManagerHandle, args: string[]): Promise<Result> {
  const name = args[1];
  if (!name) return { stdout: '', stderr: 'sprinkle open: name required\n', exitCode: 1 };
  try {
    await mgr.open(name);
    return { stdout: `Sprinkle "${name}" opened.\n`, stderr: '', exitCode: 0 };
  } catch (err) {
    return {
      stdout: '',
      stderr: `sprinkle open: ${err instanceof Error ? err.message : String(err)}\n`,
      exitCode: 1,
    };
  }
}

function handleClose(mgr: SprinkleManagerHandle, args: string[]): Result {
  const name = args[1];
  if (!name) return { stdout: '', stderr: 'sprinkle close: name required\n', exitCode: 1 };
  mgr.close(name);
  return { stdout: `Sprinkle "${name}" closed.\n`, stderr: '', exitCode: 0 };
}

async function handleReload(mgr: SprinkleManagerHandle, args: string[]): Promise<Result> {
  const name = args[1];
  if (!name) return { stdout: '', stderr: 'sprinkle reload: name required\n', exitCode: 1 };
  try {
    await mgr.reload(name);
    return { stdout: `Sprinkle "${name}" reloaded.\n`, stderr: '', exitCode: 0 };
  } catch (err) {
    return {
      stdout: '',
      stderr: `sprinkle reload: ${err instanceof Error ? err.message : String(err)}\n`,
      exitCode: 1,
    };
  }
}

async function handleRefresh(mgr: SprinkleManagerHandle): Promise<Result> {
  await mgr.refresh();
  const count = mgr.available().length;
  return {
    stdout: `Found ${count} sprinkle${count !== 1 ? 's' : ''}.\n`,
    stderr: '',
    exitCode: 0,
  };
}

function handleRoute(args: string[]): Result {
  const name = args[1];
  if (!name) {
    const routes = getAllSprinkleRoutes();
    const entries = Object.entries(routes);
    if (entries.length === 0) {
      return {
        stdout: 'No sprinkle routes configured (all licks go to cone).\n',
        stderr: '',
        exitCode: 0,
      };
    }
    const lines = entries.map(([s, scoop]) => `  ${s} -> ${scoop}`);
    return { stdout: 'Sprinkle routes:\n' + lines.join('\n') + '\n', stderr: '', exitCode: 0 };
  }
  if (args.includes('--clear')) {
    clearSprinkleRoute(name);
    return {
      stdout: `Route cleared for sprinkle "${name}" (licks will go to cone).\n`,
      stderr: '',
      exitCode: 0,
    };
  }
  const scoopIdx = args.indexOf('--scoop');
  const scoop = scoopIdx !== -1 ? args[scoopIdx + 1] : undefined;
  if (!scoop) {
    const current = getSprinkleRoute(name);
    if (current) return { stdout: `${name} -> ${current}\n`, stderr: '', exitCode: 0 };
    return { stdout: `${name} -> cone (default)\n`, stderr: '', exitCode: 0 };
  }
  setSprinkleRoute(name, scoop);
  return {
    stdout: `Sprinkle "${name}" lick events will route to scoop "${scoop}".\n`,
    stderr: '',
    exitCode: 0,
  };
}

function handleSend(mgr: SprinkleManagerHandle, args: string[]): Result {
  const name = args[1];
  if (!name) return { stdout: '', stderr: 'sprinkle send: name required\n', exitCode: 1 };
  const jsonStr = args.slice(2).join(' ');
  if (!jsonStr) return { stdout: '', stderr: 'sprinkle send: JSON data required\n', exitCode: 1 };
  let data: unknown;
  try {
    data = JSON.parse(jsonStr);
  } catch {
    return { stdout: '', stderr: 'sprinkle send: invalid JSON\n', exitCode: 1 };
  }
  mgr.sendToSprinkle(name, data);
  return { stdout: `Data sent to sprinkle "${name}".\n`, stderr: '', exitCode: 0 };
}

export function createSprinkleCommand(): Command {
  return defineCommand('sprinkle', async (args, ctx) => {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      return sprinkleHelp();
    }
    const sub = args[0];
    if (sub === 'chat') return handleChat(args, ctx);

    const mgr = getSprinkleManager();
    if (!mgr) {
      return { stdout: '', stderr: 'sprinkle: sprinkle manager not initialized\n', exitCode: 1 };
    }

    switch (sub) {
      case 'list':
        return handleList(mgr);
      case 'open':
        return handleOpen(mgr, args);
      case 'close':
        return handleClose(mgr, args);
      case 'reload':
        return handleReload(mgr, args);
      case 'refresh':
        return handleRefresh(mgr);
      case 'route':
        return handleRoute(args);
      case 'send':
        return handleSend(mgr, args);
      default:
        return { stdout: '', stderr: `sprinkle: unknown subcommand "${sub}"\n`, exitCode: 1 };
    }
  });
}
