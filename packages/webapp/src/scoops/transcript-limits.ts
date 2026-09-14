import { createImageMarkerRegex } from '../base/image-markers.js';

export const MAX_TRANSCRIPT_TOOL_TEXT_CHARS = 64 * 1024;

export function capTranscriptText(text: string, max = MAX_TRANSCRIPT_TOOL_TEXT_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [tool output truncated for the chat transcript: showing ${formatChars(
    max
  )} of ${formatChars(text.length)} — the agent received the full output]`;
}

const MAX_INPUT_CAP_DEPTH = 4;

export function capTranscriptToolInput(
  input: unknown,
  max = MAX_TRANSCRIPT_TOOL_TEXT_CHARS,
  depth = MAX_INPUT_CAP_DEPTH
): unknown {
  if (typeof input === 'string') return capTranscriptText(input, max);
  if (input === null || typeof input !== 'object' || depth <= 0) return input;
  if (Array.isArray(input)) {
    let copy: unknown[] | null = null;
    for (let i = 0; i < input.length; i++) {
      const capped = capTranscriptToolInput(input[i], max, depth - 1);
      if (capped !== input[i]) {
        copy ??= [...input];
        copy[i] = capped;
      }
    }
    return copy ?? input;
  }
  // biome-ignore lint/plugin: walks arbitrary tool input JSON; the cap is shape-agnostic by design.
  let copy: Record<string, unknown> | null = null;
  for (const [key, value] of Object.entries(input)) {
    const capped = capTranscriptToolInput(value, max, depth - 1);
    if (capped !== value) {
      // biome-ignore lint/plugin: same arbitrary tool input JSON as the accumulator above.
      copy ??= { ...(input as Record<string, unknown>) };
      copy[key] = capped;
    }
  }
  return copy ?? input;
}

export function capTranscriptToolResultForBuffer(
  result: string,
  max = MAX_TRANSCRIPT_TOOL_TEXT_CHARS
): string {
  if (!result) return result;
  if (!createImageMarkerRegex().test(result)) return capTranscriptText(result, max);
  const stripped = result.replace(createImageMarkerRegex(), '').trim();
  const capped = capTranscriptText(stripped, max);
  return capped.length > 0 ? `${capped}\n[screenshot omitted from transcript]` : '[screenshot]';
}

export function capTranscriptToolResultForEvent(
  result: string,
  max = MAX_TRANSCRIPT_TOOL_TEXT_CHARS
): string {
  if (result.length <= max) return result;

  if (!createImageMarkerRegex().test(result)) return capTranscriptText(result, max);

  const parts: string[] = [];
  let last = 0;
  for (const m of result.matchAll(createImageMarkerRegex())) {
    parts.push(capTranscriptText(result.slice(last, m.index), max));
    parts.push(m[0]);
    last = (m.index ?? 0) + m[0].length;
  }
  parts.push(capTranscriptText(result.slice(last), max));
  return parts.join('');
}

function formatChars(chars: number): string {
  if (chars >= 1024 * 1024) return `${(chars / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.round(chars / 1024)} KB`;
}
