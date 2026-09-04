/**
 * `/preview/*` URL construction — the one place that turns a VFS path into a
 * URL the browser can actually fetch.
 *
 * Lives in `base/` because both ends of the app need it and they must agree:
 * the shell (`open`, `serve`, the file tree) opens these URLs in tabs, and the
 * chat message renderer points `<img>`/`<video>` at them inline. Previously
 * only the shell half existed, in `shell/supplemental-commands/shared.ts` —
 * a module that pulls in `just-bash` and the ipk resolver, so the renderer
 * could not import it without dragging that weight onto the boot path.
 * `shared.ts` re-exports both functions, so existing shell importers are
 * unchanged.
 *
 * Why this matters for chat: a bare VFS path in an `<img src>` resolves
 * against the app origin, where the SPA fallback answers **200 with
 * `text/html`** rather than 404. The image silently fails to decode and
 * nothing logs an error. Routing through `/preview/*` is what makes the
 * service worker serve the real bytes with the real MIME type.
 */

import { isExtensionRealm } from './runtime-env.js';

/**
 * Map a rooted VFS path to a fetchable `/preview/*` URL.
 *
 * `projectRoot` scopes the preview SW's Mode-2 project serving so a previewed
 * app's own root-absolute subresources resolve inside the project rather than
 * at the VFS root.
 */
export function toPreviewUrl(vfsPath: string, projectRoot?: string): string {
  const isExt = isExtensionRealm();
  const projectRootSuffix = projectRoot ? `?projectRoot=${encodeURIComponent(projectRoot)}` : '';
  const previewPath = `/preview${vfsPath}${projectRootSuffix}`;
  // Reached through `globalThis` rather than the bare `chrome` global: this
  // module is compiled by the worker and CLI projects too, and those do not
  // carry the extension ambient types. Same shape `shared-ts/runtime-env.ts`
  // uses to answer `isExtensionRealm()` in the first place.
  if (isExt) {
    const getURL = (globalThis as { chrome?: { runtime?: { getURL?: (p: string) => string } } })
      .chrome?.runtime?.getURL;
    if (getURL) return getURL(previewPath);
  }
  // Preference: page realm (`window`) → worker realm (`self.location`) → Node/test fallback.
  // The kernel worker has no `window`, but its bundle is served from the UI origin, so
  // `self.location.origin` is the correct preview host there. In thin-bridge mode this
  // avoids pointing previews at the bridge origin (e.g. `http://localhost:5710`) instead
  // of the UI origin (e.g. `http://localhost:8787`).
  let origin = 'http://localhost:5710';
  if (typeof window !== 'undefined' && window.location?.origin) {
    origin = window.location.origin;
  } else if (typeof self !== 'undefined' && self.location?.origin) {
    origin = self.location.origin;
  }
  return `${origin}${previewPath}`;
}

/**
 * True for any preview-serving URL — both the legacy local SW path
 * (`<origin>/preview/<vfs-path>` or `chrome-extension://<id>/preview/...`)
 * and the unified worker path (`<token>.sliccy.dev` / `<token>.staging.sliccy.dev`).
 * Used by the app-tab detector to avoid identifying a preview tab as the SLICC app.
 */
export function isPreviewUrl(url: string): boolean {
  if (url.includes('/preview/')) return true;
  try {
    const host = new URL(url).host;
    return /^[^.]+\.sliccy\.(?:now|dev)$/i.test(host);
  } catch {
    return false;
  }
}
