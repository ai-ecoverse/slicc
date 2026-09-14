import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegisteredScoop } from '../../src/scoops/types.js';
import { createFakeCapabilityBroker } from '../helpers/fake-capability-broker.js';

type AgentCtorOptions = { streamFn?: unknown; transformContext?: unknown };
type CompactConfig = {
  headers?: Record<string, string>;
  contextWindow?: number;
  onMemoryUpdates?: unknown;
  shouldExtractMemories?: unknown;
  onBeforeCompaction?: unknown;
};

const captures = vi.hoisted(() => ({
  agentCtorCalls: [] as AgentCtorOptions[],
  createCompactContextCalls: [] as CompactConfig[],
}));

const mocks = vi.hoisted(() => ({
  resolveCurrentModel: vi.fn(() => ({ id: 'test-model', provider: 'anthropic' })),
  enabledFlags: new Set<string>(),
}));

vi.mock('../../src/core/feature-flags.js', () => ({
  isFeatureEnabled: (id: string) => mocks.enabledFlags.has(id),
}));

vi.mock('../../src/core/index.js', () => {
  class MockAgent {
    constructor(options: AgentCtorOptions) {
      captures.agentCtorCalls.push(options);
    }
    subscribe = vi.fn(() => () => {});
    abort = vi.fn();
  }
  return {
    Agent: MockAgent,
    adaptTools: (tools: unknown[]) => tools,
    createLogger: () => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() }),
  };
});

vi.mock('../../src/core/context-compaction.js', () => ({
  createCompactContext: (config: CompactConfig) => {
    captures.createCompactContextCalls.push(config);
    return async (messages: unknown[]) => messages;
  },
  estimateConversationTokens: () => 0,
  hasCompactionProgress: () => false,
}));

vi.mock('@earendil-works/pi-ai/compat', () => ({
  isContextOverflow: () => false,
  streamSimple: () => ({ result: () => Promise.resolve(null) }),
  getSupportedThinkingLevels: () => ['off'],
}));

vi.mock('../../src/tools/index.js', () => ({
  createFileTools: () => [],
  createBashTool: () => ({ name: 'bash' }),
  createRequestSecretTool: () => ({ name: 'request_secret' }),
}));

vi.mock('../../src/shell/almost-bash-shell-headless.js', () => ({
  AlmostBashShellHeadless: vi.fn(function () {
    return { setMaskedEnvVar: vi.fn() };
  }),
}));

vi.mock('../../src/providers/account-store.js', () => ({
  getApiKey: () => 'test-api-key',
  getSelectedProvider: () => 'adobe',
  resolveCurrentModel: mocks.resolveCurrentModel,
  resolveModelById: () => ({ id: 'test-model', provider: 'adobe' }),
  resolveModelSelectionForScoop: (id: string) => ({
    ok: true,
    selection: { modelId: id, providerId: 'adobe' },
  }),
}));

vi.mock('../../src/scoops/skills.js', () => ({
  createDefaultSkills: async () => {},
  loadSkills: async () => [],
  formatSkillsForPrompt: () => '',
}));

vi.mock('../../src/scoops/scoop-management-tools.js', () => ({
  createScoopManagementTools: () => [],
}));

const { ScoopContext } = await import('../../src/scoops/scoop-context.js');

const baseScoop: RegisteredScoop = {
  jid: 'cone_test_1',
  name: 'cone',
  folder: '',
  parentJid: null,
  requiresTrigger: false,
  assistantLabel: 'sliccy',
  addedAt: new Date().toISOString(),
};

function createMockCallbacks() {
  return {
    onResponse: vi.fn(),
    onResponseDone: vi.fn(),
    onError: vi.fn(),
    onStatusChange: vi.fn(),
    onSendMessage: vi.fn(),
    getScoops: vi.fn(() => []),
    getGlobalMemory: vi.fn(async () => ''),
    getBrowserAPI: vi.fn(() => ({})),
  };
}

function createMockFs() {
  const files = new Map<string, string>();
  return {
    mkdir: vi.fn(async () => {}),
    readFile: vi.fn(async (path: string) => {
      if (!files.has(path)) throw new Error('ENOENT');
      return files.get(path)!;
    }),
    writeFile: vi.fn(async (path: string, content: string) => {
      files.set(path, content);
    }),
  };
}

async function initWith(
  model: Record<string, unknown>,
  extraCallbacks: Record<string, unknown> = {},
  scoop: RegisteredScoop = baseScoop
): Promise<CompactConfig> {
  mocks.resolveCurrentModel.mockReturnValue(model as never);
  const callbacks = { ...createMockCallbacks(), ...extraCallbacks };
  const ctx = new ScoopContext(
    scoop,
    callbacks as never,
    createMockFs() as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    createFakeCapabilityBroker()
  );
  await ctx.init();
  expect(captures.createCompactContextCalls).toHaveLength(1);
  return captures.createCompactContextCalls[0];
}

describe('ScoopContext compaction context-window wiring', () => {
  beforeEach(() => {
    captures.agentCtorCalls.length = 0;
    captures.createCompactContextCalls.length = 0;
    mocks.resolveCurrentModel.mockReset();
  });

  it("forwards the resolved model's contextWindow to createCompactContext", async () => {
    const config = await initWith({ id: 'sonnet', provider: 'adobe', contextWindow: 1_000_000 });
    expect(config.contextWindow).toBe(1_000_000);
  });

  it('forwards a sub-200K window so GC tightens for small-context models', async () => {
    const config = await initWith({ id: 'small', provider: 'anthropic', contextWindow: 131_072 });
    expect(config.contextWindow).toBe(131_072);
  });

  it('omits contextWindow (default applies) when the model reports 0', async () => {
    const config = await initWith({ id: 'zero', provider: 'adobe', contextWindow: 0 });
    expect(config.contextWindow).toBeUndefined();
  });

  it('omits contextWindow (default applies) when the model reports no window', async () => {
    const config = await initWith({ id: 'none', provider: 'adobe' });
    expect(config.contextWindow).toBeUndefined();
  });
});

describe('ScoopContext compaction memory gating (#2003)', () => {
  const MODEL = { id: 'sonnet', provider: 'adobe', contextWindow: 200_000 };

  beforeEach(() => {
    captures.agentCtorCalls.length = 0;
    captures.createCompactContextCalls.length = 0;
    mocks.resolveCurrentModel.mockReset();
    mocks.enabledFlags.clear();
  });

  it('wires onMemoryUpdates for the cone regardless of the flag (the gate is live)', async () => {
    mocks.enabledFlags.add('agentic-memory');
    const config = await initWith(MODEL, { appendConeMemory: vi.fn() });
    expect(config.onMemoryUpdates).toBeTypeOf('function');
    expect(config.shouldExtractMemories).toBeTypeOf('function');
  });

  it('shouldExtractMemories tracks the flag LIVE — a mid-session toggle applies to the next compaction', async () => {
    const config = await initWith(MODEL, { appendConeMemory: vi.fn() });
    const gate = config.shouldExtractMemories as () => boolean;
    expect(gate()).toBe(true);
    mocks.enabledFlags.add('agentic-memory');
    expect(gate()).toBe(false);
    mocks.enabledFlags.delete('agentic-memory');
    expect(gate()).toBe(true);
  });

  it('leaves onMemoryUpdates unset without an appendConeMemory callback (unchanged)', async () => {
    const config = await initWith(MODEL);
    expect(config.onMemoryUpdates).toBeUndefined();
  });
});

describe('ScoopContext scoop pre-compaction snapshot gating (memory-v2)', () => {
  const MODEL = { id: 'sonnet', provider: 'adobe', contextWindow: 200_000 };
  const childScoop: RegisteredScoop = {
    ...baseScoop,
    jid: 'scoop_worker_1',
    name: 'worker',
    folder: 'worker',
    parentJid: 'cone_test_1',
  };

  beforeEach(() => {
    captures.agentCtorCalls.length = 0;
    captures.createCompactContextCalls.length = 0;
    mocks.resolveCurrentModel.mockReset();
    mocks.enabledFlags.clear();
  });

  it('always wires onBeforeCompaction for roots', async () => {
    const config = await initWith(MODEL);
    expect(config.onBeforeCompaction).toBeTypeOf('function');
  });

  it('wires onBeforeCompaction for scoops so memory-v2 can gate live', async () => {
    const config = await initWith(MODEL, {}, childScoop);
    expect(config.onBeforeCompaction).toBeTypeOf('function');
  });
});
