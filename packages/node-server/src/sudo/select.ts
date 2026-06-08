/**
 * Native sudo backend selection (priority order).
 *
 *   1. Electron  → `dialog.showMessageBox`
 *   2. macOS     → `osascript`
 *   3. Windows   → PowerShell
 *   4. Linux+GUI → `zenity` / `kdialog`
 *   5. headless  → editable TTY
 *   6. no channel → fail closed (deny) + log
 *
 * The environment probe is injectable so tests can force any branch without
 * touching the real platform / spawning `which`.
 */

import { execFileSync } from 'child_process';
import {
  createDenyBackend,
  createKdialogBackend,
  createOsascriptBackend,
  createPowerShellBackend,
  createZenityBackend,
} from './dialog-backends.js';
import { createElectronBackend } from './electron-backend.js';
import { createTtyBackend } from './tty-backend.js';
import type { SudoBackend } from './types.js';

/** Probed runtime facts used to pick a backend. */
export interface SudoEnv {
  platform: NodeJS.Platform;
  isElectron: boolean;
  hasDisplay: boolean;
  hasTty: boolean;
  which: (cmd: string) => boolean;
}

/** Probe the live environment. */
export function detectSudoEnv(): SudoEnv {
  return {
    platform: process.platform,
    isElectron: typeof process.versions.electron === 'string',
    hasDisplay: !!process.env.DISPLAY || !!process.env.WAYLAND_DISPLAY,
    hasTty: !!process.stdin.isTTY,
    which: defaultWhich,
  };
}

/** Synchronous best-effort `which`; false when the binary is absent. */
function defaultWhich(cmd: string): boolean {
  try {
    const probe = process.platform === 'win32' ? 'where' : 'which';
    execFileSync(probe, [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Select the highest-priority available backend for the given environment.
 * Always returns a backend — the deny backend is the fail-closed terminal.
 */
export function selectSudoBackend(env: SudoEnv = detectSudoEnv()): SudoBackend {
  if (env.isElectron) return createElectronBackend();
  if (env.platform === 'darwin') return createOsascriptBackend();
  if (env.platform === 'win32') return createPowerShellBackend();
  if (env.hasDisplay) {
    if (env.which('zenity')) return createZenityBackend();
    if (env.which('kdialog')) return createKdialogBackend();
  }
  if (env.hasTty) return createTtyBackend();
  return createDenyBackend('none');
}
