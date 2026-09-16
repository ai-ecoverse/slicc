import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type ContextTransform = (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

interface AgentCtorOptions {
  initialState: { messages: AgentMessage[] };
  transformContext?: ContextTransform;
}

interface MockAgentInstance {
  state: { messages: AgentMessage[] };
}

const captures = vi.hoisted(() => ({
  options: null as AgentCtorOptions | null,
  instance: null as MockAgentInstance | null,
}));

vi.mock('../../../src/core/index.js', () => {
  class MockAgent {
    state: { messages: AgentMessage[] };

    constructor(options: AgentCtorOptions) {
      this.state = { messages: [...options.initialState.messages] };
      captures.options = options;
      captures.instance = this;
    }
  }

  return { Agent: MockAgent };
});

const { createScoopAgent } = await import('../../../src/scoops/scoop-context/agent-factory.js');

function message(text: string): AgentMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp: 0,
  } as AgentMessage;
}

function buildAgent(
  messages: AgentMessage[],
  transformContext: ContextTransform,
  onContextCompacted: () => void
) {
  return createScoopAgent({
    model: {} as never,
    tools: [],
    systemPrompt: '',
    messages,
    thinkingLevel: 'off',
    getApiKey: () => undefined,
    transformContext,
    streamFn: vi.fn() as never,
    onContextCompacted,
  });
}

describe('createScoopAgent context compaction adoption', () => {
  beforeEach(() => {
    captures.options = null;
    captures.instance = null;
  });

  it('adopts threshold compaction for the active loop and the canonical agent history', async () => {
    const old = message('old');
    const recent = message('recent');
    const summary = message('<context-summary>old</context-summary>');
    const compact = vi.fn(async (messages: AgentMessage[]) =>
      messages.includes(old) ? [summary, recent] : messages
    );
    const onContextCompacted = vi.fn();
    const agent = buildAgent([old, recent], compact, onContextCompacted);
    const activeLoopMessages = [old, recent];
    const transform = captures.options?.transformContext;
    expect(transform).toBeTypeOf('function');

    const first = await transform!(activeLoopMessages);

    expect(first).toBe(activeLoopMessages);
    expect(activeLoopMessages).toEqual([summary, recent]);
    expect(agent.state.messages).toEqual([summary, recent]);
    expect(agent.state.messages).not.toBe(activeLoopMessages);
    expect(onContextCompacted).toHaveBeenCalledOnce();

    const toolResult = message('tool result');
    activeLoopMessages.push(toolResult);
    agent.state.messages.push(toolResult);

    const second = await transform!(activeLoopMessages);

    expect(second).toBe(activeLoopMessages);
    expect(compact).toHaveBeenNthCalledWith(2, [summary, recent, toolResult], undefined);
    expect(onContextCompacted).toHaveBeenCalledOnce();
  });

  it('does not replace or persist history when the transform is a no-op', async () => {
    const initial = [message('short context')];
    const onContextCompacted = vi.fn();
    const agent = buildAgent(initial, async (messages) => messages, onContextCompacted);
    const activeLoopMessages = [...initial];
    const stateBefore = agent.state.messages;

    const result = await captures.options?.transformContext?.(activeLoopMessages);

    expect(result).toBe(activeLoopMessages);
    expect(agent.state.messages).toBe(stateBefore);
    expect(onContextCompacted).not.toHaveBeenCalled();
  });
});
