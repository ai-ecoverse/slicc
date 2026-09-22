/**
 * Cursor over a frozen transcript's message timestamps.
 *
 * `liveThrough` is how far a compaction snapshot has appended.
 * `curatedThrough` is how far a memory-curator pass has mined. Both are the
 * newest timestamp already consumed: a later message is one with a greater
 * timestamp. A same-millisecond sibling is kept inside the slice that first
 * reaches that timestamp (see `takeDeltaSlice` in live-session-curation), so
 * the cursor never moves past a message the pass did not include.
 */

import type { ChatMessage } from '../scoops/chat-types.js';

/** Newest message timestamp in the list, or 0 when there are none. */
export function newestMessageTimestamp(messages: readonly ChatMessage[]): number {
  let newest = 0;
  for (const message of messages) {
    if (message.timestamp > newest) newest = message.timestamp;
  }
  return newest;
}

/**
 * Messages strictly newer than `cursor`. A non-positive cursor means nothing
 * has been consumed yet, so the whole list is returned.
 */
export function messagesAfterCursor(
  messages: readonly ChatMessage[],
  cursor: number
): ChatMessage[] {
  if (!(cursor > 0)) return [...messages];
  return messages.filter((message) => message.timestamp > cursor);
}
