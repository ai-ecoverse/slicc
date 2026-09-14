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

  captureStructuredOutput?: (value: unknown) => void;
}

export function createScoopAgent(init: ScoopAgentInit): Agent {
  const capture = init.captureStructuredOutput;
  return new Agent({
    initialState: {
      model: init.model,
      tools: init.tools,
      systemPrompt: init.systemPrompt,
      messages: init.messages,
      thinkingLevel: init.thinkingLevel,
    },
    getApiKey: init.getApiKey,
    transformContext: init.transformContext,
    streamFn: init.streamFn,
    afterToolCall: async (context) => {
      if (capture && context.toolCall.name === 'StructuredOutput') capture(context.args);
      return undefined;
    },
  });
}
