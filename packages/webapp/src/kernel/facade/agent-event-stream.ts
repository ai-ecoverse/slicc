import { createLogger } from '../../base/logger.js';
import type { AgentEvent } from '../../core/agent-types.js';
import type { AgentEventMsg } from '../messages.js';

const log = createLogger('kernel-agent-event-stream');

export type AgentEventListener = (scoopJid: string, event: AgentEvent) => void;

/** Translates outgoing agent-event envelopes and fans them out to kernel subscribers. */
export class AgentEventStream {
  private readonly listeners = new Set<AgentEventListener>();
  private readonly messageIds = new Map<string, string>();

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  clear(scoopJid: string): void {
    this.messageIds.delete(scoopJid);
  }

  publish(message: AgentEventMsg): void {
    const events = this.translate(message);
    for (const event of events) {
      for (const listener of this.listeners) {
        try {
          listener(message.scoopJid, event);
        } catch (error) {
          log.error('onAgentEvent listener threw', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  private translate(message: AgentEventMsg): AgentEvent[] {
    const { scoopJid, eventType } = message;
    const events: AgentEvent[] = [];
    const ensureMessageStart = (): string => {
      let messageId = this.messageIds.get(scoopJid);
      if (!messageId) {
        messageId = `scoop-${scoopJid}-${uid()}`;
        this.messageIds.set(scoopJid, messageId);
        events.push({ type: 'message_start', messageId });
      }
      return messageId;
    };

    switch (eventType) {
      case 'text_delta': {
        const messageId = ensureMessageStart();
        events.push({ type: 'content_delta', messageId, text: message.text ?? '' });
        break;
      }
      case 'tool_start': {
        const messageId = ensureMessageStart();
        events.push({
          type: 'tool_use_start',
          messageId,
          toolName: message.toolName ?? '',
          toolInput: message.toolInput,
        });
        break;
      }
      case 'tool_end': {
        const messageId = this.messageIds.get(scoopJid);
        if (!messageId) return events;
        events.push({
          type: 'tool_result',
          messageId,
          toolName: message.toolName ?? '',
          result: message.toolResult ?? '',
          isError: message.isError,
        });
        break;
      }
      case 'tool_ui': {
        const messageId = ensureMessageStart();
        events.push({
          type: 'tool_ui',
          messageId,
          toolName: message.toolName ?? '',
          requestId: message.requestId ?? '',
          html: message.html ?? '',
        });
        break;
      }
      case 'tool_ui_done': {
        const messageId = this.messageIds.get(scoopJid);
        if (!messageId) return events;
        events.push({ type: 'tool_ui_done', messageId, requestId: message.requestId ?? '' });
        break;
      }
      case 'tool_progress': {
        const messageId = this.messageIds.get(scoopJid);
        if (!messageId || !message.progress) return events;
        events.push({
          type: 'tool_progress',
          messageId,
          toolName: message.toolName ?? '',
          progress: message.progress,
        });
        break;
      }
      case 'response_done': {
        const messageId = this.messageIds.get(scoopJid);
        if (!messageId) return events;
        events.push({
          type: 'content_done',
          messageId,
          model: message.model,
          usage: message.usage,
        });
        this.messageIds.delete(scoopJid);
        break;
      }
      case 'turn_end':
        // Keep gating state aligned with the panel translator, but deliberately
        // do not synthesize a turn_end event from the wire envelope.
        this.messageIds.delete(scoopJid);
        break;
    }

    return events;
  }
}

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
