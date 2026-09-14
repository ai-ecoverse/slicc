/**
 * Tests for the Electron sudo backend using injected `showMessageBox` /
 * `promptInput` seams so the real Electron module is never imported.
 */

import { describe, expect, it, vi } from 'vitest';
import { createElectronBackend } from '../../src/sudo/electron-backend.js';
import type { SudoApproveRequest } from '../../src/sudo/types.js';

const electronMocks = vi.hoisted(() => {
  const showMessageBox = vi.fn(async () => ({ response: 1 }));
  const executeJavaScript = vi.fn<(code: string) => Promise<unknown>>(
    async () => 'edited by default prompt'
  );
  const loadURL = vi.fn(async () => undefined);
  const destroy = vi.fn();
  class BrowserWindow {
    webContents = { executeJavaScript };
    loadURL = loadURL;
    destroy = destroy;
  }
  return { showMessageBox, executeJavaScript, loadURL, destroy, BrowserWindow };
});

vi.mock('electron', () => ({
  dialog: { showMessageBox: electronMocks.showMessageBox },
  BrowserWindow: electronMocks.BrowserWindow,
}));

const REQ: SudoApproveRequest = {
  kind: 'write',
  detail: '/workspace/.git/config',
  suggestedPattern: '/workspace/.git/**',
};

describe('electron backend', () => {
  it('uses the real Electron adapter defaults through the lazy module boundary', async () => {
    electronMocks.showMessageBox.mockResolvedValueOnce({ response: 1 });
    expect(await createElectronBackend().prompt(REQ)).toEqual({ decision: 'allow' });
    expect(electronMocks.showMessageBox).toHaveBeenCalledOnce();

    electronMocks.showMessageBox.mockResolvedValueOnce({ response: 2 });
    electronMocks.executeJavaScript.mockResolvedValueOnce(' edited by default prompt ');
    expect(await createElectronBackend().prompt(REQ)).toEqual({
      decision: 'always',
      pattern: 'edited by default prompt',
    });
    expect(electronMocks.loadURL).toHaveBeenCalledWith('data:text/html,<title>SLICC sudo</title>');
    expect(electronMocks.destroy).toHaveBeenCalled();
  });

  it('maps a non-string default prompt result to cancellation and still destroys the window', async () => {
    electronMocks.showMessageBox.mockResolvedValueOnce({ response: 2 });
    electronMocks.executeJavaScript.mockResolvedValueOnce(null);
    expect(await createElectronBackend().prompt(REQ)).toEqual({
      decision: 'always',
      pattern: '/workspace/.git/**',
    });
    expect(electronMocks.destroy).toHaveBeenCalled();
  });

  it('allows when button index 1 is chosen', async () => {
    const backend = createElectronBackend({
      showMessageBox: vi.fn(async () => ({ response: 1 })),
    });
    expect(await backend.prompt(REQ)).toEqual({ decision: 'allow' });
  });

  it('denies when button index 0 is chosen', async () => {
    const backend = createElectronBackend({
      showMessageBox: vi.fn(async () => ({ response: 0 })),
    });
    expect(await backend.prompt(REQ)).toEqual({ decision: 'deny' });
  });

  it('captures an edited Always pattern (index 2)', async () => {
    const backend = createElectronBackend({
      showMessageBox: vi.fn(async () => ({ response: 2 })),
      promptInput: vi.fn(async () => '/workspace/.git/hooks/**'),
    });
    expect(await backend.prompt(REQ)).toEqual({
      decision: 'always',
      pattern: '/workspace/.git/hooks/**',
    });
  });

  it('falls back to suggested when the prompt is cancelled', async () => {
    const backend = createElectronBackend({
      showMessageBox: vi.fn(async () => ({ response: 2 })),
      promptInput: vi.fn(async () => null),
    });
    expect(await backend.prompt(REQ)).toEqual({
      decision: 'always',
      pattern: '/workspace/.git/**',
    });
  });

  it('denies when showMessageBox throws', async () => {
    const backend = createElectronBackend({
      showMessageBox: vi.fn(async () => {
        throw new Error('no display');
      }),
    });
    expect(await backend.prompt(REQ)).toEqual({ decision: 'deny' });
  });

  it('falls back to suggested when promptInput throws', async () => {
    const backend = createElectronBackend({
      showMessageBox: vi.fn(async () => ({ response: 2 })),
      promptInput: vi.fn(async () => {
        throw new Error('window gone');
      }),
    });
    expect(await backend.prompt(REQ)).toEqual({
      decision: 'always',
      pattern: '/workspace/.git/**',
    });
  });
});
