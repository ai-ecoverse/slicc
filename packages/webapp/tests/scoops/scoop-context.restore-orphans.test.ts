import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegisteredScoop } from '../../src/scoops/types.js';
import { createFakeCapabilityBroker } from '../helpers/fake-capability-broker.js';

type AgentCtorOptions = { initialState?: { messages?: AgentMessage[] } };

const captures = vi.hoisted(() => ({
  agentCtorCalls: [] as AgentCtorOptions[],
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

vi.mock('../../src/core/context-compaction.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/core/context-compaction.js')>(
    '../../src/core/context-compaction.js'
  );
  return {
    ...actual,
    createCompactContext: () => async (messages: AgentMessage[]) => messages,
  };
});

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
  getSelectedProvider: () => 'anthropic',
  resolveCurrentModel: () => ({ id: 'test-model', provider: 'anthropic' }),
  resolveModelById: () => ({ id: 'test-model', provider: 'anthropic' }),
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
  return {
    mkdir: vi.fn(async () => {}),
    readFile: vi.fn(async () => {
      throw new Error('ENOENT');
    }),
    writeFile: vi.fn(async () => {}),
  };
}

function orphanedToolResult(toolCallId = 'orphan-id'): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName: 'test_tool',
    content: [{ type: 'text', text: 'lost result' }],
    isError: false,
    timestamp: 0,
  } as unknown as AgentMessage;
}

function userMessage(text: string): AgentMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp: 0,
  } as unknown as AgentMessage;
}

function assistantMessage(text: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
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
    timestamp: 0,
  } as unknown as AgentMessage;
}

describe('ScoopContext session restore — orphan healing', () => {
  beforeEach(() => {
    captures.agentCtorCalls.length = 0;
  });

  it('strips a leading orphaned toolResult from a corrupt persisted session', async () => {
    const corrupt: AgentMessage[] = [orphanedToolResult(), userMessage('continue')];
    const sessionStore = {
      load: vi.fn().mockResolvedValue({ messages: corrupt, createdAt: 42 }),
      save: vi.fn().mockResolvedValue(undefined),
    };

    const ctx = new ScoopContext(
      baseScoop,
      createMockCallbacks() as never,
      createMockFs() as never,
      sessionStore as never,
      undefined,
      'cone_test_1',
      undefined,
      undefined,
      undefined,
      createFakeCapabilityBroker()
    );
    await ctx.init();

    expect(captures.agentCtorCalls).toHaveLength(1);
    const passed = captures.agentCtorCalls[0].initialState?.messages ?? [];

    expect(passed).toHaveLength(1);
    expect((passed[0] as { role: string }).role).toBe('user');
  });

  it('strips multiple consecutive leading orphaned toolResults', async () => {
    const corrupt: AgentMessage[] = [
      orphanedToolResult('id-1'),
      orphanedToolResult('id-2'),
      userMessage('continue'),
    ];
    const sessionStore = {
      load: vi.fn().mockResolvedValue({ messages: corrupt, createdAt: 42 }),
      save: vi.fn().mockResolvedValue(undefined),
    };

    const ctx = new ScoopContext(
      baseScoop,
      createMockCallbacks() as never,
      createMockFs() as never,
      sessionStore as never,
      undefined,
      'cone_test_1',
      undefined,
      undefined,
      undefined,
      createFakeCapabilityBroker()
    );
    await ctx.init();

    const passed = captures.agentCtorCalls[0].initialState?.messages ?? [];
    expect(passed).toHaveLength(1);
    expect((passed[0] as { role: string }).role).toBe('user');
  });

  it('passes already-clean sessions through unchanged', async () => {
    const clean: AgentMessage[] = [userMessage('hello'), assistantMessage('hi')];
    const sessionStore = {
      load: vi.fn().mockResolvedValue({ messages: clean, createdAt: 42 }),
      save: vi.fn().mockResolvedValue(undefined),
    };

    const ctx = new ScoopContext(
      baseScoop,
      createMockCallbacks() as never,
      createMockFs() as never,
      sessionStore as never,
      undefined,
      'cone_test_1',
      undefined,
      undefined,
      undefined,
      createFakeCapabilityBroker()
    );
    await ctx.init();

    expect(captures.agentCtorCalls).toHaveLength(1);
    const passed = captures.agentCtorCalls[0].initialState?.messages ?? [];
    expect(passed).toHaveLength(2);
    expect((passed[0] as { role: string }).role).toBe('user');
    expect((passed[1] as { role: string }).role).toBe('assistant');
  });
});
