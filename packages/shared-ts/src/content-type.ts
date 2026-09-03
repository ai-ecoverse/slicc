/** Check whether a content type is safe to decode as UTF-8 text. */
export function isTextContentType(contentType: string): boolean {
  if (!contentType) return false;
  const normalized = contentType.toLowerCase();
  return (
    normalized.startsWith('text/') ||
    normalized.includes('json') ||
    normalized.includes('xml') ||
    normalized.includes('javascript') ||
    normalized.includes('ecmascript') ||
    normalized.includes('html') ||
    normalized.includes('css') ||
    normalized.includes('svg')
  );
}

/**
 * Whether a content type is `application/x-www-form-urlencoded`.
 *
 * Callers need this on top of {@link isTextRequestContentType} because a form
 * body is not just text: substituting a secret into one has to respect the
 * percent-encoding (see `unmaskFormBody`).
 */
export function isFormContentType(contentType: string): boolean {
  if (!contentType) return false;
  return contentType.toLowerCase().includes('urlencoded');
}

/**
 * Request-side variant of {@link isTextContentType}, additionally matching
 * `application/x-www-form-urlencoded`.
 *
 * Form bodies carry secrets — OAuth token exchange and a long tail of provider
 * APIs POST `client_secret=…` / `token=…` as a form — so a masked token in one
 * MUST be unmasked before the proxy forwards it upstream. The plain predicate
 * stays urlencoded-free because it also gates response scrub and body caching,
 * where a form body is rare and the extra match buys nothing.
 *
 * Mirrored by `isTextRequestContentType` in
 * `packages/swift-server/Sources/Server/ContentType.swift`; the classification
 * table is pinned in both `tests/cross-impl-vectors.test.ts` and
 * `packages/swift-server/Tests/CrossImplementationTests.swift`.
 */
export function isTextRequestContentType(contentType: string): boolean {
  if (!contentType) return false;
  return isTextContentType(contentType) || isFormContentType(contentType);
}
