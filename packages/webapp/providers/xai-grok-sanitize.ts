/**
 * Payload sanitization for xAI's Responses API.
 *
 * xAI's endpoint has quirks compared to stock OpenAI:
 *   - Replayed `reasoning` items in input cause 400 errors.
 *   - `input_image` / `image_url` content types cause 422 deserialization errors.
 *   - `reasoning.effort` is only supported on a subset of models.
 *   - Empty-string content items cause validation failures.
 *
 * Strips / transforms those before the request goes out. Wired via the
 * `onPayload` callback on pi-ai's stream options so it runs after pi-ai's
 * own serialization but before the HTTP request.
 *
 * Adapted from https://github.com/stnly/pi-grok/blob/main/sanitize.ts.
 */

import { supportsReasoningEffort } from './xai-grok-models.js';

/**
 * Sanitize a provider request payload for xAI's Responses API.
 *
 * Mutates the input in place for efficiency and returns it.
 */
export function sanitizePayload(
  params: Record<string, unknown>,
  modelId: string
): Record<string, unknown> {
  const next = params;
  let strippedImages = false;

  if (Array.isArray(next.input)) {
    next.input = next.input
      .map((item: unknown) => {
        if (!item || typeof item !== 'object') return item;
        const obj = item as Record<string, unknown>;

        if (obj.type === 'reasoning') return null;

        if (Array.isArray(obj.content)) {
          const sanitized = (obj.content as unknown[])
            .map((part: unknown) => {
              if (!part || typeof part !== 'object') return part;
              const p = part as Record<string, unknown>;
              if (p.type === 'input_image' || p.type === 'image_url') {
                strippedImages = true;
                return {
                  type: 'input_text',
                  text: '[Image omitted — xAI Responses API does not support image uploads]',
                };
              }
              return p;
            })
            .filter(Boolean);

          if (sanitized.length === 0) return null;
          return { ...obj, content: sanitized };
        }

        if (typeof obj.content === 'string' && obj.content.length === 0) return null;
        return obj;
      })
      .filter(Boolean);
  }

  if (strippedImages) {
    console.warn(
      '[xai-grok] Images stripped from request — xAI Responses API does not support them.'
    );
  }

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

  delete next.include;

  return next;
}
