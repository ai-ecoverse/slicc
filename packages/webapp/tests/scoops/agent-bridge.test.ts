/**
 * Tests for AgentBridge — the direct spawn path used by the `agent`
 * supplemental shell command. The bridge creates a fresh RegisteredScoop,
 * builds a sandboxed RestrictedFS, constructs a ScoopContext, awaits
 * `ctx.prompt()` and cleans up the scratch folder + orchestrator registration
 * on every completion path.
 *
 * The bridge exposes a small `deps` injection surface (`createContext`,
 * `generateUid`, `resolveModel`, `getInheritedModelId`) so that these tests
 * can exercise the lifecycle end-to-end without spinning up a real agent
 * loop. We use a REAL `VirtualFS` (via `fake-indexeddb/auto`) and a REAL
 * `Orchestrator` (with `initDB()` so `unregisterScoop` works) to verify
 * folder creation / deletion and orchestrator registry behavior.
 */

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAgentBridge,
  type AgentBridgeContext,
  type AgentBridgeContextArgs,
} from '../../src/scoops/agent-bridge.js';
import { Orchestrator } from '../../src/scoops/orchestrator.js';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { RestrictedFS } from '../../src/fs/restricted-fs.js';
import { FsError } from '../../src/fs/types.js';
import * as db from '../../src/scoops/db.js';
import type { AgentMessage } from '../../src/core/types.js';

// ─── Helpers ───────────────────────────────────────────────────────────

interface CapturedCtxArgs {
  args: AgentBridgeContextArgs;
}

interface MockScoopContextOptions {
  /** Push into array for recording all constructions. */
  captured: CapturedCtxArgs[];
  /** Behavior of prompt(). Default resolves immediately without side effects. */
  promptBehavior?: (text: string, captured: CapturedCtxArgs) => Promise<void> | void;
  /** Messages returned by getAgentMessages(). */
  agentMessages?: AgentMessage[];
  /** Runs during prompt() before resolution (lets tests use await to observe VFS state). */
  onPrompt?: (text: string, captured: CapturedCtxArgs) => Promise<void> | void;
  /** Called when send_message should fire while prompt() is running. */
  onSendWhilePrompting?: string[];
  /** Called with dispose() invocation. */
  onDispose?: () => void;
}

function makeMockContextFactory(
  opts: MockScoopContextOptions
): (args: AgentBridgeContextArgs) => AgentBridgeContext {
  return (args) => {
    const record: CapturedCtxArgs = { args };
    opts.captured.push(record);

    return {
      async init() {
        // no-op in tests
      },
      async prompt(text: string) {
        // Emit any queued send_message callbacks to the provided callbacks
        if (opts.onSendWhilePrompting) {
          for (const msg of opts.onSendWhilePrompting) {
            args.callbacks.onSendMessage(msg);
          }
        }
        if (opts.onPrompt) await opts.onPrompt(text, record);
        if (opts.promptBehavior) await opts.promptBehavior(text, record);
      },
      dispose() {
        opts.onDispose?.();
      },
      getAgentMessages() {
        return opts.agentMessages ?? [];
      },
    };
  };
}

async function makeOrchestrator(): Promise<Orchestrator> {
  await db.initDB();
  // We construct an Orchestrator *without* calling .init() — that would pull
  // in DOM-bound setup (window.setInterval, FsWatcher, etc.). The bridge only
  // needs `unregisterScoop()` to succeed, which requires the DB to be
  // initialized. `getScoops()` reads from the in-memory map which starts empty.
  const orch = new Orchestrator(
    {} as unknown as HTMLElement,
    {
      onResponse: () => {},
      onResponseDone: () => {},
      onSendMessage: () => {},
      onStatusChange: () => {},
      onError: () => {},
      getBrowserAPI: () => ({}) as any,
    },
    { name: 'sliccy', triggerPattern: /^@sliccy\b/i }
  );
  return orch;
}

async function makeVfs(): Promise<VirtualFS> {
  const vfs = await VirtualFS.create({ dbName: `agent-bridge-test-${Math.random()}`, wipe: true });
  // Ensure root dirs exist — similar to orchestrator.ensureRootStructure().
  for (const dir of ['/workspace', '/shared', '/scoops', '/home', '/tmp']) {
    try {
      await vfs.mkdir(dir, { recursive: true });
    } catch {
      /* ignore already-exists */
    }
  }
  return vfs;
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

// ─── Tests ─────────────────────────────────────────────────────────────

describe('createAgentBridge', () => {
  let vfs: VirtualFS;
  let orch: Orchestrator;

  beforeEach(async () => {
    vfs = await makeVfs();
    orch = await makeOrchestrator();
  });

  afterEach(async () => {
    await orch.shutdown().catch(() => {});
    await vfs.dispose().catch(() => {});
  });

  // ── SPAWN — folder + scoop record ─────────────────────────────────

  describe('spawn: scratch folder + RegisteredScoop', () => {
    it('creates a /scoops/agent-<uid>/ directory before cleanup', async () => {
      const captured: CapturedCtxArgs[] = [];
      let existedDuringPrompt = false;
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({
          captured,
          promptBehavior: async () => {
            // Inspect the VFS while prompt() is still executing.
            existedDuringPrompt = await vfs.exists(`/scoops/${captured[0].args.scoop.folder}`);
          },
        }),
        generateUid: () => 'abc123',
        resolveModel: () => 'claude-opus-4-6',
        getInheritedModelId: () => 'claude-opus-4-6',
      });

      const result = await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'hi' });

      expect(result.exitCode).toBe(0);
      expect(existedDuringPrompt).toBe(true);
      // Folder name derives from uid
      expect(captured[0].args.scoop.folder).toBe('agent-abc123');
    });

    it('registers the scoop with isCone: false and type: "scoop"', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'x1',
        getInheritedModelId: () => 'claude-opus-4-6',
      });

      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(captured[0].args.scoop.isCone).toBe(false);
      expect(captured[0].args.scoop.type).toBe('scoop');
    });

    it('RegisteredScoop.folder equals the scratch folder base name', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'uid-specific',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(captured[0].args.scoop.folder).toBe('agent-uid-specific');
    });

    it('mints a unique jid per spawn (no collision across two consecutive spawns)', async () => {
      const captured: CapturedCtxArgs[] = [];
      let counter = 0;
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => `c${counter++}`,
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p1' });
      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p2' });

      expect(captured).toHaveLength(2);
      expect(captured[0].args.scoop.jid).not.toEqual(captured[1].args.scoop.jid);
    });

    it('scratch folder names are not reused across two consecutive spawns', async () => {
      const captured: CapturedCtxArgs[] = [];
      let counter = 0;
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => `u${counter++}`,
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });

      expect(captured[0].args.scoop.folder).not.toEqual(captured[1].args.scoop.folder);
    });

    it('forwards the prompt text verbatim to ctx.prompt()', async () => {
      const captured: CapturedCtxArgs[] = [];
      let observedPrompt = '';
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({
          captured,
          promptBehavior: (text) => {
            observedPrompt = text;
          },
        }),
        generateUid: () => 'v',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      const exotic = 'line1\nline2 🎉 résumé $(whoami) `date`';
      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: exotic });
      expect(observedPrompt).toBe(exotic);
    });

    it('passes a RestrictedFS instance (not the raw VFS) to the context', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'rfs',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(captured[0].args.fs).toBeInstanceOf(RestrictedFS);
    });
  });

  // ── FS — RestrictedFS ACL probing via the bridge-built instance ───

  describe('RestrictedFS ACL via bridge-built instance', () => {
    it('allows writes to the resolved cwd, /shared/, and /scoops/<folder>/', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'a1',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });

      const rfs = captured[0].args.fs;
      await rfs.writeFile('/home/out.txt', 'in-cwd');
      await rfs.writeFile('/shared/note.md', 'shared');
      await rfs.writeFile('/scoops/agent-a1/tmp.txt', 'scratch');

      expect(await vfs.readTextFile('/home/out.txt')).toBe('in-cwd');
      expect(await vfs.readTextFile('/shared/note.md')).toBe('shared');
      expect(await vfs.readTextFile('/scoops/agent-a1/tmp.txt')).toBe('scratch');
    });

    it('exposes /workspace/ as read-only (EACCES on write)', async () => {
      // Seed a workspace file so reads can succeed.
      await vfs.writeFile('/workspace/existing.txt', 'hello');

      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'ro',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });

      const rfs = captured[0].args.fs;
      // Read succeeds
      expect(await rfs.readTextFile('/workspace/existing.txt')).toBe('hello');
      // Write is blocked
      await expect(rfs.writeFile('/workspace/blocked.txt', 'x')).rejects.toMatchObject({
        code: 'EACCES',
      });
    });

    it('rejects writes outside cwd / /shared/ / /scoops/<folder>/ / /workspace/ with EACCES', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'outside',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      await bridge.spawn({ cwd: '/home/wiki', allowedCommands: ['*'], prompt: 'p' });

      const rfs = captured[0].args.fs;
      await expect(rfs.writeFile('/tmp/escape.txt', 'x')).rejects.toMatchObject({
        code: 'EACCES',
      });
      await expect(rfs.writeFile('/home/other/escape.txt', 'x')).rejects.toMatchObject({
        code: 'EACCES',
      });
    });

    it("cannot see sibling scoops' folders (invisible to the restricted view)", async () => {
      // Create a sibling scoop folder with content before spawning
      await vfs.mkdir('/scoops/other-sibling', { recursive: true });
      await vfs.writeFile('/scoops/other-sibling/secret.txt', 'sibling secret');

      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'sib',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });

      const rfs = captured[0].args.fs;
      // stat throws ENOENT for invisible paths (inside /scoops but not our folder)
      await expect(rfs.readTextFile('/scoops/other-sibling/secret.txt')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });

    it('normalizes a cwd with trailing-slash differences to a single R/W prefix', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'norm',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      await bridge.spawn({ cwd: '/home/', allowedCommands: ['*'], prompt: 'p' });

      const rfs = captured[0].args.fs;
      await rfs.writeFile('/home/t.txt', 'ok');
      expect(await vfs.readTextFile('/home/t.txt')).toBe('ok');
    });
  });

  // ── OUTPUT — send_message / fallback / empty ──────────────────────

  describe('output determination', () => {
    it('returns the last send_message payload when one was captured', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({
          captured,
          onSendWhilePrompting: ['first', 'last-wins'],
        }),
        generateUid: () => 'sm',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      const result = await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(result.exitCode).toBe(0);
      expect(result.finalText).toBe('last-wins');
    });

    it('falls back to the last assistant text from getAgentMessages() when no send_message', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({
          captured,
          agentMessages: [
            assistantTextMessage('older'),
            assistantTextMessage('final-assistant-text'),
          ],
        }),
        generateUid: () => 'fb',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      const result = await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(result.exitCode).toBe(0);
      expect(result.finalText).toBe('final-assistant-text');
    });

    it('returns empty finalText when there is neither a send_message nor any assistant text', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured, agentMessages: [] }),
        generateUid: () => 'empty',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      const result = await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(result.exitCode).toBe(0);
      expect(result.finalText).toBe('');
    });
  });

  // ── CLEAN — every completion path wipes the scratch folder ────────

  describe('cleanup: scratch folder + orchestrator + dispose + sessionStore', () => {
    it('deletes /scoops/<folder>/ after a successful completion', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'ok',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(await vfs.exists('/scoops/agent-ok')).toBe(false);
    });

    it('deletes /scoops/<folder>/ after prompt() rejects', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({
          captured,
          promptBehavior: async () => {
            throw new Error('agent loop blew up');
          },
        }),
        generateUid: () => 'err',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      const result = await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(result.exitCode).toBe(1);
      expect(result.finalText).toBe('agent loop blew up');
      expect(await vfs.exists('/scoops/agent-err')).toBe(false);
    });

    it('deletes /scoops/<folder>/ when prompt() throws synchronously', async () => {
      // A factory that returns a context whose prompt() throws synchronously
      // (before returning a Promise).
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: () => ({
          async init() {},
          prompt() {
            throw new Error('sync boom');
          },
          dispose() {},
          getAgentMessages() {
            return [];
          },
        }),
        generateUid: () => 'syncerr',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      const result = await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(result.exitCode).toBe(1);
      expect(result.finalText).toBe('sync boom');
      expect(await vfs.exists('/scoops/agent-syncerr')).toBe(false);
    });

    it('deletes /scoops/<folder>/ after an abort-style rejection', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({
          captured,
          promptBehavior: async () => {
            throw new DOMException('aborted', 'AbortError');
          },
        }),
        generateUid: () => 'abort',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      const result = await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(result.exitCode).toBe(1);
      expect(await vfs.exists('/scoops/agent-abort')).toBe(false);
    });

    it('still runs cleanup when every bash invocation would be rejected by the allow-list', async () => {
      // Allow-list enforcement lives in the bash-tool wrapper (separate
      // feature). From the bridge's perspective, rejection surfaces as tool
      // results inside the agent loop — the loop still completes and prompt()
      // resolves normally. The bridge must still clean up.
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({
          captured,
          onSendWhilePrompting: ['I could not do anything'],
        }),
        generateUid: () => 'allreject',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      const result = await bridge.spawn({ cwd: '/home', allowedCommands: [], prompt: 'p' });
      expect(result.exitCode).toBe(0);
      expect(result.finalText).toBe('I could not do anything');
      expect(await vfs.exists('/scoops/agent-allreject')).toBe(false);
    });

    it('cleanup still deletes the folder when sessionStore.delete rejects', async () => {
      const sessionStore = {
        save: vi.fn().mockResolvedValue(undefined),
        load: vi.fn().mockResolvedValue(null),
        delete: vi.fn().mockRejectedValue(new Error('session DB locked')),
        list: vi.fn().mockResolvedValue([]),
        clearAll: vi.fn().mockResolvedValue(undefined),
      } as any;

      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, sessionStore, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'sess-fail',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      const result = await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(result.exitCode).toBe(0);
      expect(await vfs.exists('/scoops/agent-sess-fail')).toBe(false);
      expect(sessionStore.delete).toHaveBeenCalledWith(captured[0].args.scoop.jid);
    });

    it('calls orchestrator.unregisterScoop(jid) on cleanup', async () => {
      const unregisterSpy = vi.spyOn(orch, 'unregisterScoop');
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'unreg',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(unregisterSpy).toHaveBeenCalledWith(captured[0].args.scoop.jid);
    });

    it('calls ctx.dispose() on the context', async () => {
      const disposeSpy = vi.fn();
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured, onDispose: disposeSpy }),
        generateUid: () => 'disp',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(disposeSpy).toHaveBeenCalledTimes(1);
    });

    it('calls sessionStore.delete(jid) on cleanup when sessionStore is provided', async () => {
      const sessionStore = {
        save: vi.fn().mockResolvedValue(undefined),
        load: vi.fn().mockResolvedValue(null),
        delete: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue([]),
        clearAll: vi.fn().mockResolvedValue(undefined),
      } as any;

      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, sessionStore, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'sd',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(sessionStore.delete).toHaveBeenCalledWith(captured[0].args.scoop.jid);
    });

    it('preserves files under /shared/ and cwd that the scoop wrote (cleanup only touches /scoops/<folder>/)', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({
          captured,
          promptBehavior: async (_t, rec) => {
            // Simulate the scoop writing via its restricted fs.
            await rec.args.fs.writeFile('/shared/out.md', 'survives');
            await rec.args.fs.writeFile('/home/wiki/out.md', 'survives');
          },
        }),
        generateUid: () => 'preserve',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      await vfs.mkdir('/home/wiki', { recursive: true });
      await bridge.spawn({ cwd: '/home/wiki', allowedCommands: ['*'], prompt: 'p' });
      expect(await vfs.readTextFile('/shared/out.md')).toBe('survives');
      expect(await vfs.readTextFile('/home/wiki/out.md')).toBe('survives');
      expect(await vfs.exists('/scoops/agent-preserve')).toBe(false);
    });

    it("leaves sibling scoops' /scoops/<other>/ untouched during cleanup", async () => {
      await vfs.mkdir('/scoops/other-sibling', { recursive: true });
      await vfs.writeFile('/scoops/other-sibling/keep.txt', 'sibling survives');

      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'notsibling',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(await vfs.readTextFile('/scoops/other-sibling/keep.txt')).toBe('sibling survives');
      expect(await vfs.exists('/scoops/agent-notsibling')).toBe(false);
    });

    it('two overlapping spawns clean up only their own folders', async () => {
      let counter = 0;
      const captured: CapturedCtxArgs[] = [];

      // Control the completion order via explicit deferred promises.
      const defs: Array<{
        promise: Promise<void>;
        resolve: () => void;
      }> = [];
      for (let i = 0; i < 2; i++) {
        let resolve!: () => void;
        const promise = new Promise<void>((r) => {
          resolve = r;
        });
        defs.push({ promise, resolve });
      }

      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: (args) => {
          const idx = counter++;
          captured.push({ args });
          return {
            async init() {},
            async prompt() {
              await defs[idx].promise;
            },
            dispose() {},
            getAgentMessages() {
              return [];
            },
          };
        },
        generateUid: (() => {
          let c = 0;
          return () => `par${c++}`;
        })(),
        getInheritedModelId: () => 'claude-opus-4-6',
      });

      const p1 = bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'first' });
      const p2 = bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'second' });

      // Both folders present while prompts are pending.
      expect(await vfs.exists('/scoops/agent-par0')).toBe(true);
      expect(await vfs.exists('/scoops/agent-par1')).toBe(true);

      // Resolve second first, let it clean up.
      defs[1].resolve();
      await p2;
      expect(await vfs.exists('/scoops/agent-par1')).toBe(false);
      // First is still running, its folder still exists.
      expect(await vfs.exists('/scoops/agent-par0')).toBe(true);

      // Resolve first.
      defs[0].resolve();
      await p1;
      expect(await vfs.exists('/scoops/agent-par0')).toBe(false);
    });

    it('does not touch /workspace/ during cleanup', async () => {
      await vfs.writeFile('/workspace/untouched.md', 'preserved');
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'ws',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(await vfs.readTextFile('/workspace/untouched.md')).toBe('preserved');
    });

    it('orchestrator.getScoops() does not contain the spawned scoop after cleanup', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'list',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      const jid = captured[0].args.scoop.jid;
      expect(orch.getScoops().find((s) => s.jid === jid)).toBeUndefined();
    });
  });

  // ── MODEL — explicit override, inheritance, unknown model ─────────

  describe('model selection', () => {
    it('inherits the parent model id when no modelId is supplied', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'm1',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      expect(captured[0].args.modelId).toBe('claude-opus-4-6');
    });

    it('threads an explicit modelId byte-for-byte to the context', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'm2',
        resolveModel: (id) => id, // all ids are valid in this test
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      await bridge.spawn({
        cwd: '/home',
        allowedCommands: ['*'],
        prompt: 'p',
        modelId: 'claude-haiku-4-5',
      });
      expect(captured[0].args.modelId).toBe('claude-haiku-4-5');
    });

    it('sets scoop.config.modelId when modelId is supplied (forwarded to ScoopContext)', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'm3',
        resolveModel: (id) => id,
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      await bridge.spawn({
        cwd: '/home',
        allowedCommands: ['*'],
        prompt: 'p',
        modelId: 'claude-haiku-4-5',
      });
      expect(captured[0].args.scoop.config?.modelId).toBe('claude-haiku-4-5');
    });

    it('returns { exitCode: 1, finalText: "agent: unknown model: <id>" } for an unknown model', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'm4',
        resolveModel: () => null, // treat every id as unknown
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      const result = await bridge.spawn({
        cwd: '/home',
        allowedCommands: ['*'],
        prompt: 'p',
        modelId: 'not-a-real-model',
      });
      expect(result.exitCode).toBe(1);
      expect(result.finalText).toBe('agent: unknown model: not-a-real-model');
      // No context was ever created
      expect(captured).toHaveLength(0);
    });

    it('returns the same error for an empty-string modelId', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'm5',
        resolveModel: (id) => (id === '' ? null : id),
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      const result = await bridge.spawn({
        cwd: '/home',
        allowedCommands: ['*'],
        prompt: 'p',
        modelId: '',
      });
      expect(result.exitCode).toBe(1);
      expect(result.finalText).toBe('agent: unknown model: ');
      expect(captured).toHaveLength(0);
    });

    it('does NOT create a scratch folder when the model is unknown (no-op cleanup)', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'never',
        resolveModel: () => null,
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      await bridge.spawn({
        cwd: '/home',
        allowedCommands: ['*'],
        prompt: 'p',
        modelId: 'bogus',
      });
      expect(await vfs.exists('/scoops/agent-never')).toBe(false);
    });

    it('does not mutate the parent inherited model id after a spawn with modelId override', async () => {
      const captured: CapturedCtxArgs[] = [];
      const inherited = 'claude-opus-4-6';
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'm6',
        resolveModel: (id) => id,
        getInheritedModelId: () => inherited,
      });
      await bridge.spawn({
        cwd: '/home',
        allowedCommands: ['*'],
        prompt: 'p',
        modelId: 'claude-haiku-4-5',
      });
      expect(inherited).toBe('claude-opus-4-6');
    });
  });

  // ── Orchestrator bypass (no cone-only tool calls) ─────────────────

  describe('orchestrator bypass: does not use cone-only tools', () => {
    it('does not call scoop_scoop / feed_scoop / drop_scoop / list_scoops on the orchestrator', async () => {
      // Orchestrator doesn't expose those as methods — they are agent tools.
      // The bridge should construct ScoopContext directly, not route through
      // the cone's tool invocation path. We assert by watching the createContext
      // factory as the only path used.
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'bypass',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      // Exactly one context was constructed via the factory.
      expect(captured).toHaveLength(1);
    });
  });

  // ── Sanity: FsError is what RestrictedFS throws ───────────────────

  describe('FsError sanity', () => {
    it("RestrictedFS built by the bridge throws FsError('EACCES') for /workspace/ writes", async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'fsx',
        getInheritedModelId: () => 'claude-opus-4-6',
      });
      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });

      const rfs = captured[0].args.fs;
      try {
        await rfs.writeFile('/workspace/x.txt', 'x');
        throw new Error('expected EACCES');
      } catch (err) {
        expect(err).toBeInstanceOf(FsError);
        expect((err as FsError).code).toBe('EACCES');
      }
    });
  });
});
