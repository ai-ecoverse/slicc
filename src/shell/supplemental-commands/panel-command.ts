/**
 * `panel` shell command — manage SHTML canvas panels.
 *
 * Usage:
 *   panel list                  — list available .shtml panels
 *   panel open <name>           — open a panel
 *   panel close <name>          — close a panel
 *   panel refresh               — re-scan VFS for .shtml files
 *   panel send <name> <json>    — push data to a panel (agent → panel)
 */

import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';
import type { PanelManager } from '../../ui/panel-manager.js';

function panelHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout:
      'usage: panel <subcommand> [args]\n\n' +
      '  list                  List available .shtml panels\n' +
      '  open <name>           Open a panel by name\n' +
      '  close <name>          Close an open panel\n' +
      '  refresh               Re-scan VFS for .shtml files\n' +
      '  send <name> <json>    Push data to a panel\n',
    stderr: '',
    exitCode: 0,
  };
}

function getPanelManager(): PanelManager | null {
  if (typeof window === 'undefined') return null;
  const mgr = (window as unknown as Record<string, unknown>).__slicc_panelManager;
  return (mgr as PanelManager) ?? null;
}

export function createPanelCommand(): Command {
  return defineCommand('panel', async (args) => {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      return panelHelp();
    }

    const mgr = getPanelManager();
    if (!mgr) {
      return { stdout: '', stderr: 'panel: panel manager not initialized\n', exitCode: 1 };
    }

    const sub = args[0];

    switch (sub) {
      case 'list': {
        await mgr.refresh();
        const panels = mgr.available();
        if (panels.length === 0) {
          return { stdout: 'No .shtml panels found.\n', stderr: '', exitCode: 0 };
        }
        const opened = new Set(mgr.opened());
        const lines = panels.map(p => {
          const status = opened.has(p.name) ? ' [open]' : '';
          return `  ${p.name}${status}  ${p.title}  (${p.path})`;
        });
        return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 };
      }

      case 'open': {
        const name = args[1];
        if (!name) {
          return { stdout: '', stderr: 'panel open: name required\n', exitCode: 1 };
        }
        try {
          await mgr.open(name);
          return { stdout: `Panel "${name}" opened.\n`, stderr: '', exitCode: 0 };
        } catch (err) {
          return { stdout: '', stderr: `panel open: ${err instanceof Error ? err.message : String(err)}\n`, exitCode: 1 };
        }
      }

      case 'close': {
        const name = args[1];
        if (!name) {
          return { stdout: '', stderr: 'panel close: name required\n', exitCode: 1 };
        }
        mgr.close(name);
        return { stdout: `Panel "${name}" closed.\n`, stderr: '', exitCode: 0 };
      }

      case 'refresh': {
        await mgr.refresh();
        const count = mgr.available().length;
        return { stdout: `Found ${count} panel${count !== 1 ? 's' : ''}.\n`, stderr: '', exitCode: 0 };
      }

      case 'send': {
        const name = args[1];
        if (!name) {
          return { stdout: '', stderr: 'panel send: name required\n', exitCode: 1 };
        }
        const jsonStr = args.slice(2).join(' ');
        if (!jsonStr) {
          return { stdout: '', stderr: 'panel send: JSON data required\n', exitCode: 1 };
        }
        let data: unknown;
        try {
          data = JSON.parse(jsonStr);
        } catch {
          return { stdout: '', stderr: 'panel send: invalid JSON\n', exitCode: 1 };
        }
        mgr.sendToPanel(name, data);
        return { stdout: `Data sent to panel "${name}".\n`, stderr: '', exitCode: 0 };
      }

      default:
        return { stdout: '', stderr: `panel: unknown subcommand "${sub}"\n`, exitCode: 1 };
    }
  });
}
