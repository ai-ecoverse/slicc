const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = '_session.id';

export async function readOrCreateSwSessionId(): Promise<string> {
  const got = (await chrome.storage.local.get(KEY)) as Record<string, string | undefined>;
  const existing = got[KEY];
  if (existing && UUID_RE.test(existing)) return existing;
  const fresh = crypto.randomUUID();
  await chrome.storage.local.set({ [KEY]: fresh });
  return fresh;
}
