/**
 * Tests for VAL-SPAWN-016 — agent-spawned scoop chat panel streams + persists
 * messages.
 *
 * Root cause of the bug (pre-fix): `AgentBridge.spawn()` constructed a hand-
 * rolled `ScoopContextCallbacks` object with no-op `onResponse`,
 * `onResponseDone`, and entirely missing `onToolStart` / `onToolEnd` handlers.
 * Only `onStatusChange` was forwarded to the orchestrator's
 * `OrchestratorCallbacks` chain (via `updateBridgeTabStatus`). As a result:
 *
 *   - `OffscreenBridge.createCallbacks(...)` never received assistant-text
 *     deltas, response-done, tool-start, or tool-end events for bridge
 *     scoops. The side panel's `agent-event` message stream was empty.
 *   - `OffscreenBridge.persistScoop(jid)` (called from
 *     `onResponseDone`/`onToolEnd`/`onSendMessage`) never fired for bridge
 *     scoops, so `session-agent-<uid>` never appeared in the shared UI
 *     `SessionStore` (backed by the `browser-coding-agent` IndexedDB).
 *   - Clicking the agent-spawned scoop row in the sidebar loaded an empty
 *     chat panel — even while the agent was actively running.
 *
 * Fix (this feature): introduce a reusable private helper
 * `Orchestrator.buildForwardingScoopCallbacks(jid, folder, extras)` that:
 *   - forwards every `ScoopContextCallbacks.X` to the corresponding
 *     `this.callbacks.X(jid, ...)` on `OrchestratorCallbacks`.
 *   - accepts `extras` so callers can LAYER local concerns (e.g.,
 *     `AgentBridge` still captures the final send_message text into its
 *     `captured[]` ring, `createScoopTab` still maintains tab state +
 *     response-buffer routing) WITHOUT losing the forwarding chain.
 *
 * Both `AgentBridge.spawn` AND `Orchestrator.createScoopTab` use the same
 * helper — architectural parity enforced by code and by these tests.
 *
 * Test plan (TDD — these fail on HEAD before the fix lands):
 *
 *   A. Bridge forwarding: a bridge-spawned scoop's ScoopContext invoking
 *      `.onResponse`/`.onResponseDone`/`.onToolStart`/`.onToolEnd` MUST cause
 *      the SAME calls to propagate to `OrchestratorCallbacks.onResponse`/
 *      `onResponseDone`/`onToolStart`/`onToolEnd` with the correct `jid`.
 *      Pre-fix: spy receives 0 calls (bridge's hand-rolled onResponse is a
 *      no-op; onToolStart/onToolEnd are missing entirely).
 *
 *   B. createScoopTab regression guard: a regular (feed_scoop-style) scoop
 *      still forwards onResponse/onResponseDone/onToolStart/onToolEnd to
 *      OrchestratorCallbacks with the correct jid (this tests the helper
 *      didn't drop behavior).
 *
 *   C. `captured[]` contract: a bridge scoop's final `send_message(text)`
 *      still lands in the bridge's `captured[]` ring AND simultaneously
 *      forwards to `OrchestratorCallbacks.onSendMessage(jid, text)` so the
 *      side panel's `persistScoop` + agent-event relay fires.
 *
 *   D. Architecture pin: `Orchestrator.buildForwardingScoopCallbacks` exists
 *      and is callable (prevents accidental removal / rename of the helper).
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

// ─── Helpers ───────────────────────────────────────────────────────────

interface CapturedCtxArgs {
  args: AgentBridgeContextArgs;
}

interface MockContextOptions {
  captured: CapturedCtxArgs[];
  /**
   * Invoked inside `prompt()` BEFORE the mock resolves. Tests drive
   * scope-context callbacks via `args.callbacks.X(...)` here to simulate a
   * real `ScoopContext` emitting events.
   */
  onPrompt?: (record: CapturedCtxArgs) => Promise<void> | void;
}

function makeMockContextFactory(
  opts: MockContextOptions
): (args: AgentBridgeContextArgs) => AgentBridgeContext {
  return (args) => {
    const record: CapturedCtxArgs = { args };
    opts.captured.push(record);
    return {
      async init() {
        /* no-op */
      },
      async prompt() {
        if (opts.onPrompt) await opts.onPrompt(record);
      },
      dispose() {
        /* no-op */
      },
      getAgentMessages() {
        return [];
      },
    };
  };
}

async function makeVfs(): Promise<VirtualFS> {
  const vfs = await VirtualFS.create({
    dbName: `agent-bridge-callback-forwarding-${Math.random()}`,
    wipe: true,
  });
  for (const dir of ['/workspace', '/shared', '/scoops', '/home', '/tmp']) {
    try {
      await vfs.mkdir(dir, { recursive: true });
    } catch {
      /* ignore already-exists */
    }
  }
  return vfs;
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
    onToolStart: vi.fn(),
    onToolEnd: vi.fn(),
    getBrowserAPI: () => ({}) as any,
    ...overrides,
  };

  const orch = new Orchestrator({} as unknown as HTMLElement, callbacks, {
    name: 'sliccy',
    triggerPattern: /^@sliccy\b/i,
  });
  return { orch, callbacks };
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe('AgentBridge — scope-context callbacks forward to OrchestratorCallbacks (VAL-SPAWN-016)', () => {
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

  // ── A. Bridge forwarding ───────────────────────────────────────────

  describe('A. Bridge forwarding: ScoopContextCallbacks → OrchestratorCallbacks', () => {
    it('forwards onResponse(text, isPartial) → orchestrator.onResponse(jid, text, isPartial)', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({
          captured,
          onPrompt: async (rec) => {
            rec.args.callbacks.onResponse('hello delta', true);
            rec.args.callbacks.onResponse('full text', false);
          },
        }),
        generateUid: () => 'fwd-onresp',
        resolveModel: () => 'claude-opus-4-6',
        getInheritedModelId: () => 'claude-opus-4-6',
      });

      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });

      const jid = captured[0].args.scoop.jid;
      const spy = callbacks.onResponse as ReturnType<typeof vi.fn>;
      const callsForJid = spy.mock.calls.filter((c) => c[0] === jid);
      expect(callsForJid).toHaveLength(2);
      expect(callsForJid[0]).toEqual([jid, 'hello delta', true]);
      expect(callsForJid[1]).toEqual([jid, 'full text', false]);
    });

    it('forwards onResponseDone() → orchestrator.onResponseDone(jid)', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({
          captured,
          onPrompt: async (rec) => {
            rec.args.callbacks.onResponseDone();
          },
        }),
        generateUid: () => 'fwd-done',
        resolveModel: () => 'claude-opus-4-6',
        getInheritedModelId: () => 'claude-opus-4-6',
      });

      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });

      const jid = captured[0].args.scoop.jid;
      const spy = callbacks.onResponseDone as ReturnType<typeof vi.fn>;
      const callsForJid = spy.mock.calls.filter((c) => c[0] === jid);
      expect(callsForJid).toHaveLength(1);
      expect(callsForJid[0]).toEqual([jid]);
    });

    it('forwards onToolStart(toolName, toolInput) → orchestrator.onToolStart(jid, toolName, toolInput)', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({
          captured,
          onPrompt: async (rec) => {
            rec.args.callbacks.onToolStart?.('bash', { command: 'ls' });
          },
        }),
        generateUid: () => 'fwd-tstart',
        resolveModel: () => 'claude-opus-4-6',
        getInheritedModelId: () => 'claude-opus-4-6',
      });

      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });

      const jid = captured[0].args.scoop.jid;
      const spy = callbacks.onToolStart as ReturnType<typeof vi.fn>;
      const callsForJid = spy.mock.calls.filter((c) => c[0] === jid);
      expect(callsForJid).toHaveLength(1);
      expect(callsForJid[0]).toEqual([jid, 'bash', { command: 'ls' }]);
    });

    it('forwards onToolEnd(toolName, result, isError) → orchestrator.onToolEnd(jid, toolName, result, isError)', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({
          captured,
          onPrompt: async (rec) => {
            rec.args.callbacks.onToolEnd?.('bash', 'ok', false);
            rec.args.callbacks.onToolEnd?.('bash', 'err!', true);
          },
        }),
        generateUid: () => 'fwd-tend',
        resolveModel: () => 'claude-opus-4-6',
        getInheritedModelId: () => 'claude-opus-4-6',
      });

      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });

      const jid = captured[0].args.scoop.jid;
      const spy = callbacks.onToolEnd as ReturnType<typeof vi.fn>;
      const callsForJid = spy.mock.calls.filter((c) => c[0] === jid);
      expect(callsForJid).toHaveLength(2);
      expect(callsForJid[0]).toEqual([jid, 'bash', 'ok', false]);
      expect(callsForJid[1]).toEqual([jid, 'bash', 'err!', true]);
    });

    it('forwards onError(error) → orchestrator.onError(jid, error)', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({
          captured,
          onPrompt: async (rec) => {
            rec.args.callbacks.onError('something broke');
          },
        }),
        generateUid: () => 'fwd-err',
        resolveModel: () => 'claude-opus-4-6',
        getInheritedModelId: () => 'claude-opus-4-6',
      });

      await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });

      const jid = captured[0].args.scoop.jid;
      const spy = callbacks.onError as ReturnType<typeof vi.fn>;
      const callsForJid = spy.mock.calls.filter((c) => c[0] === jid);
      expect(callsForJid).toHaveLength(1);
      expect(callsForJid[0]).toEqual([jid, 'something broke']);
    });
  });

  // ── C. captured[] + onSendMessage forwarding ──────────────────────

  describe('C. captured[] contract + simultaneous onSendMessage forwarding', () => {
    it('forwards onSendMessage to OrchestratorCallbacks.onSendMessage AND lands text in captured[] ring', async () => {
      const captured: CapturedCtxArgs[] = [];
      const bridge = createAgentBridge(orch, vfs, null, {
        createContext: makeMockContextFactory({
          captured,
          onPrompt: async (rec) => {
            rec.args.callbacks.onSendMessage('first', undefined);
            rec.args.callbacks.onSendMessage('final-text', undefined);
          },
        }),
        generateUid: () => 'cap-fwd',
        resolveModel: () => 'claude-opus-4-6',
        getInheritedModelId: () => 'claude-opus-4-6',
      });

      const result = await bridge.spawn({
        cwd: '/home',
        allowedCommands: ['*'],
        prompt: 'p',
      });

      // (a) captured[] contract — final text reaches stdout.
      expect(result.exitCode).toBe(0);
      expect(result.finalText).toBe('final-text');

      // (b) BOTH send_message calls forwarded to orchestrator so the
      //     side-panel relay (via OffscreenBridge.createCallbacks) sees
      //     them and persists + streams each into the chat panel.
      const jid = captured[0].args.scoop.jid;
      const spy = callbacks.onSendMessage as ReturnType<typeof vi.fn>;
      const callsForJid = spy.mock.calls.filter((c) => c[0] === jid);
      expect(callsForJid).toHaveLength(2);
      // Text is forwarded as-is; no prefix when sender is unset.
      expect(callsForJid[0]).toEqual([jid, 'first']);
      expect(callsForJid[1]).toEqual([jid, 'final-text']);
    });
  });

  // ── D. Architecture pin: buildForwardingScoopCallbacks exists ─────

  describe('D. Orchestrator.buildForwardingScoopCallbacks architectural helper', () => {
    it('exists on the Orchestrator and returns a valid ScoopContextCallbacks that forwards onResponse with jid', async () => {
      // The helper's forward path is guarded by `this.scoops.has(jid)` so
      // that late-firing callbacks after `unregisterScoop` are safely
      // dropped. Register a scoop first so the forward fires.
      const jid = 'direct-jid';
      orch.registerExistingScoop({
        jid,
        name: 'direct-folder',
        folder: 'direct-folder',
        isCone: false,
        type: 'scoop',
        requiresTrigger: false,
        assistantLabel: 'direct-folder',
        addedAt: new Date().toISOString(),
        config: {},
      });

      expect(typeof orch.buildForwardingScoopCallbacks).toBe('function');
      const cbs = orch.buildForwardingScoopCallbacks(jid, 'direct-folder');
      cbs.onResponse('hi', true);

      const spy = callbacks.onResponse as ReturnType<typeof vi.fn>;
      expect(spy).toHaveBeenCalledWith(jid, 'hi', true);
    });

    it('layers extras on top of the forwarding chain (extras run, then orchestrator callbacks run)', () => {
      const jid = 'layered-jid';
      orch.registerExistingScoop({
        jid,
        name: 'layered-folder',
        folder: 'layered-folder',
        isCone: false,
        type: 'scoop',
        requiresTrigger: false,
        assistantLabel: 'layered-folder',
        addedAt: new Date().toISOString(),
        config: {},
      });

      expect(typeof orch.buildForwardingScoopCallbacks).toBe('function');
      const callOrder: string[] = [];
      const extraSpy = vi.fn((_text: string, _isPartial: boolean) => {
        callOrder.push('extras');
      });
      const origOrchSpy = callbacks.onResponse as ReturnType<typeof vi.fn>;
      origOrchSpy.mockImplementation(() => {
        callOrder.push('orchestrator');
      });

      const cbs = orch.buildForwardingScoopCallbacks(jid, 'layered-folder', {
        onResponse: extraSpy,
      });
      cbs.onResponse('t', false);

      expect(extraSpy).toHaveBeenCalledWith('t', false);
      expect(origOrchSpy).toHaveBeenCalledWith(jid, 't', false);
      // extras fires BEFORE the forward so local concerns observe the
      // event first (important for captured[] in AgentBridge so that the
      // final-text capture happens before panel persistence).
      expect(callOrder).toEqual(['extras', 'orchestrator']);
    });

    it('forwards are gated by `this.scoops.has(jid)` — suppresses late-firing callbacks after unregister', () => {
      // When a scoop is not (or no longer) in the registry, the helper does
      // NOT forward to OrchestratorCallbacks. This prevents stray
      // post-cleanup callbacks from writing stale state to the panel.
      expect(typeof orch.buildForwardingScoopCallbacks).toBe('function');
      const cbs = orch.buildForwardingScoopCallbacks('not-registered-jid', 'nope');
      cbs.onResponse('ghost', false);
      expect(callbacks.onResponse).not.toHaveBeenCalled();
    });
  });
});

// ─── B. createScoopTab regression guard ────────────────────────────────

describe('Orchestrator.createScoopTab — helper-delegated forwarding regression guard (VAL-SPAWN-016)', () => {
  // These tests confirm that the feed_scoop-path (the pre-existing path
  // used by user-created scoops) continues to forward ScoopContextCallbacks
  // → OrchestratorCallbacks after the helper refactor. We directly exercise
  // the helper that `createScoopTab` now uses, with a `scoop.isCone = false`
  // shape so that no cone-only wiring fires.

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

  it('feed_scoop-style path: ScoopContextCallbacks.onResponse → OrchestratorCallbacks.onResponse(jid, text, isPartial)', () => {
    // Register a scoop so that the orchestrator's internal `this.scoops.has(jid)`
    // guards (carried over into extras) treat it as live.
    const jid = 'scoop_feed_path';
    orch.registerExistingScoop({
      jid,
      name: 'feed-path',
      folder: 'feed-path',
      isCone: false,
      type: 'scoop',
      requiresTrigger: false,
      assistantLabel: 'feed-path',
      addedAt: new Date().toISOString(),
      config: {},
    });

    type MaybePrivateHelper = {
      buildForwardingScoopCallbacks?: (
        jid: string,
        folder: string,
        extras?: unknown
      ) => {
        onResponse: (text: string, isPartial: boolean) => void;
        onResponseDone: () => void;
        onToolStart?: (toolName: string, toolInput: unknown) => void;
        onToolEnd?: (toolName: string, result: string, isError: boolean) => void;
      };
    };
    const helper = (orch as unknown as MaybePrivateHelper).buildForwardingScoopCallbacks;
    expect(typeof helper).toBe('function');

    const cbs = helper!.call(orch, jid, 'feed-path');
    cbs.onResponse('delta', true);
    cbs.onResponseDone();
    cbs.onToolStart?.('bash', { command: 'echo ok' });
    cbs.onToolEnd?.('bash', 'ok', false);

    expect(callbacks.onResponse).toHaveBeenCalledWith(jid, 'delta', true);
    expect(callbacks.onResponseDone).toHaveBeenCalledWith(jid);
    expect(callbacks.onToolStart).toHaveBeenCalledWith(jid, 'bash', { command: 'echo ok' });
    expect(callbacks.onToolEnd).toHaveBeenCalledWith(jid, 'bash', 'ok', false);
  });
});

// ─── E. Status-broadcast dedup (core-followup-2) ───────────────────────

describe('Orchestrator bridge-scoop status broadcast dedup (core-followup-2)', () => {
  // Rationale: before the fix, a single scope-context `onStatusChange`
  // transition fired `OrchestratorCallbacks.onStatusChange` TWICE for
  // bridge scoops — once via `updateBridgeTabStatus` (which broadcast
  // internally) AND once via the helper's forwarding phase. That is
  // harmless today but unnecessary churn + a foot-gun for future
  // status-sensitive behavior. The fix removes the duplicate broadcast
  // from `updateBridgeTabStatus` so forwarding is solely owned by
  // `buildForwardingScoopCallbacks`. The helper forwards exactly once
  // per transition; `updateBridgeTabStatus` remains the tab-state mutator.

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

  it('bridge extras + forwarding helper produce exactly ONE onStatusChange broadcast per transition', () => {
    // Arrange — register a bridge scoop. This fires an initial
    // `onStatusChange(jid, "initializing")` broadcast via
    // `registerExistingScoop`; clear the spy so only transitions under
    // test are counted.
    const jid = 'dedup-status';
    orch.registerExistingScoop({
      jid,
      name: 'dedup-folder',
      folder: 'dedup-folder',
      isCone: false,
      type: 'scoop',
      requiresTrigger: false,
      assistantLabel: 'dedup-folder',
      addedAt: new Date().toISOString(),
      config: {},
    });
    (callbacks.onStatusChange as ReturnType<typeof vi.fn>).mockClear();

    // Act — wire the helper the SAME way `AgentBridge.spawn` does: extras
    // route every scope-context status change through
    // `orchestrator.updateBridgeTabStatus`. Drive two transitions.
    const cbs = orch.buildForwardingScoopCallbacks(jid, 'dedup-folder', {
      onStatusChange: (status) => {
        orch.updateBridgeTabStatus(jid, status);
      },
    });
    cbs.onStatusChange('processing');
    cbs.onStatusChange('ready');

    // Assert — exactly one broadcast per transition (pre-fix: two each).
    const spy = callbacks.onStatusChange as ReturnType<typeof vi.fn>;
    const processingCalls = spy.mock.calls.filter((c) => c[0] === jid && c[1] === 'processing');
    const readyCalls = spy.mock.calls.filter((c) => c[0] === jid && c[1] === 'ready');
    expect(processingCalls).toHaveLength(1);
    expect(readyCalls).toHaveLength(1);
  });

  it('updateBridgeTabStatus preserves tab-state mutation (broadcast removed, mutation intact)', () => {
    const jid = 'mut-preserved';
    orch.registerExistingScoop({
      jid,
      name: 'mut-folder',
      folder: 'mut-folder',
      isCone: false,
      type: 'scoop',
      requiresTrigger: false,
      assistantLabel: 'mut-folder',
      addedAt: new Date().toISOString(),
      config: {},
    });

    // updateBridgeTabStatus must still mutate the tab entry so the UI
    // (and `list_scoops`) observe the new status via `getScoopTabState`.
    orch.updateBridgeTabStatus(jid, 'processing');
    expect(orch.getScoopTabState(jid)?.status).toBe('processing');

    orch.updateBridgeTabStatus(jid, 'ready');
    expect(orch.getScoopTabState(jid)?.status).toBe('ready');
  });
});
