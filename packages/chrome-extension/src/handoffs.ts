import type {
  GenericHandoffPayload,
  HandoffAcceptMsg,
  HandoffDismissMsg,
  HandoffListRequestMsg,
  HandoffPendingListMsg,
  PendingHandoff,
} from './messages.js';

const HANDOFFS_HOST = 'www.sliccy.ai';
const HANDOFFS_PATH = '/handoff';
const HANDOFFS_STORAGE_KEY = 'slicc.pendingHandoffs';

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

function hashFragment(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function decodeBase64UrlUtf8(fragment: string): string {
  const normalized = fragment.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4;
  const padded = padding === 0 ? normalized : normalized + '='.repeat(4 - padding);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function normalizeHandoffPayload(value: unknown): GenericHandoffPayload | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record['instruction'] !== 'string' || !record['instruction'].trim()) return null;
  if (record['title'] !== undefined && typeof record['title'] !== 'string') return null;
  if (record['context'] !== undefined && typeof record['context'] !== 'string') return null;
  if (record['notes'] !== undefined && typeof record['notes'] !== 'string') return null;
  if (record['urls'] !== undefined && !isStringArray(record['urls'])) return null;
  if (record['acceptanceCriteria'] !== undefined && !isStringArray(record['acceptanceCriteria'])) {
    return null;
  }

  return {
    title: typeof record['title'] === 'string' ? record['title'] : undefined,
    instruction: record['instruction'].trim(),
    urls: isStringArray(record['urls']) ? record['urls'] : undefined,
    context: typeof record['context'] === 'string' ? record['context'] : undefined,
    acceptanceCriteria: isStringArray(record['acceptanceCriteria'])
      ? record['acceptanceCriteria']
      : undefined,
    notes: typeof record['notes'] === 'string' ? record['notes'] : undefined,
  };
}

function normalizePendingHandoff(value: unknown): PendingHandoff | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const payload = normalizeHandoffPayload(record['payload']);
  if (!payload) return null;
  if (typeof record['handoffId'] !== 'string' || !record['handoffId']) return null;
  if (typeof record['sourceUrl'] !== 'string' || !record['sourceUrl']) return null;
  if (typeof record['receivedAt'] !== 'string' || !record['receivedAt']) return null;
  if (record['sourceTabId'] !== undefined && typeof record['sourceTabId'] !== 'number') {
    return null;
  }
  return {
    handoffId: record['handoffId'],
    sourceUrl: record['sourceUrl'],
    sourceTabId: typeof record['sourceTabId'] === 'number' ? record['sourceTabId'] : undefined,
    payload,
    receivedAt: record['receivedAt'],
  };
}

function isAllowedHandoffUrl(parsedUrl: URL): boolean {
  if (parsedUrl.pathname !== HANDOFFS_PATH) return false;
  return parsedUrl.protocol === 'https:' && parsedUrl.hostname === HANDOFFS_HOST;
}

function parseHandoffFromUrl(urlString: string, sourceTabId?: number): PendingHandoff | null {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlString);
  } catch {
    return null;
  }

  if (!isAllowedHandoffUrl(parsedUrl)) {
    return null;
  }

  const fragment = parsedUrl.hash.replace(/^#/, '');
  if (!fragment) return null;

  try {
    const json = decodeBase64UrlUtf8(fragment);
    const payload = normalizeHandoffPayload(JSON.parse(json));
    if (!payload) return null;
    return {
      handoffId: `handoff-${hashFragment(fragment)}`,
      sourceUrl: parsedUrl.toString(),
      sourceTabId,
      payload,
      receivedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

async function readPendingHandoffs(): Promise<PendingHandoff[]> {
  const stored = await chrome.storage.local.get(HANDOFFS_STORAGE_KEY);
  const raw = stored[HANDOFFS_STORAGE_KEY];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((value) => normalizePendingHandoff(value))
    .filter((value): value is PendingHandoff => value !== null);
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
