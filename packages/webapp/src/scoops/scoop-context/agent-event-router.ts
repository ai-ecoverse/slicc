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

export interface AgentEventSink {
  textDelta(delta: string): void;

  toolStart(toolName: string, args: unknown, toolCallId?: string): Promise<void> | void;
  toolUI(toolName: string, requestId: string, html: string): void;
  toolUIDone(requestId: string): void;
  toolProgress(toolName: string, progress: ToolProgressEvent, toolCallId?: string): void;
  toolResult(toolName: string, text: string, isError: boolean, toolCallId?: string): void;

  checkpoint(message?: AgentMessage): void;
  assistantMessageEnd(message: AssistantMessage): void;

  turnStart(): void;

  turnCompleted(): void;

  responseDone(): void;
  agentEnd(messages: AgentMessage[], abortSignal?: AbortSignal): void;
}

export function routeAgentEvent(
  event: CoreAgentEvent,
  sink: AgentEventSink,
  abortSignal?: AbortSignal
): Promise<void> | void {
  switch (event.type) {
    case 'message_update': {
      const ame = event.assistantMessageEvent as AssistantMessageEvent;
      if (ame.type === 'text_delta') sink.textDelta(ame.delta);
      break;
    }

    case 'tool_execution_start': {
      return sink.toolStart(event.toolName, event.args, event.toolCallId);
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
      sink.checkpoint(event.message);
      break;
    }

    case 'turn_start': {
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
    const telemetryText = parts.filter((p) => !p.startsWith('<img:')).join('\n');
    emitAgentError('tool', `${event.toolName}: ${telemetryText}`);
  }
  sink.toolResult(event.toolName, joined, event.isError, event.toolCallId);
}
