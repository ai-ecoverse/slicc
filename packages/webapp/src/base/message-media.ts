/**
 * What a markdown `![alt](href)` in a chat message should actually become.
 *
 * One markdown syntax carries every medium: the *file* decides whether the
 * renderer emits an `<img>` or a `<video>`, so an agent never has to remember
 * a second spelling. `![clip](/shared/demo.mp4)` is a video player;
 * `![shot](/shared/demo.png)` is an image.
 *
 * Lives in `base/` next to `mime-types.ts` and `preview-url.ts` — the two
 * things it composes — so the decision is pure, unit-testable, and identical
 * wherever a message is rendered.
 *
 * Extension-based typing (rather than the content sniffing `core/file-type.ts`
 * does) is deliberate and correct here: at render time we hold a *path* and no
 * bytes, and `base/mime-types.ts` is the serving-MIME table — the same one the
 * preview service worker will use to label the response. Sniffing is for
 * reading bytes; this is for choosing an element.
 */

import { getMimeType, isVideoMimeType } from './mime-types.js';
import { toPreviewUrl } from './preview-url.js';

/** How a message-body media reference should be rendered. */
export type MessageMedia =
  /** An `<img>`. */
  | { kind: 'image'; src: string }
  /** A `<video controls>`. */
  | { kind: 'video'; src: string; mimeType: string };

/** Schemes that must never reach an element attribute. */
const DANGEROUS_SCHEME_RE = /^(?:javascript|vbscript|file):/i;

/**
 * A `.shtml` reference is a dip, not a picture: `hydrateDips()` keys off
 * `img[src$=".shtml"]` and swaps in a sandboxed iframe after the stream ends.
 * Rewriting or retyping it here would break that handshake.
 */
function isDipReference(href: string): boolean {
  return stripUrlSuffix(href).toLowerCase().endsWith('.shtml');
}

/** Drop `?query` and `#hash` so extension typing sees the real filename. */
export function stripUrlSuffix(href: string): string {
  const cut = href.search(/[?#]/);
  return cut === -1 ? href : href.slice(0, cut);
}

/**
 * Decide what `![alt](href)` renders as, resolving VFS paths to `/preview/*`.
 *
 * Returns `null` when the reference must be left exactly as the markdown
 * renderer's default `<img src>` — a dip reference, a dangerous scheme, or an
 * empty href. Callers treat `null` as "emit a plain `<img>` and let DOMPurify
 * have the final say".
 */
export function resolveMessageMedia(href: string): MessageMedia | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  if (DANGEROUS_SCHEME_RE.test(trimmed)) return null;
  if (isDipReference(trimmed)) return null;

  // A rooted path is a VFS path. Left alone it resolves against the app
  // origin, where the SPA fallback answers 200 + text/html and the element
  // silently fails to decode — see `base/preview-url.ts`.
  const isVfsPath = trimmed.startsWith('/') && !trimmed.startsWith('//');
  const src = isVfsPath ? toPreviewUrl(trimmed) : trimmed;

  // A `data:` URL states its own type; everything else is typed by extension.
  const mimeType = trimmed.startsWith('data:')
    ? (trimmed.slice('data:'.length).split(/[;,]/, 1)[0] ?? '')
    : getMimeType(stripUrlSuffix(trimmed));

  if (isVideoMimeType(mimeType)) return { kind: 'video', src, mimeType };

  // Everything else is an image. That deliberately includes types we cannot
  // name — an extensionless path, a CDN URL with no suffix — because `<img>`
  // is both the markdown author's stated intent and the safe default.
  return { kind: 'image', src };
}
