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

/** The catalog's protected-origin rules (for code that must embed them, e.g. init-script guards). */
export const PROTECTED_RULES: {
  domains: readonly string[];
  hosts: readonly string[];
  schemes: readonly string[];
  refusal: string;
} = catalog.protectedOrigins;

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

type OpenerState = 'protected' | 'unprotected' | 'unknown' | undefined;

async function openerStateOf(
  tab: ChromeTab,
  getTab: (tabId: number) => Promise<ChromeTab | undefined>
): Promise<OpenerState> {
  if (typeof tab.openerTabId !== 'number') return undefined;
  try {
    const opener = await getTab(tab.openerTabId);
    if (!opener) return 'unknown';
    const openerProtected =
      isProtectedTarget(opener.url ?? '', false, 'unknown') || isProtectedUrl(opener.pendingUrl);
    return openerProtected ? 'protected' : 'unprotected';
  } catch {
    return 'unknown';
  }
}

/**
 * True when a Chrome tab must not be debugged: its committed or pending URL is
 * protected, or it is a blank/srcdoc document that may have inherited a
 * protected opener's origin. A blank tab with no opener (e.g. a fresh
 * `Target.createTarget`) is NOT protected; a blank tab whose opener is gone
 * or unreadable is (fail closed).
 */
export async function isProtectedTab(
  tab: ChromeTab | undefined,
  getTab: (tabId: number) => Promise<ChromeTab | undefined>
): Promise<boolean> {
  if (!tab) return false;
  if (isProtectedUrl(tab.pendingUrl)) return true;
  const url = tab.url ?? '';
  if (isProtectedUrl(url)) return true;
  return isProtectedTarget(url, false, await openerStateOf(tab, getTab));
}
