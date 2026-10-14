/**
 * Protected-origin guard for the chrome-extension service worker.
 *
 * Uses `@ai-ecoverse/slicc-browsers`'s canonical `protectedOrigins()` matcher
 * so every CDP path (bridge-sw, cdp-proxy-sw) can refuse access to seven's
 * sensitive origins (vault.sliccy.ai, sliccy.ai, and every *.sliccy.ai host).
 *
 * The package is a regular dependency bundled at build time by vite/rolldown.
 * Renovate keeps it current so new protected hosts propagate automatically.
 * The test suite validates against the package's `protected.json` vectors.
 */

import catalog from '@ai-ecoverse/slicc-browsers';
// @ts-expect-error — the .mjs has no .d.ts; the shape is documented in the package README.
import { protectedOrigins } from '@ai-ecoverse/slicc-browsers/protected.mjs';

/** The singleton guard instance. No extra origins — the extension has none. */
const guard = protectedOrigins(catalog.protectedOrigins) as {
  url: (text: string) => boolean;
  target: (opts: { url: string; previous?: boolean; opener?: string }) => boolean;
};

/** Refusal message carried in error responses. */
export const PROTECTED_REFUSAL: string = catalog.protectedOrigins.refusal;

/** True when `rawUrl` resolves to a protected origin. Handles blob:,
 *  filesystem:, view-source: unwrapping internally. */
export function isProtectedUrl(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  return guard.url(rawUrl);
}

/**
 * True when a CDP target with the given URL should be treated as protected.
 * Respects opener semantics: about:blank with no opener is unprotected; a
 * created tab has no opener.
 */
export function isProtectedTarget(
  url: string,
  previous = false,
  opener?: 'protected' | 'unprotected' | 'unknown'
): boolean {
  return guard.target({ url, previous, opener });
}
