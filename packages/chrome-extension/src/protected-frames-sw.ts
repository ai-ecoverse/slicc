/**
 * B24-4: remember which tabs hold a protected (seven / vault) sub-frame.
 *
 * A cross-site iframe is an out-of-process frame: chrome.debugger's tab
 * session cannot see it (`Page.getFrameTree` omits it, `Target.getTargets` is
 * not allowed), yet a screenshot captures it and synthetic input lands in it.
 * The shield's Fetch block stops NEW protected frames once a tab is attached;
 * this tracker covers frames that loaded BEFORE attach, using the
 * `webRequest` permission the SW already holds: a protected `sub_frame`
 * response marks the tab, the tab's next main-frame response or its removal
 * clears it. The set lives in `chrome.storage.session` so it survives MV3
 * worker eviction. Fail-closed: a marked tab stays unattachable until it
 * navigates its main frame, even if the iframe was removed meanwhile.
 */

import { isProtectedUrl } from './protected-origins.js';

const STORAGE_KEY = 'slicc_protected_frame_tabs';

/** Serializes read-modify-write cycles on the session-storage set. */
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

/** True when `tabId` loaded a protected sub-frame since its last main-frame navigation. */
export async function tabHasProtectedFrame(tabId: number): Promise<boolean> {
  await chain;
  try {
    return (await readTabs()).has(tabId);
  } catch {
    return true; // storage unreadable → fail closed
  }
}

/** Record one frame response (exported for tests; the listener calls it). */
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
