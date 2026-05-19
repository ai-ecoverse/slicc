/**
 * Payload sanitization for xAI's Responses API.
 *
 * xAI's endpoint has quirks compared to stock OpenAI:
 *   - Replayed `reasoning` items in input cause 400 errors.
 *   - `reasoning.effort` is only supported on a subset of models.
 *   - Empty-string content items cause validation failures.
 *   - `function_call_output.output` cannot contain image arrays.
 *   - `image_url` parts must be normalized to `input_image` with data URIs.
 *   - xAI rejects `role: "developer"` and `role: "system"` in the input
 *     array; these must be moved to top-level `instructions`.
 *   - xAI uses `text.format` instead of OpenAI's `response_format`.
 *   - xAI uses `prompt_cache_key` for conversation caching.
 *   - xAI doesn't support `prompt_cache_retention`.
 *   - xAI doesn't support `reasoning.encrypted_content` in `include`.
 *
 * Adapted from https://github.com/stnly/pi-grok/blob/main/sanitize.ts.
 *
 * Slicc-specific deviations from the reference:
 *   - The reference resolves local image paths to data URIs via `fs` /
 *     `path`. Slicc runs in the browser / extension where those modules
 *     don't exist, so local-path resolution is intentionally omitted —
 *     the agent's bash tools are expected to read the image and embed it
 *     as a data URI before it reaches a content array. Bare `http(s)` and
 *     `data:image/*` URIs flow through unchanged.
 */

import { supportsReasoningEffort } from './xai-grok-models.js';

// ── Content text extraction ────────────────────────────────────────

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      const item = part as Record<string, unknown>;
      const type = typeof item.type === 'string' ? item.type : '';
      return ['text', 'input_text', 'output_text'].includes(type) && typeof item.text === 'string'
        ? item.text
        : '';
    })
    .filter(Boolean)
    .join('\n');
}

// ── Image helpers ──────────────────────────────────────────────────

function stripShellQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Normalize an image input value to a URL or data URI string.
 *
 * Browser-safe subset: only http(s) and data:image/* URIs pass through.
 * Local file paths and `file://` URLs trigger a console warning and are
 * dropped (the upstream agent must resolve them before they reach here).
 */
function normalizeImageInput(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const cleaned = stripShellQuotes(value);
  if (/^https?:\/\//i.test(cleaned) || /^data:image\//i.test(cleaned)) {
    return cleaned;
  }
  console.warn(
    '[xai-grok] Dropping non-http/data image reference (slicc cannot resolve local paths in the browser):',
    cleaned
  );
  return undefined;
}

// ── Content part normalization ─────────────────────────────────────

function isInputImagePart(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as Record<string, unknown>).type === 'input_image'
  );
}

function normalizeImageParts(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeImageParts);
  if (!value || typeof value !== 'object') return value;

  const obj = { ...(value as Record<string, unknown>) };

  // Normalize { type: "image", data, mimeType } → input_image with data URI
  if (obj.type === 'image' && typeof obj.data === 'string' && typeof obj.mimeType === 'string') {
    return {
      type: 'input_image',
      image_url: `data:${obj.mimeType};base64,${obj.data}`,
      detail: typeof obj.detail === 'string' && obj.detail ? obj.detail : 'auto',
    };
  }

  // Normalize { type: "image_url", image_url: { url, detail } } → input_image
  if (obj.type === 'image_url') {
    const imageUrl =
      typeof obj.image_url === 'object' && obj.image_url
        ? (obj.image_url as Record<string, unknown>).url
        : obj.image_url;
    const detail =
      typeof obj.image_url === 'object' && obj.image_url
        ? (obj.image_url as Record<string, unknown>).detail
        : obj.detail;
    obj.type = 'input_image';
    obj.image_url = imageUrl;
    if (typeof detail === 'string' && detail) obj.detail = detail;
  }

  // Normalize input_image — drop unresolvable local paths in browser
  if (obj.type === 'input_image') {
    const imageUrl =
      typeof obj.image_url === 'object' && obj.image_url
        ? (obj.image_url as Record<string, unknown>).url
        : obj.image_url;
    const detail =
      typeof obj.image_url === 'object' && obj.image_url
        ? (obj.image_url as Record<string, unknown>).detail
        : obj.detail;
    const normalized = normalizeImageInput(imageUrl);
    if (normalized) obj.image_url = normalized;
    else return null;
    if (typeof detail === 'string' && detail) obj.detail = detail;
    if (typeof obj.detail !== 'string' || !obj.detail) obj.detail = 'auto';
  }

  if (Array.isArray(obj.content)) obj.content = normalizeImageParts(obj.content);
  if (Array.isArray(obj.output)) obj.output = normalizeImageParts(obj.output);
  return obj;
}

// ── function_call_output rewrite ───────────────────────────────────

/**
 * xAI rejects image arrays inside `function_call_output.output`. Extract
 * images into a separate user message so they're delivered as normal input.
 */
function rewriteFunctionCallOutput(input: Record<string, unknown>[]): Record<string, unknown>[] {
  const rewritten: Record<string, unknown>[] = [];

  for (const item of input) {
    if (
      !item ||
      typeof item !== 'object' ||
      item.type !== 'function_call_output' ||
      !Array.isArray(item.output)
    ) {
      rewritten.push(item);
      continue;
    }

    const outputParts = item.output as unknown[];
    const imageParts = outputParts.filter(isInputImagePart);
    const textParts = outputParts.filter((p) => !isInputImagePart(p));

    const textChunks: string[] = [];
    for (const part of textParts) {
      if (typeof part === 'string') {
        textChunks.push(part);
      } else if (part && typeof part === 'object') {
        const p = part as Record<string, unknown>;
        if (typeof p.text === 'string') textChunks.push(p.text);
      }
    }

    const outputText = textChunks.join('\n') || '(tool returned no text output)';
    rewritten.push({ ...item, output: outputText });

    if (imageParts.length > 0) {
      const callId = item.call_id ? ` (${String(item.call_id)})` : '';
      const label = `The previous tool result${callId} included ${imageParts.length} image${imageParts.length === 1 ? '' : 's'}. Use the attached image${imageParts.length === 1 ? '' : 's'} as the visual output from that tool.`;
      rewritten.push({
        role: 'user',
        content: [{ type: 'input_text', text: label }, ...imageParts],
      });
    }
  }

  return rewritten;
}

// ── Main sanitization ──────────────────────────────────────────────

/**
 * Sanitize a provider request payload for xAI's Responses API.
 *
 * Mutates the input in place for efficiency and returns it.
 */
export function sanitizePayload(
  params: Record<string, unknown>,
  modelId: string,
  sessionId?: string
): Record<string, unknown> {
  const next = params;

  if (Array.isArray(next.input)) {
    let input = (next.input as unknown[])
      .map((item: unknown) => {
        if (!item || typeof item !== 'object') return item;
        const obj = item as Record<string, unknown>;

        // Strip replayed reasoning items
        if (obj.type === 'reasoning') return null;

        // Drop empty string content
        if (typeof obj.content === 'string' && obj.content.length === 0) return null;

        return obj;
      })
      .filter(Boolean) as Record<string, unknown>[];

    // Move system/developer messages to top-level instructions.
    // xAI rejects role: "developer" and role: "system" in the input array.
    const instructionParts: string[] = [];
    while (input.length > 0) {
      const first = input[0];
      if (!first || typeof first !== 'object') break;
      const role = (first as Record<string, unknown>).role;
      if (role !== 'developer' && role !== 'system') break;
      const text = textFromContent((first as Record<string, unknown>).content).trim();
      if (text) instructionParts.push(text);
      input.shift();
    }
    if (instructionParts.length > 0) {
      const existing =
        typeof next.instructions === 'string' && next.instructions ? next.instructions : '';
      const merged = [existing, ...instructionParts].filter((part) => part.length > 0).join('\n\n');
      next.instructions = merged;
    }

    input = normalizeImageParts(input) as Record<string, unknown>[];
    input = rewriteFunctionCallOutput(input);

    next.input = input;
  }

  // response_format → text.format
  if (next.response_format && !next.text) {
    next.text = { format: next.response_format };
    delete next.response_format;
  }

  // Reasoning effort
  if (supportsReasoningEffort(modelId)) {
    const reasoning = next.reasoning as Record<string, unknown> | undefined;
    if (reasoning && reasoning.effort === 'minimal') {
      next.reasoning = { ...reasoning, effort: 'low' };
    }
    if (reasoning && reasoning.summary !== undefined) {
      next.reasoning = { effort: (next.reasoning as Record<string, unknown>).effort };
    }
  } else {
    delete next.reasoning;
  }

  // Strip/filter unsupported fields.
  if (Array.isArray(next.include)) {
    next.include = (next.include as unknown[]).filter(
      (item) => item !== 'reasoning.encrypted_content'
    );
    if ((next.include as unknown[]).length === 0) delete next.include;
  }

  delete next.prompt_cache_retention;

  if (sessionId && !next.prompt_cache_key) {
    next.prompt_cache_key = sessionId;
  }

  return next;
}
