# Extension detached popout — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Pop out" affordance to the SLICC Chrome extension side panel that opens the same agent state in a full-page tab using the standalone split-pane layout, with global mutual exclusion enforced by the service worker.

**Architecture:** New URL-flagged runtime mode `extension-detached` reuses the offscreen agent. Service worker coordinates a single detached tab globally via `chrome.storage.session`, with three layers of mutual exclusion (window close, UI overlay, send-path lock check in `OffscreenClient.send()`). Boot reconciliation replaces the unconditional top-level `setPanelBehavior` call to survive MV3 SW eviction.

**Tech Stack:** TypeScript, vitest, Chrome MV3 extension APIs (`chrome.sidePanel`, `chrome.action.onClicked`, `chrome.tabs`, `chrome.windows`, `chrome.storage.session`, `chrome.runtime.onStartup` / `onInstalled`).

**Spec:** `docs/superpowers/specs/2026-05-13-extension-detached-popout-design.md`

---

## File Structure

**New files:**

- `packages/chrome-extension/tests/service-worker-detached.test.ts` — unit tests for the new SW state machine, claim handler, action.onClicked, tabs.onRemoved, and boot reconciliation.

**Modified files:**

- `packages/chrome-extension/src/chrome.d.ts` — type surface additions.
- `packages/chrome-extension/src/messages.ts` — three new payload interfaces, payload-union extensions.
- `packages/chrome-extension/src/service-worker.ts` — replace top-level setPanelBehavior call with reconciler; add detached state machine and handlers.
- `packages/webapp/src/ui/runtime-mode.ts` — add `'extension-detached'` mode + query constants.
- `packages/webapp/src/ui/main.ts` — dispatcher branch + `mainExtension` signature change + listener wiring.
- `packages/webapp/src/ui/layout.ts` — `setShowPopoutButton`, `showDetachedActiveOverlay`, update file-header diagram.
- `packages/webapp/src/ui/offscreen-client.ts` — `locked` field + `setLocked` + lock check in `send()`.
- `packages/webapp/tests/ui/runtime-mode.test.ts` — extend with detached-mode tests.
- `packages/webapp/tests/ui/offscreen-client.test.ts` — extend with send-path lock test.

**Documentation files:**

- `packages/chrome-extension/CLAUDE.md`, `packages/webapp/CLAUDE.md`, `docs/architecture.md`, `docs/pitfalls.md`, `docs/testing.md`, root `CLAUDE.md`, `README.md`.

---

## Task 1: Add `chrome.d.ts` type surface additions

**Files:**

- Modify: `packages/chrome-extension/src/chrome.d.ts`

The current `chrome.d.ts` is intentionally minimal. Detached mode needs new fields and methods. Add them mechanically — no behavioral change.

- [ ] **Step 1: Read the file to understand its current shape**

Run: `cat packages/chrome-extension/src/chrome.d.ts | head -200`

Take note of `ChromeMessageSender`, `ChromeTab`, `ChromeAPI.sidePanel`, `ChromeAPI.tabs`, `ChromeAPI.windows`, `ChromeAPI.action`, `ChromeAPI.storage`, `ChromeAPI.runtime`.

- [ ] **Step 2: Add `url?: string` to `ChromeMessageSender`**

Find the interface:

```ts
interface ChromeMessageSender {
  id?: string;
  tab?: ChromeTab;
}
```

Replace with:

```ts
interface ChromeMessageSender {
  id?: string;
  tab?: ChromeTab;
  url?: string;
}
```

- [ ] **Step 3: Add `windowId?: number` to `ChromeTab`**

Find:

```ts
interface ChromeTab {
  id: number;
  title?: string;
  url?: string;
}
```

Replace with:

```ts
interface ChromeTab {
  id: number;
  title?: string;
  url?: string;
  windowId?: number;
}
```

- [ ] **Step 4: Extend `sidePanel` with `setOptions`, `open`, `close`**

Find:

```ts
sidePanel: {
  setPanelBehavior(options: { openPanelOnActionClick: boolean }): Promise<void>;
};
```

Replace with:

```ts
sidePanel: {
  setPanelBehavior(options: { openPanelOnActionClick: boolean }): Promise<void>;
  setOptions(options: { tabId?: number; path?: string; enabled?: boolean }): Promise<void>;
  open(options: { tabId?: number; windowId?: number }): Promise<void>;
  close(options: { tabId?: number; windowId?: number }): Promise<void>;
};
```

- [ ] **Step 5: Extend `action` with `onClicked`**

Find:

```ts
interface ChromeActionAPI {
  setBadgeText(details: { text: string }): Promise<void>;
  setBadgeBackgroundColor(details: { color: string }): Promise<void>;
}
```

Replace with:

```ts
interface ChromeActionAPI {
  setBadgeText(details: { text: string }): Promise<void>;
  setBadgeBackgroundColor(details: { color: string }): Promise<void>;
  onClicked: {
    addListener(callback: (tab: ChromeTab) => void): void;
  };
}
```

- [ ] **Step 6: Extend `tabs` with `onRemoved` and `update`**

Find the `tabs:` block. Locate:

```ts
tabs: {
  query(queryInfo: Record<string, unknown>): Promise<ChromeTab[]>;
  get(tabId: number): Promise<ChromeTab>;
  create(properties: { url?: string; active?: boolean }): Promise<{ id: number }>;
  remove(tabId: number): Promise<void>;
  group(options: { tabIds: number | number[]; groupId?: number }): Promise<number>;
  onCreated: {
    addListener(callback: (tab: ChromeTab) => void): void;
  };
  onUpdated: {
    addListener(
      callback: (tabId: number, changeInfo: ChromeTabChangeInfo, tab: ChromeTab) => void
    ): void;
  };
};
```

Replace with:

```ts
tabs: {
  query(queryInfo: Record<string, unknown>): Promise<ChromeTab[]>;
  get(tabId: number): Promise<ChromeTab>;
  create(properties: { url?: string; active?: boolean }): Promise<{ id: number }>;
  update(tabId: number, properties: { active?: boolean }): Promise<ChromeTab>;
  remove(tabId: number): Promise<void>;
  group(options: { tabIds: number | number[]; groupId?: number }): Promise<number>;
  onCreated: {
    addListener(callback: (tab: ChromeTab) => void): void;
  };
  onUpdated: {
    addListener(
      callback: (tabId: number, changeInfo: ChromeTabChangeInfo, tab: ChromeTab) => void
    ): void;
  };
  onRemoved: {
    addListener(
      callback: (tabId: number, removeInfo: { windowId: number; isWindowClosing: boolean }) => void
    ): void;
  };
};
```

- [ ] **Step 7: Extend `windows` with `update` and `getAll`**

Find:

```ts
windows: {
  create(options: {
    url?: string;
    type?: string;
    width?: number;
    height?: number;
    focused?: boolean;
  }): Promise<{ id?: number }>;
  remove(windowId: number): Promise<void>;
};
```

Replace with:

```ts
windows: {
  create(options: {
    url?: string;
    type?: string;
    width?: number;
    height?: number;
    focused?: boolean;
  }): Promise<{ id?: number }>;
  update(windowId: number, properties: { focused?: boolean }): Promise<{ id?: number }>;
  remove(windowId: number): Promise<void>;
  getAll(): Promise<Array<{ id: number }>>;
};
```

- [ ] **Step 8: Add `storage.session`**

Find:

```ts
storage: {
  local: ChromeStorageArea;
}
```

Replace with:

```ts
storage: {
  local: ChromeStorageArea;
  session: ChromeStorageArea;
}
```

- [ ] **Step 9: Extend `runtime` with `onStartup` and full `onInstalled`**

Find:

```ts
onInstalled?: {
  addListener?(callback: () => void): void;
};
```

Replace with:

```ts
onInstalled: {
  addListener(callback: () => void): void;
};
onStartup: {
  addListener(callback: () => void): void;
};
```

- [ ] **Step 10: Verify typecheck still passes**

Run: `npm run typecheck`
Expected: PASS (only type surface additions; no consumers reference these yet, so nothing should break).

- [ ] **Step 11: Commit**

```bash
git add packages/chrome-extension/src/chrome.d.ts
git commit -m "$(cat <<'EOF'
chore(types): extend chrome.d.ts for detached popout

Add the chrome.* surface needed by the upcoming detached popout flow:
sidePanel.setOptions/open/close, action.onClicked, tabs.onRemoved/update,
windows.update/getAll, storage.session, runtime.onStartup, and the
sender.url + tab.windowId fields used by the SW handlers.

No behavior change.
EOF
)"
```

---

## Task 2: Add new payload interfaces in `messages.ts`

**Files:**

- Modify: `packages/chrome-extension/src/messages.ts`

Three new envelope payload types feeding into the existing `PanelEnvelope` and `ServiceWorkerEnvelope` unions.

- [ ] **Step 1: Locate the message interface section and existing unions**

Run: `grep -n "^export interface\|^export type\|PanelToOffscreenMessage\|ServiceWorkerEnvelope" packages/chrome-extension/src/messages.ts | head -30`

This shows where existing per-message interfaces are declared and where the union types live (around lines 184, 534, 539).

- [ ] **Step 2: Add the three named payload interfaces**

Add the following three interfaces in the message-interface section (placed grouped together, e.g., after the last existing per-message interface but before the union type declarations):

```ts
// Detached popout messages — panel ↔ SW coordination.
// See docs/superpowers/specs/2026-05-13-extension-detached-popout-design.md.

export interface DetachedPopoutRequestMsg {
  type: 'detached-popout-request';
}

export interface DetachedClaimMsg {
  type: 'detached-claim';
}

export interface DetachedActiveMsg {
  type: 'detached-active';
}
```

- [ ] **Step 3: Extend the `PanelToOffscreenMessage` union**

Find the `PanelToOffscreenMessage` union (around line 184) and add the two panel→SW types to it. For example, if the union currently ends with:

```ts
export type PanelToOffscreenMessage =
  | UserMessageMsg
  | /* ...existing variants... */
  | TerminalControlMsg;
```

Add `| DetachedPopoutRequestMsg | DetachedClaimMsg` at the end:

```ts
export type PanelToOffscreenMessage =
  | UserMessageMsg
  | /* ...existing variants... */
  | TerminalControlMsg
  | DetachedPopoutRequestMsg
  | DetachedClaimMsg;
```

Note: read the actual ending of the union before editing — the trailing entry may differ. Preserve the order.

- [ ] **Step 4: Extend the `ServiceWorkerEnvelope.payload` union**

Find:

```ts
export interface ServiceWorkerEnvelope {
  source: 'service-worker';
  payload: CdpProxyMessage | TraySocketEventMessage | OAuthResultMsg | NavigateLickMsg;
}
```

Replace with:

```ts
export interface ServiceWorkerEnvelope {
  source: 'service-worker';
  payload:
    | CdpProxyMessage
    | TraySocketEventMessage
    | OAuthResultMsg
    | NavigateLickMsg
    | DetachedActiveMsg;
}
```

- [ ] **Step 5: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS.

Note on exhaustiveness: `OffscreenBridge.handlePanelMessage` at `packages/chrome-extension/src/offscreen-bridge.ts:745` has a `switch (msg.type)` over `PanelToOffscreenMessage` WITHOUT a `default:` clause. Adding `DetachedPopoutRequestMsg | DetachedClaimMsg` to the union is therefore safe — unknown payload types silently fall through. If a future maintainer adds `default: throw assertNever(...)` for exhaustiveness, an explicit `case 'detached-popout-request': case 'detached-claim': return;` no-op pair must be added to preserve detached mode. The spec asserts this dependency explicitly.

- [ ] **Step 6: Commit**

```bash
git add packages/chrome-extension/src/messages.ts
git commit -m "$(cat <<'EOF'
chore(types): add detached popout message envelopes

Add DetachedPopoutRequestMsg, DetachedClaimMsg, DetachedActiveMsg
interfaces and extend PanelToOffscreenMessage and
ServiceWorkerEnvelope.payload unions to include them. No handler
wiring yet; that lands in subsequent tasks.

Safe addition: handlePanelMessage in offscreen-bridge.ts has no
default-throw, so detached payloads silently fall through (as the
spec asserts).
EOF
)"
```

---

## Task 3: Extend `runtime-mode.ts` with the detached mode

**Files:**

- Modify: `packages/webapp/src/ui/runtime-mode.ts`
- Modify: `packages/webapp/tests/ui/runtime-mode.test.ts`

TDD: write the failing test first.

- [ ] **Step 1: Add failing tests for the new mode**

In `packages/webapp/tests/ui/runtime-mode.test.ts`, find the existing `it('prefers extension mode when chrome runtime is present', ...)` test (around line 16). Add these new tests in the same `describe('runtime-mode', ...)` block:

```ts
it('returns extension-detached when isExtension and ?detached=1 is set', () => {
  expect(resolveUiRuntimeMode('chrome-extension://abc/index.html?detached=1', true)).toBe(
    'extension-detached'
  );
});

it('returns extension when isExtension and ?detached is missing or wrong value', () => {
  expect(resolveUiRuntimeMode('chrome-extension://abc/index.html', true)).toBe('extension');
  expect(resolveUiRuntimeMode('chrome-extension://abc/index.html?detached=0', true)).toBe(
    'extension'
  );
  expect(resolveUiRuntimeMode('chrome-extension://abc/index.html?other=1', true)).toBe('extension');
});

it('ignores ?detached=1 when not an extension context', () => {
  // ?detached=1 alone (no isExtension) must not flip standalone to detached.
  expect(resolveUiRuntimeMode('http://localhost:5710/?detached=1', false)).toBe('standalone');
});

it('classifies extension-detached the same as extension for tray defaults', () => {
  expect(shouldUseRuntimeModeTrayDefaults('extension-detached', false)).toBe(false);
  expect(shouldUseRuntimeModeTrayDefaults('extension-detached', true)).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/webapp/tests/ui/runtime-mode.test.ts`
Expected: 4 new tests FAIL (the type union doesn't include `'extension-detached'` yet, and `resolveUiRuntimeMode` doesn't check the query param).

- [ ] **Step 3: Extend `UiRuntimeMode` and add the query constants**

In `packages/webapp/src/ui/runtime-mode.ts`, find:

```ts
export type UiRuntimeMode = 'standalone' | 'extension' | 'electron-overlay';
```

Replace with:

```ts
export type UiRuntimeMode = 'standalone' | 'extension' | 'electron-overlay' | 'extension-detached';
```

Add these constants near the existing `ELECTRON_OVERLAY_*` constants:

```ts
export const DETACHED_RUNTIME_QUERY_NAME = 'detached';
export const DETACHED_RUNTIME_QUERY_VALUE = '1';
```

- [ ] **Step 4: Update `resolveUiRuntimeMode`**

Find:

```ts
export function resolveUiRuntimeMode(locationHref: string, isExtension: boolean): UiRuntimeMode {
  if (isExtension) return 'extension';
  try {
    const url = new URL(locationHref);
    return isElectronOverlayUrl(url) ? 'electron-overlay' : 'standalone';
  } catch {
    return 'standalone';
  }
}
```

Replace with:

```ts
export function resolveUiRuntimeMode(locationHref: string, isExtension: boolean): UiRuntimeMode {
  if (isExtension) {
    try {
      const url = new URL(locationHref);
      if (url.searchParams.get(DETACHED_RUNTIME_QUERY_NAME) === DETACHED_RUNTIME_QUERY_VALUE) {
        return 'extension-detached';
      }
    } catch {
      // Fall through to plain 'extension' mode.
    }
    return 'extension';
  }
  try {
    const url = new URL(locationHref);
    return isElectronOverlayUrl(url) ? 'electron-overlay' : 'standalone';
  } catch {
    return 'standalone';
  }
}
```

- [ ] **Step 5: Verify tests pass**

Run: `npx vitest run packages/webapp/tests/ui/runtime-mode.test.ts`
Expected: All tests PASS, including the four new ones. `shouldUseRuntimeModeTrayDefaults` still returns `false` for the new mode by virtue of the existing conditional logic — no change needed to that function.

- [ ] **Step 6: Run typecheck across the workspace**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/webapp/src/ui/runtime-mode.ts packages/webapp/tests/ui/runtime-mode.test.ts
git commit -m "$(cat <<'EOF'
feat(runtime-mode): add extension-detached runtime mode

Introduces 'extension-detached' as a fourth UiRuntimeMode and the
DETACHED_RUNTIME_QUERY_NAME / DETACHED_RUNTIME_QUERY_VALUE constants.
resolveUiRuntimeMode returns 'extension-detached' when running in an
extension context with ?detached=1 in the URL, falling back to
'extension' otherwise. shouldUseRuntimeModeTrayDefaults is
unchanged — the existing conditions correctly classify
extension-detached as no-tray-defaults.
EOF
)"
```

---

## Task 4: Add the SW storage helper and constants

**Files:**

- Modify: `packages/chrome-extension/src/service-worker.ts`

Add the storage key constant and a tiny helper for reading the stored tab ID. This is the foundation that subsequent SW tasks build on.

- [ ] **Step 1: Locate the top of `service-worker.ts`**

Run: `head -50 packages/chrome-extension/src/service-worker.ts`

Find where the existing module-level constants live (e.g., `OFFSCREEN_URL` at around line 49). We will add new constants there.

- [ ] **Step 2: Add storage key and a getter**

Add just below the existing "Side panel behavior" header comment block (the block containing the line we will replace in Task 5), insert these constants and helpers:

```ts
// ---------------------------------------------------------------------------
// Detached popout state
// ---------------------------------------------------------------------------

const DETACHED_TAB_ID_KEY = 'slicc.detached.tabId';

async function readStoredDetachedTabId(): Promise<number | undefined> {
  try {
    const result = await chrome.storage.session.get(DETACHED_TAB_ID_KEY);
    const raw = result[DETACHED_TAB_ID_KEY];
    return typeof raw === 'number' ? raw : undefined;
  } catch (err) {
    console.error('[slicc-sw] storage.session.get failed', err);
    return undefined;
  }
}

async function writeStoredDetachedTabId(tabId: number): Promise<void> {
  await chrome.storage.session.set({ [DETACHED_TAB_ID_KEY]: tabId });
}

async function clearStoredDetachedTabId(): Promise<void> {
  await chrome.storage.session.remove(DETACHED_TAB_ID_KEY);
}
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/chrome-extension/src/service-worker.ts
git commit -m "$(cat <<'EOF'
feat(extension-sw): add detached-tab storage helpers

Introduce DETACHED_TAB_ID_KEY plus read/write/clear helpers backed
by chrome.storage.session. No call sites yet — this is plumbing for
the upcoming claim handler and reconciler.
EOF
)"
```

---

## Task 5: Add the boot reconciler and wire onStartup / onInstalled

**Files:**

- Modify: `packages/chrome-extension/src/service-worker.ts`
- Create: `packages/chrome-extension/tests/service-worker-detached.test.ts`

TDD: write the failing test first. The reconciler is the centerpiece of the lock state machine — every entry point converges on it.

- [ ] **Step 1: Create the new test file with chrome mocks**

Create `packages/chrome-extension/tests/service-worker-detached.test.ts` with the following content:

```ts
/**
 * Tests for the detached popout state machine in service-worker.ts.
 *
 * Focuses on reconcileDetachedLockOnBoot, claim handler,
 * action.onClicked, tabs.onRemoved. The reconciler is the most
 * failure-prone path because of MV3 SW eviction interaction with
 * persistent setOptions vs non-persistent setPanelBehavior.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const sessionStorage = new Map<string, unknown>();
const sidePanelCalls: Array<{ method: string; args: unknown }> = [];
const tabsStore = new Map<number, { id: number; windowId?: number; url?: string }>();
const tabsRemoved: number[] = [];
const windowsStore: Array<{ id: number }> = [];

const onStartupListeners: Array<() => void> = [];
const onInstalledListeners: Array<() => void> = [];
const onMessageListeners: Array<
  (
    msg: unknown,
    sender: { tab?: { id: number }; url?: string },
    sendResponse: (response?: unknown) => void
  ) => void | boolean
> = [];
const actionClickListeners: Array<(tab: { id: number | undefined; windowId?: number }) => void> =
  [];
const tabsRemovedListeners: Array<
  (tabId: number, info: { windowId: number; isWindowClosing: boolean }) => void
> = [];

const mockChrome = {
  storage: {
    session: {
      get: vi.fn(async (key: string) => ({ [key]: sessionStorage.get(key) })),
      set: vi.fn(async (items: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(items)) sessionStorage.set(k, v);
      }),
      remove: vi.fn(async (key: string) => {
        sessionStorage.delete(key);
      }),
    },
    local: {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    },
  },
  sidePanel: {
    setPanelBehavior: vi.fn(async (args: unknown) => {
      sidePanelCalls.push({ method: 'setPanelBehavior', args });
    }),
    setOptions: vi.fn(async (args: unknown) => {
      sidePanelCalls.push({ method: 'setOptions', args });
    }),
    open: vi.fn(async (args: unknown) => {
      sidePanelCalls.push({ method: 'open', args });
    }),
    close: vi.fn(async (args: unknown) => {
      sidePanelCalls.push({ method: 'close', args });
    }),
  },
  tabs: {
    get: vi.fn(async (id: number) => {
      const t = tabsStore.get(id);
      if (!t) throw new Error(`No tab ${id}`);
      return t;
    }),
    create: vi.fn(async ({ url }: { url: string }) => {
      const id = Math.max(0, ...tabsStore.keys()) + 1;
      const tab = { id, url, windowId: 100 };
      tabsStore.set(id, tab);
      return tab;
    }),
    update: vi.fn(async (id: number, _props: unknown) => tabsStore.get(id)),
    remove: vi.fn(async (id: number) => {
      tabsStore.delete(id);
      tabsRemoved.push(id);
    }),
    query: vi.fn(async () => []),
    group: vi.fn(async () => 1),
    onCreated: { addListener: vi.fn() },
    onUpdated: { addListener: vi.fn() },
    onRemoved: {
      addListener: (cb: (typeof tabsRemovedListeners)[number]) => {
        tabsRemovedListeners.push(cb);
      },
    },
  },
  windows: {
    update: vi.fn(async () => ({ id: 100 })),
    getAll: vi.fn(async () => windowsStore.slice()),
  },
  action: {
    setBadgeText: vi.fn(async () => undefined),
    setBadgeBackgroundColor: vi.fn(async () => undefined),
    onClicked: {
      addListener: (cb: (typeof actionClickListeners)[number]) => {
        actionClickListeners.push(cb);
      },
    },
  },
  runtime: {
    id: 'test-ext',
    getURL: (p: string) => `chrome-extension://test/${p}`,
    onStartup: {
      addListener: (cb: () => void) => {
        onStartupListeners.push(cb);
      },
    },
    onInstalled: {
      addListener: (cb: () => void) => {
        onInstalledListeners.push(cb);
      },
    },
    onMessage: {
      addListener: (cb: (typeof onMessageListeners)[number]) => {
        onMessageListeners.push(cb);
      },
    },
    sendMessage: vi.fn(async () => {}),
    // The existing SW also registers an onConnect handler for the
    // fetch-proxy Port at module load. Provide a no-op so import doesn't throw.
    onConnect: { addListener: vi.fn() },
    lastError: undefined,
  },
  // The SW's module-level code touches each of these surfaces. They are
  // no-ops here because the detached-popout tests don't exercise them,
  // but they MUST exist or the dynamic SW import throws "addListener of undefined".
  debugger: {
    attach: vi.fn(),
    detach: vi.fn(),
    sendCommand: vi.fn(async () => ({})),
    onEvent: { addListener: vi.fn() },
    onDetach: { addListener: vi.fn() },
  },
  offscreen: {
    hasDocument: vi.fn(async () => true),
    createDocument: vi.fn(async () => {}),
  },
  identity: {
    launchWebAuthFlow: vi.fn(),
    getRedirectURL: vi.fn(),
  },
  webRequest: {
    onHeadersReceived: { addListener: vi.fn() },
  },
  tabGroups: {
    update: vi.fn(async () => undefined),
  },
};

(globalThis as unknown as { chrome: typeof mockChrome }).chrome = mockChrome;

function resetMocks(): void {
  sessionStorage.clear();
  sidePanelCalls.length = 0;
  tabsStore.clear();
  tabsRemoved.length = 0;
  windowsStore.length = 0;
  onStartupListeners.length = 0;
  onInstalledListeners.length = 0;
  onMessageListeners.length = 0;
  actionClickListeners.length = 0;
  tabsRemovedListeners.length = 0;
  for (const fn of Object.values(mockChrome.sidePanel)) {
    if (typeof fn === 'function' && 'mockClear' in fn) (fn as { mockClear(): void }).mockClear();
  }
  for (const fn of Object.values(mockChrome.tabs)) {
    if (typeof fn === 'function' && 'mockClear' in fn) (fn as { mockClear(): void }).mockClear();
  }
}

async function loadSw(): Promise<void> {
  vi.resetModules();
  await import('../src/service-worker.js');
  // Allow the top-level reconcileDetachedLockOnBoot() promise to settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// If the dynamic import above throws "Cannot read properties of undefined
// (reading 'addListener')" or similar, the SW's existing top-level code
// touches a chrome.* surface this mock doesn't cover. Inspect the actual
// error stack; extend the mock with a no-op for the missing surface; rerun.
// The existing `packages/chrome-extension/tests/service-worker.test.ts`
// is a reference for the full chrome.* surface area the SW expects.

describe('detached popout — boot reconciliation', () => {
  beforeEach(() => {
    resetMocks();
  });

  it('applies default unlock state when storage is empty', async () => {
    await loadSw();
    expect(sidePanelCalls).toContainEqual({
      method: 'setPanelBehavior',
      args: { openPanelOnActionClick: true },
    });
    expect(sidePanelCalls).toContainEqual({
      method: 'setOptions',
      args: { enabled: true },
    });
  });

  it('applies locked state when storage points to a live tab', async () => {
    sessionStorage.set('slicc.detached.tabId', 42);
    tabsStore.set(42, {
      id: 42,
      windowId: 100,
      url: 'chrome-extension://test/index.html?detached=1',
    });

    await loadSw();

    expect(sidePanelCalls).toContainEqual({
      method: 'setPanelBehavior',
      args: { openPanelOnActionClick: false },
    });
    expect(sidePanelCalls).toContainEqual({
      method: 'setOptions',
      args: { enabled: false },
    });
  });

  it('clears stale storage and applies default when stored tab is gone', async () => {
    sessionStorage.set('slicc.detached.tabId', 99);
    // tabsStore does not contain 99.

    await loadSw();

    expect(sessionStorage.has('slicc.detached.tabId')).toBe(false);
    expect(sidePanelCalls).toContainEqual({
      method: 'setPanelBehavior',
      args: { openPanelOnActionClick: true },
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/chrome-extension/tests/service-worker-detached.test.ts`
Expected: All three tests FAIL — the SW does not yet have a reconciler.

- [ ] **Step 3: Implement the reconciler in `service-worker.ts`**

Add the reconciler immediately after the storage helpers added in Task 4 (still inside the new "Detached popout state" section):

```ts
async function reconcileDetachedLockOnBoot(): Promise<void> {
  const storedTabId = await readStoredDetachedTabId();

  if (storedTabId !== undefined) {
    let tabAlive = false;
    try {
      await chrome.tabs.get(storedTabId);
      tabAlive = true;
    } catch {
      // Tab gone (closed/discarded while SW was evicted)
    }

    if (tabAlive) {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
      await chrome.sidePanel.setOptions({ enabled: false });
      return;
    }

    await clearStoredDetachedTabId();
  }

  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  await chrome.sidePanel.setOptions({ enabled: true });
}
```

- [ ] **Step 4: Replace the top-level `setPanelBehavior` call with a reconcile call**

Find the existing line at `service-worker.ts:44`:

```ts
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
```

Replace it with:

```ts
reconcileDetachedLockOnBoot().catch((err) => {
  console.error('[slicc-sw] reconcile detached lock failed', err);
});

chrome.runtime.onStartup.addListener(() => {
  reconcileDetachedLockOnBoot().catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  reconcileDetachedLockOnBoot().catch(() => {});
});
```

Note on coexistence with `ensureOffscreen`: the existing SW already has `chrome.runtime.onInstalled?.addListener?.(() => { ensureOffscreen(); })` at `service-worker.ts:93` and a top-level `ensureOffscreen()` call at line 96. Leave those calls in place; the new reconciler runs alongside without conflict (each toggles a different chrome API surface — reconciler touches `sidePanel.*`, ensureOffscreen touches `chrome.offscreen.*`). Note that Task 1 changes the `onInstalled?` typings to non-optional; verify the existing `?.addListener?.(...)` call still compiles or simplify it to `chrome.runtime.onInstalled.addListener(() => ensureOffscreen())` in the same edit.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run packages/chrome-extension/tests/service-worker-detached.test.ts`
Expected: All three reconcile tests PASS.

- [ ] **Step 6: Run the existing SW tests to verify no regression**

Run: `npx vitest run packages/chrome-extension/tests/service-worker.test.ts`
Expected: All existing tests PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/chrome-extension/src/service-worker.ts packages/chrome-extension/tests/service-worker-detached.test.ts
git commit -m "$(cat <<'EOF'
feat(extension-sw): reconcile detached lock on boot

Replaces the unconditional top-level setPanelBehavior call with
reconcileDetachedLockOnBoot, which reads chrome.storage.session,
verifies the stored detached tab still exists, and re-applies
both setPanelBehavior and setOptions accordingly. onStartup and
onInstalled listeners trigger the same path so MV3 SW eviction
and browser cold-start cannot leave the lock half-applied.

Reconciler tests cover the three states: empty storage, live
locked tab, and stale storage clearing.
EOF
)"
```

---

## Task 6: Add the `detached-claim` handler

**Files:**

- Modify: `packages/chrome-extension/src/service-worker.ts`
- Modify: `packages/chrome-extension/tests/service-worker-detached.test.ts`

The claim handler is the canonical entry point for any new detached tab. URL validation is strict per the spec.

- [ ] **Step 1: Add failing tests for claim handling**

In `service-worker-detached.test.ts`, add a new `describe` block at the bottom:

```ts
describe('detached popout — claim handler', () => {
  beforeEach(() => {
    resetMocks();
  });

  function sendClaim(tabId: number, url: string): void {
    const env = {
      source: 'panel',
      payload: { type: 'detached-claim' },
    };
    const sender = { tab: { id: tabId }, url };
    for (const listener of onMessageListeners) {
      listener(env, sender, () => {});
    }
  }

  it('locks on first claim from a valid detached URL', async () => {
    await loadSw();
    sidePanelCalls.length = 0;

    tabsStore.set(7, { id: 7, windowId: 100 });
    sendClaim(7, 'chrome-extension://test/index.html?detached=1');
    await new Promise((r) => setTimeout(r, 0));

    expect(sessionStorage.get('slicc.detached.tabId')).toBe(7);
    expect(sidePanelCalls).toContainEqual({
      method: 'setPanelBehavior',
      args: { openPanelOnActionClick: false },
    });
    expect(sidePanelCalls).toContainEqual({
      method: 'setOptions',
      args: { enabled: false },
    });
    expect(mockChrome.runtime.sendMessage).toHaveBeenCalledWith({
      source: 'service-worker',
      payload: { type: 'detached-active' },
    });
  });

  it('accepts pathname / as well as /index.html', async () => {
    await loadSw();
    sidePanelCalls.length = 0;
    tabsStore.set(8, { id: 8, windowId: 100 });

    sendClaim(8, 'chrome-extension://test/?detached=1');
    await new Promise((r) => setTimeout(r, 0));

    expect(sessionStorage.get('slicc.detached.tabId')).toBe(8);
  });

  it('rejects claim with missing sender.url', async () => {
    await loadSw();
    sidePanelCalls.length = 0;
    tabsStore.set(9, { id: 9, windowId: 100 });

    const env = {
      source: 'panel',
      payload: { type: 'detached-claim' },
    };
    for (const listener of onMessageListeners) {
      listener(env, { tab: { id: 9 } }, () => {});
    }
    await new Promise((r) => setTimeout(r, 0));

    expect(sessionStorage.has('slicc.detached.tabId')).toBe(false);
  });

  it('rejects claim from a wrong-origin URL', async () => {
    await loadSw();
    sidePanelCalls.length = 0;
    tabsStore.set(10, { id: 10, windowId: 100 });

    sendClaim(10, 'https://evil.example.com/index.html?detached=1');
    await new Promise((r) => setTimeout(r, 0));

    expect(sessionStorage.has('slicc.detached.tabId')).toBe(false);
  });

  it('rejects claim missing the detached=1 searchParam', async () => {
    await loadSw();
    sidePanelCalls.length = 0;
    tabsStore.set(11, { id: 11, windowId: 100 });

    sendClaim(11, 'chrome-extension://test/index.html');
    await new Promise((r) => setTimeout(r, 0));

    expect(sessionStorage.has('slicc.detached.tabId')).toBe(false);
  });

  it('treats a same-tab reclaim as idempotent', async () => {
    sessionStorage.set('slicc.detached.tabId', 12);
    tabsStore.set(12, { id: 12, windowId: 100 });
    await loadSw();
    sidePanelCalls.length = 0;
    mockChrome.runtime.sendMessage.mockClear();

    sendClaim(12, 'chrome-extension://test/index.html?detached=1');
    await new Promise((r) => setTimeout(r, 0));

    expect(sessionStorage.get('slicc.detached.tabId')).toBe(12);
    expect(mockChrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('closes the new tab and focuses the existing one when a different detached already exists', async () => {
    sessionStorage.set('slicc.detached.tabId', 20);
    tabsStore.set(20, { id: 20, windowId: 100 });
    tabsStore.set(21, { id: 21, windowId: 200 });
    await loadSw();

    sendClaim(21, 'chrome-extension://test/index.html?detached=1');
    await new Promise((r) => setTimeout(r, 0));

    expect(mockChrome.tabs.remove).toHaveBeenCalledWith(21);
    expect(mockChrome.tabs.update).toHaveBeenCalledWith(20, { active: true });
    expect(mockChrome.windows.update).toHaveBeenCalledWith(100, { focused: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/chrome-extension/tests/service-worker-detached.test.ts`
Expected: 7 new tests FAIL — there's no claim handler installed yet.

- [ ] **Step 3: Add the claim handler to `service-worker.ts`**

Add this code in the "Detached popout state" section, after `reconcileDetachedLockOnBoot`:

```ts
function isValidClaimUrl(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(chrome.runtime.getURL('index.html')).origin;
  } catch {
    return false;
  }
  const isExtensionIndex = u.pathname === '/index.html' || u.pathname === '/';
  return u.origin === expectedOrigin && isExtensionIndex && u.searchParams.get('detached') === '1';
}

async function handleDetachedClaim(sender: { tab?: { id: number }; url?: string }): Promise<void> {
  const claimingTabId = sender.tab?.id;
  if (claimingTabId === undefined) return;
  if (!isValidClaimUrl(sender.url)) return;

  const storedTabId = await readStoredDetachedTabId();

  if (storedTabId === claimingTabId) {
    // Idempotent reclaim (detached tab reload). No state change.
    return;
  }

  if (storedTabId !== undefined) {
    let existing: { id: number; windowId?: number } | undefined;
    try {
      existing = await chrome.tabs.get(storedTabId);
    } catch {
      existing = undefined;
    }
    if (existing !== undefined) {
      // A different detached tab already holds the lock. Close the new one.
      await chrome.tabs.remove(claimingTabId);
      await chrome.tabs.update(existing.id, { active: true });
      if (existing.windowId !== undefined) {
        await chrome.windows.update(existing.windowId, { focused: true });
      }
      return;
    }
    // Stored tab is gone; fall through to lock with the new claimer.
  }

  await writeStoredDetachedTabId(claimingTabId);
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  await chrome.sidePanel.setOptions({ enabled: false });
  chrome.runtime.sendMessage({
    source: 'service-worker',
    payload: { type: 'detached-active' },
  });

  // Best-effort hard close of any open side panel (Chrome 141+).
  const windows = await chrome.windows.getAll();
  await Promise.all(
    windows.map(async (win) => {
      try {
        await chrome.sidePanel.close({ windowId: win.id });
      } catch {
        // No side panel open in that window — normal case, swallow.
      }
    })
  );
}
```

- [ ] **Step 4: Register the message listener**

Add this code below the `handleDetachedClaim` definition:

```ts
chrome.runtime.onMessage.addListener((message, sender, _sendResponse) => {
  // Return false explicitly to tell Chrome we will not call sendResponse
  // asynchronously. Returning true keeps sendResponse alive and conflicts
  // with the other SW onMessage listeners that may want to respond.
  if (typeof message !== 'object' || message === null) return false;
  if (!('source' in message) || !('payload' in message)) return false;
  const env = message as { source: string; payload: { type?: string } };
  if (env.source !== 'panel') return false;

  if (env.payload?.type === 'detached-claim') {
    handleDetachedClaim(sender).catch((err) => {
      console.error('[slicc-sw] handleDetachedClaim failed', err);
    });
    return false;
  }
  return false;
});
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run packages/chrome-extension/tests/service-worker-detached.test.ts`
Expected: All claim-handler tests PASS.

- [ ] **Step 6: Run existing SW tests**

Run: `npx vitest run packages/chrome-extension/tests/service-worker.test.ts`
Expected: All existing tests PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/chrome-extension/src/service-worker.ts packages/chrome-extension/tests/service-worker-detached.test.ts
git commit -m "$(cat <<'EOF'
feat(extension-sw): handle detached-claim messages

Claim handler validates the sender URL (extension origin, /index.html
or /, ?detached=1), then either locks (first claim), is idempotent
(same-tab reclaim on reload), or focuses the existing detached tab
and closes the duplicate.

Hard-close any open side panels via chrome.sidePanel.close per
window after broadcasting detached-active, for Chrome 141+.
EOF
)"
```

---

## Task 7: Add the `detached-popout-request` handler

**Files:**

- Modify: `packages/chrome-extension/src/service-worker.ts`
- Modify: `packages/chrome-extension/tests/service-worker-detached.test.ts`

The popout button click sends this. The SW creates a new tab; the new tab's boot claims the lock.

- [ ] **Step 1: Add failing test**

Append to `service-worker-detached.test.ts`:

```ts
describe('detached popout — popout-request handler', () => {
  beforeEach(() => {
    resetMocks();
  });

  it('creates the detached tab with ?detached=1 active and does not lock yet', async () => {
    await loadSw();
    sidePanelCalls.length = 0;

    const env = {
      source: 'panel',
      payload: { type: 'detached-popout-request' },
    };
    for (const listener of onMessageListeners) {
      listener(env, {}, () => {});
    }
    await new Promise((r) => setTimeout(r, 0));

    expect(mockChrome.tabs.create).toHaveBeenCalledWith({
      url: 'chrome-extension://test/index.html?detached=1',
      active: true,
    });
    // The lock is set by the new tab's claim, not by tab creation.
    expect(sessionStorage.has('slicc.detached.tabId')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run packages/chrome-extension/tests/service-worker-detached.test.ts -t "popout-request"`
Expected: FAIL — no handler for `detached-popout-request` yet.

- [ ] **Step 3: Add the handler function**

Add this function in `service-worker.ts`, after `handleDetachedClaim`:

```ts
async function handleDetachedPopoutRequest(): Promise<void> {
  const detachedUrl = `${chrome.runtime.getURL('index.html')}?detached=1`;
  await chrome.tabs.create({ url: detachedUrl, active: true });
  // The lock change is driven by the new tab's detached-claim message,
  // not by tab creation. See spec.
}
```

- [ ] **Step 4: Extend the message listener**

Update the listener registered in Task 6, adding a branch for `detached-popout-request`. Replace:

```ts
  if (env.payload?.type === 'detached-claim') {
    handleDetachedClaim(sender).catch((err) => {
      console.error('[slicc-sw] handleDetachedClaim failed', err);
    });
    return false;
  }
  return false;
});
```

with:

```ts
  if (env.payload?.type === 'detached-claim') {
    handleDetachedClaim(sender).catch((err) => {
      console.error('[slicc-sw] handleDetachedClaim failed', err);
    });
    return false;
  }

  if (env.payload?.type === 'detached-popout-request') {
    handleDetachedPopoutRequest().catch((err) => {
      console.error('[slicc-sw] handleDetachedPopoutRequest failed', err);
    });
    return false;
  }
  return false;
});
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run packages/chrome-extension/tests/service-worker-detached.test.ts`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/chrome-extension/src/service-worker.ts packages/chrome-extension/tests/service-worker-detached.test.ts
git commit -m "$(cat <<'EOF'
feat(extension-sw): handle detached-popout-request

Creating the new tab triggers the claim flow already specified;
the SW does not lock at tab-creation time.
EOF
)"
```

---

## Task 8: Add the `chrome.action.onClicked` handler

**Files:**

- Modify: `packages/chrome-extension/src/service-worker.ts`
- Modify: `packages/chrome-extension/tests/service-worker-detached.test.ts`

When the lock is active, clicking the toolbar icon should focus the existing detached tab. If the stored tab is gone, recover and open the side panel.

- [ ] **Step 1: Add failing tests**

Append to `service-worker-detached.test.ts`:

```ts
describe('detached popout — action.onClicked', () => {
  beforeEach(() => {
    resetMocks();
  });

  it('focuses the detached tab and window when stored tab is alive', async () => {
    sessionStorage.set('slicc.detached.tabId', 30);
    tabsStore.set(30, { id: 30, windowId: 555 });
    await loadSw();

    for (const cb of actionClickListeners) {
      cb({ id: 42, windowId: 0 });
    }
    await new Promise((r) => setTimeout(r, 0));

    expect(mockChrome.tabs.update).toHaveBeenCalledWith(30, { active: true });
    expect(mockChrome.windows.update).toHaveBeenCalledWith(555, { focused: true });
    expect(mockChrome.sidePanel.open).not.toHaveBeenCalled();
  });

  it('recovers and opens side panel when stored tab is gone', async () => {
    sessionStorage.set('slicc.detached.tabId', 99); // not in tabsStore
    await loadSw();
    sidePanelCalls.length = 0;

    for (const cb of actionClickListeners) {
      cb({ id: 42, windowId: 0 });
    }
    await new Promise((r) => setTimeout(r, 0));

    expect(sessionStorage.has('slicc.detached.tabId')).toBe(false);
    expect(mockChrome.sidePanel.open).toHaveBeenCalledWith({ tabId: 42 });
  });

  it('skips sidePanel.open when clickedTab.id is undefined', async () => {
    sessionStorage.set('slicc.detached.tabId', 88); // gone
    await loadSw();
    mockChrome.sidePanel.open.mockClear();

    for (const cb of actionClickListeners) {
      cb({ id: undefined, windowId: 0 });
    }
    await new Promise((r) => setTimeout(r, 0));

    expect(mockChrome.sidePanel.open).not.toHaveBeenCalled();
    // Cleanup still runs.
    expect(sessionStorage.has('slicc.detached.tabId')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/chrome-extension/tests/service-worker-detached.test.ts -t "action.onClicked"`
Expected: 3 tests FAIL — no `action.onClicked` listener registered yet.

- [ ] **Step 3: Add the handler in `service-worker.ts`**

Add this code after the message listener registration from Task 6/7:

```ts
async function handleActionClick(clickedTab: {
  id: number | undefined;
  windowId?: number;
}): Promise<void> {
  const storedId = await readStoredDetachedTabId();

  if (storedId !== undefined) {
    let alive: { id: number; windowId?: number } | undefined;
    try {
      alive = await chrome.tabs.get(storedId);
    } catch {
      alive = undefined;
    }
    if (alive !== undefined) {
      await chrome.tabs.update(storedId, { active: true });
      if (alive.windowId !== undefined) {
        await chrome.windows.update(alive.windowId, { focused: true });
      }
      return;
    }
  }

  // Recovery: no detached tab actually exists.
  // Fire-and-forget the cleanup so it doesn't consume gesture budget
  // before sidePanel.open is invoked.
  chrome.storage.session.remove(DETACHED_TAB_ID_KEY).catch(() => {});
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.sidePanel.setOptions({ enabled: true }).catch(() => {});
  if (clickedTab.id !== undefined) {
    await chrome.sidePanel.open({ tabId: clickedTab.id });
  }
}

chrome.action.onClicked.addListener((tab) => {
  handleActionClick(tab).catch((err) => {
    console.error('[slicc-sw] handleActionClick failed', err);
  });
});
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/chrome-extension/tests/service-worker-detached.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/chrome-extension/src/service-worker.ts packages/chrome-extension/tests/service-worker-detached.test.ts
git commit -m "$(cat <<'EOF'
feat(extension-sw): focus detached tab on toolbar icon click

When the detached lock is active, clicking the toolbar icon brings
the existing detached tab forward via tabs.update + windows.update.
If the stored tabId no longer resolves, clear stale state and open
a fresh side panel (recovery path).

Skips sidePanel.open when clickedTab.id is undefined (devtools or
other tab types Chrome doesn't identify).
EOF
)"
```

---

## Task 9: Add the `chrome.tabs.onRemoved` handler

**Files:**

- Modify: `packages/chrome-extension/src/service-worker.ts`
- Modify: `packages/chrome-extension/tests/service-worker-detached.test.ts`

When the detached tab disappears, unlock.

- [ ] **Step 1: Add failing tests**

Append to `service-worker-detached.test.ts`:

```ts
describe('detached popout — tabs.onRemoved', () => {
  beforeEach(() => {
    resetMocks();
  });

  it('unlocks when the locked tab is removed', async () => {
    sessionStorage.set('slicc.detached.tabId', 50);
    tabsStore.set(50, { id: 50, windowId: 100 });
    await loadSw();
    sidePanelCalls.length = 0;

    for (const cb of tabsRemovedListeners) {
      cb(50, { windowId: 100, isWindowClosing: false });
    }
    await new Promise((r) => setTimeout(r, 0));

    expect(sessionStorage.has('slicc.detached.tabId')).toBe(false);
    expect(sidePanelCalls).toContainEqual({
      method: 'setPanelBehavior',
      args: { openPanelOnActionClick: true },
    });
    expect(sidePanelCalls).toContainEqual({
      method: 'setOptions',
      args: { enabled: true },
    });
  });

  it('does nothing when an unrelated tab is removed', async () => {
    sessionStorage.set('slicc.detached.tabId', 60);
    tabsStore.set(60, { id: 60, windowId: 100 });
    await loadSw();
    sidePanelCalls.length = 0;

    for (const cb of tabsRemovedListeners) {
      cb(999, { windowId: 100, isWindowClosing: false });
    }
    await new Promise((r) => setTimeout(r, 0));

    expect(sessionStorage.get('slicc.detached.tabId')).toBe(60);
    expect(sidePanelCalls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/chrome-extension/tests/service-worker-detached.test.ts -t "tabs.onRemoved"`
Expected: 2 tests FAIL.

- [ ] **Step 3: Add the handler in `service-worker.ts`**

Append:

```ts
async function handleTabRemoved(tabId: number): Promise<void> {
  const storedId = await readStoredDetachedTabId();
  if (storedId !== tabId) return;
  await clearStoredDetachedTabId();
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  await chrome.sidePanel.setOptions({ enabled: true });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  handleTabRemoved(tabId).catch((err) => {
    console.error('[slicc-sw] handleTabRemoved failed', err);
  });
});
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/chrome-extension/tests/service-worker-detached.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/chrome-extension/src/service-worker.ts packages/chrome-extension/tests/service-worker-detached.test.ts
git commit -m "$(cat <<'EOF'
feat(extension-sw): release detached lock on tab removal

When the locked detached tab is closed (or its window closes),
tabs.onRemoved fires, the SW clears storage, and re-enables the
side panel.
EOF
)"
```

---

## Task 10: Add `locked` field + `setLocked` + `send()` check to `OffscreenClient`

**Files:**

- Modify: `packages/webapp/src/ui/offscreen-client.ts`
- Modify: `packages/webapp/tests/ui/offscreen-client.test.ts`

The send-path lock is layer 3 of mutual exclusion.

- [ ] **Step 1: Add failing test**

Open `packages/webapp/tests/ui/offscreen-client.test.ts` and add a new test inside the existing `describe('OffscreenClient', ...)` block:

```ts
it('blocks outbound messages when locked', () => {
  // updateModel() is a public method that calls this.send({ type: 'refresh-model' }).
  // Source: packages/webapp/src/ui/offscreen-client.ts updateModel() at ~line 222.
  client.updateModel();
  const beforeLockCount = sentMessages.length;

  client.setLocked(true);
  client.updateModel();
  expect(sentMessages.length).toBe(beforeLockCount); // no new send

  client.setLocked(false);
  client.updateModel();
  expect(sentMessages.length).toBeGreaterThan(beforeLockCount);
});
```

Note: the public method name on `OffscreenClient` is `updateModel()` (the discriminator it sends is `'refresh-model'` — don't be fooled by the type literal). If a future refactor renames it, substitute any public method on `OffscreenClient` that invokes `this.send(...)` — any of them exercises the lock.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/webapp/tests/ui/offscreen-client.test.ts -t "blocks outbound"`
Expected: FAIL — `client.setLocked is not a function`.

- [ ] **Step 3: Add the lock field, setter, and check in `OffscreenClient`**

Open `packages/webapp/src/ui/offscreen-client.ts`. Find an appropriate place near the top of the class for a private field declaration (alongside any other private fields). Add:

```ts
private locked = false;
```

Add a public method on the class (placement next to other public methods like `updateModel` is fine):

```ts
/**
 * Mark this client as locked. While locked, all outbound traffic
 * via send() is dropped and an error is surfaced to the UI.
 * Used by the detached-popout flow to prevent a soon-to-close
 * panel from sending duplicate user actions.
 */
setLocked(locked: boolean): void {
  this.locked = locked;
}
```

Find the existing `private send` method (around line 616):

```ts
private send(payload: PanelToOffscreenMessage): void {
  this.transport.send(payload);
}
```

Replace with:

```ts
private send(payload: PanelToOffscreenMessage): void {
  if (this.locked) {
    this.emitToUI({
      type: 'error',
      error: 'This window is detached. Close it and use the detached tab.',
    });
    return;
  }
  this.transport.send(payload);
}
```

- [ ] **Step 4: Run test**

Run: `npx vitest run packages/webapp/tests/ui/offscreen-client.test.ts -t "blocks outbound"`
Expected: PASS.

- [ ] **Step 5: Run the full existing `OffscreenClient` test file**

Run: `npx vitest run packages/webapp/tests/ui/offscreen-client.test.ts`
Expected: All tests PASS — no regression of existing behavior.

- [ ] **Step 6: Commit**

```bash
git add packages/webapp/src/ui/offscreen-client.ts packages/webapp/tests/ui/offscreen-client.test.ts
git commit -m "$(cat <<'EOF'
feat(offscreen-client): add send-path lock for detached popout

Adds a `locked` flag, a public `setLocked(value)` method, and a
short-circuit in the private `send()` chokepoint. When locked,
every outbound chrome.runtime message — chat send, scoop create/
drop, refresh-model, request-state, sprinkle-lick relay, etc. —
is dropped and an error is surfaced to the UI.

This is layer 3 of the three-layer mutual-exclusion design for
the detached popout flow.
EOF
)"
```

---

## Task 11: Add `setShowPopoutButton` and `showDetachedActiveOverlay` to `Layout`

**Files:**

- Modify: `packages/webapp/src/ui/layout.ts`

Layout-side surface for the popout button and the detached-active overlay. The actual click handler is wired by `mainExtension` (next task); Layout only exposes the methods.

- [ ] **Step 1: Read the relevant section of `layout.ts` to find the header construction**

Run: `grep -n "buildHeader\|header.className\|className = 'header" packages/webapp/src/ui/layout.ts | head -10`

Verified: Layout's `buildHeader()` creates a `<div class="header">` (no BEM prefix), with `.header__brand`, `.header__row`, `.header__title`, `.header__spacer` as inner elements. The popout button will be appended to the `.header` element. If the implementer's read shows a different class, substitute the correct one in `setShowPopoutButton` below.

- [ ] **Step 2: Add a private field for the button and overlay**

In the `Layout` class, near other private fields (e.g., `private scoopSwitcher?: ...`), add:

```ts
private popoutButtonEl?: HTMLButtonElement;
private popoutClickHandler?: () => void;
private detachedActiveOverlayEl?: HTMLDivElement;
```

- [ ] **Step 3: Add the two public methods**

Add these methods on `Layout`. All DOM construction uses `createElement` + `textContent` (no `innerHTML`):

```ts
/**
 * Show or hide the "Pop out" header button. The click handler is
 * provided by setPopoutClickHandler — Layout itself does not know
 * about the SW envelope shape.
 */
setShowPopoutButton(show: boolean): void {
  if (!show) {
    this.popoutButtonEl?.remove();
    this.popoutButtonEl = undefined;
    return;
  }
  if (this.popoutButtonEl) return;
  // Layout's buildHeader() creates a top-level `<div class="header">`.
  const headerEl = this.root.querySelector('.header') as HTMLElement | null;
  if (!headerEl) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'header__popout-btn';
  btn.title = 'Open in a new tab';
  btn.textContent = '⤴'; // simple glyph; CSS may replace with icon
  btn.setAttribute('aria-label', 'Pop out to a new tab');
  btn.addEventListener('click', () => {
    btn.disabled = true; // prevent double-fire
    this.popoutClickHandler?.();
  });
  headerEl.appendChild(btn);
  this.popoutButtonEl = btn;
}

/** Wire the popout button click handler. Replaces any previous handler. */
setPopoutClickHandler(handler: () => void): void {
  this.popoutClickHandler = handler;
}

/**
 * Render a non-dismissible full-Layout overlay indicating that a
 * detached tab has taken over. The only escape is closing this
 * window via the overlay's close button.
 */
showDetachedActiveOverlay(): void {
  if (this.detachedActiveOverlayEl) return;
  const overlay = document.createElement('div');
  overlay.className = 'layout-detached-overlay';
  overlay.setAttribute('role', 'alertdialog');
  overlay.setAttribute('aria-modal', 'true');

  const msg = document.createElement('p');
  msg.textContent = 'Detached in another tab. Close this window to continue.';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'layout-detached-overlay-close';
  btn.textContent = 'Close this window';
  btn.addEventListener('click', () => {
    window.close();
  });

  overlay.appendChild(msg);
  overlay.appendChild(btn);
  this.root.appendChild(overlay);
  this.detachedActiveOverlayEl = overlay;
}
```

- [ ] **Step 4: Add minimal CSS for the overlay**

Find the CSS file that styles `.header`. Run:

```bash
grep -rn "\.header[^_a-zA-Z]" packages/webapp/src/ui/styles/ | head -5
```

Append the following rules to whichever stylesheet currently defines `.header`:

```css
.header__popout-btn {
  background: transparent;
  border: 1px solid currentColor;
  color: inherit;
  border-radius: 4px;
  padding: 4px 8px;
  cursor: pointer;
  font-size: 14px;
  opacity: 0.7;
}
.header__popout-btn:hover {
  opacity: 1;
}
.header__popout-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.layout-detached-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  z-index: 99999;
  color: #fff;
  font-size: 16px;
  padding: 2rem;
  text-align: center;
}
.layout-detached-overlay-close {
  margin-top: 1.5rem;
  padding: 0.6rem 1.5rem;
  background: #fff;
  color: #000;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
}
```

- [ ] **Step 5: Verify typecheck and existing tests**

Run: `npm run typecheck`
Expected: PASS.

Run: `npx vitest run packages/webapp/tests/ui/`
Expected: All existing tests PASS — Layout changes are additive.

- [ ] **Step 6: Commit**

```bash
git add packages/webapp/src/ui/layout.ts packages/webapp/src/ui/styles/
git commit -m "$(cat <<'EOF'
feat(layout): add popout button and detached-active overlay APIs

setShowPopoutButton(show) renders or removes a header button.
setPopoutClickHandler(fn) wires its click handler. The click
disables the button immediately to prevent double-fire.

showDetachedActiveOverlay() renders a non-dismissible overlay with
a single Close-this-window button. There is no dismiss path —
exposing the underlying UI while it is locked at the send path
would produce silent rejection UX.

CSS in styles/ covers both surfaces with minimal styling.
EOF
)"
```

---

## Task 12: Update `mainExtension` signature and wire detached behavior

**Files:**

- Modify: `packages/webapp/src/ui/main.ts`

`mainExtension` becomes parameterized. In detached mode it uses standalone-density Layout, emits a claim, and skips the popout button. It always installs the `detached-active` listener so non-detached `index.html` tabs also self-close.

- [ ] **Step 1: Find and read `mainExtension` and the dispatcher**

Run: `grep -n "async function mainExtension\|runtimeMode === 'extension'" packages/webapp/src/ui/main.ts | head -10`

Note the function definition line (~523) and the dispatcher block (~2386-2400).

- [ ] **Step 2: Change `mainExtension` signature and Layout instantiation**

Find:

```ts
async function mainExtension(app: HTMLElement): Promise<void> {
  const { OffscreenClient } = await import('./offscreen-client.js');
  const { VirtualFS } = await import('../fs/index.js');
  const { publishAgentBridgeProxy } = await import('../scoops/agent-bridge.js');
  const layout = new Layout(app, true);
```

Replace with:

```ts
async function mainExtension(
  app: HTMLElement,
  options?: { detached?: boolean }
): Promise<void> {
  const isDetachedSelf = options?.detached === true;
  const { OffscreenClient } = await import('./offscreen-client.js');
  const { VirtualFS } = await import('../fs/index.js');
  const { publishAgentBridgeProxy } = await import('../scoops/agent-bridge.js');
  const layout = new Layout(app, !isDetachedSelf);
```

Rationale: `isExtension` (the Layout flag) is `true` for non-detached and `false` for detached — detached uses standalone-density UX per the spec.

- [ ] **Step 3: Install the `detached-active` listener**

Verified: `mainExtension` declares `let client` and assigns `client = new OffscreenClient({...})` at `main.ts:662`. The OffscreenClient instance is in scope under the name `client`.

Add this block AFTER the `client = new OffscreenClient(...)` assignment (search for `new OffscreenClient` to locate it):

```ts
// Detached popout: listen for the SW's broadcast that a detached tab
// has claimed the lock. Side panels and non-detached index.html tabs
// self-close; the detached tab itself ignores its own echo.
chrome.runtime.onMessage.addListener((msg) => {
  // Return false (or void/undefined) on every path so Chrome does not
  // keep sendResponse alive. This listener never responds.
  if (typeof msg !== 'object' || msg === null) return false;
  if (!('source' in msg) || !('payload' in msg)) return false;
  const env = msg as { source: string; payload: { type?: string } };
  if (env.source !== 'service-worker') return false;
  if (env.payload?.type !== 'detached-active') return false;

  if (isDetachedSelf) return false; // I am the claimer; ignore my own broadcast.

  enterDetachedActiveState(client, layout);
  return false;
});
```

- [ ] **Step 4: Define `enterDetachedActiveState` in the same file**

Add this helper function in `main.ts`, near `mainExtension` (just before or after it — keep them co-located):

```ts
function enterDetachedActiveState(
  client: import('./offscreen-client.js').OffscreenClient,
  layout: Layout
): void {
  // Execution order matters: close → lock → overlay.
  //
  // 1. window.close() — happy path; if it works the rest is moot.
  // 2. setLocked(true) — synchronously bounces any send() call. Doing
  //    this BEFORE the overlay closes the window where the user could
  //    click a still-active send button between close-failing and
  //    overlay-appearing.
  // 3. showDetachedActiveOverlay() — visible feedback.
  try {
    window.close();
  } catch {
    // window.close() may no-op in some Chrome configurations; layers 2+3 cover it.
  }
  client.setLocked(true);
  layout.showDetachedActiveOverlay();
}
```

- [ ] **Step 5: Emit the claim on boot when detached**

Emit the claim immediately AFTER the `detached-active` listener installation from Step 3. This ordering guarantees the listener is in place before the SW broadcast returns; the listener guards on `isDetachedSelf` so the claimer ignores its own echo regardless. The claim does NOT need to wait for any further OffscreenClient readiness — the broadcast it triggers is independent of the panel↔offscreen state-snapshot traffic.

Add this block guarded by `isDetachedSelf`, placed right after the listener registration:

```ts
if (isDetachedSelf) {
  chrome.runtime.sendMessage({
    source: 'panel',
    payload: { type: 'detached-claim' },
  });
}
```

- [ ] **Step 6: Wire popout button visibility**

Still in `mainExtension`, before the function returns (or wherever the layout-construction block ends), add:

```ts
if (!isDetachedSelf) {
  layout.setShowPopoutButton(true);
  layout.setPopoutClickHandler(() => {
    chrome.runtime.sendMessage({
      source: 'panel',
      payload: { type: 'detached-popout-request' },
    });
  });
}
```

- [ ] **Step 7: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Run the existing test suites that touch main.ts**

Run: `npx vitest run packages/webapp/tests/ui/`
Expected: All existing tests PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/webapp/src/ui/main.ts
git commit -m "$(cat <<'EOF'
feat(main): parameterize mainExtension for detached mode

mainExtension gains options.detached. In detached mode:
- Layout(app, false) for standalone-density UX
- emits detached-claim envelope on boot
- skips the popout button

In non-detached mode:
- Layout(app, true) preserves side-panel density
- shows the popout button wired to detached-popout-request

Both modes install a detached-active listener that calls
enterDetachedActiveState — window.close() + overlay +
setLocked(true) — except in the detached tab itself, which
ignores its own echo via the isDetachedSelf guard.
EOF
)"
```

---

## Task 13: Add the `extension-detached` branch in `main()`'s dispatcher

**Files:**

- Modify: `packages/webapp/src/ui/main.ts`

The dispatcher routes `'extension-detached'` mode to `mainExtension(app, { detached: true })`.

- [ ] **Step 1: Locate the dispatcher block (around line 2386)**

Find:

```ts
// Build the layout — tabbed in extension mode, split panels in standalone
const isExtension = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;
const runtimeMode = resolveUiRuntimeMode(window.location.href, isExtension);

// Extension mode: delegate to offscreen-backed UI
if (runtimeMode === 'extension') {
  return mainExtension(app);
}
```

- [ ] **Step 2: Add the detached branch and fix the stale comment**

Replace the whole block above with:

```ts
// Resolve UI runtime mode from chrome.runtime.id and URL query.
const isExtension = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;
const runtimeMode = resolveUiRuntimeMode(window.location.href, isExtension);

// Detached extension tab (?detached=1): standalone-density Layout with
// the offscreen agent. See docs/superpowers/specs/2026-05-13-extension-detached-popout-design.md
if (runtimeMode === 'extension-detached') {
  return mainExtension(app, { detached: true });
}

// Side panel or non-detached index.html tab.
if (runtimeMode === 'extension') {
  return mainExtension(app);
}
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Run the full test suite**

Run: `npm run test`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/ui/main.ts
git commit -m "$(cat <<'EOF'
feat(main): dispatch extension-detached to mainExtension({detached})

Adds the new branch in main()'s runtime-mode dispatcher and removes
the stale 'tabbed in extension mode, split panels in standalone'
comment (the tabbed layout was retired long ago — Layout uses a
single split-pane shell with isExtension controlling density).
EOF
)"
```

---

## Task 14: Manual smoke test — load the extension and verify the flow end-to-end

**Files:** None (this is a verification step before the docs work).

The unit tests cover the SW state machine and the send-path lock; this manual step exercises the UI integration that resists unit testing.

- [ ] **Step 1: Build the extension in dev mode**

Run: `SLICC_EXT_DEV=1 npm run build -w @slicc/chrome-extension`
Expected: Build completes; `dist/extension/` is fresh.

- [ ] **Step 2: Copy build to a stable path and launch Chrome for Testing**

Follow the recipe in `packages/chrome-extension/CLAUDE.md` ("Local QA: dedicated profile preinstalled with the extension"):

```bash
rm -rf /tmp/slicc-ext-build && cp -r dist/extension /tmp/slicc-ext-build
CFT="$HOME/.cache/puppeteer/chrome/mac_arm-146.0.7680.153/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
EXT="/tmp/slicc-ext-build"
PROFILE="/tmp/slicc-ext-profile"
rm -rf "$PROFILE" && mkdir -p "$PROFILE"
GOOGLE_CRASHPAD_DISABLE=1 "$CFT" \
  --user-data-dir="$PROFILE" \
  --remote-debugging-port=0 \
  --no-first-run \
  --no-default-browser-check \
  --disable-crash-reporter \
  --disable-extensions-except="$EXT" \
  --load-extension="$EXT" \
  "chrome://extensions" &
```

- [ ] **Step 3: Verify each scenario manually**

For each scenario below, observe and confirm. If a step fails, capture the symptom and fix before moving on.

| Scenario                                                                                                                                   | Expected |
| ------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| Click toolbar icon → side panel opens with popout button visible in header                                                                 | ✓        |
| Click popout button → new tab opens at `chrome-extension://<id>/index.html?detached=1`; side panel closes itself                           | ✓        |
| Click toolbar icon while detached tab is open → focuses the detached tab (no new side panel)                                               | ✓        |
| Close the detached tab → next icon click opens a fresh side panel                                                                          | ✓        |
| Open `chrome-extension://<id>/index.html?detached=1` directly in a new tab → detached mode + lock applied + any existing side panel closes | ✓        |
| Reload the detached tab (Ctrl-R) → tab boots back into detached mode (idempotent claim)                                                    | ✓        |
| Close all Chrome windows, restart Chrome with "Continue where you left off" → detached tab restored, lock re-applied when tab is activated | ✓        |
| Send a chat message in the side panel, then click popout → message history present in detached tab                                         | ✓        |
| Drag the detached tab to a new window → still functions; toolbar icon click in either window focuses the tab + its window                  | ✓        |

- [ ] **Step 4: Note any regressions in side panel functionality**

Compare against pre-detached behavior. The popout button is new; everything else should be identical.

If anything regresses, file as a follow-up issue and decide whether to fix before docs.

- [ ] **Step 5: Tear down**

```bash
pkill -f "Google Chrome.*slicc-ext-profile"
```

No commit for this task — it's manual verification.

---

## Task 15: Documentation updates (single batched task)

**Files:**

- Modify: `packages/chrome-extension/CLAUDE.md`
- Modify: `packages/webapp/CLAUDE.md`
- Modify: `docs/architecture.md`
- Modify: `docs/pitfalls.md`
- Modify: `docs/testing.md`
- Modify: `packages/webapp/src/ui/layout.ts` (file-header diagram)
- Modify: `README.md`
- Modify: root `CLAUDE.md` (if it has stale tabbed-UI wording — search first)

The spec lists 8 documentation surfaces. We batch them into one task to commit cohesively.

- [ ] **Step 1: Update `packages/chrome-extension/CLAUDE.md`**

Add a new section (placement: after "Three-Layer Architecture" or wherever feels natural):

```markdown
## Detached Popout

The extension supports popping the side panel out into a full-page tab
via a "Pop out" button in the side panel header, or by opening
`chrome-extension://<id>/index.html?detached=1` directly.

**Mutual exclusion** is global across all Chrome windows: at most one
detached tab exists at a time, and while it does the side panel is
disabled. The service worker is the sole coordinator and persists
the locked tab ID in `chrome.storage.session`.

**Boot reconciliation:** `reconcileDetachedLockOnBoot()` runs at
top-level + `onStartup` + `onInstalled`, so MV3 SW eviction and
browser cold-start cannot leave the lock half-applied.

**Three-layer mutual exclusion** on the panel side:

1. `window.close()` from the panel + `chrome.sidePanel.close({ windowId })` from SW
2. `Layout.showDetachedActiveOverlay()` — non-dismissible overlay
3. `OffscreenClient.setLocked(true)` — short-circuits the private
   `send()` chokepoint so no user-action message reaches offscreen
   even if the user interacts with a stuck UI.

**Non-detached `index.html` tabs** (e.g., the local QA recipe surface)
are treated as side-panel-equivalent: they DO listen for `detached-active`
and self-close, but DO NOT count as the canonical detached tab.

**Spec:** `docs/superpowers/specs/2026-05-13-extension-detached-popout-design.md`.
```

Also: replace any stale "tabbed UI" references in the existing
"Three-Layer Architecture" diagram with the current split-rail terminology.
Search the file for "tabbed" and update each occurrence.

- [ ] **Step 2: Update `packages/webapp/CLAUDE.md`**

In the UI subsystem section, add to the existing description of `Layout(root, isExtension)`:

```markdown
The `isExtension` flag is not styling-only — it toggles scoops-rail
visibility, scoop-switcher use, rail full-page behavior, avatar
location, and default debug-tab visibility. The detached popout
mode (see `docs/superpowers/specs/2026-05-13-extension-detached-popout-design.md`)
uses `isExtension=false` so a popped-out tab gets the full standalone
rail UX, not a stretched side panel.
```

Also add `'extension-detached'` to the list of `UiRuntimeMode` values
wherever that union is described.

- [ ] **Step 3: Update `docs/architecture.md`**

Search for "tabbed":

```bash
grep -n "tabbed" docs/architecture.md
```

Replace each occurrence with accurate wording. Specifically:

- Line ~225 (file-finding guide entry for `layout.ts`): replace
  "Split-pane (CLI) or tabbed (extension) layout; auto-selects based on extension detection"
  with
  "Unified split-pane layout. `isExtension` toggles density (scoops rail, switcher, avatar). Detached popout mode passes `isExtension=false`."

- Line ~582 ("Change layout (split vs tabbed)"): replace with
  "Change layout density (`Layout(root, isExtension)` flag)".

- Anywhere else the tabbed extension layout is mentioned: rewrite as
  unified split-pane with density toggle.

Also add a brief mention of the detached tab as a second valid UI
client surface in the extension three-layer architecture description.

- [ ] **Step 4: Update `docs/pitfalls.md`**

Append (placement: alongside other extension-mode pitfalls):

```markdown
## Detached popout: boot is the lock event

The detached popout flow accepts three entry paths: the side-panel
"Pop out" button, direct URL navigation (paste/bookmark), and
Chrome's tab restore. ALL three converge on the detached tab's boot
emitting a `detached-claim` envelope to the SW — the button is a
convenience, not a trust signal. Spec:
`docs/superpowers/specs/2026-05-13-extension-detached-popout-design.md`.

## Detached popout: claim URL validation

The SW's claim handler parses `sender.url` as a URL and validates
`origin`, pathname (`/index.html` or `/`), and
`searchParams.get('detached') === '1'`. Substring matches on
`sender.url` MUST NOT be used — they are brittle to query reordering.

## Detached popout: top-frame requirement for claim emission

`detached-claim` MUST be sent from the detached tab's top frame
because validation uses the sender document URL; a nested
sprinkle iframe will not carry `?detached=1` and the claim will
be rejected. Future code that moves the claim-emit point must
preserve this.
```

- [ ] **Step 5: Update `docs/testing.md`**

Find the "Chrome API: DebuggerClient, service workers" allow-skip line (around line 322):

```markdown
- **Chrome API**: DebuggerClient, service workers
```

Replace with:

```markdown
- **Chrome API**: DebuggerClient, service workers — EXCEPT
  state-machine and lifecycle-reconciliation logic (e.g., the
  detached-popout SW state machine), which MUST be unit-tested
  with mocked `chrome.*` APIs. See
  `packages/chrome-extension/tests/service-worker-detached.test.ts`
  for the established mock pattern.
```

- [ ] **Step 6: Update `packages/webapp/src/ui/layout.ts` file-header diagram**

The header at lines ~1-21 still depicts the retired tabbed extension
layout. Replace the whole header comment with:

```ts
/**
 * Layout — unified split-pane shell for both CLI and extension.
 *
 * The `isExtension` constructor flag toggles density (scoops rail,
 * scoop switcher, avatar, debug-tab defaults). The extension
 * (side panel) mode uses isExtension=true; the detached popout mode
 * uses isExtension=false to get the full standalone rail UX.
 *
 *   ┌───────┬─────────────┬───┬───────────────┐
 *   │  Header (popout btn, scoop switcher, etc.)│
 *   ├───────┬─────────────┬───┬───────────────┤
 *   │Scoops │             │ ║ │  Terminal      │
 *   │       │  Chat       │ ║ ├───────────────┤
 *   │       │  Panel      │ ║ │  Files        │
 *   │       │             │ ║ │               │
 *   └───────┴─────────────┴───┴───────────────┘
 *
 * Detached popout spec:
 *   docs/superpowers/specs/2026-05-13-extension-detached-popout-design.md
 */
```

- [ ] **Step 7: Update `README.md`**

Add a brief user-facing note in the features list (placement: near
other extension/UI descriptions):

```markdown
**Pop out to a full-page tab.** In the Chrome extension, the side panel
header has a "Pop out" button that opens SLICC in a full-page tab with
the standalone split-pane layout. Close the tab to return to the side
panel. State (chat history, scoops, VFS) is shared.

While a detached tab is open, the side panel is disabled globally
(across all Chrome windows) — clicking the toolbar icon focuses the
detached tab. This is intentional; close the tab to restore the side
panel. Detached popout requires Chrome 141+ for the hard-close
fallback to apply; older Chrome versions still work but rely on the
panel's own `window.close()` path.
```

- [ ] **Step 8: Search root `CLAUDE.md` for stale wording**

Run:

```bash
grep -n "tabbed\|extension mode.*compact" CLAUDE.md
```

If any matches refer to the retired tabbed extension layout, update
them to describe the current split-rail layout with density toggle.
If no matches, skip this step.

- [ ] **Step 9: Run prettier on all changed docs**

```bash
npx prettier --write \
  packages/chrome-extension/CLAUDE.md \
  packages/webapp/CLAUDE.md \
  docs/architecture.md \
  docs/pitfalls.md \
  docs/testing.md \
  packages/webapp/src/ui/layout.ts \
  README.md \
  CLAUDE.md
```

- [ ] **Step 10: Commit**

```bash
git add packages/chrome-extension/CLAUDE.md packages/webapp/CLAUDE.md docs/architecture.md docs/pitfalls.md docs/testing.md packages/webapp/src/ui/layout.ts README.md CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: detached popout cross-references and stale-wording fixes

- Add detached popout section to packages/chrome-extension/CLAUDE.md
- Note isExtension UX breadth + new UiRuntimeMode in webapp/CLAUDE.md
- Fix every "tabbed extension layout" reference in docs/architecture.md
  (the layout was unified to a split shell long ago)
- Add three pitfalls entries: boot-is-the-lock-event, claim URL
  validation strictness, top-frame requirement
- Carve out SW state-machine tests from the docs/testing.md
  "Chrome API can skip" clause
- Replace the stale tabbed-extension ASCII diagram in
  packages/webapp/src/ui/layout.ts file header
- Add user-facing popout description in README.md
EOF
)"
```

---

## Task 16: Extend the manual QA recipe with detached-mode coverage

**Files:**

- Modify: `packages/chrome-extension/CLAUDE.md`

Adds the detached-mode scenarios to the existing "Local QA" recipe.

- [ ] **Step 1: Locate the existing QA recipe**

Run: `grep -n "Local QA\|step 6\|step 7" packages/chrome-extension/CLAUDE.md | head -10`

The recipe walks through building the extension, launching Chrome for Testing, finding the extension ID, and opening the side panel via CDP.

- [ ] **Step 2: Append a "Detached popout QA" subsection**

After the existing recipe (and tear-down section), add:

```markdown
### Detached popout QA scenarios

Build with `SLICC_EXT_DEV=1` (as above) and launch Chrome for Testing
with the recipe. Then verify each scenario:

1. **Click popout button from side panel.**
   - Side panel header shows "Pop out" button.
   - Click → new tab opens at
     `chrome-extension://<id>/index.html?detached=1`.
   - Side panel closes itself.
   - Chat history is intact in the detached tab.

2. **Toolbar icon while detached open.**
   - Click toolbar icon → existing detached tab focuses, side panel
     does NOT open.
   - If detached tab is in another window, the window also focuses.

3. **Close detached → return to side panel.**
   - Close the detached tab.
   - Click toolbar icon → side panel opens normally.

4. **Direct URL access.**
   - Paste `chrome-extension://<id>/index.html?detached=1` into a new
     tab.
   - It boots into detached mode and locks the side panel.

5. **Reload detached tab.**
   - Ctrl-R the detached tab.
   - It rehydrates into detached mode (idempotent claim, no extra tabs).

6. **Browser restart with "Continue where you left off."**
   - Close all Chrome for Testing windows with the detached tab open.
   - Relaunch.
   - When the restored detached tab activates, the lock re-applies.
   - Verify the discarded-state caveat: if Chrome restores the tab as
     discarded, side panel may briefly be available; once the user
     focuses the detached tab, lock applies.

7. **Drag detached tab to a new window.**
   - Drag tab out of its window.
   - In the new window, click the toolbar icon → existing detached
     tab focuses (in the other window).

8. **Extension-page capability differences.**
   - In the detached tab, run a mount command that uses
     `showDirectoryPicker()` (e.g., `mount /workspace/scratch`).
     Verify it works under a normal tab gesture context, since the
     detached tab is a normal tab not a side panel.
   - Verify mic/voice input behaves the same as in the side panel
     (or note differences for follow-up).

9. **Tray runtime config survives popout.**
   - In the side panel, configure tray runtime (paste join URL).
   - Click popout.
   - In the detached tab, verify the tray runtime is still connected
     and `refresh-tray-runtime` relays work.
```

- [ ] **Step 3: Run prettier**

```bash
npx prettier --write packages/chrome-extension/CLAUDE.md
```

- [ ] **Step 4: Commit**

```bash
git add packages/chrome-extension/CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(extension): extend QA recipe with detached popout scenarios

Nine manual scenarios covering the happy paths plus the
side-panel/extension-tab capability differences (showDirectoryPicker,
mic) and tray runtime config preservation across a popout.
EOF
)"
```

---

## Task 17: Final verification gates

**Files:** None (CI-gate parity check).

Run the full set of gates the CI workflow runs so we don't ship a
broken branch.

- [ ] **Step 1: Format check**

Run: `npx prettier --check .`
Expected: All files PASS. If any fail, run `npx prettier --write <files>` and commit.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Run full test suite**

Run: `npm run test`
Expected: PASS.

- [ ] **Step 4: Coverage gate (chrome-extension package)**

Run: `npm run test:coverage:chrome-extension`
Expected: All thresholds met (lines/statements ≥ 55%, branches ≥ 45%, functions ≥ 60%).

If coverage slips, identify the uncovered SW paths and add focused unit tests.

- [ ] **Step 5: Full build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 6: Extension-specific build**

Run: `npm run build -w @slicc/chrome-extension`
Expected: PASS.

- [ ] **Step 7: Re-run the manual smoke test from Task 14**

Repeat each row in the Task 14 verification table on the final build.

- [ ] **Step 8: If anything failed**

Fix and re-run from Step 1. Do not push a partially-passing branch.

---

## Done

Once all tasks are complete and all gates pass on the final commit:

- Push the branch: `git push -u origin feat/extension-detached-popout`
- Open a PR referencing the spec (`docs/superpowers/specs/2026-05-13-extension-detached-popout-design.md`)
- The PR description should call out the three-layer mutual-exclusion model and the SW boot-reconciliation contract — these are the load-bearing pieces reviewers should examine.
