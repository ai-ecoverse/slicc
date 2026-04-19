/**
 * Tests for the streamlined AgentBridge. Uses a mock Orchestrator that
 * records `registerScoop`, `sendPrompt`, `unregisterScoop`, and the
 * observer subscription — the bridge doesn't own a ScoopContext anymore,
 * so the test doesn't need to stand up one.
 */

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_BRIDGE_GLOBAL_KEY,
  createAgentBridge,
  publishAgentBridge,
  type AgentSpawnOptions,
} from '../../src/scoops/agent-bridge.js';
import type { Orchestrator, ScoopObserver } from '../../src/scoops/orchestrator.js';
import type { VirtualFS } from '../../src/fs/virtual-fs.js';
import type { RegisteredScoop } from '../../src/scoops/types.js';
import { CURRENT_SCOOP_CONFIG_VERSION } from '../../src/scoops/types.js';

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
  };

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

function makeMockSharedFs(): { fs: VirtualFS; rmCalls: string[] } {
  const rmCalls: string[] = [];
  const mock: Partial<VirtualFS> = {
    rm: vi.fn(async (path: string) => {
      rmCalls.push(path);
    }) as unknown as VirtualFS['rm'],
  };
  return { fs: mock as unknown as VirtualFS, rmCalls };
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
      generateUid: () => 'fixed12',
      resolveModel: (id) => id,
    });

    scripts.set('agent_fixed12', (obs) => {
      obs.onSendMessage?.('hi');
    });
    await bridge.spawn(BASE_OPTS);

    expect(registerCalls).toHaveLength(1);
    const scoop = registerCalls[0];
    expect(scoop.jid).toBe('agent_fixed12');
    expect(scoop.folder).toBe('agent-fixed12');
    expect(scoop.isCone).toBe(false);
    expect(scoop.configSchemaVersion).toBe(CURRENT_SCOOP_CONFIG_VERSION);
    expect(scoop.config).toEqual({
      visiblePaths: ['/workspace/'],
      writablePaths: ['/workspace/', '/shared/', '/scoops/agent-fixed12/'],
      allowedCommands: ['*'],
    });
  });

  it('normalizes cwd to a trailing-slash prefix', async () => {
    const { orchestrator, registerCalls, scripts } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, { generateUid: () => 'u' });
    scripts.set('agent_u', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn({ ...BASE_OPTS, cwd: '/scoops/some-scoop' });

    expect(registerCalls[0].config?.writablePaths?.[0]).toBe('/scoops/some-scoop/');
  });

  it('forwards allowedCommands verbatim', async () => {
    const { orchestrator, registerCalls, scripts } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, { generateUid: () => 'u' });
    scripts.set('agent_u', (obs) => obs.onSendMessage?.('done'));

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
});

describe('createAgentBridge — model resolution', () => {
  it('uses an explicit modelId when provided', async () => {
    const { orchestrator, registerCalls, scripts } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateUid: () => 'u',
      resolveModel: (id) => id,
    });
    scripts.set('agent_u', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn({ ...BASE_OPTS, modelId: 'claude-sonnet-4-6' });

    expect(registerCalls[0].config?.modelId).toBe('claude-sonnet-4-6');
  });

  it('rejects an unknown modelId without creating a scoop', async () => {
    const { orchestrator, registerCalls } = makeMockOrchestrator();
    const { fs, rmCalls } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateUid: () => 'u',
      resolveModel: () => null,
    });

    const result = await bridge.spawn({ ...BASE_OPTS, modelId: 'not-a-model' });

    expect(result.exitCode).toBe(1);
    expect(result.finalText).toContain('unknown model');
    expect(registerCalls).toHaveLength(0);
    expect(rmCalls).toHaveLength(0);
  });

  it('inherits modelId from parent scoop when found in the orchestrator registry', async () => {
    const { orchestrator, registerCalls, scripts, knownScoops } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    knownScoops.push({
      jid: 'scoop_parent',
      name: 'parent',
      folder: 'parent',
      isCone: false,
      type: 'scoop',
      requiresTrigger: false,
      assistantLabel: 'parent',
      addedAt: '2026-04-19T00:00:00Z',
      config: { modelId: 'claude-opus-4-7' },
      configSchemaVersion: CURRENT_SCOOP_CONFIG_VERSION,
    });
    const bridge = createAgentBridge(orchestrator, fs, null, {
      generateUid: () => 'u',
      resolveModel: (id) => id,
    });
    scripts.set('agent_u', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn({ ...BASE_OPTS, parentJid: 'scoop_parent' });

    expect(registerCalls[0].config?.modelId).toBe('claude-opus-4-7');
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
      isCone: true,
      type: 'cone',
      requiresTrigger: false,
      assistantLabel: 'sliccy',
      addedAt: '2026-04-19T00:00:00Z',
    });
    const bridge = createAgentBridge(orchestrator, fs, null, { generateUid: () => 'u' });
    scripts.set('agent_u', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn({ ...BASE_OPTS, parentJid: 'cone_1' });

    expect(registerCalls[0].config?.modelId).toBeUndefined();
  });
});

describe('createAgentBridge — output capture', () => {
  it('returns the last send_message as finalText', async () => {
    const { orchestrator, scripts } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, { generateUid: () => 'u' });
    scripts.set('agent_u', (obs) => {
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
    const bridge = createAgentBridge(orchestrator, fs, null, { generateUid: () => 'u' });
    scripts.set('agent_u', (obs) => {
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
    const bridge = createAgentBridge(orchestrator, fs, null, { generateUid: () => 'u' });
    scripts.set('agent_u', (obs) => {
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
    const bridge = createAgentBridge(orchestrator, fs, null, { generateUid: () => 'u' });
    scripts.set('agent_u', () => undefined);

    const result = await bridge.spawn(BASE_OPTS);

    expect(result.exitCode).toBe(0);
    expect(result.finalText).toBe('');
  });
});

describe('createAgentBridge — error handling', () => {
  it('promotes onError to exitCode 1 with the error text', async () => {
    const { orchestrator, scripts } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, { generateUid: () => 'u' });
    scripts.set('agent_u', (obs) => {
      obs.onError?.('pi-ai stream aborted');
    });

    const result = await bridge.spawn(BASE_OPTS);

    expect(result.exitCode).toBe(1);
    expect(result.finalText).toBe('pi-ai stream aborted');
  });

  it("keeps the first specific error over a later 'Agent not initialized' follow-up", async () => {
    const { orchestrator, scripts } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, { generateUid: () => 'u' });
    scripts.set('agent_u', (obs) => {
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
    const bridge = createAgentBridge(orchestrator, fs, null, { generateUid: () => 'u' });

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
    const bridge = createAgentBridge(orchestrator, fs, null, { generateUid: () => 'u' });

    const result = await bridge.spawn(BASE_OPTS);

    expect(result.exitCode).toBe(1);
    expect(result.finalText).toBe('init failed');
    // Cleanup still runs — unregisterScoop is safe against unknown jids.
    expect(unregisterCalls).toContain('agent_u');
    expect(rmCalls).toContain('/scoops/agent-u');
  });
});

describe('createAgentBridge — cleanup', () => {
  it('unregisters the scoop and removes the scratch folder on success', async () => {
    const { orchestrator, unregisterCalls, scripts } = makeMockOrchestrator();
    const { fs, rmCalls } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, { generateUid: () => 'u' });
    scripts.set('agent_u', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn(BASE_OPTS);

    expect(unregisterCalls).toEqual(['agent_u']);
    expect(rmCalls).toEqual(['/scoops/agent-u']);
  });

  it('cleanup runs even when the scoop errors out', async () => {
    const { orchestrator, unregisterCalls, scripts } = makeMockOrchestrator();
    const { fs, rmCalls } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, { generateUid: () => 'u' });
    scripts.set('agent_u', (obs) => obs.onError?.('stream error'));

    await bridge.spawn(BASE_OPTS);

    expect(unregisterCalls).toEqual(['agent_u']);
    expect(rmCalls).toEqual(['/scoops/agent-u']);
  });

  it('unsubscribes the observer after the run so subsequent events are dropped', async () => {
    const { orchestrator, observers, scripts } = makeMockOrchestrator();
    const { fs } = makeMockSharedFs();
    const bridge = createAgentBridge(orchestrator, fs, null, { generateUid: () => 'u' });
    scripts.set('agent_u', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn(BASE_OPTS);

    // After the run, no observer should remain subscribed for this jid.
    expect(observers.has('agent_u')).toBe(false);
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
      generateUid: () => 'u',
    });
    scripts.set('agent_u', (obs) => obs.onSendMessage?.('done'));

    await bridge.spawn(BASE_OPTS);

    expect(deleteCalls).toEqual(['agent_u']);
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
