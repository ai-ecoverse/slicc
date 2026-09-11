/**
 * Archive-at-rest credential redaction (Track C, P0c).
 *
 * The export boundary already redacts (known secrets + the full pattern
 * set), but an archive sits on disk for months before anyone exports it —
 * and Memory v2 feeds archives back into enrichment, search, and scoop
 * prompts. This module scrubs structural key material out of the bytes
 * BEFORE they are persisted, at the serializer chokepoints every archive
 * writer shares (`formatArchiveAsMarkdown`, `writeSessionJsonl`,
 * `serializeAgentSessionArchive`).
 *
 * Deliberately narrower than the export scan, in both directions:
 *
 * - **Patterns only, no known-secrets pass.** The known-secret redactor is
 *   an async worker service; archive writes happen in both realms and must
 *   stay synchronous. Known secrets still get caught at export.
 * - **High-precision categories only.** The keyword-assignment `password`
 *   rule (`token = <anything>`) matches ordinary code discussion; fine in
 *   a one-way export, unacceptable in the copy the user keeps, searches,
 *   and thaws. What remains matches only real key material: JWTs, PEM
 *   private-key blocks, `Bearer` header values, and vendor key prefixes
 *   (sk-…, xoxb/xoxp, AKIA…, ghp_…, hf_…).
 *
 * Idempotent: existing `⟦REDACTED:…⟧` markers are excluded from scanning,
 * so re-rendering an already-redacted archive never double-wraps.
 */

import { type CredentialCategory, redactCredentialPatterns } from '@slicc/shared-ts';
import type { ChatMessage } from '../scoops/chat-types.js';

/** High-precision subset applied at rest (see module doc for the rationale). */
export const AT_REST_CREDENTIAL_CATEGORIES: readonly CredentialCategory[] = [
  'jwt',
  'private-key',
  'bearer-token',
  'api-key',
];

/** Marker id prefix distinguishing at-rest redactions from export-time `r` ids. */
const ID_PREFIX = 'ar';

/** Running id counter so every marker in one archive gets a distinct id. */
export interface AtRestRedactionState {
  nextId: number;
}

/** Fresh counter for one archive render. */
export function newAtRestState(): AtRestRedactionState {
  return { nextId: 1 };
}

/** Redact one string with the at-rest pattern subset. */
export function redactArchiveText(text: string, state: AtRestRedactionState): string {
  const { text: out, nextId } = redactCredentialPatterns(text, ID_PREFIX, state.nextId, {
    categories: AT_REST_CREDENTIAL_CATEGORIES,
  });
  state.nextId = nextId;
  return out;
}

/**
 * A message list is a JSON tree (it round-trips through the archive's JSON
 * block and the JSONL sidecar); this names that shape for the walker.
 */
type JsonValue = string | number | boolean | null | undefined | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

/**
 * Walk any JSON-ish value and redact every string leaf. Returns the SAME
 * reference when nothing changed so the (overwhelmingly common) clean
 * archive costs no allocation beyond the scan itself.
 */
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

/**
 * Redact every string leaf of a message list — content, tool-call input
 * and results, attachment names, compaction summaries. Returns the input
 * array unchanged (same reference) when no leaf matched.
 */
export function redactChatMessagesAtRest(
  messages: readonly ChatMessage[],
  state: AtRestRedactionState = newAtRestState()
): readonly ChatMessage[] {
  return redactValue(messages as unknown as JsonValue, state) as unknown as readonly ChatMessage[];
}
