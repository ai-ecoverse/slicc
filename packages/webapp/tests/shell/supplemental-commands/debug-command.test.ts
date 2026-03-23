import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IFileSystem } from 'just-bash';
import { createDebugCommand } from './debug-command.js';

function createMockCtx() {
  return {
    fs: {
      resolvePath: (b: string, p: string) => (p.startsWith('/') ? p : `${b}/${p}`),
    } as IFileSystem,
    cwd: '/home',
    env: new Map<string, string>(),
    stdin: '',
  };
}

describe('debug command', () => {
  const ctx = createMockCtx();

  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
    });
    vi.stubGlobal('window', {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('has correct name', () => {
    expect(createDebugCommand().name).toBe('debug');
  });

  it('shows help with --help', async () => {
    const result = await createDebugCommand().execute(['--help'], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('usage: debug');
  });

  it('rejects unknown arguments', async () => {
    const result = await createDebugCommand().execute(['maybe'], ctx);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown argument 'maybe'");
  });

  it('shows current state as off by default', async () => {
    const result = await createDebugCommand().execute([], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('off');
  });

  it('shows current state as on when hidden tabs is empty', async () => {
    vi.mocked(localStorage.getItem).mockReturnValue('[]');
    const result = await createDebugCommand().execute([], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('on');
  });

  it('calls direct hook when available (panel context)', async () => {
    const toggle = vi.fn();
    (window as any).__slicc_debug_tabs = toggle;

    const result = await createDebugCommand().execute(['on'], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('enabled');
    expect(toggle).toHaveBeenCalledWith(true);
  });

  it('calls direct hook with false for off', async () => {
    const toggle = vi.fn();
    (window as any).__slicc_debug_tabs = toggle;

    const result = await createDebugCommand().execute(['off'], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hidden');
    expect(toggle).toHaveBeenCalledWith(false);
  });

  it('falls back to chrome.runtime.sendMessage when no direct hook (offscreen context)', async () => {
    const sendMessage = vi.fn();
    vi.stubGlobal('chrome', { runtime: { sendMessage } });

    const result = await createDebugCommand().execute(['on'], ctx);
    expect(result.exitCode).toBe(0);
    expect(sendMessage).toHaveBeenCalledWith({
      source: 'offscreen',
      payload: { type: 'debug-tabs', show: true },
    });
  });

  it('returns error when neither hook nor chrome.runtime available', async () => {
    const result = await createDebugCommand().execute(['on'], ctx);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('failed');
  });
});
