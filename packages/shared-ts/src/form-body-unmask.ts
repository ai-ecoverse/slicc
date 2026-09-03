/**
 * Encoding-aware masked→real unmask for `application/x-www-form-urlencoded`
 * request bodies.
 *
 * A form body is text, so the naive path is a substring replace of the masked
 * token with the real value. That corrupts the body whenever the real secret
 * contains a character that is reserved in a form: `&` and `=` split one field
 * into two (or inject an attacker-shaped extra parameter), `+` is decoded
 * upstream as a space, and a bare `%` becomes a malformed escape. Base64
 * secrets — AWS keys, many OAuth client secrets — routinely contain `+`, `/`,
 * and `=`, so the naive path silently breaks exactly the token exchanges that
 * made form unmasking necessary in the first place.
 *
 * This walks the body field by field, unmasks each value in its DECODED form,
 * and re-encodes only the values that actually changed. Untouched fields keep
 * their original bytes, so a body with no masked token is forwarded verbatim.
 *
 * Same shape as `SecretsPipeline.unmaskAuthorizationBasic`, which decodes
 * base64, unmasks, and re-encodes rather than substituting into the wire form.
 *
 * Mirrored by `unmaskFormBody` in
 * `packages/swift-server/Sources/Server/FormBodyUnmask.swift`; the
 * substitution table is pinned in both cross-impl test files.
 */

import type { SecretsPipeline } from './secrets-pipeline.js';

/** The unmask surface this helper needs — `SecretsPipeline` or a wrapper over one. */
export type FormBodyUnmasker = Pick<SecretsPipeline, 'unmaskBody' | 'hasSecrets'>;

/**
 * Percent-decode one form component. `+` means space in a form body, so it is
 * promoted to `%20` before decoding. Returns `null` for a malformed escape,
 * which the caller treats as "cannot reason about this field's encoding".
 */
function decodeFormComponent(raw: string): string | null {
  try {
    return decodeURIComponent(raw.replace(/\+/g, '%20'));
  } catch {
    return null;
  }
}

/**
 * Percent-encode one form component. `encodeURIComponent` escapes every
 * character that is reserved in a form body and leaves only unreserved ones
 * (`A-Za-z0-9-_.!~*'()`), all of which are legal in a form value. Space becomes
 * `%20` rather than `+`; both decode to a space.
 */
function encodeFormComponent(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Unmask a form-urlencoded body. Returns the original string when nothing
 * changed, so the caller can skip re-encoding the buffer.
 */
export function unmaskFormBody(
  pipeline: FormBodyUnmasker,
  body: string,
  hostname: string
): { text: string } {
  if (!body || !pipeline.hasSecrets()) return { text: body };

  let changed = false;
  const fields = body.split('&').map((field) => {
    const eq = field.indexOf('=');
    const name = eq < 0 ? '' : field.slice(0, eq + 1);
    const rawValue = eq < 0 ? field : field.slice(eq + 1);
    if (!rawValue) return field;

    const decoded = decodeFormComponent(rawValue);
    if (decoded === null) {
      // Malformed percent-escape: the field's encoding is not interpretable, so
      // fall back to the legacy substring replace rather than dropping the
      // secret. Best-effort — a reserved character in the real value can still
      // corrupt a field this broken.
      const { text } = pipeline.unmaskBody(rawValue, hostname);
      if (text === rawValue) return field;
      changed = true;
      return `${name}${text}`;
    }

    const { text } = pipeline.unmaskBody(decoded, hostname);
    if (text === decoded) return field;
    changed = true;
    return `${name}${encodeFormComponent(text)}`;
  });

  return { text: changed ? fields.join('&') : body };
}
