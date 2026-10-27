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

import {
  corruptValueKey,
  type QuarantineStorage,
  replaceStoredValue,
} from './storage-quarantine.js';

export const OAUTH_EXTRA_DOMAINS_KEY = 'slicc_oauth_extra_domains';

export type OAuthExtraDomainsStore = Record<string, string[]>;

export type LocalStorageLike = QuarantineStorage;

/** `null` when `raw` is not a JSON object: a value nothing may overwrite unpreserved (#4146). */
function parseOAuthExtras(raw: string): OAuthExtraDomainsStore | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const out: OAuthExtraDomainsStore = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (!Array.isArray(v)) continue;
    const cleaned = v.filter((d): d is string => typeof d === 'string' && d.length > 0);
    if (cleaned.length > 0) out[k] = cleaned;
  }
  return out;
}

/** `{}` when absent or unparsable; {@link writeOAuthExtras} preserves an unparsable value. */
export function readOAuthExtras(storage: LocalStorageLike): OAuthExtraDomainsStore {
  try {
    const raw = storage.getItem(OAUTH_EXTRA_DOMAINS_KEY);
    if (!raw) return {};
    return parseOAuthExtras(raw) ?? {};
  } catch {
    return {};
  }
}

const CORRUPT_OAUTH_EXTRAS_KEY = corruptValueKey(OAUTH_EXTRA_DOMAINS_KEY);

/**
 * Every writer replaces the whole store from a `readOAuthExtras` baseline,
 * which is `{}` for an unparsable value, so such a value is first copied to
 * `slicc_oauth_extra_domains.corrupt` (#4146). Returns whether it was.
 */
function persistOAuthExtras(storage: LocalStorageLike, store: OAuthExtraDomainsStore): boolean {
  let copied: boolean;
  // setItem throws synchronously on QuotaExceededError. The options-page
  // click handlers call this through addOAuthExtraDomain / remove / clear
  // and rely on the throw being caught by their toast wiring; without an
  // explicit message the toast says nothing useful.
  try {
    copied = replaceStoredValue(
      storage,
      OAUTH_EXTRA_DOMAINS_KEY,
      JSON.stringify(store),
      (raw) => parseOAuthExtras(raw) !== null
    );
  } catch (err) {
    throw new Error(
      `Failed to persist OAuth extras (localStorage quota exceeded?): ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (copied) {
    console.error(
      `[slicc] ${OAUTH_EXTRA_DOMAINS_KEY} was unparsable; copied it to ${CORRUPT_OAUTH_EXTRAS_KEY} before saving`
    );
  }
  return copied;
}

export function writeOAuthExtras(storage: LocalStorageLike, store: OAuthExtraDomainsStore): void {
  persistOAuthExtras(storage, store);
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
  try {
    writeOAuthExtras(storage, store);
  } catch (err) {
    return { added: false, reason: err instanceof Error ? err.message : String(err) };
  }
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

/** Also drops the unreadable copy, which may still list the cleared provider's domains. */
export function clearOAuthExtras(storage: LocalStorageLike, providerId: string): void {
  const store = readOAuthExtras(storage);
  delete store[providerId];
  if (!persistOAuthExtras(storage, store)) storage.removeItem?.(CORRUPT_OAUTH_EXTRAS_KEY);
}
