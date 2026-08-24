/**
 * Tests for the streamlined AgentBridge. Uses a mock Orchestrator that
 * records `registerScoop`, `sendPrompt`, `unregisterScoop`, and the
 * observer subscription — the bridge doesn't own a ScoopContext anymore,
 * so the test doesn't need to stand up one.
 */

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsError } from '../../src/fs/types.js';
import type { VirtualFS } from '../../src/fs/virtual-fs.js';
import {
  AGENT_BRIDGE_GLOBAL_KEY,
  type AgentSpawnOptions,
  createAgentBridge,
  defaultResolveModel,
  publishAgentBridge,
} from '../../src/scoops/agent-bridge.js';

// `defaultResolveModel` is a thin delegate over account-store's
// `resolveModelSelectionForScoop`; mock just that seam and keep every other
// provider-settings export real so the rest of the suite is unaffected. The
// resolver's own alias/provider-scoping semantics are covered against the real
// pi-ai catalogue in tests/providers/model-alias-resolution.test.ts.
//
// The mock stands in for two configured providers — `adobe` (selected) and
// `openrouter` — mirroring the #2195 setup. The adobe list includes
// claude-haiku-4-5, which the real picker hides via
// PICKER_HIDDEN_MODEL_PATTERNS — the regression: a picker-hidden model must
// still validate for an explicit sub-agent target.
const MOCK_CATALOGUES: Record<
  string,
  Array<{ id: string; name: string; contextWindow: number }>
> = {
  adobe: [
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: 200000 },
    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', contextWindow: 200000 },
    { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', contextWindow: 1000000 },
    { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', contextWindow: 1000000 },
  ],
  openrouter: [
    { id: 'openai/gpt-5.6-terra-pro', name: 'GPT-5.6 Terra Pro', contextWindow: 400000 },
    { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128000 },
    { id: 'gpt-5', name: 'GPT-5', contextWindow: 1000000 },
    { id: 'o3', name: 'o3', contextWindow: 200000 },
    { id: 'anthropic/claude-opus-5-fast', name: 'Claude Opus 5 Fast', contextWindow: 1000000 },
  ],
};
const MOCK_SELECTED_PROVIDER = 'adobe';

/** Exact id, else the keyword match with the largest context window. */
function matchInProvider(input: string, providerId: string): string | null {
  const catalogue = MOCK_CATALOGUES[providerId] ?? [];
  if (catalogue.some((m) => m.id === input)) return input;
  const keyword = input.toLowerCase();
  const matches = catalogue.filter(
    (m) => m.id.toLowerCase().includes(keyword) || m.name.toLowerCase().includes(keyword)
  );
  if (matches.length === 0) return null;
  return matches.reduce((best, m) =>
    m.contextWindow > best.contextWindow ||
    (m.contextWindow === best.contextWindow && m.id > best.id)
      ? m
      : best
  ).id;
}

/** Structural stand-in for `resolveModelSelectionForScoop`. */
function mockResolveModelSelectionForScoop(input: string): {
  ok: boolean;
  selection?: { modelId: string; providerId: string };
  error?: string;
} {
  if (!input) return { ok: false, error: 'unknown model: (empty)' };
  const idx = input.indexOf(':');
  const prefix = idx > 0 ? input.slice(0, idx) : null;
  if (prefix !== null && Object.hasOwn(MOCK_CATALOGUES, prefix)) {
    const modelId = matchInProvider(input.slice(idx + 1), prefix);
    return modelId === null
      ? { ok: false, error: `unknown model: ${input}` }
      : { ok: true, selection: { modelId, providerId: prefix } };
  }
  const selected = matchInProvider(input, MOCK_SELECTED_PROVIDER);
  if (selected !== null) {
    return { ok: true, selection: { modelId: selected, providerId: MOCK_SELECTED_PROVIDER } };
  }
  const others = Object.keys(MOCK_CATALOGUES)
    .filter((p) => p !== MOCK_SELECTED_PROVIDER)
    .flatMap((providerId) => {
      const modelId = matchInProvider(input, providerId);
      return modelId === null ? [] : [{ modelId, providerId }];
    });
  if (others.length === 1) return { ok: true, selection: others[0] };
  if (others.length > 1) {
    return {
      ok: false,
      error: `ambiguous model: ${input} matches ${others
        .map((o) => `${o.providerId}:${o.modelId}`)
        .join(', ')} — qualify it as provider:model`,
    };
  }
  return { ok: false, error: `unknown model: ${input}` };
}

vi.mock('../../src/providers/account-store.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/providers/account-store.js')>();
  return {
    ...actual,
    resolveModelSelectionForScoop: mockResolveModelSelectionForScoop,
  };
});

/** Shorthand for a successful resolver stub in `deps.resolveModel`. */
function pinned(modelId: string, providerId = MOCK_SELECTED_PROVIDER) {
  return { ok: true as const, selection: { modelId, providerId } };
}

import type { Orchestrator, ScoopObserver } from '../../src/scoops/orchestrator.js';
import type { ScoopContext } from '../../src/scoops/scoop-context.js';
import type { RegisteredScoop } from '../../src/scoops/types.js';
import { CURRENT_SCOOP_CONFIG_VERSION } from '../../src/scoops/types.js';
import { LiveWorkUnit } from '../../src/work-unit/live-unit.js';
import { WorkUnitManager } from '../../src/work-unit/manager.js';

/**
 * Observer-driven mock orchestrator. Each `sendPrompt` call drives the
 * scoop through a scripted event sequence (set via `mock.scriptRun`) so
 * tests can assert end-to-end capture without a real ScoopContext.
 */
function makeMockOrchestrator(): {
  orchestrator: Orchestrator;
  registerCalls: RegisteredScoop[];
  unregisterCalls: string[];
  sendPromptCalls: Array<{ jid: string; prompt: string }>;
  observers: Map<string, Set<ScoopObserver>>;
  scripts: Map<string, (obs: ScoopObserver) => Promise<void> | void>;
  knownScoops: RegisteredScoop[];
} {
  const registerCalls: RegisteredScoop[] = [];
  const unregisterCalls: string[] = [];
  const sendPromptCalls: Array<{ jid: string; prompt: string }> = [];
  const observers = new Map<string, Set<ScoopObserver>>();
  const scripts = new Map<string, (obs: ScoopObserver) => Promise<void> | void>();
  const knownScoops: RegisteredScoop[] = [];

  const mock: Partial<Orchestrator> = {
    registerScoop: vi.fn(async (scoop: RegisteredScoop) => {
      registerCalls.push(scoop);
      knownScoops.push(scoop);
    }),
    unregisterScoop: vi.fn(async (jid: string) => {
      unregisterCalls.push(jid);
      const idx = knownScoops.findIndex((s) => s.jid === jid);
      if (idx >= 0) knownScoops.splice(idx, 1);
    }),
    sendPrompt: vi.fn(
      async (jid: string, prompt: string, _senderId: string, _senderName: string) => {
        sendPromptCalls.push({ jid, prompt });
        const script = scripts.get(jid);
        if (!script) return;
        const obsSet = observers.get(jid);
        if (!obsSet || obsSet.size === 0) return;
        for (const obs of obsSet) {
          await script(obs);
        }
      }
    ),
    observeScoop: vi.fn((jid: string, observer: ScoopObserver) => {
      let set = observers.get(jid);
      if (!set) {
        set = new Set();
        observers.set(jid, set);
      }
      set.add(observer);
      return () => {
        const s = observers.get(jid);
        if (!s) return;
        s.delete(observer);
        if (s.size === 0) observers.delete(jid);
      };
    }),
    getScoops: vi.fn(() => knownScoops),
    getScoopContext: vi.fn(() => undefined),
  };

  mock.getWorkUnits = vi.fn(() => makeWorkUnits(knownScoops));

  return {
    orchestrator: mock as unknown as Orchestrator,
    registerCalls,
    unregisterCalls,
    sendPromptCalls,
    observers,
    scripts,
    knownScoops,
  };
}

/**
 * The bridge resolves a spawned agent's default read-only roots through the
 * REAL `WorkUnitManager.rootOf` walk (#2271), so every orchestrator double
 * hands it a manager over its own registry rather than re-implementing the
 * walk.
 */
function makeWorkUnits(scoops: RegisteredScoop[]): WorkUnitManager {
  return new WorkUnitManager({
    getScoop: (jid) => scoops.find((s) => s.jid === jid),
    getScoops: () => scoops,
    registerScoop: async () => {},
    ensureLiveUnit: (jid) =>
      new LiveWorkUnit(jid, {
        getScoop: (j) => scoops.find((s) => s.jid === j),
        sendPrompt: async () => {},
        clearIdleTimer: () => {},
        forgetCompletion: () => {},
        unregister: async () => {},
      }),
  });
}

function makeMockSharedFs(options?: {
  /** Throw from `rm`. Takes the path so the caller can pick a matching error. */
  rm?: (path: string) => Promise<void>;
  /** Throw from `writeFile` (receipt-failure tests). */
  writeFile?: (path: string) => Promise<void>;
}): { fs: VirtualFS; rmCalls: string[]; writes: Array<{ path: string; content: string }> } {
  const rmCalls: string[] = [];
  const writes: Array<{ path: string; content: string }> = [];
  const mock: Partial<VirtualFS> = {
    rm: vi.fn(async (path: string) => {
      rmCalls.push(path);
      if (options?.rm) await options.rm(path);
    }) as unknown as VirtualFS['rm'],
    mkdir: vi.fn(async () => {}) as unknown as VirtualFS['mkdir'],
    writeFile: vi.fn(async (path: string, content: string) => {
      if (options?.writeFile) await options.writeFile(path);
      writes.push({ path, content });
    }) as unknown as VirtualFS['writeFile'],
  };
  return { fs: mock as unknown as VirtualFS, rmCalls, writes };
}

const BASE_OPTS: AgentSpawnOptions = {
  cwd: '/workspace',
  allowedCommands: ['*'],
  prompt: 'hello',
};

describe('createAgentBridge — config construction', () => {
  it('builds a scoop record with pure-replace sandbox config and stamps schema version', async () => {
    const { orchestrator, registerCalls, scripts } = makeMockOrchestrator();
    const { fs: sharedFs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, sharedFs, null, {
      generateName: () => 'exuberant-lavender',
      resolveModel: (id) => pinned(id),
    });

    scripts.set('agent_exuberant_lavender', (obs) => {
      obs.onSendMessage?.('hi');
    });
    await bridge.spawn(BASE_OPTS);

    expect(registerCalls).toHaveLength(1);
    const scoop = registerCalls[0];
    expect(scoop.jid).toBe('agent_exuberant_lavender');
    expect(scoop.folder).toBe('agent-exuberant-lavender');
    expect(scoop.folder).toMatch(/^agent-[a-z]+-[a-z]+$/);
    expect(scoop.jid).toMatch(/^agent_[a-z]+_[a-z]+$/);
    expect(scoop.configSchemaVersion).toBe(CURRENT_SCOOP_CONFIG_VERSION);
    // Ephemeral agent scoops must opt out of the orchestrator's cone-notify
    // side effect; the bridge drains responses via `observeScoop` instead.
    expect(scoop.notifyOnComplete).toBe(false);
    expect(scoop.config).toEqual({
      visiblePaths: ['/workspace/'],
      writablePaths: ['/workspace/', '/shared/', '/scoops/agent-exuberant-lavender/', '/tmp/'],
      allowedCommands: ['*'],
    });
  });

  it('normalizes cwd to a trailing-slash prefix', async () => {
    const { orchestrator, registerCalls, scripts } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'jolly-mint',
    });
    scripts.set('agent_jolly_mint', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn({ ...BASE_OPTS, cwd: '/scoops/some-scoop' });

    expect(registerCalls[0].config?.writablePaths?.[0]).toBe('/scoops/some-scoop/');
  });

  it('uses explicit writablePaths with pure-replace semantics', async () => {
    const { orchestrator, registerCalls, scripts } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'jolly-mint',
    });
    scripts.set('agent_jolly_mint', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn({
      ...BASE_OPTS,
      writablePaths: ['/workspace', '/knowledge/'],
    });

    expect(registerCalls[0].config?.writablePaths).toEqual([
      '/workspace/',
      '/knowledge/',
      '/scoops/agent-jolly-mint/',
      '/tmp/',
    ]);
  });

  it('keeps historical cwd and /shared roots when writablePaths is omitted', async () => {
    const { orchestrator, registerCalls, scripts } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'jolly-mint',
    });
    scripts.set('agent_jolly_mint', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn({ ...BASE_OPTS, cwd: '/scoops/caller' });

    expect(registerCalls[0].config?.writablePaths).toEqual([
      '/scoops/caller/',
      '/shared/',
      '/scoops/agent-jolly-mint/',
      '/tmp/',
    ]);
  });

  it('falls back to historical writable roots for a non-absolute override', async () => {
    const { orchestrator, registerCalls, scripts } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'jolly-mint',
    });
    scripts.set('agent_jolly_mint', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn({ ...BASE_OPTS, writablePaths: ['/knowledge/', 'relative'] });

    expect(registerCalls[0].config?.writablePaths).toEqual([
      '/workspace/',
      '/shared/',
      '/scoops/agent-jolly-mint/',
      '/tmp/',
    ]);
  });

  it('forwards allowedCommands verbatim', async () => {
    const { orchestrator, registerCalls, scripts } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'jolly-mint',
    });
    scripts.set('agent_jolly_mint', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn({ ...BASE_OPTS, allowedCommands: ['echo', 'cat'] });

    expect(registerCalls[0].config?.allowedCommands).toEqual(['echo', 'cat']);
  });

  it('defaults visiblePaths to ["/workspace/"] when the option is absent', async () => {
    const { orchestrator, registerCalls, scripts } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, { generateUid: () => 'u' });
    scripts.set('agent_u', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn(BASE_OPTS);

    expect(registerCalls[0].config?.visiblePaths).toEqual(['/workspace/']);
  });

  // #2271: the default read-only root is the workspace of the ROOT that owns
  // the spawning unit, so an agent spawned inside an extra cone (or by one of
  // its scoops) reads that cone's files, not the primary cone's.
  it('defaults visiblePaths to the owning cone workspace when spawned under an extra cone', async () => {
    const { orchestrator, registerCalls, scripts, knownScoops } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const extraCone: RegisteredScoop = {
      jid: 'cone_beta',
      name: 'Beta',
      folder: 'cone-beta',
      requiresTrigger: false,
      assistantLabel: 'Beta',
      addedAt: new Date().toISOString(),
      parentJid: null,
    };
    const betaScoop: RegisteredScoop = {
      ...extraCone,
      jid: 'scoop_beta_worker',
      name: 'worker',
      folder: 'beta-worker',
      assistantLabel: 'beta-worker',
      parentJid: extraCone.jid,
    };
    knownScoops.push(extraCone, betaScoop);
    const bridge = createAgentBridge(orchestrator, fs, null, { generateUid: () => 'u' });
    scripts.set('agent_u', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn({ ...BASE_OPTS, parentJid: extraCone.jid });
    // The skills library rides along — it lives outside the cone's workspace.
    expect(registerCalls[0].config?.visiblePaths).toEqual([
      '/cones/cone-beta/workspace/',
      '/workspace/skills/',
    ]);

    // …and through a scoop of that cone: the chain is walked up to the root.
    scripts.set('agent_u', (obs) => obs.onSendMessage?.('done'));
    await bridge.spawn({ ...BASE_OPTS, parentJid: betaScoop.jid });
    expect(registerCalls[1].config?.visiblePaths).toEqual([
      '/cones/cone-beta/workspace/',
      '/workspace/skills/',
    ]);
  });

  it('passes an explicit visiblePaths list through pure-replace (no merge with /workspace/)', async () => {
    const { orchestrator, registerCalls, scripts } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, { generateUid: () => 'u' });
    scripts.set('agent_u', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn({ ...BASE_OPTS, visiblePaths: ['/foo/'] });

    expect(registerCalls[0].config?.visiblePaths).toEqual(['/foo/']);
  });

  it('passes visiblePaths: [] through as an empty read-only root list', async () => {
    const { orchestrator, registerCalls, scripts } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, { generateUid: () => 'u' });
    scripts.set('agent_u', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn({ ...BASE_OPTS, visiblePaths: [] });

    expect(registerCalls[0].config?.visiblePaths).toEqual([]);
  });

  it('normalizes each visiblePaths entry to a trailing-slash prefix', async () => {
    const { orchestrator, registerCalls, scripts } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, { generateUid: () => 'u' });
    scripts.set('agent_u', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn({
      ...BASE_OPTS,
      visiblePaths: ['/workspace', '/shared/assets/', '/docs'],
    });

    expect(registerCalls[0].config?.visiblePaths).toEqual([
      '/workspace/',
      '/shared/assets/',
      '/docs/',
    ]);
  });

  it('preserves existing visiblePaths already ending in a slash without doubling it', async () => {
    const { orchestrator, registerCalls, scripts } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, { generateUid: () => 'u' });
    scripts.set('agent_u', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn({ ...BASE_OPTS, visiblePaths: ['/workspace/'] });

    expect(registerCalls[0].config?.visiblePaths).toEqual(['/workspace/']);
  });

  it('unions invokingCwd into the default visiblePaths when --read-only is absent', async () => {
    const { orchestrator, registerCalls, scripts } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, { generateUid: () => 'u' });
    scripts.set('agent_u', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn({ ...BASE_OPTS, invokingCwd: '/home/user' });

    expect(registerCalls[0].config?.visiblePaths).toEqual(['/workspace/', '/home/user/']);
  });

  it('de-dupes invokingCwd against the /workspace/ default when they match', async () => {
    const { orchestrator, registerCalls, scripts } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, { generateUid: () => 'u' });
    scripts.set('agent_u', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn({ ...BASE_OPTS, invokingCwd: '/workspace' });

    expect(registerCalls[0].config?.visiblePaths).toEqual(['/workspace/']);
  });

  it('normalizes invokingCwd to a trailing-slash prefix', async () => {
    const { orchestrator, registerCalls, scripts } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, { generateUid: () => 'u' });
    scripts.set('agent_u', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn({ ...BASE_OPTS, invokingCwd: '/home/user' });

    // The second entry is the normalized invokingCwd — no pre-existing
    // trailing slash, but the bridge adds one.
    expect(registerCalls[0].config?.visiblePaths?.[1]).toBe('/home/user/');
  });

  it('ignores invokingCwd when an explicit --read-only list is set (pure-replace wins)', async () => {
    const { orchestrator, registerCalls, scripts } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, { generateUid: () => 'u' });
    scripts.set('agent_u', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn({
      ...BASE_OPTS,
      invokingCwd: '/home/user',
      visiblePaths: ['/custom/'],
    });

    // --read-only pure-replace: neither /workspace/ nor invokingCwd leak
    // into the final list.
    expect(registerCalls[0].config?.visiblePaths).toEqual(['/custom/']);
  });

  it('ignores invokingCwd when visiblePaths is explicitly an empty list', async () => {
    const { orchestrator, registerCalls, scripts } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, { generateUid: () => 'u' });
    scripts.set('agent_u', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn({
      ...BASE_OPTS,
      invokingCwd: '/home/user',
      visiblePaths: [],
    });

    expect(registerCalls[0].config?.visiblePaths).toEqual([]);
  });

  it('ignores empty-string invokingCwd (terminal shell sometimes starts without one)', async () => {
    const { orchestrator, registerCalls, scripts } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, { generateUid: () => 'u' });
    scripts.set('agent_u', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn({ ...BASE_OPTS, invokingCwd: '' });

    expect(registerCalls[0].config?.visiblePaths).toEqual(['/workspace/']);
  });

  it('always includes /tmp/ in writablePaths — unchangeable by any spawn option', async () => {
    const { orchestrator, registerCalls, scripts } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, { generateUid: () => 'u' });
    scripts.set('agent_u', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn({
      ...BASE_OPTS,
      visiblePaths: ['/anything/'],
      invokingCwd: '/anywhere',
      allowedCommands: ['ls'],
    });

    expect(registerCalls[0].config?.writablePaths).toContain('/tmp/');
  });

  it('does not duplicate /tmp/ when cwd == /tmp (prefix-normalized equality)', async () => {
    const { orchestrator, registerCalls, scripts } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, { generateUid: () => 'u' });
    scripts.set('agent_u', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn({ ...BASE_OPTS, cwd: '/tmp' });

    const tmpCount = (registerCalls[0].config?.writablePaths ?? []).filter(
      (p) => p === '/tmp/'
    ).length;
    expect(tmpCount).toBe(1);
  });

  it('writablePaths baseline (cwd=/workspace) is [cwd, /shared/, scratch, /tmp/]', async () => {
    const { orchestrator, registerCalls, scripts } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'jolly-mint',
    });
    scripts.set('agent_jolly_mint', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn(BASE_OPTS);

    expect(registerCalls[0].config?.writablePaths).toEqual([
      '/workspace/',
      '/shared/',
      '/scoops/agent-jolly-mint/',
      '/tmp/',
    ]);
  });
});

describe('createAgentBridge — name generation', () => {
  it('defaults to an <adjective>-<flavor> token when no generator is injected', async () => {
    const { orchestrator, registerCalls, scripts, observers } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null);
    // We don't know the jid in advance — drive the script through the
    // observer subscription as it fires.
    (orchestrator.sendPrompt as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      // Fire a minimal success event through every observer so the
      // spawn completes cleanly.
      for (const set of observers.values()) {
        for (const obs of set) {
          obs.onSendMessage?.('done');
        }
      }
    });
    void scripts; // unused in this test

    const result = await bridge.spawn(BASE_OPTS);

    expect(result.exitCode).toBe(0);
    expect(registerCalls).toHaveLength(1);
    const scoop = registerCalls[0];
    expect(scoop.folder).toMatch(/^agent-[a-z]+-[a-z]+$/);
    expect(scoop.jid).toMatch(/^agent_[a-z]+_[a-z]+$/);
  });

  it('retries the name generator when the first pick collides with an existing jid', async () => {
    const { orchestrator, registerCalls, scripts, knownScoops } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    // Seed a fake collision: a previously-registered agent scoop with the
    // jid the first pick would produce.
    knownScoops.push({
      jid: 'agent_cozy_vanilla',
      name: 'agent-cozy-vanilla',
      folder: 'agent-cozy-vanilla',
      parentJid: 'cone_1',
      requiresTrigger: false,
      assistantLabel: 'agent-cozy-vanilla',
      addedAt: '2026-04-19T00:00:00Z',
    });

    const picks = ['cozy-vanilla', 'sunny-mango'];
    let callIdx = 0;
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => picks[callIdx++] ?? 'fallback-fallback',
    });
    scripts.set('agent_sunny_mango', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn(BASE_OPTS);

    expect(callIdx).toBe(2); // one collision, one fresh pick
    expect(registerCalls[0].folder).toBe('agent-sunny-mango');
    expect(registerCalls[0].jid).toBe('agent_sunny_mango');
  });

  it('falls back to the hex uid generator after eight consecutive collisions', async () => {
    const { orchestrator, registerCalls, scripts, knownScoops } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    // Seed a collision for the one name the generator will ever return.
    knownScoops.push({
      jid: 'agent_cozy_vanilla',
      name: 'agent-cozy-vanilla',
      folder: 'agent-cozy-vanilla',
      parentJid: 'cone_1',
      requiresTrigger: false,
      assistantLabel: 'agent-cozy-vanilla',
      addedAt: '2026-04-19T00:00:00Z',
    });

    let nameCalls = 0;
    let uidCalls = 0;
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => {
        nameCalls++;
        return 'cozy-vanilla'; // always collides
      },
      generateUid: () => {
        uidCalls++;
        return 'deadbeef';
      },
    });
    scripts.set('agent_deadbeef', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn(BASE_OPTS);

    expect(nameCalls).toBe(8);
    expect(uidCalls).toBe(1);
    expect(registerCalls[0].folder).toBe('agent-deadbeef');
    expect(registerCalls[0].jid).toBe('agent_deadbeef');
  });
});

describe('createAgentBridge — model resolution', () => {
  it('uses an explicit modelId when provided', async () => {
    const { orchestrator, registerCalls, scripts } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'jolly-mint',
      resolveModel: (id) => pinned(id),
    });
    scripts.set('agent_jolly_mint', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn({ ...BASE_OPTS, modelId: 'claude-sonnet-4-6' });

    expect(registerCalls[0].config?.modelId).toBe('claude-sonnet-4-6');
  });

  it('rejects an unknown modelId without creating a scoop', async () => {
    const { orchestrator, registerCalls } = makeMockOrchestrator();
    const { fs, rmCalls } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'jolly-mint',
      resolveModel: (id) => ({ ok: false as const, error: `unknown model: ${id}` }),
    });

    const result = await bridge.spawn({ ...BASE_OPTS, modelId: 'not-a-model' });

    expect(result.exitCode).toBe(1);
    expect(result.finalText).toContain('unknown model');
    expect(registerCalls).toHaveLength(0);
    expect(rmCalls).toHaveLength(0);
  });

  it('stores the resolved model id in config when a shorthand is provided', async () => {
    const { orchestrator, registerCalls, scripts } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'jolly-mint',
      resolveModel: (id) => pinned(id === 'opus' ? 'claude-opus-4-8' : id),
    });
    scripts.set('agent_jolly_mint', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn({ ...BASE_OPTS, modelId: 'opus' });

    expect(registerCalls[0].config?.modelId).toBe('claude-opus-4-8');
  });

  it('inherits modelId from parent scoop when found in the orchestrator registry', async () => {
    const { orchestrator, registerCalls, scripts, knownScoops } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    knownScoops.push({
      jid: 'scoop_parent',
      name: 'parent',
      folder: 'parent',
      parentJid: 'cone_1',
      requiresTrigger: false,
      assistantLabel: 'parent',
      addedAt: '2026-04-19T00:00:00Z',
      config: { modelId: 'claude-opus-4-7' },
      configSchemaVersion: CURRENT_SCOOP_CONFIG_VERSION,
    });
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'jolly-mint',
      resolveModel: (id) => pinned(id),
    });
    scripts.set('agent_jolly_mint', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn({ ...BASE_OPTS, parentJid: 'scoop_parent' });

    expect(registerCalls[0].config?.modelId).toBe('claude-opus-4-7');
  });

  // Regression (#1752): an explicit --model must never be quietly replaced by
  // the parent's (typically far more expensive) model. Either the resolved id
  // lands on the config, or the spawn fails — never a silent inheritance.
  it('never falls back to the parent model when an explicit modelId resolves', async () => {
    const { orchestrator, registerCalls, scripts, knownScoops } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    knownScoops.push({
      jid: 'cone_1',
      name: 'Cone',
      folder: 'cone',
      parentJid: null,
      requiresTrigger: false,
      assistantLabel: 'sliccy',
      addedAt: '2026-04-19T00:00:00Z',
      config: { modelId: 'claude-opus-4-8' },
      configSchemaVersion: CURRENT_SCOOP_CONFIG_VERSION,
    });
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'jolly-mint',
    });
    scripts.set('agent_jolly_mint', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn({ ...BASE_OPTS, modelId: 'claude-haiku-4-5', parentJid: 'cone_1' });

    expect(registerCalls[0].config?.modelId).toBe('claude-haiku-4-5');
  });

  it('rejects the spawn rather than inheriting the parent when the model is unknown', async () => {
    const { orchestrator, registerCalls, knownScoops } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    knownScoops.push({
      jid: 'cone_1',
      name: 'Cone',
      folder: 'cone',
      parentJid: null,
      requiresTrigger: false,
      assistantLabel: 'sliccy',
      addedAt: '2026-04-19T00:00:00Z',
      config: { modelId: 'claude-opus-4-8' },
      configSchemaVersion: CURRENT_SCOOP_CONFIG_VERSION,
    });
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'jolly-mint',
    });

    const result = await bridge.spawn({
      ...BASE_OPTS,
      modelId: 'this-model-does-not-exist-xyz',
      parentJid: 'cone_1',
    });

    expect(result.exitCode).toBe(1);
    expect(result.finalText).toContain('unknown model');
    expect(registerCalls).toHaveLength(0);
  });

  it('leaves modelId unset when neither explicit nor parent has one', async () => {
    const { orchestrator, registerCalls, scripts, knownScoops } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    // Cone-like parent with no modelId on config — ScoopContext will fall
    // back to the UI selection. The bridge must NOT synthesize a default.
    knownScoops.push({
      jid: 'cone_1',
      name: 'Cone',
      folder: 'cone',
      parentJid: null,
      requiresTrigger: false,
      assistantLabel: 'sliccy',
      addedAt: '2026-04-19T00:00:00Z',
    });
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'jolly-mint',
    });
    scripts.set('agent_jolly_mint', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn({ ...BASE_OPTS, parentJid: 'cone_1' });

    expect(registerCalls[0].config?.modelId).toBeUndefined();
  });
  // #2195: a cross-provider model must be pinned to ITS provider on the scoop
  // config. Storing the id alone would let ScoopContext re-resolve it against
  // the selected provider and silently run the scoop on that provider's
  // (far more expensive) model.
  it('records the resolved provider alongside a cross-provider model id', async () => {
    const { orchestrator, registerCalls, scripts } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'jolly-mint',
    });
    scripts.set('agent_jolly_mint', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn({ ...BASE_OPTS, modelId: 'openrouter:openai/gpt-5.6-terra-pro' });

    expect(registerCalls[0].config?.modelId).toBe('openai/gpt-5.6-terra-pro');
    expect(registerCalls[0].config?.modelProviderId).toBe('openrouter');
  });

  it('pins a bare id that only a non-selected provider offers', async () => {
    const { orchestrator, registerCalls, scripts } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'jolly-mint',
    });
    scripts.set('agent_jolly_mint', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn({ ...BASE_OPTS, modelId: 'openai/gpt-5.6-terra-pro' });

    expect(registerCalls[0].config?.modelId).toBe('openai/gpt-5.6-terra-pro');
    expect(registerCalls[0].config?.modelProviderId).toBe('openrouter');
  });

  it('accepts modelProviderId as a separate option, equivalently to the qualified form', async () => {
    const { orchestrator, registerCalls, scripts } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'jolly-mint',
    });
    scripts.set('agent_jolly_mint', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn({
      ...BASE_OPTS,
      modelId: 'openai/gpt-5.6-terra-pro',
      modelProviderId: 'openrouter',
    });

    expect(registerCalls[0].config?.modelProviderId).toBe('openrouter');
  });

  // The cost-overrun guard: an explicit cross-provider model must not leave
  // the parent's provider (or its model) on the child's config.
  it('never inherits the parent provider when an explicit cross-provider model resolves', async () => {
    const { orchestrator, registerCalls, scripts, knownScoops } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    knownScoops.push({
      jid: 'cone_1',
      name: 'Cone',
      folder: 'cone',
      parentJid: null,
      requiresTrigger: false,
      assistantLabel: 'sliccy',
      addedAt: '2026-04-19T00:00:00Z',
      config: { modelId: 'claude-opus-4-8', modelProviderId: 'adobe' },
      configSchemaVersion: CURRENT_SCOOP_CONFIG_VERSION,
    });
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'jolly-mint',
    });
    scripts.set('agent_jolly_mint', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn({
      ...BASE_OPTS,
      modelId: 'openrouter:openai/gpt-5.6-terra-pro',
      parentJid: 'cone_1',
    });

    expect(registerCalls[0].config?.modelId).toBe('openai/gpt-5.6-terra-pro');
    expect(registerCalls[0].config?.modelProviderId).toBe('openrouter');
  });

  it('inherits the parent provider together with the parent model id', async () => {
    const { orchestrator, registerCalls, scripts, knownScoops } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    knownScoops.push({
      jid: 'scoop_parent',
      name: 'parent',
      folder: 'parent',
      parentJid: 'cone_1',
      requiresTrigger: false,
      assistantLabel: 'parent',
      addedAt: '2026-04-19T00:00:00Z',
      config: { modelId: 'openai/gpt-5.6-terra-pro', modelProviderId: 'openrouter' },
      configSchemaVersion: CURRENT_SCOOP_CONFIG_VERSION,
    });
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'jolly-mint',
    });
    scripts.set('agent_jolly_mint', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn({ ...BASE_OPTS, parentJid: 'scoop_parent' });

    expect(registerCalls[0].config?.modelId).toBe('openai/gpt-5.6-terra-pro');
    expect(registerCalls[0].config?.modelProviderId).toBe('openrouter');
  });

  it('rejects a qualified id whose provider does not offer the model', async () => {
    const { orchestrator, registerCalls } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'jolly-mint',
    });

    const result = await bridge.spawn({
      ...BASE_OPTS,
      modelId: 'openrouter:claude-haiku-4-5',
    });

    expect(result.exitCode).toBe(1);
    expect(result.finalText).toContain('unknown model');
    expect(registerCalls).toHaveLength(0);
  });

  it('surfaces the resolver error verbatim after the "agent:" prefix', async () => {
    const { orchestrator } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'jolly-mint',
      resolveModel: () => ({ ok: false as const, error: 'ambiguous model: opus matches a:b, c:d' }),
    });

    const result = await bridge.spawn({ ...BASE_OPTS, modelId: 'opus' });

    expect(result.finalText).toBe('agent: ambiguous model: opus matches a:b, c:d');
  });
});

describe('createAgentBridge — thinking level resolution', () => {
  it('forwards an explicit thinkingLevel onto the scoop config', async () => {
    const { orchestrator, registerCalls, scripts } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'jolly-mint',
      resolveModel: (id) => pinned(id),
    });
    scripts.set('agent_jolly_mint', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn({ ...BASE_OPTS, thinkingLevel: 'high' });

    expect(registerCalls[0].config?.thinkingLevel).toBe('high');
  });

  it('inherits thinkingLevel from a parent scoop when no explicit value is provided', async () => {
    const { orchestrator, registerCalls, scripts, knownScoops } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    knownScoops.push({
      jid: 'scoop_parent',
      name: 'parent',
      folder: 'parent',
      parentJid: 'cone_1',
      requiresTrigger: false,
      assistantLabel: 'parent',
      addedAt: '2026-04-19T00:00:00Z',
      config: { thinkingLevel: 'medium' },
      configSchemaVersion: CURRENT_SCOOP_CONFIG_VERSION,
    });
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'jolly-mint',
    });
    scripts.set('agent_jolly_mint', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn({ ...BASE_OPTS, parentJid: 'scoop_parent' });

    expect(registerCalls[0].config?.thinkingLevel).toBe('medium');
  });

  it('explicit thinkingLevel overrides the parent inheritance', async () => {
    const { orchestrator, registerCalls, scripts, knownScoops } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    knownScoops.push({
      jid: 'scoop_parent',
      name: 'parent',
      folder: 'parent',
      parentJid: 'cone_1',
      requiresTrigger: false,
      assistantLabel: 'parent',
      addedAt: '2026-04-19T00:00:00Z',
      config: { thinkingLevel: 'medium' },
      configSchemaVersion: CURRENT_SCOOP_CONFIG_VERSION,
    });
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'jolly-mint',
    });
    scripts.set('agent_jolly_mint', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn({ ...BASE_OPTS, parentJid: 'scoop_parent', thinkingLevel: 'xhigh' });

    expect(registerCalls[0].config?.thinkingLevel).toBe('xhigh');
  });

  it('leaves thinkingLevel unset when no explicit value and no parent override', async () => {
    const { orchestrator, registerCalls, scripts } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'jolly-mint',
    });
    scripts.set('agent_jolly_mint', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn(BASE_OPTS);

    expect(registerCalls[0].config?.thinkingLevel).toBeUndefined();
  });

  it('rejects an invalid thinkingLevel without creating a scoop', async () => {
    const { orchestrator, registerCalls } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'jolly-mint',
    });

    const result = await bridge.spawn({
      ...BASE_OPTS,
      thinkingLevel: 'turbo' as never,
    });

    expect(result.exitCode).toBe(1);
    expect(result.finalText).toContain('invalid thinking level');
    expect(registerCalls).toHaveLength(0);
  });
});

describe('createAgentBridge — structured output schema', () => {
  it('copies structuredOutputSchema into scoop.config', async () => {
    const { orchestrator, registerCalls, scripts } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'jolly-mint',
    });
    scripts.set('agent_jolly_mint', (obs) => obs.onSendMessage?.('done'));

    const schema = { type: 'object' };
    await bridge.spawn({
      ...BASE_OPTS,
      structuredOutputSchema: schema,
    });

    expect(registerCalls).toHaveLength(1);
    expect(registerCalls[0].config?.structuredOutputSchema).toEqual(schema);
  });
});

describe('createAgentBridge — output capture', () => {
  it('returns the last send_message as finalText', async () => {
    const { orchestrator, scripts } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'jolly-mint',
    });
    scripts.set('agent_jolly_mint', (obs) => {
      obs.onSendMessage?.('first');
      obs.onSendMessage?.('second');
      obs.onSendMessage?.('third');
    });

    const result = await bridge.spawn(BASE_OPTS);

    expect(result.exitCode).toBe(0);
    expect(result.finalText).toBe('third');
  });

  it('falls back to the assistant response buffer when no send_message fires', async () => {
    const { orchestrator, scripts } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'jolly-mint',
    });
    scripts.set('agent_jolly_mint', (obs) => {
      obs.onResponse?.('hello ', true);
      obs.onResponse?.('world', true);
    });

    const result = await bridge.spawn(BASE_OPTS);

    expect(result.exitCode).toBe(0);
    expect(result.finalText).toBe('hello world');
  });

  it('non-partial onResponse replaces the buffer (non-streaming providers)', async () => {
    const { orchestrator, scripts } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'jolly-mint',
    });
    scripts.set('agent_jolly_mint', (obs) => {
      obs.onResponse?.('streaming text', true);
      // Then a non-partial with the full text — mirrors pi-ai for
      // non-streaming providers. Must REPLACE, not append.
      obs.onResponse?.('final text', false);
    });

    const result = await bridge.spawn(BASE_OPTS);

    expect(result.finalText).toBe('final text');
  });

  it('returns an empty string when the scoop produces nothing', async () => {
    const { orchestrator, scripts } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'jolly-mint',
    });
    scripts.set('agent_jolly_mint', () => undefined);

    const result = await bridge.spawn(BASE_OPTS);

    expect(result.exitCode).toBe(0);
    expect(result.finalText).toBe('');
  });
});

describe('createAgentBridge — error handling', () => {
  it('promotes onError to exitCode 1 with the error text', async () => {
    const { orchestrator, scripts } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'jolly-mint',
    });
    scripts.set('agent_jolly_mint', (obs) => {
      obs.onError?.('pi-ai stream aborted');
    });

    const result = await bridge.spawn(BASE_OPTS);

    expect(result.exitCode).toBe(1);
    expect(result.finalText).toBe('pi-ai stream aborted');
  });

  it("keeps the first specific error over a later 'Agent not initialized' follow-up", async () => {
    const { orchestrator, scripts } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'jolly-mint',
    });
    scripts.set('agent_jolly_mint', (obs) => {
      obs.onError?.('No API key configured for provider "anthropic"');
      obs.onError?.('Agent not initialized');
    });

    const result = await bridge.spawn(BASE_OPTS);

    expect(result.exitCode).toBe(1);
    expect(result.finalText).toBe('No API key configured for provider "anthropic"');
  });

  it('surfaces a sendPrompt rejection as exitCode 1', async () => {
    const { orchestrator } = makeMockOrchestrator();
    (orchestrator.sendPrompt as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      throw new Error('boom');
    });
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'jolly-mint',
    });

    const result = await bridge.spawn(BASE_OPTS);

    expect(result.exitCode).toBe(1);
    expect(result.finalText).toBe('boom');
  });

  it('returns exitCode 1 when registerScoop rejects', async () => {
    const { orchestrator, unregisterCalls } = makeMockOrchestrator();
    (orchestrator.registerScoop as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      throw new Error('init failed');
    });
    const { fs, rmCalls } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'jolly-mint',
    });

    const result = await bridge.spawn(BASE_OPTS);

    expect(result.exitCode).toBe(1);
    expect(result.finalText).toBe('init failed');
    // Cleanup still runs — unregisterScoop is safe against unknown jids.
    expect(unregisterCalls).toContain('agent_jolly_mint');
    expect(rmCalls).toContain('/scoops/agent-jolly-mint');
  });
});

describe('createAgentBridge — cleanup', () => {
  it('unregisters the scoop and removes the scratch folder on success', async () => {
    const { orchestrator, unregisterCalls, scripts } = makeMockOrchestrator();
    const { fs, rmCalls } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'jolly-mint',
    });
    scripts.set('agent_jolly_mint', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn(BASE_OPTS);

    expect(unregisterCalls).toEqual(['agent_jolly_mint']);
    expect(rmCalls).toEqual(['/scoops/agent-jolly-mint']);
  });

  it('cleanup runs even when the scoop errors out', async () => {
    const { orchestrator, unregisterCalls, scripts } = makeMockOrchestrator();
    const { fs, rmCalls } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'jolly-mint',
    });
    scripts.set('agent_jolly_mint', (obs) => obs.onError?.('stream error'));

    await bridge.spawn(BASE_OPTS);

    expect(unregisterCalls).toEqual(['agent_jolly_mint']);
    expect(rmCalls).toEqual(['/scoops/agent-jolly-mint']);
  });

  it('unsubscribes the observer after the run so subsequent events are dropped', async () => {
    const { orchestrator, observers, scripts } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'jolly-mint',
    });
    scripts.set('agent_jolly_mint', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn(BASE_OPTS);

    // After the run, no observer should remain subscribed for this jid.
    expect(observers.has('agent_jolly_mint')).toBe(false);
  });

  it('deletes the sessionStore entry when one is provided', async () => {
    const { orchestrator, scripts } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const deleteCalls: string[] = [];
    const sessionStore = {
      delete: vi.fn(async (jid: string) => {
        deleteCalls.push(jid);
      }),
    } as unknown as import('../../src/core/session.js').SessionStore;
    const bridge = createAgentBridge(orchestrator, fs, sessionStore, {
      generateName: () => 'jolly-mint',
    });
    scripts.set('agent_jolly_mint', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn(BASE_OPTS);

    expect(deleteCalls).toEqual(['agent_jolly_mint']);
  });

  it('silently swallows ENOENT from scratch-folder rm (registerScoop rolled back)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { orchestrator, unregisterCalls } = makeMockOrchestrator();
    // Make registerScoop throw so the scratch folder never existed.
    (orchestrator.registerScoop as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      throw new Error('init failed');
    });
    const { fs, rmCalls } = makeMockSharedFs({
      rm: async (path) => {
        throw new FsError('ENOENT', 'no such file or directory', path);
      },
    });
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'jolly-mint',
    });

    const result = await bridge.spawn(BASE_OPTS);

    // Result still surfaces the real init error.
    expect(result.exitCode).toBe(1);
    expect(result.finalText).toBe('init failed');
    // Cleanup ran…
    expect(unregisterCalls).toContain('agent_jolly_mint');
    expect(rmCalls).toContain('/scoops/agent-jolly-mint');
    // …but no scratch-folder warning was emitted for the ENOENT.
    const scratchWarnings = warnSpy.mock.calls.filter((c) =>
      String(c.join(' ')).includes('scratch folder cleanup failed')
    );
    expect(scratchWarnings).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it('still warns when scratch-folder rm fails with a non-ENOENT code', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { orchestrator, scripts } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs({
      rm: async (path) => {
        throw new FsError('EACCES', 'permission denied', path);
      },
    });
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'jolly-mint',
    });
    scripts.set('agent_jolly_mint', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn(BASE_OPTS);

    const scratchWarnings = warnSpy.mock.calls.filter((c) =>
      String(c.join(' ')).includes('scratch folder cleanup failed')
    );
    expect(scratchWarnings.length).toBeGreaterThan(0);
    warnSpy.mockRestore();
  });
});

describe('createAgentBridge — structured output capture', () => {
  /**
   * Helper to build a fake orchestrator whose getScoopContext returns a stub
   * getStructuredOutput() that flips to captured after a set number of
   * sendPrompt calls.
   */
  function fakeOrchWithStructuredOutput(captureOnPrompt: number) {
    let prompts = 0;
    const ctx = {
      getStructuredOutput: () => ({ captured: prompts >= captureOnPrompt, value: { ok: true } }),
    };
    const mock: Partial<Orchestrator> = {
      registerScoop: vi.fn(async () => {}),
      unregisterScoop: vi.fn(async () => {}),
      observeScoop: vi.fn(() => () => {}),
      getScoops: vi.fn(() => []),
      getWorkUnits: vi.fn(() => makeWorkUnits([])),
      getScoopContext: vi.fn(() => ctx as unknown as ScoopContext),
      sendPrompt: vi.fn(async () => {
        prompts++;
      }),
    };
    return {
      orchestrator: mock as unknown as Orchestrator,
      get prompts() {
        return prompts;
      },
    };
  }

  it('returns captured JSON when StructuredOutput is called (no nudge needed)', async () => {
    const fake = fakeOrchWithStructuredOutput(1);
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(fake.orchestrator, fs, null, { generateUid: () => 'u' });

    const result = await bridge.spawn({
      cwd: '/workspace',
      allowedCommands: ['*'],
      prompt: 'test',
      structuredOutputSchema: { type: 'object' },
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.finalText)).toEqual({ ok: true });
    expect(fake.prompts).toBe(1); // initial only, no nudges
  });

  it('nudges up to 2x, then returns error when never called', async () => {
    const fake = fakeOrchWithStructuredOutput(99);
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(fake.orchestrator, fs, null, { generateUid: () => 'u' });

    const result = await bridge.spawn({
      cwd: '/workspace',
      allowedCommands: ['*'],
      prompt: 'test',
      structuredOutputSchema: { type: 'object' },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.finalText).toContain('did not produce StructuredOutput');
    expect(fake.prompts).toBe(3); // initial + 2 nudges
  });

  it('captures after first nudge (2 total prompts)', async () => {
    const fake = fakeOrchWithStructuredOutput(2);
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(fake.orchestrator, fs, null, { generateUid: () => 'u' });

    const result = await bridge.spawn({
      cwd: '/workspace',
      allowedCommands: ['*'],
      prompt: 'test',
      structuredOutputSchema: { type: 'object' },
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.finalText)).toEqual({ ok: true });
    expect(fake.prompts).toBe(2); // initial + 1 nudge
  });

  it('does not nudge when no schema is configured', async () => {
    const { orchestrator, scripts } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, { generateName: () => 'test-agent' });
    scripts.set('agent_test_agent', (obs) => obs.onSendMessage?.('regular response'));

    const result = await bridge.spawn({
      cwd: '/workspace',
      allowedCommands: ['*'],
      prompt: 'test',
    });

    expect(result.exitCode).toBe(0);
    expect(result.finalText).toBe('regular response');
  });

  it('surfaces a scoopError raised during a nudge (not the generic message)', async () => {
    let prompts = 0;
    let observer: { onError?: (m: string) => void } | undefined;
    const ctx = { getStructuredOutput: () => ({ captured: false, value: undefined }) };
    const mock: Partial<Orchestrator> = {
      registerScoop: vi.fn(async () => {}),
      unregisterScoop: vi.fn(async () => {}),
      observeScoop: vi.fn((_jid: string, handler: unknown) => {
        observer = handler as { onError?: (m: string) => void };
        return () => {};
      }),
      getScoops: vi.fn(() => []),
      getWorkUnits: vi.fn(() => makeWorkUnits([])),
      getScoopContext: vi.fn(() => ctx as unknown as ScoopContext),
      sendPrompt: vi.fn(async () => {
        prompts++;
        // Fail on the first nudge (2nd round-trip), as a real LLM error would.
        if (prompts === 2) observer?.onError?.('adobe proxy 502 (capability shim)');
      }),
    };
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(mock as unknown as Orchestrator, fs, null, {
      generateUid: () => 'u',
    });

    const result = await bridge.spawn({
      cwd: '/workspace',
      allowedCommands: ['*'],
      prompt: 'test',
      structuredOutputSchema: { type: 'object' },
    });

    expect(result.exitCode).toBe(1);
    expect(result.finalText).toContain('502');
    expect(result.finalText).not.toContain('did not produce StructuredOutput');
    expect(prompts).toBe(2); // initial + 1 nudge, then bailed on the real error
  });
});

describe('publishAgentBridge', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>)[AGENT_BRIDGE_GLOBAL_KEY];
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[AGENT_BRIDGE_GLOBAL_KEY];
  });

  it('installs the bridge on globalThis.__slicc_agent', () => {
    const { orchestrator } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();

    const bridge = publishAgentBridge(orchestrator, fs, null);

    expect((globalThis as Record<string, unknown>)[AGENT_BRIDGE_GLOBAL_KEY]).toBe(bridge);
  });
});

describe('defaultResolveModel', () => {
  /** Assert the pinned model id, ignoring the provider. */
  function idOf(input: string): string | null {
    const resolution = defaultResolveModel(input);
    return resolution.ok ? resolution.selection.modelId : null;
  }

  it('accepts a model in the full provider list even if hidden from the picker', () => {
    // claude-haiku-4-5 is hidden from the cone picker (PICKER_HIDDEN_MODEL_PATTERNS),
    // so it is absent from getAllAvailableModels() — but it IS a real provider model and
    // a valid explicit sub-agent target. Regression: it must validate, not be rejected.
    expect(idOf('claude-haiku-4-5')).toBe('claude-haiku-4-5');
    expect(idOf('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    expect(idOf('claude-opus-4-8')).toBe('claude-opus-4-8');
  });

  it('pins a resolved model to the provider that offers it', () => {
    expect(defaultResolveModel('claude-haiku-4-5')).toEqual({
      ok: true,
      selection: { modelId: 'claude-haiku-4-5', providerId: 'adobe' },
    });
  });

  it('rejects a model no configured provider advertises', () => {
    const resolution = defaultResolveModel('nonexistent-xyz-999');
    expect(resolution.ok).toBe(false);
    expect(resolution.ok === false && resolution.error).toContain('unknown model');
  });

  it('resolves bare "opus" to the best available opus model (lexicographic tiebreaker)', () => {
    // Both opus-4-8 and opus-4-6 have contextWindow=1000000; lexicographic tiebreaker picks 4-8
    expect(idOf('opus')).toBe('claude-opus-4-8');
  });

  it('resolves bare "sonnet" to the best available sonnet model', () => {
    expect(idOf('sonnet')).toBe('claude-sonnet-4-6');
  });

  it('resolves bare "haiku" to the best available haiku model', () => {
    expect(idOf('haiku')).toBe('claude-haiku-4-5');
  });

  it('resolves "gpt" to the best GPT model by context window', () => {
    // gpt-5 has 1000000 context, gpt-4o has 128000 → picks gpt-5
    expect(idOf('gpt')).toBe('gpt-5');
  });

  it('resolves shorthands case-insensitively', () => {
    expect(idOf('Opus')).toBe('claude-opus-4-8');
    expect(idOf('GPT')).toBe('gpt-5');
  });

  it('does not match unrelated keywords', () => {
    expect(idOf('llama')).toBeNull();
  });

  // #2195: a bare id only the non-selected provider offers used to be
  // rejected outright ("unknown model") because validation was locked to the
  // selected provider's catalogue.
  it('pins a bare id unique to a non-selected provider to that provider', () => {
    expect(defaultResolveModel('openai/gpt-5.6-terra-pro')).toEqual({
      ok: true,
      selection: { modelId: 'openai/gpt-5.6-terra-pro', providerId: 'openrouter' },
    });
  });

  it('accepts the canonical provider:model form for a non-selected provider', () => {
    expect(defaultResolveModel('openrouter:openai/gpt-5.6-terra-pro')).toEqual({
      ok: true,
      selection: { modelId: 'openai/gpt-5.6-terra-pro', providerId: 'openrouter' },
    });
  });

  it('accepts the canonical provider:model form for the SELECTED provider', () => {
    expect(defaultResolveModel('adobe:claude-haiku-4-5')).toEqual({
      ok: true,
      selection: { modelId: 'claude-haiku-4-5', providerId: 'adobe' },
    });
  });
});

// ---------------------------------------------------------------------------
// parentJid propagation to RegisteredScoop (Fix: task-5-review P1)
// ---------------------------------------------------------------------------

describe('createAgentBridge — parentJid propagation', () => {
  it('sets parentJid on the registered scoop when options.parentJid is provided', async () => {
    const { orchestrator, registerCalls, scripts, knownScoops } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    knownScoops.push({
      jid: 'cone_main_1',
      name: 'Cone',
      folder: 'cone',
      parentJid: null,
      requiresTrigger: false,
      assistantLabel: 'sliccy',
      addedAt: '2026-04-19T00:00:00Z',
    });
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'birch-lime',
    });
    scripts.set('agent_birch_lime', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn({ ...BASE_OPTS, parentJid: 'cone_main_1' });

    expect(registerCalls[0].parentJid).toBe('cone_main_1');
  });

  it('adopts the default root as owner when options.parentJid is absent (#1666)', async () => {
    const { orchestrator, registerCalls, scripts, knownScoops } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    knownScoops.push({
      jid: 'cone_main_1',
      name: 'Cone',
      folder: 'cone',
      parentJid: null,
      requiresTrigger: false,
      assistantLabel: 'sliccy',
      addedAt: '2026-04-19T00:00:00Z',
    });
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'cedar-fig',
    });
    scripts.set('agent_cedar_fig', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn(BASE_OPTS);

    // Ownership is never inferred from names or timestamps — it is the
    // registered root. (`originToolCallId` stays unset; see the next test.)
    expect(registerCalls[0].parentJid).toBe('cone_main_1');
  });

  it('records a null parent only when no root is registered at all', async () => {
    const { orchestrator, registerCalls, scripts } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'cedar-fig',
    });
    scripts.set('agent_cedar_fig', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn(BASE_OPTS);

    expect(registerCalls[0].parentJid).toBeNull();
  });

  it('does not set originToolCallId (never inferred in agent-bridge path)', async () => {
    const { orchestrator, registerCalls, scripts, knownScoops } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    knownScoops.push({
      jid: 'scoop_worker_1',
      name: 'worker',
      folder: 'worker',
      parentJid: 'cone_1',
      requiresTrigger: true,
      assistantLabel: 'worker',
      addedAt: '2026-04-19T00:00:00Z',
    });
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'elm-kiwi',
    });
    scripts.set('agent_elm_kiwi', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn({ ...BASE_OPTS, parentJid: 'scoop_worker_1' });

    expect(registerCalls[0].originToolCallId).toBeUndefined();
  });
});

describe('createAgentBridge — success receipts (#1989)', () => {
  it('writes the receipt on exit 0 before the spawn resolves', async () => {
    const { orchestrator, scripts } = makeMockOrchestrator();
    const { fs, writes } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'diligent-pistachio',
    });
    scripts.set('agent_diligent_pistachio', (obs) => obs.onSendMessage?.('curated'));

    const result = await bridge.spawn({
      ...BASE_OPTS,
      // Isolate the receipt write from the default /tmp session archive.
      persistSession: false,
      successReceiptPath: '/sessions/.curated/pending-abc.md',
    });

    expect(result.exitCode).toBe(0);
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe('/sessions/.curated/pending-abc.md');
    // ISO timestamp content — debuggability, not a contract.
    expect(writes[0].content).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('writes no receipt when the scoop errors', async () => {
    const { orchestrator, scripts } = makeMockOrchestrator();
    const { fs, writes } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'somber-walnut',
    });
    scripts.set('agent_somber_walnut', (obs) => obs.onError?.('provider exploded'));

    const result = await bridge.spawn({
      ...BASE_OPTS,
      // Isolate the receipt assertion from the default /tmp session archive.
      persistSession: false,
      successReceiptPath: '/sessions/.curated/pending-abc.md',
    });

    expect(result.exitCode).toBe(1);
    expect(writes).toHaveLength(0);
  });

  it('rejects a relative successReceiptPath without spawning', async () => {
    const { orchestrator, registerCalls } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'brisk-nougat',
    });

    const result = await bridge.spawn({
      ...BASE_OPTS,
      successReceiptPath: 'sessions/receipt',
    });

    expect(result.exitCode).toBe(1);
    expect(result.finalText).toContain('successReceiptPath must be absolute');
    expect(registerCalls).toHaveLength(0);
  });

  it('a receipt write failure never fails the successful spawn', async () => {
    const { orchestrator, scripts } = makeMockOrchestrator();
    const { fs, writes } = makeMockSharedFs({
      writeFile: async () => {
        throw new Error('quota exceeded');
      },
    });
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'stoic-honeycomb',
    });
    scripts.set('agent_stoic_honeycomb', (obs) => obs.onSendMessage?.('curated'));

    const result = await bridge.spawn({
      ...BASE_OPTS,
      successReceiptPath: '/sessions/.curated/pending-abc.md',
    });

    expect(result.exitCode).toBe(0);
    expect(result.finalText).toBe('curated');
    expect(writes).toHaveLength(0);
  });
});

describe('createAgentBridge — run bounds + cancellation (#1972)', () => {
  it('copies maxTurns and maxWallClockMs into the scoop config', async () => {
    const { orchestrator, registerCalls, scripts } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'bounded-caramel',
    });
    scripts.set('agent_bounded_caramel', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn({ ...BASE_OPTS, maxTurns: 25, maxWallClockMs: 120_000 });

    expect(registerCalls[0].config).toMatchObject({ maxTurns: 25, maxWallClockMs: 120_000 });
  });

  it('copies backgroundAfterSeconds into the scoop config, including 0', async () => {
    for (const seconds of [45, 0]) {
      const { orchestrator, registerCalls, scripts } = makeMockOrchestrator();
      const { fs } = makeMockSharedFs();
      const bridge = createAgentBridge(orchestrator, fs, null, {
        generateName: () => 'detached-sorbet',
      });
      scripts.set('agent_detached_sorbet', (obs) => obs.onSendMessage?.('done'));

      await bridge.spawn({ ...BASE_OPTS, backgroundAfterSeconds: seconds });

      expect(registerCalls[0].config).toMatchObject({ backgroundAfterSeconds: seconds });
    }
  });

  it('rejects a negative backgroundAfterSeconds without spawning', async () => {
    const { orchestrator, registerCalls } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'strict-sorbet',
    });

    const result = await bridge.spawn({ ...BASE_OPTS, backgroundAfterSeconds: -1 });

    expect(result.exitCode).toBe(1);
    expect(result.finalText).toContain('invalid backgroundAfterSeconds');
    expect(registerCalls).toHaveLength(0);
  });

  it('rejects non-positive or fractional bounds without spawning', async () => {
    const { orchestrator, registerCalls } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'strict-taffy',
    });

    for (const bad of [{ maxTurns: 0 }, { maxTurns: 2.5 }, { maxWallClockMs: -1 }]) {
      const result = await bridge.spawn({ ...BASE_OPTS, ...bad });
      expect(result.exitCode).toBe(1);
      expect(result.finalText).toContain('must be a positive integer');
    }
    expect(registerCalls).toHaveLength(0);
  });

  it('an already-aborted signal short-circuits before any scoop registers', async () => {
    const { orchestrator, registerCalls } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'eager-fudge',
    });
    const controller = new AbortController();
    controller.abort();

    const result = await bridge.spawn({ ...BASE_OPTS, signal: controller.signal });

    expect(result).toEqual({ finalText: 'agent: aborted before start', exitCode: 1 });
    expect(registerCalls).toHaveLength(0);
  });

  it('aborting mid-run stops the scoop and resolves with a non-zero exit', async () => {
    const { orchestrator, scripts } = makeMockOrchestrator();
    const stopScoop = vi.fn();
    (orchestrator as unknown as { stopScoop: typeof stopScoop }).stopScoop = stopScoop;
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'reclaimed-sorbet',
    });
    const controller = new AbortController();
    scripts.set('agent_reclaimed_sorbet', (obs) => {
      // The caller gives up while the scoop is mid-run.
      controller.abort();
      obs.onResponse?.('partial work', false);
    });

    const result = await bridge.spawn({ ...BASE_OPTS, signal: controller.signal });

    expect(stopScoop).toHaveBeenCalledWith('agent_reclaimed_sorbet');
    expect(result).toEqual({ finalText: 'agent: aborted', exitCode: 1 });
  });
});

describe('createAgentBridge — session archive (persistSession)', () => {
  it('persistSession: true writes a durable archive under /sessions', async () => {
    const { orchestrator, scripts } = makeMockOrchestrator();
    const { fs, writes } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'zesty-custard',
    });
    scripts.set('agent_zesty_custard', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn({ ...BASE_OPTS, persistSession: true });

    const archive = writes.filter((w) => w.path.startsWith('/sessions/agent-zesty-custard-'));
    expect(archive).toHaveLength(1);
    expect(archive[0].path).toMatch(/^\/sessions\/agent-zesty-custard-.*\.md$/);
    expect(archive[0].content).toContain('# Agent session: zesty-custard');
  });

  it('persistSession undefined (default) writes an ephemeral archive under /tmp', async () => {
    const { orchestrator, scripts } = makeMockOrchestrator();
    const { fs, writes } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'zesty-custard',
    });
    scripts.set('agent_zesty_custard', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn(BASE_OPTS);

    const archive = writes.filter((w) => w.path.startsWith('/tmp/agent-'));
    expect(archive).toHaveLength(1);
    expect(archive[0].path).toMatch(/^\/tmp\/agent-zesty-custard-.*\.md$/);
  });

  it('persistSession: false writes no session archive', async () => {
    const { orchestrator, scripts } = makeMockOrchestrator();
    const { fs, writes } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'zesty-custard',
    });
    scripts.set('agent_zesty_custard', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn({ ...BASE_OPTS, persistSession: false });

    expect(writes).toHaveLength(0);
  });

  it('a fixed name produces the agent-<name> folder and agent_<name> jid', async () => {
    const { orchestrator, registerCalls, scripts } = makeMockOrchestrator();
    const { fs, writes } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, {
      // Would be used only on the default (random) path — the fixed name wins.
      generateName: () => 'should-not-be-used',
    });
    scripts.set('agent_memory_curator', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn({ ...BASE_OPTS, name: 'memory-curator', persistSession: true });

    expect(registerCalls[0].folder).toBe('agent-memory-curator');
    expect(registerCalls[0].jid).toBe('agent_memory_curator');
    const archive = writes.filter((w) => w.path.startsWith('/sessions/agent-memory-curator-'));
    expect(archive).toHaveLength(1);
  });

  it('rejects a malformed fixed name without spawning', async () => {
    const { orchestrator, registerCalls } = makeMockOrchestrator();
    const { fs, writes } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'jolly-mint',
    });

    const result = await bridge.spawn({ ...BASE_OPTS, name: 'Bad_Name!' });

    expect(result.exitCode).toBe(1);
    expect(result.finalText).toContain('invalid name');
    expect(registerCalls).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it('accepts digits inside a name token (per-cone curator names)', async () => {
    const { orchestrator, registerCalls } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'jolly-mint',
    });

    // `memory-curator-<folder>` carries a cone folder, and `coneFolderFor`
    // mints digits — from the user's name and from its de-duplication
    // suffix (#2271). A leading digit is still rejected: the jid is
    // `agent_<token>`.
    const ok = await bridge.spawn({ ...BASE_OPTS, name: 'memory-curator-cone-beta-2' });
    expect(ok.exitCode).toBe(0);
    expect(registerCalls[0].folder).toBe('agent-memory-curator-cone-beta-2');

    const bad = await bridge.spawn({ ...BASE_OPTS, name: '2cone' });
    expect(bad.exitCode).toBe(1);
    expect(bad.finalText).toContain('invalid name');
  });

  it('rejects a fixed name whose jid is already registered, without spawning', async () => {
    const { orchestrator, registerCalls, knownScoops } = makeMockOrchestrator();
    const { fs, writes } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'should-not-be-used',
    });
    // A prior curator (still running, or crashed-but-registered) holds the jid.
    knownScoops.push({ jid: 'agent_memory_curator', folder: 'agent-memory-curator' } as never);

    const result = await bridge.spawn({
      ...BASE_OPTS,
      name: 'memory-curator',
      persistSession: true,
    });

    expect(result.exitCode).toBe(1);
    expect(result.finalText).toContain('name already in use');
    // No second scoop registered, no archive clobbering the live run's folder.
    expect(registerCalls).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it('writes the session archive even when the agent exits non-zero', async () => {
    const { orchestrator, scripts } = makeMockOrchestrator();
    const { fs, writes } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'zesty-custard',
    });
    scripts.set('agent_zesty_custard', (obs) => obs.onError?.('provider exploded'));

    const result = await bridge.spawn({ ...BASE_OPTS, persistSession: true });

    expect(result.exitCode).toBe(1);
    const archive = writes.filter((w) => w.path.startsWith('/sessions/agent-zesty-custard-'));
    expect(archive).toHaveLength(1);
    // The header carries the non-zero exit for the human reader.
    expect(archive[0].content).toContain('exit code: 1');
  });

  it('serializes captured agent messages into the archive body', async () => {
    const { orchestrator, scripts } = makeMockOrchestrator();
    const { fs, writes } = makeMockSharedFs();
    const messages = [
      { role: 'user', content: 'do the thing', timestamp: 1 },
      { role: 'assistant', content: 'did it', timestamp: 2 },
    ];
    (orchestrator.getScoopContext as ReturnType<typeof vi.fn>).mockReturnValue({
      getAgentMessages: () => messages,
    } as unknown as ScoopContext);
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'zesty-custard',
    });
    scripts.set('agent_zesty_custard', (obs) => obs.onSendMessage?.('did it'));

    await bridge.spawn({ ...BASE_OPTS, prompt: 'do the thing', persistSession: true });

    const archive = writes.find((w) => w.path.startsWith('/sessions/agent-zesty-custard-'));
    expect(archive?.content).toContain('## Prompt');
    expect(archive?.content).toContain('do the thing');
    expect(archive?.content).toContain('## user');
    expect(archive?.content).toContain('## assistant');
    expect(archive?.content).toContain('did it');
  });

  it('never fails the spawn when the archive write throws', async () => {
    const { orchestrator, scripts } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs({
      writeFile: async () => {
        throw new Error('quota exceeded');
      },
    });
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateName: () => 'zesty-custard',
    });
    scripts.set('agent_zesty_custard', (obs) => obs.onSendMessage?.('done'));

    const result = await bridge.spawn({ ...BASE_OPTS, persistSession: true });

    expect(result.exitCode).toBe(0);
    expect(result.finalText).toBe('done');
  });
});
