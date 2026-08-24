/**
 * The agent → UI event plumbing.
 *
 * Owns: the `AgentEvent` switch, the tool-UI/progress content decoding, and
 * the tool-result formatting (including the base64-stripped telemetry excerpt).
 *
 * Changes when pi-agent-core adds an event, or when a tool learns a new
 * partial-result content type. Everything here is translation — it makes no
 * lifecycle decisions of its own, which is exactly why it reads better as a
 * router over a sink than as five methods on the context.
 */

import type { AssistantMessage as PiAssistantMessage } from '@earendil-works/pi-ai';
import { isContextOverflow } from '@earendil-works/pi-ai/compat';
import type {
  AgentMessage,
  AssistantMessage,
  AssistantMessageEvent,
  AgentEvent as CoreAgentEvent,
} from '../../core/index.js';
import { emitAgentError } from '../../core/telemetry-hook.js';
import { PROGRESS_CONTENT_TYPE, type ToolProgressEvent } from '../../shell/progress/types.js';

/** Everything the router can tell the context about. */
export interface AgentEventSink {
  /** A streaming text delta from the assistant. */
  textDelta(delta: string): void;
  toolStart(toolName: string, args: unknown, toolCallId?: string): void;
  toolUI(toolName: string, requestId: string, html: string): void;
  toolUIDone(requestId: string): void;
  toolProgress(toolName: string, progress: ToolProgressEvent, toolCallId?: string): void;
  toolResult(toolName: string, text: string, isError: boolean, toolCallId?: string): void;
  /**
   * A completed message or tool result exists — durable-worthy the moment it
   * does, since that is exactly what an abnormal turn death loses (#1987).
   */
  checkpoint(): void;
  assistantMessageEnd(message: AssistantMessage): void;
  /** `turn_start`; the run-bound ceiling is enforced here (#1972). */
  turnStart(): void;
  /** A COMPLETED turn, counted whether or not it produced a response. */
  turnCompleted(): void;
  /** The turn produced a real answer (not an overflow error). */
  responseDone(): void;
  agentEnd(messages: AgentMessage[], abortSignal?: AbortSignal): void;
}

export function routeAgentEvent(
  event: CoreAgentEvent,
  sink: AgentEventSink,
  abortSignal?: AbortSignal
): void {
  switch (event.type) {
    case 'message_update': {
      const ame = event.assistantMessageEvent as AssistantMessageEvent;
      if (ame.type === 'text_delta') sink.textDelta(ame.delta);
      break;
    }

    case 'tool_execution_start': {
      sink.toolStart(event.toolName, event.args, event.toolCallId);
      break;
    }

    case 'tool_execution_update': {
      routeToolUIEvents(event, sink);
      break;
    }

    case 'tool_execution_end': {
      routeToolResult(event, sink);
      sink.checkpoint();
      break;
    }

    case 'message_end': {
      if (event.message.role === 'assistant') {
        sink.assistantMessageEnd(event.message as AssistantMessage);
      }
      sink.checkpoint();
      break;
    }

    case 'turn_start': {
      // #1972: stop only when the agent tries to BEGIN a turn past the
      // ceiling — a run that completes exactly on `maxTurns` finishes
      // normally (its final turn_end + agent_end fire first).
      sink.turnStart();
      break;
    }

    case 'turn_end': {
      sink.turnCompleted();
      if (
        event.message.role === 'assistant' &&
        isContextOverflow(event.message as PiAssistantMessage)
      ) {
        break;
      }
      sink.responseDone();
      break;
    }

    case 'agent_end': {
      sink.agentEnd(event.messages, abortSignal);
      break;
    }
  }
}

/** Decode a tool's partial result into UI / progress callbacks. */
function routeToolUIEvents(
  event: { partialResult: unknown; toolName: string; toolCallId?: string },
  sink: AgentEventSink
): void {
  const partialResult = event.partialResult as {
    content?: Array<{
      type: string;
      requestId?: string;
      html?: string;
      progress?: ToolProgressEvent;
    }>;
  };
  for (const c of partialResult?.content ?? []) {
    if (c.type === 'tool_ui' && c.requestId && c.html) {
      sink.toolUI(event.toolName, c.requestId, c.html);
    } else if (c.type === 'tool_ui_done' && c.requestId) {
      sink.toolUIDone(c.requestId);
    } else if (c.type === PROGRESS_CONTENT_TYPE && c.progress) {
      sink.toolProgress(event.toolName, c.progress, event.toolCallId);
    }
  }
}

/** Flatten a tool result to text (+ inline image markers) and report it. */
function routeToolResult(
  event: { result: unknown; toolName: string; isError: boolean; toolCallId?: string },
  sink: AgentEventSink
): void {
  const result = event.result as {
    content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  };
  const parts: string[] = [];
  for (const c of result?.content ?? []) {
    if (c.type === 'text' && c.text) parts.push(c.text);
    if (c.type === 'image' && c.data && c.mimeType)
      parts.push(`<img:data:${c.mimeType};base64,${c.data}>`);
  }
  const joined = parts.join('\n');
  if (event.isError) {
    // Telemetry is best-effort — `target` is sanitized+truncated by
    // `trackError` downstream so passing the raw text excerpt is safe.
    // Strip `<img:data:...;base64,...>` parts before emitting: their
    // base64 payload can run into MBs per failed image-emitting tool
    // call, and the telemetry sink only truncates downstream on the
    // wire. The full `joined` (images included) still flows to the
    // onToolEnd callback unchanged.
    const telemetryText = parts.filter((p) => !p.startsWith('<img:')).join('\n');
    emitAgentError('tool', `${event.toolName}: ${telemetryText}`);
  }
  sink.toolResult(event.toolName, joined, event.isError, event.toolCallId);
}
