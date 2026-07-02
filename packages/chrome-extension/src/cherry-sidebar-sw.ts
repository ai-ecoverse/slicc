/**
 * Cherry sidebar on-demand toggle helpers (Wave 3b thin-extension).
 *
 * Factored into testable pure/injectable functions so unit tests can drive
 * them without a live service worker. Imported by service-worker.ts.
 *
 * On toolbar-icon click → inject relay(ISOLATED) + main(MAIN) + mount();
 * on second click → teardown + untrack; on page reload → re-inject if tracked;
 * on tab-remove/close-button → untrack. Generation counters debounce concurrent
 * toggle/reload events so a rapid second-click cannot orphan a sidebar.
 */

/// <reference path="./chrome.d.ts" />

import type { SwToRelayMessage } from './cherry-relay-protocol.js';

const ACTIVATED_TABS_KEY = 'slicc_cherry_tabs';

export async function readActivatedTabs(): Promise<Set<number>> {
  const r = await chrome.storage.session.get(ACTIVATED_TABS_KEY);
  return new Set<number>((r?.[ACTIVATED_TABS_KEY] as number[] | undefined) ?? []);
}

export async function writeActivatedTabs(tabs: Set<number>): Promise<void> {
  await chrome.storage.session.set({ [ACTIVATED_TABS_KEY]: [...tabs] });
}

/**
 * A per-tab generation counter. Each track/untrack/reload bumps the tab's
 * generation; an in-flight injection that discovers a newer generation aborts
 * before mount() so a rapid untrack (2nd click) cannot leave an orphan sidebar.
 */
const tabGeneration = new Map<number, number>();

export function bumpGeneration(tabId: number): number {
  const next = (tabGeneration.get(tabId) ?? 0) + 1;
  tabGeneration.set(tabId, next);
  return next;
}

/** Relay Port registry keyed by sender tab id. */
// `ChromeRuntimePort` is a global ambient type (chrome.d.ts is a global script,
// no import needed).
const relayPorts = new Map<number, ChromeRuntimePort>();

/** Cached leader tray join URL, or null when the leader drops its tray. */
let cachedLeaderJoinUrl: string | null = null;

/**
 * Chrome forbids injection into chrome://, both Web Store hosts, view-source, etc.
 * Also refuse the leader tab (the leader is the UI host, not a cherry surface) —
 * `isLeaderUrl` wraps the SW's existing `isLeaderTabUrl` so a restored/unpinned
 * leader (whose stored id may have changed) is still rejected by URL.
 */
export function canInjectInto(
  url: string | undefined,
  isLeaderUrl: (u: string) => boolean
): boolean {
  if (!url) return false;
  if (!/^https?:\/\//.test(url)) return false;
  if (
    url.startsWith('https://chrome.google.com/webstore') ||
    url.startsWith('https://chromewebstore.google.com/')
  ) {
    return false;
  }
  return !isLeaderUrl(url);
}

/**
 * Inject relay-isolated.js(ISOLATED) → cherry-sidebar-main.js(MAIN) → mount().
 * Checks `stillCurrent()` between each step; aborts if generation changed (rapid
 * untrack mid-inject). Post-mount stale check: a teardown can race in AFTER the
 * last stillCurrent() but BEFORE MAIN mounted, so we re-check and unmount() if stale.
 */
export async function injectCherry(tabId: number, generation: number): Promise<void> {
  const stillCurrent = () => tabGeneration.get(tabId) === generation;

  // biome-ignore lint/suspicious/noExplicitAny: chrome namespace not available in helper module
  await (chrome as any).scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    files: ['relay-isolated.js'],
  });
  if (!stillCurrent()) return; // untracked mid-inject → abort before mounting

  // biome-ignore lint/suspicious/noExplicitAny: chrome namespace not available in helper module
  await (chrome as any).scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    files: ['cherry-sidebar-main.js'],
  });
  if (!stillCurrent()) return;

  // biome-ignore lint/suspicious/noExplicitAny: chrome namespace not available in helper module
  await (chrome as any).scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () =>
      (globalThis as { __sliccCherrySidebar?: { mount(): void } }).__sliccCherrySidebar?.mount(),
  });

  // Post-mount stale check. A teardown (2nd click) can race in AFTER the last
  // stillCurrent() check but BEFORE MAIN mounted + started listening, so the
  // relay teardown event is lost and mount() runs anyway → orphan sidebar. Now
  // that MAIN is mounted, re-check and unmount directly if we're stale.
  if (!stillCurrent()) {
    // biome-ignore lint/suspicious/noExplicitAny: chrome namespace not available in helper module
    await (chrome as any).scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () =>
        (
          globalThis as { __sliccCherrySidebar?: { unmount(): void } }
        ).__sliccCherrySidebar?.unmount(),
    });
  }
}

/**
 * Send {kind:'teardown'} to the tab's relay Port; wrap postMessage in try/catch
 * (the Port may be mid-disconnect on the MAIN-close path). No-op if no registered Port.
 */
export function postTeardown(tabId: number): void {
  const port = relayPorts.get(tabId);
  if (!port) return;
  try {
    port.postMessage({ kind: 'teardown' } satisfies SwToRelayMessage);
  } catch {
    // Port may already be disconnecting; best-effort.
  }
}

/**
 * Toggle a tab's cherry sidebar. If tracked → untrack + teardown; else → track +
 * inject. On failure, roll back the tracked-set ONLY if still the current generation
 * (stale rejected inject must NOT untrack a newer mount).
 */
export async function toggleCherryTab(
  tabId: number,
  ensureLeader: () => Promise<void>
): Promise<void> {
  const activated = await readActivatedTabs();
  if (activated.has(tabId)) {
    // Already tracked → untoggle
    activated.delete(tabId);
    await writeActivatedTabs(activated);
    bumpGeneration(tabId);
    postTeardown(tabId);
  } else {
    // Untracked → track + inject
    activated.add(tabId);
    await writeActivatedTabs(activated);
    await ensureLeader(); // create-if-missing, no focus
    const gen = bumpGeneration(tabId);
    try {
      await injectCherry(tabId, gen);
    } catch (err) {
      // Injection failure (restricted page, tab closed, etc.) → roll back ONLY
      // if still the current generation. A stale rejected inject (superseded by
      // a newer generation that already mounted) must NOT untrack the newer mount.
      if (tabGeneration.get(tabId) === gen) {
        const current = await readActivatedTabs();
        current.delete(tabId);
        await writeActivatedTabs(current);
      }
      throw err;
    }
  }
}

/**
 * Handle a relay Port onConnect event. Registers the Port, sends the cached
 * leader join-url, and wires onMessage/onDisconnect handlers.
 */
export async function handleCherryRelayConnect(
  port: ChromeRuntimePort,
  untrackTab: (tabId: number) => Promise<void>
): Promise<void> {
  const tabId = port.sender?.tab?.id;
  if (typeof tabId !== 'number') return;

  // Register (replace any prior Port for this tab)
  relayPorts.set(tabId, port);

  // Send the cached join-url (or null if leader has no tray)
  try {
    port.postMessage({ kind: 'join-url', joinUrl: cachedLeaderJoinUrl } satisfies SwToRelayMessage);
  } catch {
    // Port may have disconnected immediately; best-effort.
  }

  port.onMessage.addListener((msg: unknown) => {
    if (typeof msg !== 'object' || msg === null) return;
    if ((msg as { kind?: unknown }).kind !== 'close') return;
    // User clicked close-button in the sidebar → untrack this tab. Non-async
    // listener + explicit .catch (the codebase pattern): a swallowed untrack
    // failure would leave the tab tracked and the sidebar would reappear on
    // reload, so surface it.
    bumpGeneration(tabId);
    untrackTab(tabId).catch((err) => {
      console.error('[slicc-sw] failed to untrack tab on cherry close', { tabId, err });
    });
  });

  port.onDisconnect.addListener(() => {
    // Identity-guarded deregister: the relay disconnects its old Port before
    // reconnecting, so an old Port's onDisconnect can fire AFTER the new Port
    // has registered. Only deregister if this is still the live Port.
    if (relayPorts.get(tabId) === port) {
      relayPorts.delete(tabId);
    }
    // Do NOT untrack here (disconnect ≠ close — the tab may just have navigated
    // and will re-inject on onUpdated).
  });
}

/**
 * Cache the leader's tray join URL and push it to all registered relay Ports.
 * Only caches when `tabId === storedLeaderTabId` (non-leader tabs are ignored).
 */
export async function onLeaderJoinUrl(
  joinUrl: string | null,
  tabId: number | undefined,
  readStoredLeaderTabId: () => Promise<number | undefined>
): Promise<void> {
  const storedId = await readStoredLeaderTabId();
  if (tabId !== storedId) return; // non-leader tab → ignore
  cachedLeaderJoinUrl = joinUrl;
  const msg: SwToRelayMessage = { kind: 'join-url', joinUrl };
  for (const port of relayPorts.values()) {
    try {
      port.postMessage(msg);
    } catch {
      // Port disconnected; will be cleaned up by onDisconnect.
    }
  }
}

/**
 * Handle tabs.onUpdated (status=complete): re-inject if the tab is tracked AND
 * injectable. The generation bump debounces rapid reloads (each complete supersedes
 * the prior in-flight inject).
 */
export async function handleTabUpdated(
  tabId: number,
  url: string | undefined,
  isLeaderUrl: (u: string) => boolean
): Promise<void> {
  const activated = await readActivatedTabs();
  if (!activated.has(tabId)) return; // untracked → no-op
  if (!canInjectInto(url, isLeaderUrl)) return; // restricted URL → no-op
  const gen = bumpGeneration(tabId);
  try {
    await injectCherry(tabId, gen);
  } catch {
    // Injection failed → untrack if still the current generation
    if (tabGeneration.get(tabId) === gen) {
      activated.delete(tabId);
      await writeActivatedTabs(activated);
    }
  }
}

/**
 * Handle tabs.onRemoved: bump generation (cancels any in-flight inject), untrack,
 * drop the relay Port.
 */
export async function handleTabRemoved(tabId: number): Promise<void> {
  bumpGeneration(tabId);
  const activated = await readActivatedTabs();
  activated.delete(tabId);
  await writeActivatedTabs(activated);
  relayPorts.delete(tabId);
}
