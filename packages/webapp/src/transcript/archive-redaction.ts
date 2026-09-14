import { type CredentialCategory, redactCredentialPatterns } from '@slicc/shared-ts';
import type { ChatMessage } from '../scoops/chat-types.js';

export const AT_REST_CREDENTIAL_CATEGORIES: readonly CredentialCategory[] = [
  'jwt',
  'private-key',
  'bearer-token',
  'api-key',
];

const ID_PREFIX = 'ar';

export interface AtRestRedactionState {
  nextId: number;
}

export function newAtRestState(): AtRestRedactionState {
  return { nextId: 1 };
}

export function redactArchiveText(text: string, state: AtRestRedactionState): string {
  const { text: out, nextId } = redactCredentialPatterns(text, ID_PREFIX, state.nextId, {
    categories: AT_REST_CREDENTIAL_CATEGORIES,
  });
  state.nextId = nextId;
  return out;
}

type JsonValue = string | number | boolean | null | undefined | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

function redactValue(value: JsonValue, state: AtRestRedactionState): JsonValue {
  if (typeof value === 'string') return redactArchiveText(value, state);
  if (Array.isArray(value)) {
    let changed = false;
    const out: JsonValue[] = [];
    for (const item of value) {
      const next = redactValue(item, state);
      if (next !== item) changed = true;
      out.push(next);
    }
    return changed ? out : value;
  }
  if (typeof value === 'object' && value !== null) {
    let changed = false;
    const out: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      const next = redactValue(item, state);
      if (next !== item) changed = true;
      out[key] = next;
    }
    return changed ? out : value;
  }
  return value;
}

export function redactChatMessagesAtRest(
  messages: readonly ChatMessage[],
  state: AtRestRedactionState = newAtRestState()
): readonly ChatMessage[] {
  return redactValue(messages as unknown as JsonValue, state) as unknown as readonly ChatMessage[];
}
