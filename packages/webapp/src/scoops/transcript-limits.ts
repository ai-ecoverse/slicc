/**
 * Size caps applied at the chat-TRANSCRIPT boundary — the kernel
 * bridge's per-scoop buffers, the agent events emitted to the panel,
 * and restored-history rebuilds (`agentMessagesToChatMessages`).
 *
 * Why: the transcript keeps every tool call of a session and — unlike
 * the canonical agent history — is never compacted. Uncapped, it grows
 * ~1:1 with tool output (a `cat` of a 1MB file retains 1MB in the
 * agent realm AND the panel realm, forever), which is how skill-heavy
 * sessions marched the offscreen document / kernel-worker tab into the
 * V8 4GB OOM. 64KB per tool result/input field is far beyond what the
 * chat UI can usefully display; the agent itself always receives the
 * FULL output — these caps apply to the human-facing transcript only.
 *
 * The canonical agent history (`agent-sessions` DB, compaction input)
 * MUST NOT be routed through these helpers.
 */

/** Per tool-result / per input-string-field transcript budget. */
export const MAX_TRANSCRIPT_TOOL_TEXT_CHARS = 64 * 1024;

/**
 * Cap a transcript text to `max` chars, appending an explicit marker
 * so users (and the panel) can tell output was elided. Identity for
 * text at or under the cap — callers can rely on reference equality
 * to skip downstream work.
 */
export function capTranscriptText(text: string, max = MAX_TRANSCRIPT_TOOL_TEXT_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [tool output truncated for the chat transcript: showing ${formatChars(
    max
  )} of ${formatChars(text.length)} — the agent received the full output]`;
}

/**
 * Maximum nesting depth {@link capTranscriptToolInput} descends into a
 * tool-input object. MCP-style tools regularly nest payloads a couple
 * of levels down (`{ params: { content: … } }`); four levels covers
 * every tool shape we ship while bounding the walk on pathological /
 * cyclic inputs. Strings nested deeper than this pass through
 * UNCAPPED — keep oversized fields within this depth.
 */
const MAX_INPUT_CAP_DEPTH = 4;

/**
 * Cap a tool input for the transcript: oversized string values (e.g.
 * `write_file`'s `content`, or an MCP tool's nested
 * `params.content`) are capped while the object/array shape — which
 * the panel's per-tool input renderers rely on — is preserved.
 * Recurses to {@link MAX_INPUT_CAP_DEPTH} levels (a depth bound also
 * makes cyclic inputs safe). Returns the SAME reference when nothing
 * needed capping, and a copy of only the mutated spine otherwise (the
 * original input object is owned by the agent loop and must not be
 * mutated).
 */
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
  let copy: Record<string, unknown> | null = null;
  for (const [key, value] of Object.entries(input)) {
    const capped = capTranscriptToolInput(value, max, depth - 1);
    if (capped !== value) {
      copy ??= { ...(input as Record<string, unknown>) };
      copy[key] = capped;
    }
  }
  return copy ?? input;
}

/**
 * Inline screenshot marker emitted by `scoop-context.formatToolResult`
 * (`<img:data:image/png;base64,...>`). The live panel extracts it into
 * a transient `_screenshotDataUrl` and strips it from the stored
 * result; it is never useful — and very expensive — to persist.
 *
 * Exposed as a factory, NOT a shared module-level regex: `/g` regexes
 * are stateful (`.test()` advances `lastIndex`), and a shared instance
 * used across the test/replace/matchAll call sites below is one
 * refactor away from returning wrong answers when two transcript ops
 * land in the same tick. A fresh instance per call is stateless by
 * construction and costs nothing at per-tool-call frequency.
 */
const imgMarkerRe = (): RegExp => /<img:data:image\/[^>]+>/g;

/**
 * Cap a tool result for the BUFFERED transcript (kernel-bridge
 * `messageBuffers` → `browser-coding-agent` UI store). Image markers
 * are stripped entirely — mirroring what the live panel itself keeps
 * (`ChatPanel.handleToolResult` strips them too, holding the data URL
 * only as a transient render property), and removing the single
 * biggest payload class (screenshots, ~MBs each) from the
 * session-lifetime buffer. A placeholder notes the omission so a
 * rebuilt transcript reads sensibly.
 */
export function capTranscriptToolResultForBuffer(
  result: string,
  max = MAX_TRANSCRIPT_TOOL_TEXT_CHARS
): string {
  if (!result) return result;
  if (!imgMarkerRe().test(result)) return capTranscriptText(result, max);
  const stripped = result.replace(imgMarkerRe(), '').trim();
  const capped = capTranscriptText(stripped, max);
  return capped.length > 0 ? `${capped}\n[screenshot omitted from transcript]` : '[screenshot]';
}

/**
 * Cap a tool result for the EMITTED agent event (live panel, tray
 * followers). Image markers are preserved WHOLE — the panel parses
 * them out for inline screenshot rendering, and a mid-base64 cut
 * would silently break that — while the text around them is capped.
 */
export function capTranscriptToolResultForEvent(
  result: string,
  max = MAX_TRANSCRIPT_TOOL_TEXT_CHARS
): string {
  if (result.length <= max) return result;
  // Fast path: no images — plain text cap.
  if (!imgMarkerRe().test(result)) return capTranscriptText(result, max);
  // Keep markers intact; cap each text segment between them.
  const parts: string[] = [];
  let last = 0;
  for (const m of result.matchAll(imgMarkerRe())) {
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
