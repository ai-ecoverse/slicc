import type { RegisteredScoop } from './types.js';

const DAILY_UUID_KEY_PREFIX = 'slicc:adobe-daily-uuid:';

const inMemoryFallback = new Map<string, { uuid: string; date: string }>();

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function safeLocalStorage(): Storage | null {
  try {
    const storage = globalThis.localStorage;
    if (
      !storage ||
      typeof storage.getItem !== 'function' ||
      typeof storage.setItem !== 'function'
    ) {
      return null;
    }
    return storage;
  } catch {
    return null;
  }
}

export function getDailyAdobeUuid(anchor: string): string {
  const today = todayUtc();
  const storage = safeLocalStorage();
  const key = DAILY_UUID_KEY_PREFIX + anchor;

  if (storage) {
    let raw: string | null = null;
    try {
      raw = storage.getItem(key);
    } catch {
      raw = null;
    }
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { uuid?: string; date?: string };
        if (parsed.date === today && typeof parsed.uuid === 'string') return parsed.uuid;
      } catch {}
    }
    const uuid = crypto.randomUUID();
    try {
      storage.setItem(key, JSON.stringify({ uuid, date: today }));
    } catch {}
    return uuid;
  }

  const cached = inMemoryFallback.get(anchor);
  if (cached && cached.date === today) return cached.uuid;
  const uuid = crypto.randomUUID();
  inMemoryFallback.set(anchor, { uuid, date: today });
  return uuid;
}

async function hashFolder(folder: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}:${folder}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function getAdobeSessionId(
  scoop: RegisteredScoop,
  coneJid: string | undefined
): Promise<string> {
  const anchor = coneJid ?? scoop.jid;
  const uuid = getDailyAdobeUuid(anchor);
  if (scoop.parentJid === null) return uuid;
  const folderHash = await hashFolder(scoop.folder, uuid);
  return `${uuid}/${folderHash}`;
}

export function __resetAdobeSessionIdCacheForTests(): void {
  inMemoryFallback.clear();
}
