/**
 * Tests for `publishAgentBridge` — the bootstrap helper that wires the
 * `createAgentBridge` result onto `globalThis.__slicc_agent` so the `agent`
 * supplemental shell command can locate it.
 *
 * The hook is published from BOTH bootstrap entry points:
 *   - CLI / standalone float: `packages/webapp/src/ui/main.ts`
 *   - Extension float (offscreen document): `packages/chrome-extension/src/offscreen.ts`
 *
 * This file simulates the bootstrap sequence in-process:
 *   1. Construct an Orchestrator backed by `fake-indexeddb`.
 *   2. Await `orchestrator.init()` so that `sharedFs` is populated.
 *   3. Call `publishAgentBridge(orchestrator, sharedFs, sessionStore)`.
 *   4. Assert `typeof globalThis.__slicc_agent.spawn === 'function'`.
 *
 * Additional invariants covered:
 *   - The hook is published exactly once per bootstrap (idempotent replacement
 *     — never left in a half-initialized state).
 *   - If `orchestrator.init()` throws, `publishAgentBridge` is NOT called, and
 *     `globalThis.__slicc_agent` stays undefined.
 *   - The published `spawn` is the SAME reference that `agent-command.ts`
 *     consumes — a round-trip through a mock LLM confirms the wiring.
 */

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  publishAgentBridge,
  publishAgentBridgeProxy,
  AGENT_BRIDGE_GLOBAL_KEY,
  AGENT_SPAWN_REQUEST_TYPE,
  type AgentBridge,
  type AgentBridgeContext,
  type AgentBridgeContextArgs,
} from '../../src/scoops/agent-bridge.js';
import { Orchestrator } from '../../src/scoops/orchestrator.js';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { SessionStore } from '../../src/core/session.js';
import * as db from '../../src/scoops/db.js';
import { createAgentCommand } from '../../src/shell/supplemental-commands/agent-command.js';
import type { IFileSystem } from 'just-bash';
import type { AgentMessage } from '../../src/core/types.js';

// ─── Fixtures ──────────────────────────────────────────────────────────

/**
 * Stubs the minimal `window` surface needed by `orchestrator.init()`:
 *   - `window.setInterval` — used by `startMessageLoop`.
 */
function stubWindowForOrchestrator(): void {
  vi.stubGlobal('window', {
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
  });
}

async function makeVfs(): Promise<VirtualFS> {
  const vfs = await VirtualFS.create({
    dbName: `agent-bridge-hook-test-${Math.random().toString(36).slice(2)}`,
    wipe: true,
  });
  for (const dir of ['/workspace', '/shared', '/scoops', '/home', '/tmp']) {
    try {
      await vfs.mkdir(dir, { recursive: true });
    } catch {
      /* already-exists */
    }
  }
  return vfs;
}

function makeOrchestrator(): Orchestrator {
  return new Orchestrator(
    {} as unknown as HTMLElement,
    {
      onResponse: () => {},
      onResponseDone: () => {},
      onSendMessage: () => {},
      onStatusChange: () => {},
      onError: () => {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getBrowserAPI: () => ({}) as any,
    },
    { name: 'sliccy', triggerPattern: /^@sliccy\b/i }
  );
}

function getPublishedBridge(): AgentBridge | undefined {
  return (globalThis as Record<string, unknown>)[AGENT_BRIDGE_GLOBAL_KEY] as
    | AgentBridge
    | undefined;
}

function clearPublishedBridge(): void {
  delete (globalThis as Record<string, unknown>)[AGENT_BRIDGE_GLOBAL_KEY];
}

function assistantTextMessage(text: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'anthropic',
    provider: 'anthropic',
    model: 'test-model',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

function createMockContextFactory(opts: {
  onPrompt?: (text: string, args: AgentBridgeContextArgs) => Promise<void> | void;
  sendWhilePrompting?: string[];
  agentMessages?: AgentMessage[];
}): (args: AgentBridgeContextArgs) => AgentBridgeContext {
  return (args) => ({
    async init() {
      /* no-op */
    },
    async prompt(text) {
      if (opts.sendWhilePrompting) {
        for (const msg of opts.sendWhilePrompting) {
          args.callbacks.onSendMessage(msg);
        }
      }
      await opts.onPrompt?.(text, args);
    },
    dispose() {
      /* no-op */
    },
    getAgentMessages() {
      return opts.agentMessages ?? [];
    },
  });
}

function createMockShellCtx(vfs: VirtualFS, cwd = '/home') {
  const fs: Partial<IFileSystem> = {
    resolvePath: (base: string, path: string) => (path.startsWith('/') ? path : `${base}/${path}`),
    exists: (p: string) => vfs.exists(p),
    stat: async (p: string) => {
      const s = await vfs.stat(p);
      return {
        isFile: s.type === 'file',
        isDirectory: s.type === 'directory',
        isSymbolicLink: false,
        mode: 0o755,
        size: s.size,
        mtime: new Date(s.mtime),
      };
    },
  };
  return {
    fs: fs as IFileSystem,
    cwd,
    env: new Map<string, string>(),
    stdin: '',
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe('publishAgentBridge — bootstrap hook', () => {
  let vfs: VirtualFS;

  beforeEach(async () => {
    stubWindowForOrchestrator();
    await db.initDB();
    vfs = await makeVfs();
    clearPublishedBridge();
  });

  afterEach(async () => {
    clearPublishedBridge();
    await vfs.dispose().catch(() => {});
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('happy-path bootstrap sequence', () => {
    it('publishes globalThis.__slicc_agent with a spawn() function', async () => {
      // 1. Bootstrap: construct orchestrator, init it (awaits sharedFs).
      const orchestrator = makeOrchestrator();
      try {
        await orchestrator.init();
        const sharedFs = orchestrator.getSharedFS();
        const sessionStore = orchestrator.getSessionStore();
        expect(sharedFs).not.toBeNull();

        // 2. Call the helper.
        publishAgentBridge(orchestrator, sharedFs!, sessionStore);

        // 3. Assert the hook is present with a spawn() function.
        const bridge = getPublishedBridge();
        expect(bridge).toBeDefined();
        expect(typeof bridge!.spawn).toBe('function');
      } finally {
        await orchestrator.shutdown().catch(() => {});
      }
    });

    it('returns the same reference that it publishes', async () => {
      const orchestrator = makeOrchestrator();
      try {
        await orchestrator.init();
        const returned = publishAgentBridge(
          orchestrator,
          orchestrator.getSharedFS()!,
          orchestrator.getSessionStore()
        );
        expect(getPublishedBridge()).toBe(returned);
      } finally {
        await orchestrator.shutdown().catch(() => {});
      }
    });

    it('accepts a null sessionStore (CLI/extension can defer persistence)', async () => {
      const orchestrator = makeOrchestrator();
      try {
        await orchestrator.init();
        publishAgentBridge(orchestrator, orchestrator.getSharedFS()!, null);
        expect(typeof getPublishedBridge()?.spawn).toBe('function');
      } finally {
        await orchestrator.shutdown().catch(() => {});
      }
    });

    it('works with a freshly constructed SessionStore (matches bootstrap options)', async () => {
      const orchestrator = makeOrchestrator();
      try {
        await orchestrator.init();
        const store = new SessionStore();
        publishAgentBridge(orchestrator, orchestrator.getSharedFS()!, store);
        expect(typeof getPublishedBridge()?.spawn).toBe('function');
      } finally {
        await orchestrator.shutdown().catch(() => {});
      }
    });
  });

  describe('bootstrap ordering — hook absent until init resolves', () => {
    it('does NOT publish the hook if init() is never called', () => {
      // Intentional: constructing an Orchestrator alone must NOT publish.
      makeOrchestrator();
      expect(getPublishedBridge()).toBeUndefined();
    });

    it('does NOT publish when the caller skips the helper after init()', async () => {
      const orchestrator = makeOrchestrator();
      try {
        await orchestrator.init();
        // publishAgentBridge deliberately NOT called.
        expect(getPublishedBridge()).toBeUndefined();
      } finally {
        await orchestrator.shutdown().catch(() => {});
      }
    });

    it('leaves the hook undefined when init() throws before the helper runs', async () => {
      const orchestrator = makeOrchestrator();
      // Force init() to reject by spying db.initDB.
      const initSpy = vi
        .spyOn(db, 'initDB')
        .mockRejectedValueOnce(new Error('simulated init failure'));

      let threw = false;
      try {
        await orchestrator.init();
      } catch {
        threw = true;
      }
      // Bootstrap code would NEVER reach publishAgentBridge after a rejection.
      expect(threw).toBe(true);
      expect(getPublishedBridge()).toBeUndefined();
      initSpy.mockRestore();
    });
  });

  describe('idempotency — single reference per bootstrap', () => {
    it('replaces any existing hook (no double-publishing as separate references)', async () => {
      const orchestrator = makeOrchestrator();
      try {
        await orchestrator.init();
        const first = publishAgentBridge(
          orchestrator,
          orchestrator.getSharedFS()!,
          orchestrator.getSessionStore()
        );
        const second = publishAgentBridge(
          orchestrator,
          orchestrator.getSharedFS()!,
          orchestrator.getSessionStore()
        );
        // After the second call, only one reference remains under the global key,
        // and it equals the most recent call's return value.
        expect(getPublishedBridge()).toBe(second);
        // The first and second are distinct bridge instances — but the *published*
        // hook is always exactly one reference at a time.
        expect(first).not.toBe(second);
      } finally {
        await orchestrator.shutdown().catch(() => {});
      }
    });
  });

  describe('round-trip — hook is the same reference consumed by agent-command', () => {
    it('agent-command invokes the published hook and prints the final send_message', async () => {
      const orchestrator = makeOrchestrator();
      try {
        await orchestrator.init();

        // Publish a bridge with a mock ScoopContext so no LLM call happens.
        publishAgentBridge(
          orchestrator,
          orchestrator.getSharedFS()!,
          orchestrator.getSessionStore(),
          {
            createContext: createMockContextFactory({
              sendWhilePrompting: ['pong from mock LLM'],
            }),
            generateUid: () => 'rt1',
            resolveModel: () => 'claude-opus-4-6',
            getInheritedModelId: () => 'claude-opus-4-6',
          }
        );

        // Invoke the shell command — it should look up `globalThis.__slicc_agent`.
        const result = await createAgentCommand().execute(
          ['.', '*', 'ping'],
          createMockShellCtx(orchestrator.getSharedFS()!, '/home')
        );

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.stdout).toBe('pong from mock LLM\n');
      } finally {
        await orchestrator.shutdown().catch(() => {});
      }
    });

    it('round-trip falls back to last assistant text when no send_message fires', async () => {
      const orchestrator = makeOrchestrator();
      try {
        await orchestrator.init();

        publishAgentBridge(
          orchestrator,
          orchestrator.getSharedFS()!,
          orchestrator.getSessionStore(),
          {
            createContext: createMockContextFactory({
              agentMessages: [assistantTextMessage('fallback text')],
            }),
            generateUid: () => 'rt2',
            resolveModel: () => 'claude-opus-4-6',
            getInheritedModelId: () => 'claude-opus-4-6',
          }
        );

        const result = await createAgentCommand().execute(
          ['.', '*', 'ping'],
          createMockShellCtx(orchestrator.getSharedFS()!, '/home')
        );
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe('fallback text\n');
      } finally {
        await orchestrator.shutdown().catch(() => {});
      }
    });
  });
});

// ─── publishAgentBridgeProxy — side-panel relay to offscreen ─────────────
//
// The side-panel realm in extension mode does NOT own an Orchestrator. Its
// WasmShell's `agent` command still looks up `globalThis.__slicc_agent`, so
// the panel bootstrap must publish a proxy bridge whose `spawn()` forwards
// to the offscreen document via `chrome.runtime.sendMessage` and awaits the
// response. These tests assert:
//   (a) the panel-side hook exists and is a function after publishAgentBridgeProxy();
//   (b) calling it sends the expected message and returns the simulated
//       offscreen response;
//   (c) the CLI bootstrap path still publishes the DIRECT (non-proxy) bridge.
//
// Chrome's runtime API is stubbed on globalThis for these tests.

interface StubbedChromeCall {
  message: unknown;
  respond: (response: unknown) => void;
}

/** Build a minimal globalThis.chrome stub capturing every sendMessage call. */
function makeChromeStub(
  onCall: (call: StubbedChromeCall) => void,
  opts: { lastError?: { message?: string } } = {}
): Record<string, unknown> {
  return {
    runtime: {
      lastError: opts.lastError,
      sendMessage: (message: unknown, callback?: (response: unknown) => void): void => {
        onCall({
          message,
          respond: (response) => callback?.(response),
        });
      },
    },
  };
}

describe('publishAgentBridgeProxy — side-panel relay to offscreen', () => {
  beforeEach(async () => {
    stubWindowForOrchestrator();
    await db.initDB();
    clearPublishedBridge();
  });

  afterEach(() => {
    clearPublishedBridge();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('(a) publishes globalThis.__slicc_agent with a spawn() function when chrome.runtime is stubbed', () => {
    vi.stubGlobal(
      'chrome',
      makeChromeStub(() => {})
    );

    const returned = publishAgentBridgeProxy();

    const bridge = getPublishedBridge();
    expect(bridge).toBeDefined();
    expect(typeof bridge!.spawn).toBe('function');
    expect(bridge).toBe(returned);
  });

  it('(b) spawn() sends the expected agent-spawn-request and resolves with the simulated offscreen response', async () => {
    const calls: StubbedChromeCall[] = [];
    vi.stubGlobal(
      'chrome',
      makeChromeStub((call) => {
        calls.push(call);
      })
    );

    publishAgentBridgeProxy();
    const bridge = getPublishedBridge()!;

    const spawnPromise = bridge.spawn({
      cwd: '/home/wiki',
      allowedCommands: ['*'],
      prompt: 'ping',
      modelId: 'claude-opus-4-6',
      parentJid: 'cone_1',
    });

    // The proxy must dispatch exactly one message with the expected envelope.
    expect(calls).toHaveLength(1);
    expect(calls[0].message).toEqual({
      source: 'panel',
      payload: {
        type: AGENT_SPAWN_REQUEST_TYPE,
        options: {
          cwd: '/home/wiki',
          allowedCommands: ['*'],
          prompt: 'ping',
          modelId: 'claude-opus-4-6',
          parentJid: 'cone_1',
        },
      },
    });

    // Simulate the offscreen document sending its response.
    calls[0].respond({ ok: true, result: { finalText: 'pong from offscreen', exitCode: 0 } });

    const result = await spawnPromise;
    expect(result).toEqual({ finalText: 'pong from offscreen', exitCode: 0 });
  });

  it('spawn() forwards minimal options (no optional fields) correctly', async () => {
    const calls: StubbedChromeCall[] = [];
    vi.stubGlobal(
      'chrome',
      makeChromeStub((call) => {
        calls.push(call);
      })
    );

    publishAgentBridgeProxy();
    const promise = getPublishedBridge()!.spawn({
      cwd: '/',
      allowedCommands: ['ls'],
      prompt: '',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].message).toEqual({
      source: 'panel',
      payload: {
        type: AGENT_SPAWN_REQUEST_TYPE,
        options: {
          cwd: '/',
          allowedCommands: ['ls'],
          prompt: '',
        },
      },
    });

    calls[0].respond({ ok: true, result: { finalText: '', exitCode: 0 } });
    await expect(promise).resolves.toEqual({ finalText: '', exitCode: 0 });
  });

  it('spawn() rejects when the offscreen replies with ok: false', async () => {
    let respond!: (r: unknown) => void;
    vi.stubGlobal(
      'chrome',
      makeChromeStub((call) => {
        respond = call.respond;
      })
    );

    publishAgentBridgeProxy();
    const promise = getPublishedBridge()!.spawn({
      cwd: '/',
      allowedCommands: ['*'],
      prompt: 'x',
    });

    respond({ ok: false, error: 'bridge unavailable' });
    await expect(promise).rejects.toThrow(/bridge unavailable/);
  });

  it('spawn() rejects when chrome.runtime.lastError is set', async () => {
    let respond!: (r: unknown) => void;
    vi.stubGlobal(
      'chrome',
      makeChromeStub(
        (call) => {
          respond = call.respond;
        },
        { lastError: { message: 'simulated chrome error' } }
      )
    );

    publishAgentBridgeProxy();
    const promise = getPublishedBridge()!.spawn({
      cwd: '/',
      allowedCommands: ['*'],
      prompt: 'x',
    });

    respond(undefined);
    await expect(promise).rejects.toThrow(/simulated chrome error/);
  });

  it('spawn() rejects when chrome.runtime is not available at call time', async () => {
    // Publish while chrome exists, then remove it before invocation — mirrors
    // the edge case where the extension tab loses its runtime mid-flight.
    vi.stubGlobal(
      'chrome',
      makeChromeStub(() => {})
    );
    publishAgentBridgeProxy();
    vi.stubGlobal('chrome', undefined);

    const promise = getPublishedBridge()!.spawn({
      cwd: '/',
      allowedCommands: ['*'],
      prompt: 'x',
    });
    await expect(promise).rejects.toThrow(/chrome\.runtime\.sendMessage/);
  });

  it('spawn() rejects when the offscreen replies with ok: true but no result', async () => {
    let respond!: (r: unknown) => void;
    vi.stubGlobal(
      'chrome',
      makeChromeStub((call) => {
        respond = call.respond;
      })
    );
    publishAgentBridgeProxy();
    const promise = getPublishedBridge()!.spawn({
      cwd: '/',
      allowedCommands: ['*'],
      prompt: 'x',
    });
    respond({ ok: true });
    await expect(promise).rejects.toThrow(/result/);
  });

  it('spawn() rejects when the offscreen callback is invoked with undefined', async () => {
    let respond!: (r: unknown) => void;
    vi.stubGlobal(
      'chrome',
      makeChromeStub((call) => {
        respond = call.respond;
      })
    );
    publishAgentBridgeProxy();
    const promise = getPublishedBridge()!.spawn({
      cwd: '/',
      allowedCommands: ['*'],
      prompt: 'x',
    });
    respond(undefined);
    await expect(promise).rejects.toThrow(/empty response|chrome\.runtime/);
  });

  it('(c) publishAgentBridge (CLI/offscreen path) still publishes the DIRECT (non-proxy) bridge', async () => {
    // Ensure no chrome stub — the direct bridge must work without chrome.runtime.
    vi.unstubAllGlobals();

    const orchestrator = makeOrchestrator();
    try {
      // Re-establish the window stub that unstubAllGlobals() would have cleared
      // — every run needs it because Orchestrator.init() touches window.*.
      stubWindowForOrchestrator();
      await orchestrator.init();

      const direct = publishAgentBridge(
        orchestrator,
        orchestrator.getSharedFS()!,
        orchestrator.getSessionStore(),
        {
          createContext: createMockContextFactory({
            sendWhilePrompting: ['direct-path output'],
          }),
          generateUid: () => 'directbridge1',
          resolveModel: () => 'claude-opus-4-6',
          getInheritedModelId: () => 'claude-opus-4-6',
        }
      );

      // The direct bridge's spawn() executes the real scoop-spawn flow
      // (scratch folder, ScoopContext stub, cleanup) WITHOUT touching
      // chrome.runtime — proving it's the direct (non-proxy) bridge.
      const result = await direct.spawn({
        cwd: '/home',
        allowedCommands: ['*'],
        prompt: 'ping',
      });
      expect(result).toEqual({ finalText: 'direct-path output', exitCode: 0 });
      expect(getPublishedBridge()).toBe(direct);
    } finally {
      await orchestrator.shutdown().catch(() => {});
    }
  });

  it('publishAgentBridgeProxy replaces a prior direct bridge with a different reference (no double-publishing)', async () => {
    const orchestrator = makeOrchestrator();
    try {
      await orchestrator.init();

      const direct = publishAgentBridge(
        orchestrator,
        orchestrator.getSharedFS()!,
        orchestrator.getSessionStore()
      );

      vi.stubGlobal(
        'chrome',
        makeChromeStub(() => {})
      );
      const proxy = publishAgentBridgeProxy();

      expect(proxy).not.toBe(direct);
      expect(getPublishedBridge()).toBe(proxy);
    } finally {
      await orchestrator.shutdown().catch(() => {});
    }
  });
});
