/**
 * Regression coverage for `ScoopContext.init()` healing of corrupted
 * persisted sessions: orphaned `toolResult` messages at the head of
 * `saved.messages` must be stripped before the Agent is constructed,
 * otherwise Bedrock rejects the next turn with
 * "unexpected tool_use_id found in tool_result blocks".
 *
 * Captures the `Agent` constructor args so we can assert the
 * `initialState.messages` the Agent is built with — that's the
 * load-bearing observation: removing the `stripOrphanedToolResults`
 * call at `scoop-context.ts` session-restore site must make this fail.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegisteredScoop } from '../../src/scoops/types.js';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

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

// Keep real `stripOrphanedToolResults` so the wire-up is what's under test.
// Replace `createCompactContext` with a no-op to avoid loading pi-coding-agent.
vi.mock('../../src/core/context-compaction.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/core/context-compaction.js')>(
    '../../src/core/context-compaction.js'
  );
  return {
    ...actual,
    createCompactContext: () => async (messages: AgentMessage[]) => messages,
  };
});

vi.mock('@earendil-works/pi-ai', () => ({
  isContextOverflow: () => false,
  streamSimple: () => ({ result: () => Promise.resolve(null) }),
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
  resolveCurrentModel: () => ({ id: 'test-model', provider: 'anthropic' }),
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
    // A session persisted in IndexedDB whose first message is a toolResult
    // with no preceding assistant. Without the stripOrphanedToolResults call
    // at the session-restore site, this message flows into the Agent's
    // initialState and Bedrock rejects the next prompt with a 400.
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
      'cone_test_1'
    );
    await ctx.init();

    expect(captures.agentCtorCalls).toHaveLength(1);
    const passed = captures.agentCtorCalls[0].initialState?.messages ?? [];
    // The orphan must be gone before the Agent sees the history.
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
      'cone_test_1'
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
      'cone_test_1'
    );
    await ctx.init();

    expect(captures.agentCtorCalls).toHaveLength(1);
    const passed = captures.agentCtorCalls[0].initialState?.messages ?? [];
    expect(passed).toHaveLength(2);
    expect((passed[0] as { role: string }).role).toBe('user');
    expect((passed[1] as { role: string }).role).toBe('assistant');
  });
});
