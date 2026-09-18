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

export interface SudoEnv {
  platform: NodeJS.Platform;
  isElectron: boolean;
  hasDisplay: boolean;
  hasTty: boolean;
  which: (cmd: string) => boolean;
}

export function detectSudoEnv(): SudoEnv {
  return {
    platform: process.platform,
    isElectron: typeof process.versions.electron === 'string',
    hasDisplay: !!process.env.DISPLAY || !!process.env.WAYLAND_DISPLAY,
    hasTty: !!process.stdin.isTTY,
    which: defaultWhich,
  };
}

export function defaultWhich(cmd: string): boolean {
  try {
    const probe = process.platform === 'win32' ? 'where' : 'which';
    execFileSync(probe, [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

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
