// Unit tests for createShellBridgeHandler.
//
// Covers:
// - canHandle: known vs unknown types
// - handleRequest: shell-exec routes to registry.runExec, targets to browser.listAllTargets,
//   shell-session-status to registry.sessionStatus, vfs-read/vfs-write/etc throw (deferred)
// - handleRequest: unknown type throws
// - handleStream: shell-exec stream routes to registry.streamExec, frames forwarded in order
// - error mapping: rejects bubble as thrown errors

import { describe, expect, it, vi } from 'vitest';
import type { BrowserAPI } from '../../src/cdp/browser-api.js';
import type { VirtualFS } from '../../src/fs/virtual-fs.js';
import type { ExecFrame, SubstrateSessionRegistry } from '../../src/kernel/substrate-session.js';
import type { LickManager } from '../../src/scoops/lick-manager.js';
import { createShellBridgeHandler } from '../../src/scoops/shell-bridge-handler.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeRegistry(overrides: Partial<SubstrateSessionRegistry> = {}): SubstrateSessionRegistry {
  return {
    runExec: vi.fn().mockResolvedValue({
      stdout: 'out',
      stderr: '',
      exitCode: 0,
      pid: 42,
    }),
    streamExec: vi
      .fn()
      .mockImplementation(async (_sid: string, _cmd: string, onFrame: (f: ExecFrame) => void) => {
        onFrame({ t: 'stdout', d: 'hello\n' });
        onFrame({ t: 'exit', code: 0, pid: 42 });
      }),
    sessionStatus: vi.fn().mockReturnValue({
      alive: true,
      cwd: '/workspace',
      runningPids: [42],
      bufferedTail: 'tail',
    }),
    sweepIdle: vi.fn(),
    dispose: vi.fn(),
    ...overrides,
  } as unknown as SubstrateSessionRegistry;
}

function makeBrowser(overrides: Partial<BrowserAPI> = {}): BrowserAPI {
  return {
    listAllTargets: vi
      .fn()
      .mockResolvedValue([{ targetId: 't1', url: 'https://example.com', title: 'Example' }]),
    ...overrides,
  } as unknown as BrowserAPI;
}

function makeLickManager(overrides: Partial<LickManager> = {}): LickManager {
  return {
    emitEvent: vi.fn(),
    ...overrides,
  } as unknown as LickManager;
}

function makeFs(overrides: Partial<VirtualFS> = {}): VirtualFS {
  return {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    stat: vi.fn(),
    readdir: vi.fn(),
    ...overrides,
  } as unknown as VirtualFS;
}

// ---------------------------------------------------------------------------
// canHandle
// ---------------------------------------------------------------------------

describe('canHandle', () => {
  it('returns true for shell-exec', () => {
    const h = createShellBridgeHandler({
      registry: makeRegistry(),
      lickManager: makeLickManager(),
      browser: makeBrowser(),
      fs: makeFs(),
    });
    expect(h.canHandle('shell-exec')).toBe(true);
  });

  it('returns true for shell-session-status', () => {
    const h = createShellBridgeHandler({
      registry: makeRegistry(),
      lickManager: makeLickManager(),
      browser: makeBrowser(),
      fs: makeFs(),
    });
    expect(h.canHandle('shell-session-status')).toBe(true);
  });

  it('returns true for targets', () => {
    const h = createShellBridgeHandler({
      registry: makeRegistry(),
      lickManager: makeLickManager(),
      browser: makeBrowser(),
      fs: makeFs(),
    });
    expect(h.canHandle('targets')).toBe(true);
  });

  it('returns true for deferred vfs-read', () => {
    const h = createShellBridgeHandler({
      registry: makeRegistry(),
      lickManager: makeLickManager(),
      browser: makeBrowser(),
      fs: makeFs(),
    });
    expect(h.canHandle('vfs-read')).toBe(true);
  });

  it('returns true for deferred vfs-write', () => {
    const h = createShellBridgeHandler({
      registry: makeRegistry(),
      lickManager: makeLickManager(),
      browser: makeBrowser(),
      fs: makeFs(),
    });
    expect(h.canHandle('vfs-write')).toBe(true);
  });

  it('returns true for deferred vfs-stat', () => {
    const h = createShellBridgeHandler({
      registry: makeRegistry(),
      lickManager: makeLickManager(),
      browser: makeBrowser(),
      fs: makeFs(),
    });
    expect(h.canHandle('vfs-stat')).toBe(true);
  });

  it('returns true for deferred vfs-list', () => {
    const h = createShellBridgeHandler({
      registry: makeRegistry(),
      lickManager: makeLickManager(),
      browser: makeBrowser(),
      fs: makeFs(),
    });
    expect(h.canHandle('vfs-list')).toBe(true);
  });

  it('returns true for deferred lick-emit', () => {
    const h = createShellBridgeHandler({
      registry: makeRegistry(),
      lickManager: makeLickManager(),
      browser: makeBrowser(),
      fs: makeFs(),
    });
    expect(h.canHandle('lick-emit')).toBe(true);
  });

  it('returns false for unknown type', () => {
    const h = createShellBridgeHandler({
      registry: makeRegistry(),
      lickManager: makeLickManager(),
      browser: makeBrowser(),
      fs: makeFs(),
    });
    expect(h.canHandle('list_webhooks')).toBe(false);
    expect(h.canHandle('totally-unknown')).toBe(false);
    expect(h.canHandle('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleRequest — shell-exec (non-stream)
// ---------------------------------------------------------------------------

describe('handleRequest shell-exec', () => {
  it('calls registry.runExec with sessionId and command, returns result', async () => {
    const registry = makeRegistry();
    const h = createShellBridgeHandler({
      registry,
      lickManager: makeLickManager(),
      browser: makeBrowser(),
      fs: makeFs(),
    });
    const result = await h.handleRequest('shell-exec', {
      sessionId: 'sess-1',
      command: 'echo hello',
    });
    expect(registry.runExec).toHaveBeenCalledWith('sess-1', 'echo hello');
    expect(result).toEqual({ stdout: 'out', stderr: '', exitCode: 0, pid: 42 });
  });

  it('propagates registry.runExec rejection', async () => {
    const registry = makeRegistry({
      runExec: vi.fn().mockRejectedValue(new Error('exec failed')),
    });
    const h = createShellBridgeHandler({
      registry,
      lickManager: makeLickManager(),
      browser: makeBrowser(),
      fs: makeFs(),
    });
    await expect(
      h.handleRequest('shell-exec', { sessionId: 'sid', command: 'bad' })
    ).rejects.toThrow('exec failed');
  });
});

// ---------------------------------------------------------------------------
// handleRequest — targets
// ---------------------------------------------------------------------------

describe('handleRequest targets', () => {
  it('calls browser.listAllTargets and returns result', async () => {
    const browser = makeBrowser();
    const h = createShellBridgeHandler({
      registry: makeRegistry(),
      lickManager: makeLickManager(),
      browser,
      fs: makeFs(),
    });
    const result = await h.handleRequest('targets', {});
    expect(browser.listAllTargets).toHaveBeenCalled();
    expect(result).toEqual([{ targetId: 't1', url: 'https://example.com', title: 'Example' }]);
  });
});

// ---------------------------------------------------------------------------
// handleRequest — shell-session-status
// ---------------------------------------------------------------------------

describe('handleRequest shell-session-status', () => {
  it('calls registry.sessionStatus with sessionId and returns status', async () => {
    const registry = makeRegistry();
    const h = createShellBridgeHandler({
      registry,
      lickManager: makeLickManager(),
      browser: makeBrowser(),
      fs: makeFs(),
    });
    const result = await h.handleRequest('shell-session-status', { sessionId: 'sess-2' });
    expect(registry.sessionStatus).toHaveBeenCalledWith('sess-2');
    expect(result).toEqual({
      alive: true,
      cwd: '/workspace',
      runningPids: [42],
      bufferedTail: 'tail',
    });
  });
});

// ---------------------------------------------------------------------------
// handleRequest — deferred cases throw
// ---------------------------------------------------------------------------

describe('handleRequest deferred cases', () => {
  it('vfs-read throws not-implemented', async () => {
    const h = createShellBridgeHandler({
      registry: makeRegistry(),
      lickManager: makeLickManager(),
      browser: makeBrowser(),
      fs: makeFs(),
    });
    await expect(h.handleRequest('vfs-read', {})).rejects.toThrow(/not implemented/i);
  });

  it('vfs-write throws not-implemented', async () => {
    const h = createShellBridgeHandler({
      registry: makeRegistry(),
      lickManager: makeLickManager(),
      browser: makeBrowser(),
      fs: makeFs(),
    });
    await expect(h.handleRequest('vfs-write', {})).rejects.toThrow(/not implemented/i);
  });

  it('vfs-stat throws not-implemented', async () => {
    const h = createShellBridgeHandler({
      registry: makeRegistry(),
      lickManager: makeLickManager(),
      browser: makeBrowser(),
      fs: makeFs(),
    });
    await expect(h.handleRequest('vfs-stat', {})).rejects.toThrow(/not implemented/i);
  });

  it('vfs-list throws not-implemented', async () => {
    const h = createShellBridgeHandler({
      registry: makeRegistry(),
      lickManager: makeLickManager(),
      browser: makeBrowser(),
      fs: makeFs(),
    });
    await expect(h.handleRequest('vfs-list', {})).rejects.toThrow(/not implemented/i);
  });

  it('lick-emit throws not-implemented', async () => {
    const h = createShellBridgeHandler({
      registry: makeRegistry(),
      lickManager: makeLickManager(),
      browser: makeBrowser(),
      fs: makeFs(),
    });
    await expect(h.handleRequest('lick-emit', {})).rejects.toThrow(/not implemented/i);
  });
});

// ---------------------------------------------------------------------------
// handleRequest — unknown type
// ---------------------------------------------------------------------------

describe('handleRequest unknown type', () => {
  it('throws for type not in canHandle set', async () => {
    const h = createShellBridgeHandler({
      registry: makeRegistry(),
      lickManager: makeLickManager(),
      browser: makeBrowser(),
      fs: makeFs(),
    });
    await expect(h.handleRequest('bogus-type', {})).rejects.toThrow(/bogus-type/);
  });
});

// ---------------------------------------------------------------------------
// handleStream — shell-exec streaming
// ---------------------------------------------------------------------------

describe('handleStream shell-exec', () => {
  it('calls registry.streamExec and forwards frames in order', async () => {
    const frames: ExecFrame[] = [];
    const registry = makeRegistry({
      streamExec: vi
        .fn()
        .mockImplementation(async (_sid: string, _cmd: string, onFrame: (f: ExecFrame) => void) => {
          onFrame({ t: 'stdout', d: 'line1\n' });
          onFrame({ t: 'stderr', d: 'err\n' });
          onFrame({ t: 'exit', code: 1, pid: 99 });
        }),
    });
    const h = createShellBridgeHandler({
      registry,
      lickManager: makeLickManager(),
      browser: makeBrowser(),
      fs: makeFs(),
    });
    await h.handleStream('shell-exec', { sessionId: 'sid', command: 'run' }, (f) => {
      frames.push(f);
    });
    expect(registry.streamExec).toHaveBeenCalledWith('sid', 'run', expect.any(Function));
    expect(frames).toEqual([
      { t: 'stdout', d: 'line1\n' },
      { t: 'stderr', d: 'err\n' },
      { t: 'exit', code: 1, pid: 99 },
    ]);
  });

  it('propagates streamExec rejection', async () => {
    const registry = makeRegistry({
      streamExec: vi.fn().mockRejectedValue(new Error('stream failed')),
    });
    const h = createShellBridgeHandler({
      registry,
      lickManager: makeLickManager(),
      browser: makeBrowser(),
      fs: makeFs(),
    });
    await expect(
      h.handleStream('shell-exec', { sessionId: 'sid', command: 'bad' }, () => {})
    ).rejects.toThrow('stream failed');
  });
});
