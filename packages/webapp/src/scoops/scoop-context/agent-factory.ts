import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { Api } from '@earendil-works/pi-ai';
import type { streamSimple } from '@earendil-works/pi-ai/compat';
import type { createCompactContext } from '../../core/context-compaction.js';
import type { AgentMessage, adaptTools, Model } from '../../core/index.js';
import { Agent } from '../../core/index.js';

export interface ScoopAgentInit {
  model: Model<Api>;
  tools: ReturnType<typeof adaptTools>;
  systemPrompt: string;
  messages: AgentMessage[];
  thinkingLevel: ThinkingLevel;
  getApiKey: () => string | undefined;
  transformContext: ReturnType<typeof createCompactContext>;
  streamFn: typeof streamSimple;

  onContextCompacted?: () => void;

  captureStructuredOutput?: (value: unknown) => void;
}

function sameMessages(left: readonly AgentMessage[], right: readonly AgentMessage[]): boolean {
  return left.length === right.length && left.every((message, index) => message === right[index]);
}

function contextChanged(
  messages: readonly AgentMessage[],
  transformed: readonly AgentMessage[]
): boolean {
  return !sameMessages(messages, transformed);
}

export function createScoopAgent(init: ScoopAgentInit): Agent {
  const capture = init.captureStructuredOutput;
  let agent: Agent;
  const transformContext = async (
    messages: AgentMessage[],
    signal?: AbortSignal
  ): Promise<AgentMessage[]> => {
    const transformed = await init.transformContext(messages, signal);
    if (signal?.aborted || !contextChanged(messages, transformed)) return messages;

    if (!sameMessages(agent.state.messages, messages)) return transformed;
    messages.splice(0, messages.length, ...transformed);
    agent.state.messages = [...transformed];
    init.onContextCompacted?.();
    return messages;
  };

  agent = new Agent({
    initialState: {
      model: init.model,
      tools: init.tools,
      systemPrompt: init.systemPrompt,
      messages: init.messages,
      thinkingLevel: init.thinkingLevel,
    },
    getApiKey: init.getApiKey,
    transformContext,
    streamFn: init.streamFn,
    afterToolCall: async (context) => {
      if (capture && context.toolCall.name === 'StructuredOutput') capture(context.args);
      return undefined;
    },
  });
  return agent;
}
