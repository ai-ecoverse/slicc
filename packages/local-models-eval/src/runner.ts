/**
 * Drive a single scenario through pi-agent-core's `runAgentLoop`.
 *
 * Uses the same loop SLICC's cone runs in production, just with the
 * scenario's tool subset and a sandbox-rooted system prompt. Tracks
 * per-turn telemetry so the verifier can pin call shape (e.g. "round 1
 * must emit ≥2 tool_calls" for parallel_math) and the CLI can print
 * a short transcript on failure.
 */

import {
  runAgentLoop,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
} from '@mariozechner/pi-agent-core';
import {
  streamSimple,
  type AssistantMessage,
  type Message,
  type Model,
  type ToolCall,
  type ToolResultMessage,
} from '@mariozechner/pi-ai';

export interface RoundLog {
  index: number;
  /** What the model decided to do this turn. */
  toolCalls: Array<{ id: string; name: string; arguments: unknown }>;
  /** Tool result text routed back to the model, in source order. */
  toolResults: string[];
  /** Plain-text content emitted by the assistant (post-thinking). */
  text: string;
  /** True when this turn ended without any tool calls (final answer). */
  isFinal: boolean;
}

export interface RunResult {
  finished: boolean;
  rounds: RoundLog[];
  /** Last assistant text (the answer the user would see in SLICC). */
  finalText: string;
  totalElapsedMs: number;
  error: string | null;
}

export interface RunOptions {
  model: Model<any>;
  systemPrompt: string;
  userPrompt: string;
  tools: AgentTool<any>[];
  /** Safety cap. If the loop tries to take more turns we abort and FAIL. */
  maxRounds: number;
  /** Cap each individual LLM request (model load + generate). */
  requestTimeoutMs?: number;
}

/**
 * Extract the user-visible text from an assistant message — the
 * concatenation of all `text` content blocks. We deliberately skip
 * `thinking` blocks because that's what SLICC's chat panel does;
 * verifiers should match against what the user actually sees.
 */
function assistantText(msg: AssistantMessage): string {
  return msg.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

function toolCallSummaries(msg: AssistantMessage): RoundLog['toolCalls'] {
  return msg.content
    .filter((block): block is ToolCall => block.type === 'toolCall')
    .map((block) => ({
      id: block.id,
      name: block.name,
      arguments: block.arguments,
    }));
}

function toolResultText(result: ToolResultMessage): string {
  return result.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

export async function runScenario(opts: RunOptions): Promise<RunResult> {
  const rounds: RoundLog[] = [];
  let nextIndex = 1;
  let error: string | null = null;
  const started = performance.now();

  // We attach an event sink that captures per-turn data. The loop
  // emits `turn_end` for each assistant message with its tool results
  // attached, which is exactly what we want for the transcript.
  const emit = async (event: AgentEvent): Promise<void> => {
    if (event.type === 'turn_end') {
      const message = event.message as AgentMessage;
      // Custom messages (status/notification) don't have an LLM
      // role; pi-agent-core surfaces them through the same event
      // but we only care about real assistant turns here.
      if ((message as { role?: string }).role !== 'assistant') return;
      const assistant = message as AssistantMessage;
      const tcs = toolCallSummaries(assistant);
      const isFinal = tcs.length === 0;
      // Pi's contract: transport / model failures land as an
      // assistant message with stopReason "error" + errorMessage.
      // Surface that into our `error` so the verifier doesn't see
      // "everything finished cleanly" on a 401 or a network drop.
      if ((assistant.stopReason === 'error' || assistant.stopReason === 'aborted') && !error) {
        error = assistant.errorMessage || `assistant stopReason=${assistant.stopReason}`;
      }
      rounds.push({
        index: nextIndex++,
        toolCalls: tcs,
        toolResults: event.toolResults.map(toolResultText),
        text: assistantText(assistant),
        isFinal,
      });
    }
  };

  // shouldStopAfterTurn enforces our max-rounds budget — pi's loop
  // doesn't have a built-in turn cap, only token / iteration caps
  // we'd have to over-tune.
  const shouldStop = ({ message }: { message: AgentMessage }): boolean => {
    if ((message as { role?: string }).role !== 'assistant') return false;
    const tcs = toolCallSummaries(message as AssistantMessage);
    if (tcs.length === 0) return true; // model is done
    if (rounds.length >= opts.maxRounds) {
      error = `hit max_rounds=${opts.maxRounds} without finishing`;
      return true;
    }
    return false;
  };

  const controller = new AbortController();
  const timeoutId = opts.requestTimeoutMs
    ? setTimeout(() => controller.abort(), opts.requestTimeoutMs * (opts.maxRounds + 2))
    : null;

  try {
    await runAgentLoop(
      [{ role: 'user', content: opts.userPrompt, timestamp: Date.now() }],
      {
        systemPrompt: opts.systemPrompt,
        messages: [],
        tools: opts.tools,
      },
      {
        model: opts.model,
        convertToLlm: (messages) =>
          messages.filter(
            (m): m is Message =>
              (m as { role?: string }).role === 'user' ||
              (m as { role?: string }).role === 'assistant' ||
              (m as { role?: string }).role === 'toolResult'
          ),
        shouldStopAfterTurn: shouldStop,
        // SwiftLM is unauthenticated, but pi-ai's openai-completions
        // provider hard-fails when no key is resolvable for the
        // configured provider name. Hand back a placeholder; SwiftLM
        // ignores the Authorization header.
        getApiKey: () => 'sk-swiftlm-no-auth-required',
      },
      emit,
      controller.signal,
      streamSimple
    );
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }

  const totalElapsedMs = Math.round(performance.now() - started);
  const lastRound = rounds[rounds.length - 1];
  const finalText = lastRound?.text ?? '';
  // "Finished" means the loop exited because the model stopped emitting
  // tool calls — not because we error'd out, hit the round budget, or
  // got a transport failure.
  const finished = !error && !!lastRound?.isFinal;

  return { finished, rounds, finalText, totalElapsedMs, error };
}
