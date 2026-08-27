/**
 * The short, human-facing name for a MIME type — `image/png` → `png`,
 * `application/x-mach-binary` → `mach-binary`, `image/svg+xml` → `svg`.
 *
 * Chip-sized on purpose. Every surface that has already told the user WHAT
 * kind of thing it is showing (an image, a document) only needs the last
 * distinguishing word, and the full type is what the `title` is for.
 *
 * Lives in `internal/` rather than beside its first caller because two
 * surfaces label the same payload and must agree: Quick Look's header chip,
 * and the transcript's decoded-base64 chip in the webapp (which reaches this
 * through the `@slicc/webcomponents/internal/*` entry, the way
 * `message-renderer.ts` already reaches `escapeHtml`). Two copies of this
 * would let a blob be called one thing in the bubble and another in the
 * previewer it opens.
 */

/**
 * `application/octet-stream` has no informative subtype — "octet-stream" tells
 * a reader nothing they would not already assume. `binary` is what `file(1)`
 * would say, and it is the honest label for "we could not identify this".
 */
const OPAQUE_LABEL = 'binary';

export function shortMimeLabel(mime: string): string {
  const base = mime.split(';', 1)[0]?.trim() ?? mime;
  if (base === 'application/octet-stream' || base.length === 0) return OPAQUE_LABEL;
  const subtype = base.slice(base.indexOf('/') + 1);
  // `x-` is a registration artifact, and a `+xml` / `+json` suffix names the
  // SYNTAX rather than the format — `svg+xml` is an SVG, not an XML.
  return subtype.replace(/^x-/, '').replace(/\+.*$/, '');
}
