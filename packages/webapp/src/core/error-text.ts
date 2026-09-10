/**
 * Coerce unknown error values into a string without implicit `String()`.
 *
 * Production OpTel on www.sliccy.ai (Jun–Sep 2026) showed the literal
 * `[object Object]` as the most common `error` checkpoint target (970 pv):
 * `JSON.stringify` of a ping whose `target` is a plain object, or
 * `String(object)` / `object.toString()`, both collapse every distinct
 * payload into one unreadable facet. This helper is the single conversion
 * used by `trackError`, the runtime error listeners, and the error-card
 * render path so those families stay countable.
 *
 * @see https://github.com/ai-ecoverse/slicc/issues/3035
 */

/** Turn `details` into a raw string. Does not unwrap structured `{message}`. */
export function errorDetailsToRawString(details: unknown): string | undefined {
  if (details == null) return undefined;
  if (typeof details === 'string') return details;
  if (details instanceof Error) return formatErrorInstance(details);
  if (typeof details === 'object') return stringifyObject(details);
  if (typeof details === 'number' || typeof details === 'boolean' || typeof details === 'bigint') {
    return String(details);
  }
  return undefined;
}

/**
 * Coerce and unwrap. Prefer `message` / `error.message` on objects and on
 * JSON strings so `upstream_error` / `bedrock returned 400` become one
 * facet instead of one unique blob per payload.
 */
export function formatErrorDetails(details: unknown): string | undefined {
  const raw = errorDetailsToRawString(details);
  if (raw === undefined) return undefined;
  return unwrapStructuredErrorMessage(raw);
}

/** Extract a countable message from a JSON blob or `{message}` envelope. */
export function unwrapStructuredErrorMessage(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return raw;
  const direct = messageFromJson(trimmed);
  if (direct) return direct;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start > 0 && end > start) {
    const embedded = messageFromJson(trimmed.slice(start, end + 1));
    if (embedded) return embedded;
  }
  return raw;
}

function formatErrorInstance(error: Error): string {
  const name = error.name && error.name !== 'Error' ? error.name : '';
  const message = error.message || '';
  if (name && message) return `${name}: ${message}`;
  return message || name || 'Error';
}

function stringifyObject(obj: object): string | undefined {
  try {
    const json = JSON.stringify(obj);
    return typeof json === 'string' ? json : undefined;
  } catch {
    // Circular / non-enumerable bags: never fall back to `String(obj)`.
    return undefined;
  }
}

function messageFromJson(text: string): string | undefined {
  if (!text.startsWith('{')) return undefined;
  try {
    return messageFromUnknown(JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

function messageFromUnknown(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as { message?: unknown; error?: unknown };
  if (typeof obj.message === 'string' && obj.message.length > 0) return obj.message;
  if (typeof obj.error === 'string' && obj.error.length > 0) return obj.error;
  if (obj.error && typeof obj.error === 'object') {
    const inner = obj.error as { message?: unknown };
    if (typeof inner.message === 'string' && inner.message.length > 0) return inner.message;
  }
  return undefined;
}
