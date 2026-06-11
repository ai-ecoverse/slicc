/**
 * Maps the webapp's `ChatMessage` records onto `@slicc/webcomponents` chat
 * elements. This is the presentation seam of the WC migration: the data
 * shapes stay the webapp's own (`ui/types.ts`), the DOM is the component
 * library's. Markdown rendering reuses the existing `message-renderer.ts`
 * pipeline so both UIs render byte-identical HTML for the same content.
 */

import type { SliccUserMessage } from '@slicc/webcomponents';
import type { MessageAttachment } from '../../core/attachments.js';
import { renderAssistantMessageContent, renderMessageContent } from '../message-renderer.js';
import type { ChatMessage, ToolCall } from '../types.js';

// Side-effect import registers every element this module instantiates.
import '@slicc/webcomponents';

/** Attachment chip shape accepted by `<slicc-user-message>` (not re-exported
 *  by the barrel, so derive it from the class's method signature). */
type UserAttachment = Parameters<SliccUserMessage['setAttachments']>[0][number];

/** Leading `[<Channel> Event: <name>]` marker on lick message content. */
const LICK_HEADER_RE = /^\[([^:\]]+):\s*([^\]]+)\]\s*\n?/;

/** Text glyph for an action row, keyed by tool name (default gear). */
const TOOL_ICONS: Readonly<Record<string, string>> = {
  bash: '$',
  read_file: '☰',
  write_file: '✎',
  edit_file: '✎',
};

function el(tag: string, attrs: Record<string, string> = {}): HTMLElement {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

/** Compact single-line summary of a tool call's input for the row label. */
export function summarizeToolInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return firstLine(input);
  if (typeof input === 'object') {
    const record = input as Record<string, unknown>;
    const primary = record['path'] ?? record['file_path'] ?? record['command'] ?? record['name'];
    if (typeof primary === 'string') return firstLine(primary);
  }
  return '';
}

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? '';
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

function toolCallRow(call: ToolCall): HTMLElement {
  const row = el('slicc-action-row', {
    icon: TOOL_ICONS[call.name] ?? '⚙',
    label: `${call.name} ${summarizeToolInput(call.input)}`.trim(),
    result: call.isError ? 'error' : call.result !== undefined ? 'done' : '…',
  });
  if (call.result !== undefined) {
    const body = document.createElement('div');
    body.setAttribute('slot', 'body');
    body.textContent = call.result.length > 600 ? `${call.result.slice(0, 600)}…` : call.result;
    row.append(body);
  }
  return row;
}

function userMessageEl(message: ChatMessage): HTMLElement {
  const bubble = document.createElement('slicc-user-message');
  bubble.setBodyHtml(renderMessageContent(message.content));
  if (message.queued) bubble.setAttribute('data-queued', '');
  if (message.attachments?.length) {
    bubble.setAttachments(message.attachments.map(toUserAttachment));
  }
  return bubble;
}

function toUserAttachment(attachment: MessageAttachment): UserAttachment {
  const kind = attachment.kind === 'image' ? 'image' : attachment.kind === 'text' ? 'text' : 'file';
  return {
    name: attachment.name,
    kind,
    src:
      kind === 'image' && attachment.data
        ? `data:${attachment.mimeType};base64,${attachment.data}`
        : undefined,
  };
}

function assistantMessageEls(message: ChatMessage): HTMLElement[] {
  const bubble = document.createElement('slicc-agent-message');
  if (message.isStreaming) bubble.setAttribute('streaming', '');
  bubble.setBodyHtml(renderAssistantMessageContent(message.content, message.isStreaming === true));
  const rows = (message.toolCalls ?? []).map(toolCallRow);
  return [bubble, ...rows];
}

function lickCardEl(message: ChatMessage): HTMLElement {
  const header = LICK_HEADER_RE.exec(message.content);
  return el('slicc-lick-card', {
    kind: message.channel ?? 'webhook',
    'event-label': header?.[2] ?? message.channel ?? 'event',
    body: header ? message.content.slice(header[0].length) : message.content,
  });
}

function delegationEls(message: ChatMessage): HTMLElement[] {
  const line = el('slicc-delegation-line', {
    kind: 'feed',
    verb: 'feed_scoop',
    label: firstLine(message.content.replace(/\*\*\[[^\]]*\]\*\*\s*/, '')),
  });
  const bubble = document.createElement('slicc-user-message');
  bubble.setBodyHtml(renderMessageContent(message.content));
  return [line, bubble];
}

/** Elements for a single chat message, in thread order. */
export function messageEls(message: ChatMessage): HTMLElement[] {
  if (message.source === 'lick') return [lickCardEl(message)];
  if (message.source === 'delegation' || message.channel === 'delegation') {
    return delegationEls(message);
  }
  if (message.role === 'assistant') return assistantMessageEls(message);
  return [userMessageEl(message)];
}

/** Locale-formatted day label for a separator (e.g. `Mon, Jan 1`). */
function dayLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

/** A `slicc-day-separator` labelled for the given timestamp's local date. */
export function daySeparatorEl(timestamp: number): HTMLElement {
  return el('slicc-day-separator', { label: dayLabel(timestamp) });
}

/**
 * Full thread children for a message list: a `slicc-day-separator` at each
 * local-date boundary, then the per-message elements in order.
 */
export function buildThreadChildren(messages: readonly ChatMessage[]): HTMLElement[] {
  const children: HTMLElement[] = [];
  let lastDay = '';
  for (const message of messages) {
    const day = new Date(message.timestamp).toDateString();
    if (day !== lastDay) {
      children.push(daySeparatorEl(message.timestamp));
      lastDay = day;
    }
    children.push(...messageEls(message));
  }
  return children;
}
