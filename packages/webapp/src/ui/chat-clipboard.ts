/**
 * Markdown serialization of a chat history — the "copy chat history"
 * format, also embedded in frozen-session archives as the human-readable
 * body below the structured data block. Extracted from the legacy ChatPanel.
 *
 * Dictation markers (🎙️ and ◁…▷ — see `speech/dictation-priming.ts`) are
 * stripped from USER-role content here so that human-facing serializations
 * (clipboard copy + frozen-session archive body) read cleanly. Only the
 * user role is touched because markers are only ever appended to dictated
 * user messages; assistant content passes through untouched. The
 * structured `ChatMessage[]` that the freezer embeds for thaw keeps the
 * markers intact (thaw re-renders through `userMessageEl`, which is the
 * single render-time strip site).
 */

import { formatAttachmentSummary } from '../core/attachments.js';
import { stripDictationMarkers } from '../speech/dictation-priming.js';
import type { ChatMessage } from './types.js';

export function formatChatForClipboard(messages: ChatMessage[]): string {
  let formatted = '';
  for (const msg of messages) {
    const heading = msg.role === 'user' ? 'User' : 'Assistant';
    const content = msg.role === 'user' ? stripDictationMarkers(msg.content) : msg.content;
    formatted += `## ${heading}\n${content}\n\n`;
    if (msg.attachments?.length) {
      formatted += `Attachments:\n${msg.attachments
        .map((attachment) => `- ${formatAttachmentSummary(attachment)}`)
        .join('\n')}\n\n`;
    }
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        formatted += `### Tool: ${tc.name}\nInput: ${JSON.stringify(tc.input, null, 2)}\nResult: ${tc.result ?? ''}\n\n`;
      }
    }
  }
  return formatted;
}
