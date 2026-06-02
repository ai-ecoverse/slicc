/**
 * Tests for native sudo backend selection priority using injected `SudoEnv`.
 */

import { describe, expect, it } from 'vitest';
import { type SudoEnv, selectSudoBackend } from '../../src/sudo/select.js';

function env(overrides: Partial<SudoEnv>): SudoEnv {
  return {
    platform: 'linux',
    isElectron: false,
    hasDisplay: false,
    hasTty: false,
    which: () => false,
    ...overrides,
  };
}

describe('selectSudoBackend', () => {
  it('prefers Electron above everything', () => {
    expect(selectSudoBackend(env({ isElectron: true, platform: 'darwin' })).name).toBe('electron');
  });

  it('selects osascript on macOS', () => {
    expect(selectSudoBackend(env({ platform: 'darwin' })).name).toBe('osascript');
  });

  it('selects powershell on Windows', () => {
    expect(selectSudoBackend(env({ platform: 'win32' })).name).toBe('powershell');
  });

  it('selects zenity on Linux with a display', () => {
    const backend = selectSudoBackend(env({ hasDisplay: true, which: (c) => c === 'zenity' }));
    expect(backend.name).toBe('zenity');
  });

  it('selects kdialog when zenity is absent', () => {
    const backend = selectSudoBackend(env({ hasDisplay: true, which: (c) => c === 'kdialog' }));
    expect(backend.name).toBe('kdialog');
  });

  it('falls back to TTY when there is no GUI', () => {
    expect(selectSudoBackend(env({ hasTty: true })).name).toBe('tty');
  });

  it('fails closed (deny) when no channel exists', () => {
    expect(selectSudoBackend(env({})).name).toBe('none');
  });

  it('ignores GUI tools without a display', () => {
    const backend = selectSudoBackend(env({ hasDisplay: false, which: () => true, hasTty: true }));
    expect(backend.name).toBe('tty');
  });
});
