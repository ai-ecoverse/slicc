import { formatAttachmentSummary } from '../core/attachments.js';
import type { ChatMessage } from '../scoops/chat-types.js';
import { stripDictationMarkers } from '../speech/dictation-priming.js';

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
