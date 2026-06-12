/**
 * Markdown serialization of a chat history — the "copy chat history"
 * format, also embedded in frozen-session archives so re-rendering stays
 * byte-identical across freeze/thaw. Extracted from the legacy ChatPanel.
 */

import { formatAttachmentSummary } from '../core/attachments.js';
import type { ChatMessage } from './types.js';

export function formatChatForClipboard(messages: ChatMessage[]): string {
  let formatted = '';
  for (const msg of messages) {
    const heading = msg.role === 'user' ? 'User' : 'Assistant';
    formatted += `## ${heading}\n${msg.content}\n\n`;
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
