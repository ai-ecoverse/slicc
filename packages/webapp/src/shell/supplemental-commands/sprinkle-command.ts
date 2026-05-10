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

import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';
import { showToolUIFromContext } from '../../tools/tool-ui.js';
import type { SprinkleManager } from '../../ui/sprinkle-manager.js';
import {
  getSprinkleRoute,
  setSprinkleRoute,
  clearSprinkleRoute,
  getAllSprinkleRoutes,
} from '../../ui/sprinkle-bridge.js';

function sprinkleHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout:
      'usage: sprinkle <subcommand> [args]\n\n' +
      '  list                  List available .shtml sprinkles\n' +
      '  open <name>           Open a sprinkle by name\n' +
      '  close <name>          Close an open sprinkle\n' +
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

function getSprinkleManager(): SprinkleManager | null {
  // Read from `globalThis` rather than `window` so the lookup works in
  // both the page realm (where the real `SprinkleManager` is published
  // by the standalone bootstrap) and the kernel-worker realm (where a
  // BroadcastChannel-backed proxy from `sprinkle-bridge-channel.ts` is
  // published on `globalThis.__slicc_sprinkleManager`).
  const mgr = (globalThis as Record<string, unknown>).__slicc_sprinkleManager;
  return (mgr as SprinkleManager) ?? null;
}

export function createSprinkleCommand(): Command {
  return defineCommand('sprinkle', async (args, ctx) => {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      return sprinkleHelp();
    }

    const sub = args[0];

    // Handle 'chat' subcommand separately - doesn't need sprinkle manager
    if (sub === 'chat') {
      // Get HTML from args or stdin
      let html = args.slice(1).join(' ');

      // Check for piped stdin
      if (!html && ctx.stdin) {
        html = ctx.stdin;
      }

      if (!html) {
        return { stdout: '', stderr: 'sprinkle chat: HTML content required\n', exitCode: 1 };
      }

      // Show inline UI in chat
      const result = await showToolUIFromContext({
        html,
        onAction: async (action, data) => {
          return { action, data };
        },
      });

      if (result === null) {
        return {
          stdout: '',
          stderr: 'sprinkle chat: not in tool execution context\n',
          exitCode: 1,
        };
      }

      // Return the action result as JSON
      return { stdout: JSON.stringify(result) + '\n', stderr: '', exitCode: 0 };
    }

    const mgr = getSprinkleManager();
    if (!mgr) {
      return { stdout: '', stderr: 'sprinkle: sprinkle manager not initialized\n', exitCode: 1 };
    }

    switch (sub) {
      case 'list': {
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

      case 'open': {
        const name = args[1];
        if (!name) {
          return { stdout: '', stderr: 'sprinkle open: name required\n', exitCode: 1 };
        }
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

      case 'close': {
        const name = args[1];
        if (!name) {
          return { stdout: '', stderr: 'sprinkle close: name required\n', exitCode: 1 };
        }
        mgr.close(name);
        return { stdout: `Sprinkle "${name}" closed.\n`, stderr: '', exitCode: 0 };
      }

      case 'refresh': {
        await mgr.refresh();
        const count = mgr.available().length;
        return {
          stdout: `Found ${count} sprinkle${count !== 1 ? 's' : ''}.\n`,
          stderr: '',
          exitCode: 0,
        };
      }

      case 'route': {
        const name = args[1];
        if (!name) {
          // List all routes
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
          return {
            stdout: 'Sprinkle routes:\n' + lines.join('\n') + '\n',
            stderr: '',
            exitCode: 0,
          };
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
          // Show current route for this sprinkle
          const current = getSprinkleRoute(name);
          if (current) {
            return { stdout: `${name} -> ${current}\n`, stderr: '', exitCode: 0 };
          }
          return { stdout: `${name} -> cone (default)\n`, stderr: '', exitCode: 0 };
        }

        setSprinkleRoute(name, scoop);
        return {
          stdout: `Sprinkle "${name}" lick events will route to scoop "${scoop}".\n`,
          stderr: '',
          exitCode: 0,
        };
      }

      case 'send': {
        const name = args[1];
        if (!name) {
          return { stdout: '', stderr: 'sprinkle send: name required\n', exitCode: 1 };
        }
        const jsonStr = args.slice(2).join(' ');
        if (!jsonStr) {
          return { stdout: '', stderr: 'sprinkle send: JSON data required\n', exitCode: 1 };
        }
        let data: unknown;
        try {
          data = JSON.parse(jsonStr);
        } catch {
          return { stdout: '', stderr: 'sprinkle send: invalid JSON\n', exitCode: 1 };
        }
        mgr.sendToSprinkle(name, data);
        return { stdout: `Data sent to sprinkle "${name}".\n`, stderr: '', exitCode: 0 };
      }

      default:
        return { stdout: '', stderr: `sprinkle: unknown subcommand "${sub}"\n`, exitCode: 1 };
    }
  });
}
