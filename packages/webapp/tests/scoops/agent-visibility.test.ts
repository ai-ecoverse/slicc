/**
 * Tests for VAL-SPAWN-014 + VAL-SPAWN-015 — bridge-spawned scoop visibility.
 *
 * These tests exercise two production bugs surfaced by user-interactive
 * testing of the `agent` supplemental shell command:
 *
 *   Bug 2 (VAL-SPAWN-014): `list_scoops` returns bridge-spawned scoops with
 *     status `'unknown'` (the fallback string in `scoop-management-tools`)
 *     rather than a first-class orchestrator tab status like `'initializing'`,
 *     `'processing'`, or `'ready'`.
 *
 *   Bug 3 (VAL-SPAWN-015): The orchestrator's `OrchestratorCallbacks
 *     .onStatusChange` callback — the UI-refresh trigger used by
 *     `ScoopsPanel` and its extension mirror — is never invoked for
 *     bridge-spawned scoops, so those scoops are invisible in the side panel
 *     UI despite being present in `orchestrator.getScoops()`.
 *
 * Both bugs share a root cause: {@link Orchestrator.registerExistingScoop}
 * populates only the `scoops` + `messageQueues` maps, skipping the `tabs`
 * map and the callback pipeline. The bridge's own scope-context callback
 * (`ScoopContextCallbacks.onStatusChange`) is additionally a no-op, so any
 * transitions the real `ScoopContext` might emit are discarded.
 *
 * The "red" side of these tests is written against the post-fix contract:
 *   1. `orchestrator.getScoopTabState(jid)?.status` must be a first-class
 *      tab status (not `'unknown'`) DURING the active agent-loop.
 *   2. The `OrchestratorCallbacks.onStatusChange` spy installed at
 *      construction time must receive at least one call with the bridge
 *      scoop's jid and a non-`'unknown'` status by the time `spawn()`
 *      resolves.
 *
 * We use a real `VirtualFS` (via `fake-indexeddb/auto`) and a real
 * `Orchestrator` (DB initialized, but `.init()` not called — the bridge
 * only needs `unregisterScoop()` to work, which requires DB init only).
 */

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAgentBridge,
  type AgentBridgeContext,
  type AgentBridgeContextArgs,
} from '../../src/scoops/agent-bridge.js';
import { Orchestrator, type OrchestratorCallbacks } from '../../src/scoops/orchestrator.js';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import * as db from '../../src/scoops/db.js';
import type { ScoopTabState } from '../../src/scoops/types.js';

// ─── Helpers ───────────────────────────────────────────────────────────

interface CapturedCtxArgs {
  args: AgentBridgeContextArgs;
}

interface MockScoopContextOptions {
  captured: CapturedCtxArgs[];
  /**
   * Called during `prompt()` before it resolves. Lets tests inspect the
   * orchestrator state mid-run (while the bridge has already registered
   * the scoop, before cleanup fires).
   */
  onPrompt?: (text: string, record: CapturedCtxArgs) => Promise<void> | void;
  /**
   * Promise that `prompt()` awaits before resolving. When supplied, the
   * caller controls when the agent loop completes. Useful for inspecting
   * the orchestrator registry + tab map while the loop is still live.
   */
  promptHold?: Promise<void>;
  /**
   * When provided, `onStatusChange` (the scope-context callback installed by
   * the bridge) is invoked with each item in sequence during `prompt()`.
   * Simulates a real `ScoopContext` transitioning `initializing → processing
   * → ready` as the agent loop progresses.
   */
  emitStatusesDuringPrompt?: ScoopTabState['status'][];
}

function makeMockContextFactory(
  opts: MockScoopContextOptions
): (args: AgentBridgeContextArgs) => AgentBridgeContext {
  return (args) => {
    const record: CapturedCtxArgs = { args };
    opts.captured.push(record);

    return {
      async init() {
        // no-op — bridge has already registered the scoop with the
        // orchestrator at this point via `registerExistingScoop`
      },
      async prompt(text: string) {
        if (opts.emitStatusesDuringPrompt) {
          for (const status of opts.emitStatusesDuringPrompt) {
            args.callbacks.onStatusChange(status);
          }
        }
        if (opts.onPrompt) await opts.onPrompt(text, record);
        if (opts.promptHold) await opts.promptHold;
      },
      dispose() {
        // no-op
      },
      getAgentMessages() {
        return [];
      },
    };
  };
}

async function makeOrchestrator(
  overrides: Partial<OrchestratorCallbacks> = {}
): Promise<{ orch: Orchestrator; callbacks: OrchestratorCallbacks }> {
  await db.initDB();

  const callbacks: OrchestratorCallbacks = {
    onResponse: vi.fn(),
    onResponseDone: vi.fn(),
    onSendMessage: vi.fn(),
    onStatusChange: vi.fn(),
    onError: vi.fn(),
    getBrowserAPI: () => ({}) as any,
    ...overrides,
  };

  const orch = new Orchestrator({} as unknown as HTMLElement, callbacks, {
    name: 'sliccy',
    triggerPattern: /^@sliccy\b/i,
  });
  return { orch, callbacks };
}

async function makeVfs(): Promise<VirtualFS> {
  const vfs = await VirtualFS.create({
    dbName: `agent-visibility-test-${Math.random()}`,
    wipe: true,
  });
  for (const dir of ['/workspace', '/shared', '/scoops', '/home', '/tmp']) {
    try {
      await vfs.mkdir(dir, { recursive: true });
    } catch {
      /* ignore */
    }
  }
  return vfs;
}

/** Ordered list of first-class tab statuses that `list_scoops` could legitimately report. */
const FIRST_CLASS_STATUSES: readonly ScoopTabState['status'][] = [
  'initializing',
  'ready',
  'processing',
  'error',
];

// ─── Tests ─────────────────────────────────────────────────────────────

describe('Agent bridge scoop visibility (VAL-SPAWN-014 + VAL-SPAWN-015)', () => {
  let vfs: VirtualFS;
  let orch: Orchestrator;
  let callbacks: OrchestratorCallbacks;

  beforeEach(async () => {
    vfs = await makeVfs();
    const made = await makeOrchestrator();
    orch = made.orch;
    callbacks = made.callbacks;
  });

  afterEach(async () => {
    await orch.shutdown().catch(() => {});
    await vfs.dispose().catch(() => {});
  });

  // ── VAL-SPAWN-014 — list_scoops-style lookup reports first-class status ─

  describe('VAL-SPAWN-014: list_scoops reports first-class tab status', () => {
    it("getScoopTabState(jid) returns a non-'unknown' status DURING active spawn (and the scoop is gone after cleanup)", async () => {
      // Hold the mock agent loop open so we can observe the mid-run state.
      let releaseHold!: () => void;
      const promptHold = new Promise<void>((resolve) => {
        releaseHold = resolve;
      });

      const captured: CapturedCtxArgs[] = [];
      let midRunStatus: ScoopTabState['status'] | 'unknown' | undefined;
      let midRunJidPresent = false;

      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({
          captured,
          promptHold,
          onPrompt: async (_text, record) => {
            const jid = record.args.scoop.jid;
            // (a) orchestrator.getScoops() must contain the bridge scoop
            //     during the run (baseline, already covered elsewhere).
            midRunJidPresent = orch.getScoops().some((s) => s.jid === jid);
            // (b) orchestrator.getScoopTabState(jid)?.status must be a
            //     first-class orchestrator tab status — NOT the fallback
            //     'unknown' string that `list_scoops` falls back to when
            //     there is no tab entry.
            midRunStatus = orch.getScoopTabState(jid)?.status ?? 'unknown';
          },
        }),
        generateUid: () => 'spawn014',
        resolveModel: () => 'claude-opus-4-6',
        getInheritedModelId: () => 'claude-opus-4-6',
      });

      // Start the spawn and wait until onPrompt has observed the live state
      // before releasing the hold. We schedule a microtask-level release to
      // ensure onPrompt runs first.
      const spawnPromise = bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });
      // Yield the event loop so prompt() → onPrompt() runs.
      await new Promise<void>((r) => setTimeout(r, 0));
      releaseHold();
      const result = await spawnPromise;
      expect(result.exitCode).toBe(0);

      // Mid-run, the scoop was present in the registry.
      expect(midRunJidPresent).toBe(true);
      // Mid-run, the tab status was a first-class status — not 'unknown'.
      expect(midRunStatus).not.toBe('unknown');
      expect(FIRST_CLASS_STATUSES).toContain(midRunStatus as ScoopTabState['status']);

      // After cleanup, the scoop is no longer in the registry.
      const jid = captured[0].args.scoop.jid;
      expect(orch.getScoops().find((s) => s.jid === jid)).toBeUndefined();
      // And the tab entry is gone too.
      expect(orch.getScoopTabState(jid)).toBeUndefined();
    });

    it('registerExistingScoop populates the tabs map so list_scoops sees a first-class status', () => {
      // Direct unit test on the orchestrator helper used by the bridge.
      const jid = 'agent_direct_unit';
      orch.registerExistingScoop({
        jid,
        name: 'agent-direct',
        folder: 'agent-direct',
        isCone: false,
        type: 'scoop',
        requiresTrigger: false,
        assistantLabel: 'agent-direct',
        addedAt: new Date().toISOString(),
        config: {},
      });

      const tab = orch.getScoopTabState(jid);
      expect(tab).toBeDefined();
      // The concrete initial status is 'initializing' — matching what
      // `createScoopTab` uses for newly-created scoops.
      expect(tab?.status).toBe('initializing');
      // And it is NOT the `list_scoops` fallback string.
      expect(tab?.status).not.toBe('unknown');
    });
  });

  // ── VAL-SPAWN-015 — onStatusChange fires for bridge-spawned scoops ───

  describe('VAL-SPAWN-015: OrchestratorCallbacks.onStatusChange fires for bridge scoops', () => {
    it('fires at least once with the bridge scoop jid and a non-unknown status by the time spawn() resolves', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({ captured }),
        generateUid: () => 'spawn015',
        resolveModel: () => 'claude-opus-4-6',
        getInheritedModelId: () => 'claude-opus-4-6',
      });

      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });

      const jid = captured[0].args.scoop.jid;
      const spy = callbacks.onStatusChange as ReturnType<typeof vi.fn>;
      const callsForJid = spy.mock.calls.filter((call) => call[0] === jid);

      // At LEAST one call must have been emitted for our bridge scoop jid —
      // the initial `initializing` transition fired from
      // `registerExistingScoop`. Additional transitions during spawn are
      // acceptable (and exercised below).
      expect(callsForJid.length).toBeGreaterThanOrEqual(1);

      // None of the recorded statuses are the fallback `'unknown'` string.
      for (const call of callsForJid) {
        const status = call[1];
        expect(status).not.toBe('unknown');
        expect(FIRST_CLASS_STATUSES).toContain(status);
      }
    });

    it('fires with initial status on registration (before the agent loop body runs)', async () => {
      const captured: CapturedCtxArgs[] = [];
      let spyCountAtPromptEntry = 0;
      let jidAtPromptEntry = '';

      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({
          captured,
          onPrompt: async (_text, record) => {
            jidAtPromptEntry = record.args.scoop.jid;
            const spy = callbacks.onStatusChange as ReturnType<typeof vi.fn>;
            spyCountAtPromptEntry = spy.mock.calls.filter((c) => c[0] === jidAtPromptEntry).length;
          },
        }),
        generateUid: () => 'init-fire',
        resolveModel: () => 'claude-opus-4-6',
        getInheritedModelId: () => 'claude-opus-4-6',
      });

      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });

      // By the time the agent loop entered prompt(), the registration-time
      // `initializing` status change must already have fired. Without this,
      // the side panel `ScoopsPanel.refreshScoops()` never runs, so the
      // bridge scoop is invisible in the UI.
      expect(spyCountAtPromptEntry).toBeGreaterThanOrEqual(1);
    });

    it('propagates scope-context status transitions during the agent loop', async () => {
      // This test covers the bridge-side part of the fix: the bridge's
      // `ScoopContextCallbacks.onStatusChange` is NO LONGER a no-op. When the
      // scope context transitions (e.g., `initializing → processing →
      // ready`), those transitions must flow through the orchestrator's
      // `onStatusChange` pipeline.
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({
          captured,
          emitStatusesDuringPrompt: ['processing', 'ready'],
        }),
        generateUid: () => 'transitions',
        resolveModel: () => 'claude-opus-4-6',
        getInheritedModelId: () => 'claude-opus-4-6',
      });

      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });

      const jid = captured[0].args.scoop.jid;
      const spy = callbacks.onStatusChange as ReturnType<typeof vi.fn>;
      const statusesForJid = spy.mock.calls
        .filter((call) => call[0] === jid)
        .map((call) => call[1] as string);

      // At minimum we expect the registration-time transition + at least one
      // scope-context transition to have reached the orchestrator callback.
      expect(statusesForJid.length).toBeGreaterThanOrEqual(2);
      // And we expect 'processing' to appear among the propagated statuses.
      expect(statusesForJid).toContain('processing');
    });
  });

  // ── Orchestrator API surface ─────────────────────────────────────────

  describe('Orchestrator.updateBridgeTabStatus', () => {
    it('updates the tab status and refreshes lastActivity without broadcasting onStatusChange', async () => {
      // core-followup-2 / VAL-SPAWN-016 scrutiny-round-1 dedup:
      // `updateBridgeTabStatus` is now a single-purpose tab-state mutator.
      // Status broadcasts are forwarded solely by
      // `buildForwardingScoopCallbacks` — having this method ALSO broadcast
      // produced duplicate `onStatusChange` events for every bridge-scoop
      // transition (extras trigger here + helper forwarding phase).
      const jid = 'agent_update_unit';
      orch.registerExistingScoop({
        jid,
        name: 'agent-update',
        folder: 'agent-update',
        isCone: false,
        type: 'scoop',
        requiresTrigger: false,
        assistantLabel: 'agent-update',
        addedAt: new Date().toISOString(),
        config: {},
      });

      const before = orch.getScoopTabState(jid);
      expect(before?.status).toBe('initializing');
      const beforeActivity = before?.lastActivity;

      // Small delay so lastActivity changes (ISO strings have ms precision).
      await new Promise<void>((r) => setTimeout(r, 2));

      const spy = callbacks.onStatusChange as ReturnType<typeof vi.fn>;
      spy.mockClear();

      orch.updateBridgeTabStatus(jid, 'processing');

      const after = orch.getScoopTabState(jid);
      expect(after?.status).toBe('processing');
      expect(after?.lastActivity).not.toBe(beforeActivity);
      // NO broadcast — the helper's forwarding phase owns status dispatch.
      expect(spy).not.toHaveBeenCalled();
    });

    it('is a safe no-op when the jid is not registered as a bridge tab', () => {
      const spy = callbacks.onStatusChange as ReturnType<typeof vi.fn>;
      spy.mockClear();
      // Does not throw.
      expect(() => orch.updateBridgeTabStatus('nonexistent', 'ready')).not.toThrow();
      // Does not fire a callback for a jid that was never registered.
      expect(spy).not.toHaveBeenCalled();
    });
  });
});
