import { isProtectedUrl } from './protected-origins.js';

const STORAGE_KEY = 'slicc_protected_frame_tabs';

let chain: Promise<unknown> = Promise.resolve();

async function readTabs(): Promise<Set<number>> {
  const got = await chrome.storage.session.get(STORAGE_KEY);
  const raw = got[STORAGE_KEY];
  return new Set(Array.isArray(raw) ? raw.filter((v): v is number => typeof v === 'number') : []);
}

function update(mutate: (tabs: Set<number>) => boolean): Promise<void> {
  const next = chain.then(async () => {
    const tabs = await readTabs();
    if (mutate(tabs)) await chrome.storage.session.set({ [STORAGE_KEY]: [...tabs] });
  });
  chain = next.catch(() => {});
  return next;
}

export async function tabHasProtectedFrame(tabId: number): Promise<boolean> {
  await chain;
  try {
    return (await readTabs()).has(tabId);
  } catch {
    return true;
  }
}

export function noteFrameResponse(details: {
  tabId: number;
  type: string;
  url: string;
}): Promise<void> {
  const { tabId, type, url } = details;
  if (tabId < 0) return Promise.resolve();
  if (type === 'main_frame') return update((tabs) => tabs.delete(tabId));
  if (type === 'sub_frame' && isProtectedUrl(url)) {
    return update((tabs) => {
      if (tabs.has(tabId)) return false;
      tabs.add(tabId);
      return true;
    });
  }
  return Promise.resolve();
}

export function installProtectedFrameTracker(): void {
  chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
      noteFrameResponse(details).catch(() => {});
    },
    { urls: ['<all_urls>'], types: ['main_frame', 'sub_frame'] }
  );
  chrome.tabs.onRemoved.addListener((tabId) => {
    update((tabs) => tabs.delete(tabId)).catch(() => {});
  });
}
