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
  /** Persist the canonical history after threshold compaction replaces it. */
  onContextCompacted?: () => void;
  /**
   * Set only when the unit declared a `structuredOutputSchema`: the tool's
   * arguments ARE the unit's return value, so they are captured at the
   * `afterToolCall` boundary as well as inside the tool itself (the tool may
   * be short-circuited by the adapter).
   */
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

    // pi-agent-core passes transformContext a snapshot used by the active run;
    // assigning the returned array only affects this one LLM request. Adopt the
    // compacted history in both places so the next tool continuation cannot
    // compact the same oversized prefix again.
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
