/**
 * Regression coverage for the Adobe `X-Session-Id` wiring in `ScoopContext.init()`.
 *
 * Two paths must both attach the same identifier on the Adobe provider so the
 * LLM proxy can group requests into a single logical session:
 *
 *  1. The agent's `streamFn` wrapper (Anthropic / OpenAI streaming).
 *  2. The compaction `transformContext` returned by `createCompactContext`,
 *     which calls pi-coding-agent's `completeSimple` directly and bypasses
 *     the `streamFn` wrapper.
 *
 * Without (2), pi-mode summarization requests landed in the proxy without the
 * header and were assigned a content-derived hex session id, fragmenting
 * sessions and leaving Pi conversations unclassified in the dashboard.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegisteredScoop } from '../../src/scoops/types.js';

type AgentCtorOptions = {
  streamFn?: unknown;
  transformContext?: unknown;
};

type StreamFn = (
  model: { provider: string },
  context: unknown,
  options?: { headers?: Record<string, string> }
) => unknown;

type CompactConfig = { headers?: Record<string, string> };

const captures = vi.hoisted(() => ({
  agentCtorCalls: [] as AgentCtorOptions[],
  createCompactContextCalls: [] as CompactConfig[],
  streamSimpleCalls: [] as Array<{
    model: { provider: string };
    options?: { headers?: Record<string, string> };
  }>,
}));

const mocks = vi.hoisted(() => ({
  resolveCurrentModel: vi.fn(() => ({ id: 'test-model', provider: 'anthropic' })),
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
}));

vi.mock('@mariozechner/pi-ai', () => ({
  isContextOverflow: () => false,
  streamSimple: (
    model: { provider: string },
    _context: unknown,
    options?: { headers?: Record<string, string> }
  ) => {
    captures.streamSimpleCalls.push({ model, options });
    return { result: () => Promise.resolve(null) };
  },
  getSupportedThinkingLevels: () => ['off'],
}));

vi.mock('../../src/tools/index.js', () => ({
  createFileTools: () => [],
  createBashTool: () => ({ name: 'bash' }),
}));

vi.mock('../../src/shell/index.js', () => ({
  WasmShell: vi.fn(function () {
    return {};
  }),
}));

vi.mock('../../src/ui/provider-settings.js', () => ({
  getApiKey: () => 'test-api-key',
  getSelectedProvider: () => 'anthropic',
  resolveCurrentModel: mocks.resolveCurrentModel,
  resolveModelById: () => ({ id: 'test-model', provider: 'anthropic' }),
}));

vi.mock('../../src/scoops/skills.js', () => ({
  createDefaultSkills: async () => {},
  loadSkills: async () => [],
  formatSkillsForPrompt: () => '',
}));

vi.mock('../../src/scoops/scoop-management-tools.js', () => ({
  createScoopManagementTools: () => [],
}));

vi.mock('../../src/core/secret-env.js', () => ({
  fetchSecretEnvVars: async () => ({}),
}));

const { ScoopContext } = await import('../../src/scoops/scoop-context.js');

const baseScoop: RegisteredScoop = {
  jid: 'cone_test_1',
  name: 'cone',
  folder: '',
  isCone: true,
  type: 'cone',
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

describe('ScoopContext Adobe X-Session-Id wiring', () => {
  beforeEach(() => {
    captures.agentCtorCalls.length = 0;
    captures.createCompactContextCalls.length = 0;
    captures.streamSimpleCalls.length = 0;
    mocks.resolveCurrentModel.mockReset();
  });

  it('forwards X-Session-Id to compaction headers when the model is Adobe', async () => {
    mocks.resolveCurrentModel.mockReturnValue({ id: 'test-model', provider: 'adobe' });

    const ctx = new ScoopContext(
      baseScoop,
      createMockCallbacks() as never,
      createMockFs() as never
    );
    await ctx.init();

    expect(captures.createCompactContextCalls).toHaveLength(1);
    const passed = captures.createCompactContextCalls[0];
    expect(passed.headers).toBeDefined();
    expect(passed.headers!['X-Session-Id']).toEqual(expect.any(String));
    expect(passed.headers!['X-Session-Id'].length).toBeGreaterThan(0);
  });

  it('omits compaction headers when the model is not Adobe', async () => {
    mocks.resolveCurrentModel.mockReturnValue({ id: 'test-model', provider: 'anthropic' });

    const ctx = new ScoopContext(
      baseScoop,
      createMockCallbacks() as never,
      createMockFs() as never
    );
    await ctx.init();

    expect(captures.createCompactContextCalls).toHaveLength(1);
    expect(captures.createCompactContextCalls[0].headers).toBeUndefined();
  });

  it('streamFn injects X-Session-Id only when invoked with an Adobe model', async () => {
    mocks.resolveCurrentModel.mockReturnValue({ id: 'test-model', provider: 'adobe' });

    const ctx = new ScoopContext(
      baseScoop,
      createMockCallbacks() as never,
      createMockFs() as never
    );
    await ctx.init();

    expect(captures.agentCtorCalls).toHaveLength(1);
    const streamFn = captures.agentCtorCalls[0].streamFn as StreamFn;
    expect(typeof streamFn).toBe('function');

    streamFn({ provider: 'adobe' }, { messages: [] });
    streamFn({ provider: 'anthropic' }, { messages: [] });

    expect(captures.streamSimpleCalls).toHaveLength(2);
    expect(captures.streamSimpleCalls[0].options?.headers?.['X-Session-Id']).toEqual(
      expect.any(String)
    );
    expect(captures.streamSimpleCalls[1].options?.headers).toBeUndefined();
  });

  it('uses the same X-Session-Id for streamFn and compaction headers', async () => {
    // Both code paths must agree on the identifier or the proxy splits a single
    // logical session into two clusters (one for tool turns, one for Pi
    // summarization).
    mocks.resolveCurrentModel.mockReturnValue({ id: 'test-model', provider: 'adobe' });

    const ctx = new ScoopContext(
      baseScoop,
      createMockCallbacks() as never,
      createMockFs() as never
    );
    await ctx.init();

    const compactionId = captures.createCompactContextCalls[0].headers!['X-Session-Id'];
    const streamFn = captures.agentCtorCalls[0].streamFn as StreamFn;
    streamFn({ provider: 'adobe' }, { messages: [] });
    const streamId = captures.streamSimpleCalls[0].options!.headers!['X-Session-Id'];

    expect(compactionId).toBe(streamId);
  });
});
