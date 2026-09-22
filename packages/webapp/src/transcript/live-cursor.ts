import type { ChatMessage } from '../scoops/chat-types.js';

export function newestMessageTimestamp(messages: readonly ChatMessage[]): number {
  let newest = 0;
  for (const message of messages) {
    if (message.timestamp > newest) newest = message.timestamp;
  }
  return newest;
}

export function messagesAfterCursor(
  messages: readonly ChatMessage[],
  cursor: number
): ChatMessage[] {
  if (!(cursor > 0)) return [...messages];
  return messages.filter((message) => message.timestamp > cursor);
}
