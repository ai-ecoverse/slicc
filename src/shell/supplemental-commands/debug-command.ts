import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';

/**
 * Extension-only command to toggle debug tabs (Terminal, Memory).
 *
 * May run in either the side panel shell or the offscreen agent shell.
 * Tries the direct window hook first (panel), then falls back to
 * chrome.runtime messaging (offscreen → service worker → panel).
 */
export function createDebugCommand(): Command {
  return defineCommand('debug', async (args) => {
    if (args.includes('--help') || args.includes('-h')) {
      return {
        stdout:
          'usage: debug [on|off]\n\n' +
          '  Toggle debug tabs (Terminal, Memory) in extension mode.\n' +
          '  Without arguments, shows current state.\n',
        stderr: '',
        exitCode: 0,
      };
    }

    const arg = args[0]?.toLowerCase();
    if (arg !== 'on' && arg !== 'off' && arg !== undefined) {
      return {
        stdout: '',
        stderr: `debug: unknown argument '${arg}' (use 'on' or 'off')\n`,
        exitCode: 1,
      };
    }

    if (!arg) {
      try {
        const raw = localStorage.getItem('slicc-hidden-tabs');
        const hidden = raw ? JSON.parse(raw) as string[] : ['terminal', 'memory'];
        const on = !hidden.includes('terminal');
        return { stdout: `Debug tabs: ${on ? 'on' : 'off'}\n`, stderr: '', exitCode: 0 };
      } catch {
        return { stdout: 'Debug tabs: off\n', stderr: '', exitCode: 0 };
      }
    }

    const show = arg === 'on';

    // Try direct hook (works when running in the side panel's shell)
    const toggle = (window as any).__slicc_debug_tabs as ((show: boolean) => void) | undefined;
    if (toggle) {
      toggle(show);
      return { stdout: `Debug tabs ${show ? 'enabled' : 'hidden'}\n`, stderr: '', exitCode: 0 };
    }

    // Offscreen context: relay via chrome.runtime to the panel
    try {
      (chrome as any).runtime.sendMessage({
        source: 'offscreen',
        payload: { type: 'debug-tabs', show },
      });
      return { stdout: `Debug tabs ${show ? 'enabled' : 'hidden'}\n`, stderr: '', exitCode: 0 };
    } catch {
      return { stdout: '', stderr: 'debug: failed to send toggle message\n', exitCode: 1 };
    }
  });
}
