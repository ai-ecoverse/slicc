/**
 * Tests for the `Orchestrator.unregisterScoop` cleanup-ordering contract.
 *
 * Scope: follow-up to VAL-SPAWN-015 (bridge-spawned scoop visibility). The
 * visibility feature introduced a terminal `onStatusChange(jid, 'ready')`
 * callback so the UI's side-panel `ScoopsPanel` refreshes when a bridge
 * scoop's run ends. Because the UI's `onStatusChange` handler re-reads
 * `orchestrator.getScoops()` via `refreshScoops()`, the terminal callback
 * MUST fire ONLY AFTER the scoop has been removed from `this.scoops` and
 * its tab entry cleared from `this.tabs`. Otherwise the panel reads the
 * about-to-be-removed scoop one last time and leaves a ghost row in the
 * UI until an unrelated refresh later clears it (if ever).
 *
 * Contract (post-fix):
 *   1. When the terminal `onStatusChange(jid, 'ready')` fires for a
 *      bridge-registered scoop during `unregisterScoop(jid)`:
 *        - `orchestrator.getScoops().find(s => s.jid === jid)` is
 *          `undefined` (the scoop has already been removed from the
 *          registry).
 *        - `orchestrator.getScoopTabState(jid)` is `undefined` (the tab
 *          entry has already been dropped).
 *        - The in-memory message queue for that jid has been cleared
 *          (observable via `orchestrator.getScoop(jid)` returning
 *          `undefined`).
 *   2. After `bridge.spawn()` resolves, the scoop is fully gone — no
 *      entries remain in `getScoops()` / `getScoopTabState()`.
 *
 * If the old ordering ever regresses (callback BEFORE removal), these
 * assertions fail inside the spy's callback invocation, which is detected
 * via a captured-state sentinel checked after `spawn()` resolves.
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

interface MockScoopContextOptions {
  captured: CapturedCtxArgs[];
}

function makeMockContextFactory(
  opts: MockScoopContextOptions
): (args: AgentBridgeContextArgs) => AgentBridgeContext {
  return (args) => {
    const record: CapturedCtxArgs = { args };
    opts.captured.push(record);

    return {
      async init() {
        // no-op
      },
      async prompt(_text: string) {
        // Resolve immediately so the bridge proceeds straight to cleanup.
        return;
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
    dbName: `agent-cleanup-test-${Math.random()}`,
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

// ─── Tests ─────────────────────────────────────────────────────────────

describe('Orchestrator.unregisterScoop cleanup ordering (bridge scoops)', () => {
  let vfs: VirtualFS;
  let orch: Orchestrator;

  beforeEach(async () => {
    vfs = await makeVfs();
  });

  afterEach(async () => {
    await orch?.shutdown().catch(() => {});
    await vfs.dispose().catch(() => {});
  });

  it("fires terminal onStatusChange(jid, 'ready') AFTER removing the scoop from getScoops()", async () => {
    /**
     * Capture the orchestrator state observed inside the spy's callback
     * function body at the moment `onStatusChange(jid, 'ready')` fires
     * for the bridge scoop. After `spawn()` resolves we assert those
     * captured values against the post-fix contract.
     *
     * We compute the expected bridge jid synchronously from a
     * deterministic `generateUid`, so the spy can match on it from the
     * very first callback invocation — no microtask/macrotask timing
     * race. The bridge jid format is `agent_${uid}` per `agent-bridge.ts`.
     */
    const uid = 'cleanup-order';
    const expectedJid = `agent_${uid}`;

    let readyCallbackFired = false;
    let scoopStillInRegistryAtReady: boolean | null = null;
    let tabStateAtReady: ReturnType<Orchestrator['getScoopTabState']> | 'not-captured' =
      'not-captured';

    // Pre-create the orchestrator with a callback that inspects the
    // orchestrator state at the moment 'ready' fires for the bridge jid.
    const callbacks: OrchestratorCallbacks = {
      onResponse: vi.fn(),
      onResponseDone: vi.fn(),
      onSendMessage: vi.fn(),
      onStatusChange: vi.fn((jid: string, status: string) => {
        if (jid === expectedJid && status === 'ready') {
          readyCallbackFired = true;
          // At this exact moment, getScoops() MUST NOT include this jid
          // and getScoopTabState(jid) MUST be undefined.
          scoopStillInRegistryAtReady = orch.getScoops().some((s) => s.jid === jid);
          tabStateAtReady = orch.getScoopTabState(jid);
        }
      }),
      onError: vi.fn(),
      getBrowserAPI: () => ({}) as any,
    };
    await db.initDB();
    orch = new Orchestrator({} as unknown as HTMLElement, callbacks, {
      name: 'sliccy',
      triggerPattern: /^@sliccy\b/i,
    });

    const captured: CapturedCtxArgs[] = [];
    const bridge = createAgentBridge(orch, vfs, null, {
      createContext: makeMockContextFactory({ captured }),
      generateUid: () => uid,
      resolveModel: () => 'claude-opus-4-6',
      getInheritedModelId: () => 'claude-opus-4-6',
    });

    // Kick off the spawn. The bridge registers the scoop before calling
    // prompt(); our mock prompt() resolves immediately, so the bridge
    // proceeds into its finally-block cleanup that calls
    // `orchestrator.unregisterScoop(jid)`.
    const result = await bridge.spawn({
      cwd: '/home',
      allowedCommands: ['*'],
      prompt: 'p',
    });
    expect(result.exitCode).toBe(0);
    expect(captured.length).toBe(1);
    expect(captured[0].args.scoop.jid).toBe(expectedJid);

    // The terminal callback MUST have fired for this jid.
    expect(readyCallbackFired).toBe(true);

    // Core cleanup-ordering assertions: at the moment the terminal
    // `ready` callback fired, the scoop was already removed.
    expect(scoopStillInRegistryAtReady).toBe(false);
    expect(tabStateAtReady).toBeUndefined();

    // And post-spawn the registry is still clean.
    expect(orch.getScoops().find((s) => s.jid === expectedJid)).toBeUndefined();
    expect(orch.getScoopTabState(expectedJid)).toBeUndefined();
    expect(orch.getScoop(expectedJid)).toBeUndefined();
  });

  it('fires terminal onStatusChange(jid, ready) exactly once per bridge cleanup', async () => {
    // Spy counts calls with (jid, 'ready') for the bridge scoop. Exactly
    // one is expected — the bridge-tab branch in unregisterScoop.
    const { orch: o, callbacks } = await makeOrchestrator();
    orch = o;

    const captured: CapturedCtxArgs[] = [];
    const bridge = createAgentBridge(orch, vfs, null, {
      createContext: makeMockContextFactory({ captured }),
      generateUid: () => 'ready-count',
      resolveModel: () => 'claude-opus-4-6',
      getInheritedModelId: () => 'claude-opus-4-6',
    });

    await bridge.spawn({ cwd: '/home', allowedCommands: ['*'], prompt: 'p' });

    const jid = captured[0].args.scoop.jid;
    const spy = callbacks.onStatusChange as ReturnType<typeof vi.fn>;
    const readyCalls = spy.mock.calls.filter(
      (call: unknown[]) => call[0] === jid && call[1] === 'ready'
    );
    expect(readyCalls.length).toBe(1);
  });

  it('direct unregisterScoop on a bridge-registered scoop removes registry BEFORE firing onStatusChange', async () => {
    // Unit-level probe: register a bridge scoop directly, then invoke
    // unregisterScoop() without going through the AgentBridge. This
    // isolates the ordering inside unregisterScoop itself.
    let snapshotAtReady: {
      scoopPresent: boolean;
      tabState: ReturnType<Orchestrator['getScoopTabState']>;
    } | null = null;

    const callbacks: OrchestratorCallbacks = {
      onResponse: vi.fn(),
      onResponseDone: vi.fn(),
      onSendMessage: vi.fn(),
      onStatusChange: vi.fn((jid: string, status: string) => {
        if (status === 'ready' && jid === 'agent_direct_cleanup') {
          snapshotAtReady = {
            scoopPresent: orch.getScoops().some((s) => s.jid === jid),
            tabState: orch.getScoopTabState(jid),
          };
        }
      }),
      onError: vi.fn(),
      getBrowserAPI: () => ({}) as any,
    };
    await db.initDB();
    orch = new Orchestrator({} as unknown as HTMLElement, callbacks, {
      name: 'sliccy',
      triggerPattern: /^@sliccy\b/i,
    });

    const jid = 'agent_direct_cleanup';
    orch.registerExistingScoop({
      jid,
      name: 'agent-direct-cleanup',
      folder: 'agent-direct-cleanup',
      isCone: false,
      type: 'scoop',
      requiresTrigger: false,
      assistantLabel: 'agent-direct-cleanup',
      addedAt: new Date().toISOString(),
      config: {},
    });

    // Sanity: pre-cleanup state is populated.
    expect(orch.getScoops().some((s) => s.jid === jid)).toBe(true);
    expect(orch.getScoopTabState(jid)).toBeDefined();

    await orch.unregisterScoop(jid);

    // The terminal callback fired and observed a post-removal registry.
    expect(snapshotAtReady).not.toBeNull();
    expect(snapshotAtReady!.scoopPresent).toBe(false);
    expect(snapshotAtReady!.tabState).toBeUndefined();

    // And the final state confirms removal.
    expect(orch.getScoops().some((s) => s.jid === jid)).toBe(false);
    expect(orch.getScoopTabState(jid)).toBeUndefined();
  });
});
