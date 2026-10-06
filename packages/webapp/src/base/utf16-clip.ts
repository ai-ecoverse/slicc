/**
 * Head-clip by UTF-16 index without splitting a surrogate pair.
 *
 * Same cut as bench `cutBefore` (#3820): a plain `.slice(0, max)` can land
 * between the two halves of an astral character. `JSON.stringify` then emits
 * a lone `\udXXX` escape, and strict Adobe/Bedrock GPT proxies reject the
 * whole body (`unexpected end of hex escape`, HTTP 400). The quickLabel
 * path (composer placeholder + scoop chip tips) hits that family.
 */

/** Slice end that does not leave a trailing high surrogate. */
export function cutBefore(s: string, end: number): number {
  if (end <= 0) return 0;
  const c = s.charCodeAt(end - 1);
  return c >= 0xd800 && c <= 0xdbff ? end - 1 : end;
}

/** Keep at most `max` UTF-16 units, never splitting a surrogate pair. */
export function clipUtf16(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, cutBefore(text, max));
}

/**
 * Replace unpaired UTF-16 surrogates with U+FFFD (ES2024 `toWellFormed` semantics).
 *
 * Kept as a pure walk so Safari before 16.4 (and any other runtime without
 * `String.prototype.toWellFormed`) cannot TypeError out of `quickLabel`
 * before its fail-soft `try` — the call sits above that catch on purpose.
 */
export function replaceLoneSurrogates(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text.slice(i, i + 2);
        i += 1;
      } else {
        out += '\uFFFD';
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      out += '\uFFFD';
    } else {
      out += text.slice(i, i + 1);
    }
  }
  return out;
}

/**
 * Replace unpaired UTF-16 surrogates with U+FFFD.
 *
 * Prefer the native ES2024 method when present; otherwise use
 * {@link replaceLoneSurrogates}. Never throws for a missing native.
 */
export function wellFormed(text: string): string {
  const native = (String.prototype as unknown as { toWellFormed?: (this: string) => string })
    .toWellFormed;
  if (typeof native === 'function') return native.call(text);
  return replaceLoneSurrogates(text);
}

/** Cap for scoop/cone `lastActivity` snippets fed into quickLabel chip tips. */
export const LAST_ACTIVITY_MAX = 600;
