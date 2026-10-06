export function cutBefore(s: string, end: number): number {
  if (end <= 0) return 0;
  const c = s.charCodeAt(end - 1);
  return c >= 0xd800 && c <= 0xdbff ? end - 1 : end;
}

export function clipUtf16(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, cutBefore(text, max));
}

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

export function wellFormed(text: string): string {
  const native = (String.prototype as unknown as { toWellFormed?: (this: string) => string })
    .toWellFormed;
  if (typeof native === 'function') return native.call(text);
  return replaceLoneSurrogates(text);
}

export const LAST_ACTIVITY_MAX = 600;
