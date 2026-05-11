/**
 * Tiny pure-JS layer over the page-localStorage key
 * `slicc_oauth_extra_domains`. Same shape and key the webapp's
 * `provider-settings.ts` uses; this module exists so the options page
 * (`secrets.html` / `secrets-entry.ts`) can share the same backend
 * without pulling in the full provider-settings module (which would
 * fan out into a heavy bundle).
 *
 * Both pages live at chrome-extension://<id>/* so they hit the same
 * localStorage. Updates here are visible to the side panel on its next
 * read (no chrome.runtime round-trip needed).
 */

export const OAUTH_EXTRA_DOMAINS_KEY = 'slicc_oauth_extra_domains';

export type OAuthExtraDomainsStore = Record<string, string[]>;

export interface LocalStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readOAuthExtras(storage: LocalStorageLike): OAuthExtraDomainsStore {
  try {
    const raw = storage.getItem(OAUTH_EXTRA_DOMAINS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: OAuthExtraDomainsStore = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof k !== 'string' || !Array.isArray(v)) continue;
      const cleaned = v.filter((d): d is string => typeof d === 'string' && d.length > 0);
      if (cleaned.length > 0) out[k] = cleaned;
    }
    return out;
  } catch {
    return {};
  }
}

export function writeOAuthExtras(storage: LocalStorageLike, store: OAuthExtraDomainsStore): void {
  storage.setItem(OAUTH_EXTRA_DOMAINS_KEY, JSON.stringify(store));
}

export function addOAuthExtraDomain(
  storage: LocalStorageLike,
  providerId: string,
  domain: string
): { added: boolean; reason?: string } {
  if (!providerId || !domain) return { added: false, reason: 'provider and domain required' };
  const store = readOAuthExtras(storage);
  const current = store[providerId] ?? [];
  const lower = domain.toLowerCase();
  if (current.some((d) => d.toLowerCase() === lower)) {
    return { added: false, reason: 'duplicate' };
  }
  store[providerId] = [...current, domain];
  writeOAuthExtras(storage, store);
  return { added: true };
}

export function removeOAuthExtraDomain(
  storage: LocalStorageLike,
  providerId: string,
  domain: string
): { removed: boolean } {
  const store = readOAuthExtras(storage);
  const current = store[providerId] ?? [];
  const lower = domain.toLowerCase();
  const next = current.filter((d) => d.toLowerCase() !== lower);
  if (next.length === current.length) return { removed: false };
  if (next.length === 0) delete store[providerId];
  else store[providerId] = next;
  writeOAuthExtras(storage, store);
  return { removed: true };
}

export function clearOAuthExtras(storage: LocalStorageLike, providerId: string): void {
  const store = readOAuthExtras(storage);
  delete store[providerId];
  writeOAuthExtras(storage, store);
}
