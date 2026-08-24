/**
 * Construction of the pi `Agent` a work unit runs.
 *
 * Owns: the initial agent state and the four hooks a unit wires into it —
 * the credential getter, the compaction `transformContext`, the
 * session-header stream wrapper, and the structured-output capture.
 *
 * Changes when pi-agent-core's construction contract changes, or when a unit
 * gains another agent-level hook. Separating it keeps `init()` a readable
 * sequence of "gather the inputs, then build the agent".
 */

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
  /**
   * Set only when the unit declared a `structuredOutputSchema`: the tool's
   * arguments ARE the unit's return value, so they are captured at the
   * `afterToolCall` boundary as well as inside the tool itself (the tool may
   * be short-circuited by the adapter).
   */
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
