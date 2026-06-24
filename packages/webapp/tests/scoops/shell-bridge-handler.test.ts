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
    handleWebhookEvent: vi.fn(),
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
// handleRequest — lick-emit navigate (Task 11)
// ---------------------------------------------------------------------------

describe('handleRequest lick-emit navigate', () => {
  it('emits navigate event and returns {ok:true} for valid handoff', async () => {
    const emitEvent = vi.fn();
    const lickManager = makeLickManager({ emitEvent });
    const h = createShellBridgeHandler({
      registry: makeRegistry(),
      lickManager,
      browser: makeBrowser(),
      fs: makeFs(),
    });
    const result = await h.handleRequest('lick-emit', {
      lickType: 'navigate',
      data: { verb: 'handoff', target: 'cone', url: 'https://sliccy.ai/foo' },
    });
    expect(emitEvent).toHaveBeenCalledOnce();
    const [event] = emitEvent.mock.calls[0];
    expect(event.type).toBe('navigate');
    expect(event.navigateUrl).toBe('https://sliccy.ai/foo');
    expect(event.body).toMatchObject({
      url: 'https://sliccy.ai/foo',
      verb: 'handoff',
      target: 'cone',
    });
    expect(result).toEqual({ ok: true });
  });

  it('emits navigate event for upskill verb', async () => {
    const emitEvent = vi.fn();
    const lickManager = makeLickManager({ emitEvent });
    const h = createShellBridgeHandler({
      registry: makeRegistry(),
      lickManager,
      browser: makeBrowser(),
      fs: makeFs(),
    });
    await h.handleRequest('lick-emit', {
      lickType: 'navigate',
      data: { verb: 'upskill', target: 'cone', url: 'https://github.com/foo/bar' },
    });
    const [event] = emitEvent.mock.calls[0];
    expect(event.body.verb).toBe('upskill');
  });

  it('includes optional fields (instruction, branch, path, title) in body when present', async () => {
    const emitEvent = vi.fn();
    const lickManager = makeLickManager({ emitEvent });
    const h = createShellBridgeHandler({
      registry: makeRegistry(),
      lickManager,
      browser: makeBrowser(),
      fs: makeFs(),
    });
    await h.handleRequest('lick-emit', {
      lickType: 'navigate',
      data: {
        verb: 'handoff',
        target: 'cone',
        url: 'https://sliccy.ai',
        instruction: 'do the thing',
        branch: 'main',
        path: '/workspace',
        title: 'My Title',
      },
    });
    const [event] = emitEvent.mock.calls[0];
    expect(event.body).toMatchObject({
      instruction: 'do the thing',
      branch: 'main',
      path: '/workspace',
      title: 'My Title',
    });
  });

  it('throws when verb is invalid (emitEvent NOT called)', async () => {
    const emitEvent = vi.fn();
    const lickManager = makeLickManager({ emitEvent });
    const h = createShellBridgeHandler({
      registry: makeRegistry(),
      lickManager,
      browser: makeBrowser(),
      fs: makeFs(),
    });
    await expect(
      h.handleRequest('lick-emit', {
        lickType: 'navigate',
        data: { verb: 'invalid', target: 'cone', url: 'https://sliccy.ai' },
      })
    ).rejects.toThrow(/verb/i);
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it('throws when url is missing (emitEvent NOT called)', async () => {
    const emitEvent = vi.fn();
    const lickManager = makeLickManager({ emitEvent });
    const h = createShellBridgeHandler({
      registry: makeRegistry(),
      lickManager,
      browser: makeBrowser(),
      fs: makeFs(),
    });
    await expect(
      h.handleRequest('lick-emit', {
        lickType: 'navigate',
        data: { verb: 'handoff', target: 'cone' },
      })
    ).rejects.toThrow();
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it('throws when target is missing (emitEvent NOT called)', async () => {
    const emitEvent = vi.fn();
    const lickManager = makeLickManager({ emitEvent });
    const h = createShellBridgeHandler({
      registry: makeRegistry(),
      lickManager,
      browser: makeBrowser(),
      fs: makeFs(),
    });
    await expect(
      h.handleRequest('lick-emit', {
        lickType: 'navigate',
        data: { verb: 'handoff', url: 'https://sliccy.ai' },
      })
    ).rejects.toThrow();
    expect(emitEvent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleRequest — lick-emit webhook (Task 11)
// ---------------------------------------------------------------------------

describe('handleRequest lick-emit webhook', () => {
  it('calls handleWebhookEvent with webhookId, headers, body and returns {ok:true}', async () => {
    const handleWebhookEvent = vi.fn();
    const lickManager = makeLickManager({ handleWebhookEvent });
    const h = createShellBridgeHandler({
      registry: makeRegistry(),
      lickManager,
      browser: makeBrowser(),
      fs: makeFs(),
    });
    const result = await h.handleRequest('lick-emit', {
      lickType: 'webhook',
      data: {
        webhookId: 'wh-abc',
        headers: { 'x-custom': 'val' },
        body: { event: 'push' },
      },
    });
    expect(handleWebhookEvent).toHaveBeenCalledOnce();
    const [id, headers, body] = handleWebhookEvent.mock.calls[0];
    expect(id).toBe('wh-abc');
    expect(headers).toEqual({ 'x-custom': 'val' });
    expect(body).toEqual({ event: 'push' });
    expect(result).toEqual({ ok: true });
  });

  it('throws when webhookId is missing (handleWebhookEvent NOT called)', async () => {
    const handleWebhookEvent = vi.fn();
    const lickManager = makeLickManager({ handleWebhookEvent });
    const h = createShellBridgeHandler({
      registry: makeRegistry(),
      lickManager,
      browser: makeBrowser(),
      fs: makeFs(),
    });
    await expect(
      h.handleRequest('lick-emit', {
        lickType: 'webhook',
        data: { headers: {}, body: {} },
      })
    ).rejects.toThrow(/webhookId/i);
    expect(handleWebhookEvent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleRequest — lick-emit unsupported type (Task 11)
// ---------------------------------------------------------------------------

describe('handleRequest lick-emit unsupported type', () => {
  it('throws for unsupported lick type (e.g. "cron")', async () => {
    const h = createShellBridgeHandler({
      registry: makeRegistry(),
      lickManager: makeLickManager(),
      browser: makeBrowser(),
      fs: makeFs(),
    });
    await expect(h.handleRequest('lick-emit', { lickType: 'cron', data: {} })).rejects.toThrow(
      /unsupported/i
    );
  });
});

// ---------------------------------------------------------------------------
// handleRequest — vfs-read (Task 10)
// ---------------------------------------------------------------------------

import type { DirEntry, Stats } from '../../src/fs/types.js';
import { FsError } from '../../src/fs/types.js';

function makeVfsFs(overrides: Partial<VirtualFS> = {}): VirtualFS {
  return {
    readFile: vi.fn().mockResolvedValue('file content'),
    writeFile: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ type: 'file', size: 42, mtime: 1000, ctime: 900 } as Stats),
    readDir: vi.fn().mockResolvedValue([
      { name: 'a.txt', type: 'file' },
      { name: 'sub', type: 'directory' },
    ] as DirEntry[]),
    ...overrides,
  } as unknown as VirtualFS;
}

describe('handleRequest vfs-read', () => {
  it('reads a utf-8 file and returns {content, encoding:"utf-8"}', async () => {
    const readFile = vi.fn().mockResolvedValue('hello world');
    const h = createShellBridgeHandler({
      registry: makeRegistry(),
      lickManager: makeLickManager(),
      browser: makeBrowser(),
      fs: makeVfsFs({ readFile }),
    });
    const result = await h.handleRequest('vfs-read', { path: '/workspace/a.txt' });
    expect(readFile).toHaveBeenCalledWith('/workspace/a.txt', { encoding: 'utf-8' });
    expect(result).toEqual({ content: 'hello world', encoding: 'utf-8' });
  });

  it('reads a binary file as base64 and exact bytes survive round-trip', async () => {
    // Raw binary bytes [0, 255, 128, 1]
    const rawBytes = new Uint8Array([0, 255, 128, 1]);
    const readFile = vi.fn().mockResolvedValue(rawBytes);
    const h = createShellBridgeHandler({
      registry: makeRegistry(),
      lickManager: makeLickManager(),
      browser: makeBrowser(),
      fs: makeVfsFs({ readFile }),
    });
    const result = (await h.handleRequest('vfs-read', {
      path: '/workspace/img.png',
      encoding: 'base64',
    })) as { content: string; encoding: string };
    expect(readFile).toHaveBeenCalledWith('/workspace/img.png', { encoding: 'binary' });
    expect(result.encoding).toBe('base64');
    // Decode and assert exact bytes survive
    const decoded = Uint8Array.from(atob(result.content), (c) => c.charCodeAt(0));
    expect(Array.from(decoded)).toEqual([0, 255, 128, 1]);
  });

  it('throws when path is missing', async () => {
    const h = createShellBridgeHandler({
      registry: makeRegistry(),
      lickManager: makeLickManager(),
      browser: makeBrowser(),
      fs: makeVfsFs(),
    });
    await expect(h.handleRequest('vfs-read', {})).rejects.toThrow(/path/i);
  });

  it('throws when path is an empty string', async () => {
    const h = createShellBridgeHandler({
      registry: makeRegistry(),
      lickManager: makeLickManager(),
      browser: makeBrowser(),
      fs: makeVfsFs(),
    });
    await expect(h.handleRequest('vfs-read', { path: '' })).rejects.toThrow(/path/i);
  });

  it('propagates FsError from readFile', async () => {
    const readFile = vi.fn().mockRejectedValue(new FsError('ENOENT', 'no such file', '/x'));
    const h = createShellBridgeHandler({
      registry: makeRegistry(),
      lickManager: makeLickManager(),
      browser: makeBrowser(),
      fs: makeVfsFs({ readFile }),
    });
    await expect(h.handleRequest('vfs-read', { path: '/x' })).rejects.toThrow('ENOENT');
  });
});

// ---------------------------------------------------------------------------
// handleRequest — vfs-write (Task 10)
// ---------------------------------------------------------------------------

describe('handleRequest vfs-write', () => {
  it('writes a utf-8 string and returns {ok:true}', async () => {
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const h = createShellBridgeHandler({
      registry: makeRegistry(),
      lickManager: makeLickManager(),
      browser: makeBrowser(),
      fs: makeVfsFs({ writeFile }),
    });
    const result = await h.handleRequest('vfs-write', {
      path: '/workspace/out.txt',
      content: 'data',
    });
    expect(writeFile).toHaveBeenCalledWith('/workspace/out.txt', 'data');
    expect(result).toEqual({ ok: true });
  });

  it('decodes base64 content to Uint8Array before writeFile', async () => {
    const rawBytes = new Uint8Array([0, 255, 128, 1]);
    // Encode with chunked btoa (same as handler)
    let binary = '';
    const chunkSize = 8192;
    for (let i = 0; i < rawBytes.length; i += chunkSize) {
      binary += String.fromCharCode(...rawBytes.subarray(i, i + chunkSize));
    }
    const b64 = btoa(binary);

    const writeFile = vi.fn().mockResolvedValue(undefined);
    const h = createShellBridgeHandler({
      registry: makeRegistry(),
      lickManager: makeLickManager(),
      browser: makeBrowser(),
      fs: makeVfsFs({ writeFile }),
    });
    await h.handleRequest('vfs-write', {
      path: '/workspace/img.bin',
      content: b64,
      encoding: 'base64',
    });
    const writtenData = writeFile.mock.calls[0][1] as Uint8Array;
    expect(writtenData).toBeInstanceOf(Uint8Array);
    expect(Array.from(writtenData)).toEqual([0, 255, 128, 1]);
  });

  it('throws when path is missing', async () => {
    const h = createShellBridgeHandler({
      registry: makeRegistry(),
      lickManager: makeLickManager(),
      browser: makeBrowser(),
      fs: makeVfsFs(),
    });
    await expect(h.handleRequest('vfs-write', { content: 'x' })).rejects.toThrow(/path/i);
  });

  it('propagates FsError from writeFile', async () => {
    const writeFile = vi.fn().mockRejectedValue(new FsError('ENOENT', 'no such dir', '/missing'));
    const h = createShellBridgeHandler({
      registry: makeRegistry(),
      lickManager: makeLickManager(),
      browser: makeBrowser(),
      fs: makeVfsFs({ writeFile }),
    });
    await expect(
      h.handleRequest('vfs-write', { path: '/missing/out.txt', content: 'x' })
    ).rejects.toThrow('ENOENT');
  });
});

// ---------------------------------------------------------------------------
// handleRequest — vfs-stat (Task 10)
// ---------------------------------------------------------------------------

describe('handleRequest vfs-stat', () => {
  it('returns {type:"file", size, mtime} for a file', async () => {
    const stat = vi
      .fn()
      .mockResolvedValue({ type: 'file', size: 99, mtime: 1234567, ctime: 0 } as Stats);
    const h = createShellBridgeHandler({
      registry: makeRegistry(),
      lickManager: makeLickManager(),
      browser: makeBrowser(),
      fs: makeVfsFs({ stat }),
    });
    const result = await h.handleRequest('vfs-stat', { path: '/workspace/file.txt' });
    expect(stat).toHaveBeenCalledWith('/workspace/file.txt');
    expect(result).toEqual({ type: 'file', size: 99, mtime: 1234567 });
  });

  it('returns {type:"directory"} for a directory', async () => {
    const stat = vi
      .fn()
      .mockResolvedValue({ type: 'directory', size: 0, mtime: 500, ctime: 0 } as Stats);
    const h = createShellBridgeHandler({
      registry: makeRegistry(),
      lickManager: makeLickManager(),
      browser: makeBrowser(),
      fs: makeVfsFs({ stat }),
    });
    const result = (await h.handleRequest('vfs-stat', { path: '/workspace' })) as {
      type: string;
    };
    expect(result.type).toBe('directory');
  });

  it('throws when path is missing', async () => {
    const h = createShellBridgeHandler({
      registry: makeRegistry(),
      lickManager: makeLickManager(),
      browser: makeBrowser(),
      fs: makeVfsFs(),
    });
    await expect(h.handleRequest('vfs-stat', {})).rejects.toThrow(/path/i);
  });

  it('propagates FsError from stat', async () => {
    const stat = vi.fn().mockRejectedValue(new FsError('ENOENT', 'not found', '/x'));
    const h = createShellBridgeHandler({
      registry: makeRegistry(),
      lickManager: makeLickManager(),
      browser: makeBrowser(),
      fs: makeVfsFs({ stat }),
    });
    await expect(h.handleRequest('vfs-stat', { path: '/x' })).rejects.toThrow('ENOENT');
  });
});

// ---------------------------------------------------------------------------
// handleRequest — vfs-list (Task 10)
// ---------------------------------------------------------------------------

describe('handleRequest vfs-list', () => {
  it('returns readDir result directly', async () => {
    const entries: DirEntry[] = [
      { name: 'foo.ts', type: 'file' },
      { name: 'bar', type: 'directory' },
    ];
    const readDir = vi.fn().mockResolvedValue(entries);
    const h = createShellBridgeHandler({
      registry: makeRegistry(),
      lickManager: makeLickManager(),
      browser: makeBrowser(),
      fs: makeVfsFs({ readDir }),
    });
    const result = await h.handleRequest('vfs-list', { path: '/workspace' });
    expect(readDir).toHaveBeenCalledWith('/workspace');
    expect(result).toEqual(entries);
  });

  it('throws when path is missing', async () => {
    const h = createShellBridgeHandler({
      registry: makeRegistry(),
      lickManager: makeLickManager(),
      browser: makeBrowser(),
      fs: makeVfsFs(),
    });
    await expect(h.handleRequest('vfs-list', {})).rejects.toThrow(/path/i);
  });

  it('propagates FsError from readDir', async () => {
    const readDir = vi.fn().mockRejectedValue(new FsError('ENOENT', 'not found', '/x'));
    const h = createShellBridgeHandler({
      registry: makeRegistry(),
      lickManager: makeLickManager(),
      browser: makeBrowser(),
      fs: makeVfsFs({ readDir }),
    });
    await expect(h.handleRequest('vfs-list', { path: '/x' })).rejects.toThrow('ENOENT');
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
// handleRequest — shell-exec input guards (deferred finding #1)
// ---------------------------------------------------------------------------

describe('handleRequest shell-exec input guards', () => {
  it('throws when sessionId is missing', async () => {
    const registry = makeRegistry();
    const h = createShellBridgeHandler({
      registry,
      lickManager: makeLickManager(),
      browser: makeBrowser(),
      fs: makeFs(),
    });
    await expect(h.handleRequest('shell-exec', { command: 'ls' })).rejects.toThrow(
      'shell-exec: sessionId and command are required'
    );
    expect(registry.runExec).not.toHaveBeenCalled();
  });

  it('throws when sessionId is an empty string', async () => {
    const registry = makeRegistry();
    const h = createShellBridgeHandler({
      registry,
      lickManager: makeLickManager(),
      browser: makeBrowser(),
      fs: makeFs(),
    });
    await expect(h.handleRequest('shell-exec', { sessionId: '', command: 'ls' })).rejects.toThrow(
      'shell-exec: sessionId and command are required'
    );
    expect(registry.runExec).not.toHaveBeenCalled();
  });

  it('throws when command is missing', async () => {
    const registry = makeRegistry();
    const h = createShellBridgeHandler({
      registry,
      lickManager: makeLickManager(),
      browser: makeBrowser(),
      fs: makeFs(),
    });
    await expect(h.handleRequest('shell-exec', { sessionId: 'sess-1' })).rejects.toThrow(
      'shell-exec: sessionId and command are required'
    );
    expect(registry.runExec).not.toHaveBeenCalled();
  });

  it('throws when command is an empty string', async () => {
    const registry = makeRegistry();
    const h = createShellBridgeHandler({
      registry,
      lickManager: makeLickManager(),
      browser: makeBrowser(),
      fs: makeFs(),
    });
    await expect(
      h.handleRequest('shell-exec', { sessionId: 'sess-1', command: '' })
    ).rejects.toThrow('shell-exec: sessionId and command are required');
    expect(registry.runExec).not.toHaveBeenCalled();
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
