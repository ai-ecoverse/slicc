import catalog from '@ai-ecoverse/slicc-browsers';
// @ts-expect-error — the .mjs has no .d.ts; the shape is documented in the package README.
import { protectedOrigins } from '@ai-ecoverse/slicc-browsers/protected.mjs';

const guard = protectedOrigins(catalog.protectedOrigins) as {
  url: (text: string) => boolean;
  target: (opts: { url: string; previous?: boolean; opener?: string }) => boolean;
};

export const PROTECTED_RULES: {
  domains: readonly string[];
  hosts: readonly string[];
  schemes: readonly string[];
  refusal: string;
} = catalog.protectedOrigins;

export const PROTECTED_REFUSAL: string = catalog.protectedOrigins.refusal;

export function isProtectedUrl(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  return guard.url(rawUrl);
}

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
