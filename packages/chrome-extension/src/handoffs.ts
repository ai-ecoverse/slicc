import type {
  HandoffAcceptMsg,
  HandoffDismissMsg,
  HandoffListRequestMsg,
  HandoffPendingListMsg,
  PendingHandoff,
} from './messages.js';
import { normalizePendingHandoff, parseHandoffFromUrl } from './handoff-shared.js';

const HANDOFFS_STORAGE_KEY = 'slicc.pendingHandoffs';
const DISMISSED_HANDOFFS_KEY = 'slicc.dismissedHandoffIds';

let pendingHandoffMutation: Promise<unknown> = Promise.resolve();

export type HandoffPanelMessage = HandoffListRequestMsg | HandoffAcceptMsg | HandoffDismissMsg;

export function initializeHandoffs(): void {
  void syncHandoffBadge();
  void scanOpenHandoffTabs();
}

export function isHandoffPanelMessage(payload: unknown): payload is HandoffPanelMessage {
  if (typeof payload !== 'object' || payload === null || !('type' in payload)) {
    return false;
  }
  const messageType = (payload as { type?: unknown }).type;
  return (
    messageType === 'handoff-list-request' ||
    messageType === 'handoff-accept' ||
    messageType === 'handoff-dismiss'
  );
}

export function handleCreatedTabHandoff(tab: ChromeTab): void {
  if (tab.url) void queueHandoffFromUrl(tab.url, tab.id);
}

export function handleUpdatedTabHandoff(changeInfo: ChromeTabChangeInfo, tab: ChromeTab): void {
  const url = changeInfo.url ?? tab.url;
  if (url) void queueHandoffFromUrl(url, tab.id);
}

export function handlePanelHandoffMessage(panelPayload: HandoffPanelMessage): void {
  if (panelPayload.type === 'handoff-list-request') {
    void publishPendingHandoffs().catch((err) => {
      console.error('[slicc-sw] Failed to publish pending handoffs:', err);
    });
    return;
  }

  void (async () => {
    try {
      const cleared = await clearPendingHandoff(panelPayload.handoffId);
      await closeHandoffTab(cleared);
    } catch (err) {
      console.error('[slicc-sw] Failed to clear pending handoff:', err);
    }
  })();
}

async function readPendingHandoffs(): Promise<PendingHandoff[]> {
  const stored = await chrome.storage.local.get(HANDOFFS_STORAGE_KEY);
  const raw = stored[HANDOFFS_STORAGE_KEY];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((value) => normalizePendingHandoff(value))
    .filter((value): value is PendingHandoff => value !== null);
}

async function readDismissedIds(): Promise<Set<string>> {
  const stored = await chrome.storage.local.get(DISMISSED_HANDOFFS_KEY);
  const raw = stored[DISMISSED_HANDOFFS_KEY];
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((v): v is string => typeof v === 'string'));
}

async function addDismissedId(handoffId: string): Promise<void> {
  const dismissed = await readDismissedIds();
  dismissed.add(handoffId);
  // Keep only the most recent 200 entries to avoid unbounded growth
  const entries = [...dismissed];
  const trimmed = entries.length > 200 ? entries.slice(entries.length - 200) : entries;
  await chrome.storage.local.set({ [DISMISSED_HANDOFFS_KEY]: trimmed });
}

async function sendHandoffMessage(payload: HandoffPendingListMsg): Promise<void> {
  await chrome.runtime.sendMessage({
    source: 'service-worker',
    payload,
  });
}

async function syncHandoffBadge(handoffs?: PendingHandoff[]): Promise<void> {
  const list = handoffs ?? (await readPendingHandoffs());
  const count = list.length;
  await chrome.action.setBadgeBackgroundColor({ color: '#ff5f72' });
  await chrome.action.setBadgeText({ text: count > 0 ? (count > 99 ? '99+' : String(count)) : '' });
}

async function publishPendingHandoffs(handoffs?: PendingHandoff[]): Promise<void> {
  const list = handoffs ?? (await readPendingHandoffs());
  await syncHandoffBadge(list);
  await sendHandoffMessage({
    type: 'handoff-pending-list',
    handoffs: list,
  } satisfies HandoffPendingListMsg);
}

async function storePendingHandoffs(handoffs: PendingHandoff[]): Promise<void> {
  await chrome.storage.local.set({ [HANDOFFS_STORAGE_KEY]: handoffs });
  await publishPendingHandoffs(handoffs);
}

function runPendingHandoffMutation<T>(fn: () => Promise<T>): Promise<T> {
  const run = pendingHandoffMutation.then(fn, fn);
  pendingHandoffMutation = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function queueHandoffFromUrl(urlString: string, sourceTabId?: number): Promise<void> {
  const handoff = parseHandoffFromUrl(urlString, sourceTabId);
  if (!handoff) return;

  await runPendingHandoffMutation(async () => {
    // Don't re-queue handoffs that were already accepted or dismissed
    const dismissed = await readDismissedIds();
    if (dismissed.has(handoff.handoffId)) return;

    const current = await readPendingHandoffs();
    if (current.some((item) => item.handoffId === handoff.handoffId)) return;
    await storePendingHandoffs([...current, handoff]);
  });
}

async function clearPendingHandoff(handoffId: string): Promise<PendingHandoff | null> {
  return runPendingHandoffMutation(async () => {
    const current = await readPendingHandoffs();
    const removed = current.find((item) => item.handoffId === handoffId) ?? null;
    const next = current.filter((item) => item.handoffId !== handoffId);
    if (!removed) {
      await publishPendingHandoffs(current);
      return null;
    }
    // Remember this ID so scanOpenHandoffTabs won't re-queue it
    await addDismissedId(handoffId);
    await storePendingHandoffs(next);
    return removed;
  });
}

async function closeHandoffTab(handoff: PendingHandoff | null): Promise<void> {
  if (typeof handoff?.sourceTabId !== 'number') return;
  try {
    await chrome.tabs.remove(handoff.sourceTabId);
  } catch (err) {
    console.info('[slicc-sw] Failed to close handoff tab (best-effort)', {
      handoffId: handoff.handoffId,
      sourceTabId: handoff.sourceTabId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function scanOpenHandoffTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.url) {
      await queueHandoffFromUrl(tab.url, tab.id);
    }
  }
}
