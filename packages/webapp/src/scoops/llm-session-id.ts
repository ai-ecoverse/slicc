/**
 * Adobe provider session ID.
 *
 * Generates a privacy-safe identifier for the Adobe LLM proxy `X-Session-Id`
 * header so Adobe can group related requests (cone + its scoops) for usage
 * monitoring without learning anything that could deanonymize the user:
 *
 * - The cone's identifier is a `crypto.randomUUID()` generated per cone and
 *   rotated every calendar day (UTC). This avoids any millisecond-timestamp
 *   correlation against the provider's own request logs.
 * - A scoop's identifier is `{uuid}/{hash(folder, uuid)}` — the hash preserves
 *   the cone→scoop grouping while salting the scoop folder so the original
 *   name never leaves the browser.
 *
 * The daily UUID is cached in `localStorage`; if storage is unavailable the
 * function falls back to an in-memory per-process UUID (still rotates per
 * launch which is strictly more private than persisting).
 */

import type { RegisteredScoop } from './types.js';

const DAILY_UUID_KEY_PREFIX = 'slicc:adobe-daily-uuid:';

const inMemoryFallback = new Map<string, { uuid: string; date: string }>();

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function safeLocalStorage(): Storage | null {
  try {
    const ls = globalThis.localStorage as Storage | undefined;
    // Node 24+ exposes an experimental `globalThis.localStorage = {}`
    // shim that's truthy but lacks `getItem` / `setItem`. Feature-test
    // before returning so the truthy guard at the call site doesn't
    // attempt to invoke methods that don't exist.
    if (ls && typeof ls.getItem === 'function' && typeof ls.setItem === 'function') {
      return ls;
    }
    return null;
  } catch {
    return null;
  }
}

function getDailyUuid(coneJid: string): string {
  const today = todayUtc();
  const storage = safeLocalStorage();
  const key = DAILY_UUID_KEY_PREFIX + coneJid;

  if (storage) {
    const raw = storage.getItem(key);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { uuid?: string; date?: string };
        if (parsed.date === today && typeof parsed.uuid === 'string') return parsed.uuid;
      } catch {
        // fall through to regenerate
      }
    }
    const uuid = crypto.randomUUID();
    try {
      storage.setItem(key, JSON.stringify({ uuid, date: today }));
    } catch {
      // quota/permission error — UUID is still returned for this call
    }
    return uuid;
  }

  const cached = inMemoryFallback.get(coneJid);
  if (cached && cached.date === today) return cached.uuid;
  const uuid = crypto.randomUUID();
  inMemoryFallback.set(coneJid, { uuid, date: today });
  return uuid;
}

async function hashFolder(folder: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}:${folder}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Build the Adobe `X-Session-Id` value for this scoop.
 *
 * @param scoop  - The scoop the identifier belongs to.
 * @param coneJid - The owning cone's JID (used only as the localStorage key
 *   and as hash salt; never leaves the browser).
 */
export async function getAdobeSessionId(
  scoop: RegisteredScoop,
  coneJid: string | undefined
): Promise<string> {
  const anchor = coneJid ?? scoop.jid;
  const uuid = getDailyUuid(anchor);
  if (scoop.isCone) return uuid;
  const folderHash = await hashFolder(scoop.folder, uuid);
  return `${uuid}/${folderHash}`;
}

/** Test-only: clear the in-memory fallback cache. */
export function __resetAdobeSessionIdCacheForTests(): void {
  inMemoryFallback.clear();
}
