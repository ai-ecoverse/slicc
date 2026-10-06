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
 * Replace unpaired UTF-16 surrogates with U+FFFD.
 *
 * Thin wrapper over ES2024 `String.prototype.toWellFormed` — present at
 * runtime (Node ≥ 20 / modern browsers) but not yet in our TS `lib` target
 * (`ES2022`), so call sites stay typed without bumping the project lib.
 */
export function wellFormed(text: string): string {
  return (String.prototype as unknown as { toWellFormed(this: string): string }).toWellFormed.call(
    text
  );
}

/** Cap for scoop/cone `lastActivity` snippets fed into quickLabel chip tips. */
export const LAST_ACTIVITY_MAX = 600;
