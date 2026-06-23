# Follower Fast-Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Boot a standalone browser tray *follower* (a `/join/<token>` URL or `?tray=…/join/…`, plus the `?cherry=1` embed) into a lightweight no-kernel-worker mount that connects to the leader immediately, instead of standing up the full standalone kernel/cone first.

**Architecture:** Add a `'follower'` `UiRuntimeMode`, detect it (validated join URL) early in `main()`, and dispatch `follower`/`cherry` to a new `mountWcUiFollower` that runs the existing page prelude (page `BrowserAPI` + CDP transport), mounts the WC shell in a reduced "connecting" configuration, starts `startPageFollowerTray` (the `FollowerSyncManager` becomes the chat `AgentHandle`), installs a page-side CDP `NavigationWatcher` for navigate-lick forwarding, wires a storage-only switch-out, and **never spawns the kernel worker**.

**Tech Stack:** TypeScript, Vitest (`environment: node`, `globals: true`), the `@slicc/webcomponents` WC shell, the existing tray-sync (`FollowerSyncManager`) and CDP (`BrowserAPI`/`NavigationWatcher`) layers.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-23-follower-fast-path-design.md` (the authoritative design; this plan implements it).
- **Dual-mode:** this change is **standalone-only**. The extension (`isExtension` short-circuits `resolveUiRuntimeMode`) and iOS followers are out of scope and MUST NOT be touched.
- **Never spawn the worker on the follower path:** `mountWcUiFollower` must not call `spawnKernelWorker()` nor `client.sendSetFollowerForwarding()` (there is no `OffscreenClient`).
- **Cherry precedence:** `?cherry=1` must resolve to `'cherry'` (checked before the follower branch). Cherry skips the navigate watcher.
- **Detection rule:** follower = a parseable **`joinUrl`** (`…/join/<token>`) from `?tray=` query / current-URL path / stored key. A `…/tray/<trayId>` path or `?tray=<base>/tray/<id>` (a `trayId` with `joinUrl: null`) is leader/session state and is **NOT** follower.
- **`resolveUiRuntimeMode` stays Node-testable:** it is called in `tests/ui/runtime-mode.test.ts` with no DOM. Add an optional `storage` param; resolve `window.localStorage` only behind `typeof window !== 'undefined'`. Never read the global unconditionally.
- **Logging:** `createLogger('namespace')` from `packages/webapp/src/core/logger.ts`.
- **Lint:** `npx biome check --write <files>` + `npx prettier --write <files>` before each commit (CI rejects unformatted code).
- **`/licks-ws` HTTP-injection is an accepted scope cut** (see spec Non-goals) — do not build a replacement.

---

## File Structure

- **`packages/webapp/src/scoops/tray-runtime-config.ts`** (modify) — add `resolveFollowerJoinUrl(locationHref, storage)` reusing the existing `?tray=` query + path + stored-key parsing; returns a non-null join URL or null.
- **`packages/webapp/src/ui/runtime-mode.ts`** (modify) — add `'follower'` to `UiRuntimeMode`; `resolveUiRuntimeMode` gains an optional `storage` param and a follower branch after the cherry check.
- **`packages/webapp/src/ui/main.ts`** (modify) — dispatch `follower`/`cherry` to `mountWcUiFollower` after `setupSwRegistration`, before `bootstrapOAuthReplicas`.
- **`packages/webapp/src/ui/wc/wc-follower.ts`** (create) — `mountWcUiFollower`: the lightweight no-worker follower boot.
- **`packages/webapp/src/ui/follower-navigate-watcher.ts`** (create) — `startFollowerNavigateWatcher(transport, getSync)`: CDP `NavigationWatcher` → `forwardLick`.
- **`packages/webapp/src/ui/follower-switch-out.ts`** (create) — storage-only "stop following" / "become leader" + reload.
- Tests mirror under `packages/webapp/tests/...`.

This plan defers the heaviest piece — fully decoupling the WC shell mount from `OffscreenClient` — into Task 3, which is sized larger and flagged as the primary risk. Tasks 1–2 and 4–6 are small and independently testable.

---

### Task 1: `resolveFollowerJoinUrl` helper

**Files:**
- Modify: `packages/webapp/src/scoops/tray-runtime-config.ts`
- Test: `packages/webapp/tests/scoops/tray-runtime-config.test.ts` (add cases; create if absent)

**Interfaces:**
- Consumes: existing `parseTrayUrlValue(raw)` (returns `TrayUrlConfig | null` where a `join` path → `joinUrl` set, a `tray` path → `trayId` set + `joinUrl: null`), `parseTrayJoinUrlValue(raw)` (returns `TrayJoinConfig | null`), `hasStoredTrayJoinUrl(storage)`, `TRAY_QUERY_PARAM`, `TRAY_JOIN_STORAGE_KEY`, `RuntimeConfigStorage`.
- Produces: `resolveFollowerJoinUrl(locationHref: string, storage?: RuntimeConfigStorage | null): string | null` — the join URL when one is resolvable, else null.

- [ ] **Step 1: Write the failing test**

Add to `packages/webapp/tests/scoops/tray-runtime-config.test.ts` (create the file with this content if it does not exist):

```typescript
import { describe, expect, it } from 'vitest';
import {
  resolveFollowerJoinUrl,
  TRAY_JOIN_STORAGE_KEY,
} from '../../src/scoops/tray-runtime-config.js';

function memStorage(entries: Record<string, string> = {}) {
  const map = new Map(Object.entries(entries));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

describe('resolveFollowerJoinUrl', () => {
  const JOIN = 'https://www.sliccy.ai/join/tray-1.cap-token';

  it('resolves a join URL on the current path', () => {
    expect(resolveFollowerJoinUrl(JOIN, null)).toBe(JOIN);
  });

  it('resolves a join URL passed via the ?tray= query (node-server --join shape)', () => {
    const href = `http://localhost:5710/?tray=${encodeURIComponent(JOIN)}`;
    expect(resolveFollowerJoinUrl(href, null)).toBe(JOIN);
  });

  it('resolves a stored join URL when the page URL has none', () => {
    const storage = memStorage({ [TRAY_JOIN_STORAGE_KEY]: JOIN });
    expect(resolveFollowerJoinUrl('http://localhost:5710/', storage)).toBe(JOIN);
  });

  it('returns null for a leader …/tray/<id> session URL (joinUrl is null)', () => {
    const href = 'http://localhost:5710/?tray=https://www.sliccy.ai/base/tray/tray-1';
    expect(resolveFollowerJoinUrl(href, null)).toBeNull();
  });

  it('returns null for a worker-only config with no join URL', () => {
    const href = 'http://localhost:5710/?tray=https://www.sliccy.ai/base';
    expect(resolveFollowerJoinUrl(href, null)).toBeNull();
  });

  it('returns null when nothing is present', () => {
    expect(resolveFollowerJoinUrl('http://localhost:5710/', null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/webapp/tests/scoops/tray-runtime-config.test.ts`
Expected: FAIL — `resolveFollowerJoinUrl` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `packages/webapp/src/scoops/tray-runtime-config.ts` (after `hasStoredTrayJoinUrl`):

```typescript
/**
 * Resolve a follower JOIN URL from the page URL or stored config, covering the
 * launch shapes the tray uses: a `?tray=<…/join/token>` query (what
 * `node-server --join` builds), a `…/join/<token>` path on the current URL
 * (deployed sliccy.ai follower tab), or a stored join URL. Returns the join URL
 * only when a parseable `joinUrl` exists — a `…/tray/<trayId>` leader/session
 * shape (trayId set, joinUrl null) yields null. Used by `resolveUiRuntimeMode`
 * for follower detection and by `mountWcUiFollower` to obtain the join URL.
 */
export function resolveFollowerJoinUrl(
  locationHref: string,
  storage?: RuntimeConfigStorage | null
): string | null {
  // 1. ?tray=<value> query param (node-server --join canonical shape).
  try {
    const url = new URL(locationHref);
    const fromQuery = parseTrayUrlValue(url.searchParams.get(TRAY_QUERY_PARAM));
    if (fromQuery?.joinUrl) return fromQuery.joinUrl;
  } catch {
    // not a parseable URL — fall through to stored config
  }
  // 2. The current URL itself as a join URL (e.g. served from the worker at /join/:token).
  const fromPath = parseTrayJoinUrlValue(locationHref);
  if (fromPath?.joinUrl) return fromPath.joinUrl;
  // 3. Stored join URL.
  const stored = parseTrayJoinUrlValue(storage?.getItem(TRAY_JOIN_STORAGE_KEY) ?? null);
  return stored?.joinUrl ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/webapp/tests/scoops/tray-runtime-config.test.ts`
Expected: PASS (all 6 cases).

- [ ] **Step 5: Format + commit**

```bash
npx biome check --write packages/webapp/src/scoops/tray-runtime-config.ts packages/webapp/tests/scoops/tray-runtime-config.test.ts
npx prettier --write packages/webapp/src/scoops/tray-runtime-config.ts packages/webapp/tests/scoops/tray-runtime-config.test.ts
git add packages/webapp/src/scoops/tray-runtime-config.ts packages/webapp/tests/scoops/tray-runtime-config.test.ts
git commit -m "feat(tray): add resolveFollowerJoinUrl helper (#1107)"
```

---

### Task 2: `'follower'` runtime mode + early dispatch

**Files:**
- Modify: `packages/webapp/src/ui/runtime-mode.ts`
- Modify: `packages/webapp/src/ui/main.ts`
- Test: `packages/webapp/tests/ui/runtime-mode.test.ts`

**Interfaces:**
- Consumes: `resolveFollowerJoinUrl` (Task 1).
- Produces: `UiRuntimeMode` now includes `'follower'`; `resolveUiRuntimeMode(locationHref: string, isExtension: boolean, storage?: RuntimeConfigStorage | null): UiRuntimeMode`.

- [ ] **Step 1: Write the failing test**

Add to `packages/webapp/tests/ui/runtime-mode.test.ts`:

```typescript
import { TRAY_JOIN_STORAGE_KEY } from '../../src/scoops/tray-runtime-config.js';

function memStorage(entries: Record<string, string> = {}) {
  const map = new Map(Object.entries(entries));
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
}

describe('resolveUiRuntimeMode — follower', () => {
  const JOIN = 'https://www.sliccy.ai/join/tray-1.cap-token';

  it('detects a follower from a /join/ path', () => {
    expect(resolveUiRuntimeMode(JOIN, false)).toBe('follower');
  });

  it('detects a follower from a ?tray=<join> query', () => {
    expect(
      resolveUiRuntimeMode(`http://localhost:5710/?tray=${encodeURIComponent(JOIN)}`, false)
    ).toBe('follower');
  });

  it('detects a follower from a stored join URL', () => {
    expect(
      resolveUiRuntimeMode('http://localhost:5710/', false, memStorage({ [TRAY_JOIN_STORAGE_KEY]: JOIN }))
    ).toBe('follower');
  });

  it('does NOT treat a leader /tray/<id> session URL as follower', () => {
    expect(
      resolveUiRuntimeMode('http://localhost:5710/?tray=https://www.sliccy.ai/base/tray/tray-1', false)
    ).toBe('standalone');
  });

  it('keeps cherry winning over follower', () => {
    expect(resolveUiRuntimeMode(`${JOIN}?cherry=1`, false)).toBe('cherry');
  });

  it('never returns follower in an extension context', () => {
    expect(resolveUiRuntimeMode(JOIN, true)).toBe('extension');
  });

  it('is callable with no storage arg and no DOM (does not throw)', () => {
    expect(() => resolveUiRuntimeMode('http://localhost:5710/', false)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/webapp/tests/ui/runtime-mode.test.ts`
Expected: FAIL — follower cases return `'standalone'`.

- [ ] **Step 3: Implement the mode + detection**

In `packages/webapp/src/ui/runtime-mode.ts`, add `'follower'` to the union:

```typescript
export type UiRuntimeMode =
  | 'standalone'
  | 'extension'
  | 'electron-overlay'
  | 'extension-detached'
  | 'hosted-leader'
  | 'connect'
  | 'cherry'
  | 'follower';
```

Add the import at the top:

```typescript
import { resolveFollowerJoinUrl, type RuntimeConfigStorage } from '../scoops/tray-runtime-config.js';
```

Change the signature and add the follower branch (after the `cherry` check, before the electron/standalone return):

```typescript
export function resolveUiRuntimeMode(
  locationHref: string,
  isExtension: boolean,
  storage?: RuntimeConfigStorage | null
): UiRuntimeMode {
  if (isExtension) {
    // ...unchanged...
  }
  try {
    const url = new URL(locationHref);
    if (url.searchParams.get('connect') === '1') return 'connect';
    if (url.searchParams.get('runtime') === HOSTED_LEADER_RUNTIME_QUERY_VALUE) return 'hosted-leader';
    if (url.searchParams.get('cherry') === '1') return 'cherry';
    // Follower fast-path: a validated join URL (path, ?tray= query, or stored key).
    // Resolve storage lazily and DOM-safely so this stays callable in Node tests.
    // NOTE: only an OMITTED storage arg falls back to ambient window.localStorage;
    // an explicit `null` means "no storage" (tests pass null to assert URL-only
    // detection) and must NOT reach for the global.
    const followerStorage =
      storage === undefined ? (typeof window !== 'undefined' ? window.localStorage : null) : storage;
    if (resolveFollowerJoinUrl(locationHref, followerStorage)) return 'follower';
    return isElectronOverlayUrl(url) ? 'electron-overlay' : 'standalone';
  } catch {
    return 'standalone';
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/webapp/tests/ui/runtime-mode.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire early dispatch in `main.ts`**

In `packages/webapp/src/ui/main.ts`, immediately after the `if (swResult === 'reload-pending') return;` line (≈ line 90) and **before** `await registerProviders();`, insert:

```typescript
  // Follower fast-path: a tray follower (and the cherry embed) needs neither
  // the local OAuth bootstrap (it uses the leader's credentials over the tray
  // channel) nor the kernel worker. Dispatch here, before the OAuth wait, so
  // the follower paints + connects without that dead time.
  if (!isExtension && (runtimeMode === 'follower' || runtimeMode === 'cherry')) {
    const { mountWcUiFollower } = await import('./wc/wc-follower.js');
    return mountWcUiFollower(app, log, runtimeMode);
  }
```

(Leave the existing `cherry` handling inside `mountWcUiLive`/`wc-tray.ts` in place for now; Task 4 removes the cherry path from the live boot once `mountWcUiFollower` handles it. Until Task 4, cherry resolves here first, so the live cherry branch is simply unreached.)

- [ ] **Step 6: Add a placeholder `mountWcUiFollower` so the import resolves**

Create `packages/webapp/src/ui/wc/wc-follower.ts`:

```typescript
import { createLogger } from '../../core/logger.js';
import type { BootStageLogger } from '../boot/types.js';
import type { UiRuntimeMode } from '../runtime-mode.js';

const log = createLogger('wc-follower');

/** Lightweight no-kernel follower boot. Built out across Tasks 3-6. */
export async function mountWcUiFollower(
  _app: HTMLElement,
  _log: BootStageLogger,
  runtimeMode: UiRuntimeMode
): Promise<void> {
  log.info('mountWcUiFollower (placeholder)', { runtimeMode });
}
```

- [ ] **Step 7: Typecheck + format + commit**

```bash
npx tsc --noEmit -p tsconfig.json
npx biome check --write packages/webapp/src/ui/runtime-mode.ts packages/webapp/src/ui/main.ts packages/webapp/src/ui/wc/wc-follower.ts packages/webapp/tests/ui/runtime-mode.test.ts
npx prettier --write packages/webapp/src/ui/runtime-mode.ts packages/webapp/src/ui/main.ts packages/webapp/src/ui/wc/wc-follower.ts packages/webapp/tests/ui/runtime-mode.test.ts
git add -A && git commit -m "feat(ui): follower runtime mode + early dispatch (#1107)"
```

---

### Task 3: `mountWcUiFollower` — no-worker shell + follower tray

**Files:**
- Modify: `packages/webapp/src/ui/wc/wc-follower.ts`
- Reference (read, do not break): `packages/webapp/src/ui/boot/setup-standalone-prelude.ts` (`setupStandalonePrelude(deps)`, `deps = { runtimeMode, envBaseUrl, window, log }` → `{ browser, realCdpTransport, cherryJoinUrl, cherryTransport, instanceId, … }`), `packages/webapp/src/ui/wc/wc-live.ts` (`prepareWcShell(app, floatLabel)` → `WcShellBoot { refs, setClient, setController, getController, onClientReady, … }`; `submittedText` is in `wc-shell.ts`), `packages/webapp/src/ui/wc/wc-chat-controller.ts` (`new WcChatController({ thread, agent, onProcessingChange? })`; methods `setAgent`, `loadMessages`, `addUserMessage`, `setProcessing`, `sendUserMessage`), `packages/webapp/src/ui/wc/wc-sprinkles.ts` (`new WcSprinkleZone(refs).callbacks()` → `{ addSprinkle, removeSprinkle }`), `packages/webapp/src/ui/page-follower-tray.ts` (`startPageFollowerTray(StartPageFollowerTrayOptions)` → `PageFollowerTrayHandle { stop(); currentSync }`), `packages/webapp/src/ui/types.ts` (`AgentHandle = { sendMessage; onEvent(cb): () => void; stop }`).
- Test: `packages/webapp/tests/ui/wc/wc-follower.test.ts`

**Interfaces:**
- Consumes: `setupStandalonePrelude(deps)`, `prepareWcShell(app, floatLabel)`, `WcChatController`, `WcSprinkleZone`, `submittedText`, `startPageFollowerTray(options)`, `resolveFollowerJoinUrl` (Task 1).
- Produces: a working `mountWcUiFollower(app, log, runtimeMode)` that connects a follower with chat + sprinkles, **without** spawning the kernel worker.

> **Decoupling approach (codex-verified):** `attachWcClient` (`wc-live.ts:1150`) hard-depends on an `OffscreenClient` — do NOT call it. But `prepareWcShell(app, floatLabel)` itself does **not** require a client (`setClient` is a separate method we simply never call). So: call `prepareWcShell`, construct a `WcChatController` with a **no-op `AgentHandle`** (the follower sync replaces it via `setChatAgent` once connected), `boot.setController(controller)`, wire the composer `submit` event manually with `submittedText`, and use `new WcSprinkleZone(boot.refs).callbacks()` for `addSprinkle`/`removeSprinkle`. No `buildWcShellFrame` extraction is needed; reuse `prepareWcShell` as-is.

- [ ] **Step 1: Write the failing test**

Create `packages/webapp/tests/ui/wc/wc-follower.test.ts` (first line is the env pragma; reuse the existing DOM stubs helper):

```typescript
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

// Spy on the kernel-worker spawn to PROVE the follower path never calls it.
const spawnSpy = vi.fn();
vi.mock('../../../src/kernel/spawn.js', () => ({
  spawnKernelWorker: (...args: unknown[]) => spawnSpy(...args),
}));

const startFollowerSpy = vi.fn(() => ({ stop: vi.fn(), currentSync: null }));
vi.mock('../../../src/ui/page-follower-tray.js', () => ({
  startPageFollowerTray: (...args: unknown[]) => startFollowerSpy(...args),
  CHERRY_RUNTIME_TAG: 'slicc-cherry',
}));

vi.mock('../../../src/ui/boot/setup-standalone-prelude.js', () => ({
  setupStandalonePrelude: vi.fn(async () => ({
    browser: { getTransport: () => ({}), listPages: async () => [] },
    realCdpTransport: {},
    cherryJoinUrl: undefined,
    cherryTransport: undefined,
    instanceId: 'i',
  })),
}));

describe('mountWcUiFollower', () => {
  beforeEach(() => {
    spawnSpy.mockClear();
    startFollowerSpy.mockClear();
    document.body.innerHTML = '<div id="app"></div>';
    // Set the page URL to a join URL via history (do NOT redefine window.location).
    history.replaceState(null, '', 'https://www.sliccy.ai/join/tray-1.cap-token');
  });

  it('starts the follower tray and NEVER spawns the kernel worker', async () => {
    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await mountWcUiFollower(app, { stage: () => {} } as never, 'follower');
    expect(startFollowerSpy).toHaveBeenCalledTimes(1);
    expect(spawnSpy).not.toHaveBeenCalled();
    // The follower tray was handed the page BrowserAPI + a non-cherry runtime tag.
    const opts = startFollowerSpy.mock.calls[0][0] as { runtime: string; browserAPI: unknown };
    expect(opts.runtime).toBe('slicc-standalone');
    expect(opts.browserAPI).toBeTruthy();
  });
});
```

> If `history.replaceState` to a cross-origin URL throws under jsdom, set the test file's jsdom URL instead via a top-of-file `// @vitest-environment-options { "url": "https://www.sliccy.ai/join/tray-1.cap-token" }` and drop the `history.replaceState` line.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/webapp/tests/ui/wc/wc-follower.test.ts`
Expected: FAIL — placeholder `mountWcUiFollower` does not call `startPageFollowerTray`.

- [ ] **Step 3: Implement `mountWcUiFollower`**

Replace `packages/webapp/src/ui/wc/wc-follower.ts`:

```typescript
import { createLogger } from '../../core/logger.js';
import { resolveFollowerJoinUrl } from '../../scoops/tray-runtime-config.js';
import type { AgentHandle } from '../types.js';
import { CHERRY_RUNTIME_TAG, startPageFollowerTray } from '../page-follower-tray.js';
import { setupStandalonePrelude } from '../boot/setup-standalone-prelude.js';
import type { BootStageLogger } from '../boot/types.js';
import type { UiRuntimeMode } from '../runtime-mode.js';
import { prepareWcShell } from './wc-live.js';
import { WcChatController } from './wc-chat-controller.js';
import { WcSprinkleZone } from './wc-sprinkles.js';
import { submittedText } from './wc-shell.js';

const log = createLogger('wc-follower');

/** A placeholder agent until the follower sync connects and replaces it via setChatAgent. */
const NOOP_AGENT: AgentHandle = {
  sendMessage: () => {},
  onEvent: () => () => {},
  stop: () => {},
};

export async function mountWcUiFollower(
  app: HTMLElement,
  bootLog: BootStageLogger,
  runtimeMode: UiRuntimeMode
): Promise<void> {
  const prelude = await setupStandalonePrelude({
    runtimeMode,
    envBaseUrl: import.meta.env.VITE_WORKER_BASE_URL ?? null,
    window,
    log: bootLog,
  });

  const isCherry = runtimeMode === 'cherry';
  const joinUrl = isCherry
    ? prelude.cherryJoinUrl
    : resolveFollowerJoinUrl(window.location.href, window.localStorage);
  if (!joinUrl) {
    log.error('follower mount with no join URL — falling back to live boot');
    const { mountWcUiLive } = await import('./wc-live.js');
    return mountWcUiLive(app, bootLog, 'standalone');
  }

  // Reuse the WC shell frame WITHOUT a client (never call boot.setClient /
  // attachWcClient — those require an OffscreenClient + spawn the worker).
  const boot = prepareWcShell(app, isCherry ? 'cherry · follower' : 'follower');
  const controller = new WcChatController({ thread: boot.refs.thread, agent: NOOP_AGENT });
  boot.setController(controller);
  boot.refs.inputCard.removeAttribute('disabled');

  // Composer submit → forward to the (follower-sync) agent the controller holds.
  boot.refs.inputCard.addEventListener('submit', (event) => {
    const text = submittedText(event);
    if (text) controller.sendUserMessage(text);
  });

  const sprinkleZone = new WcSprinkleZone(boot.refs);
  const sprinkleCallbacks = sprinkleZone.callbacks();

  const follower = startPageFollowerTray({
    joinUrl,
    runtime: isCherry ? CHERRY_RUNTIME_TAG : 'slicc-standalone',
    browserAPI: prelude.browser,
    onSnapshot: (messages) => controller.loadMessages(messages),
    onUserMessage: (text, id, _jid, atts) => controller.addUserMessage(text, atts, id),
    onStatus: (status) => controller.setProcessing(status === 'processing'),
    setChatAgent: (agent) => controller.setAgent(agent),
    addSprinkle: sprinkleCallbacks.addSprinkle,
    removeSprinkle: sprinkleCallbacks.removeSprinkle,
    ...(isCherry
      ? { onCherrySliccEvent: (name, detail) => prelude.cherryTransport?.emitSliccEventToHost(name, detail) }
      : {}),
  });

  if (isCherry && prelude.cherryTransport) {
    prelude.cherryTransport.onHostEvent = (name, detail) =>
      follower.currentSync?.sendCherryHostEvent(name, detail);
  }

  // Tasks 4 (navigate watcher, non-cherry) + 6 (switch-out) wire in here.
  log.info('follower mounted', { runtimeMode, isCherry });
}
```

> Verify the exact `WcChatController` method names + `onUserMessage` arg order against `wc-tray.ts:buildFollowerOptions` (the existing follower wiring) and `wc-chat-controller.ts` while implementing — match them rather than guessing. The load-bearing test assertions are: `startPageFollowerTray` called once with `browserAPI` + the right runtime tag, and `spawnKernelWorker` never called.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/webapp/tests/ui/wc/wc-follower.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck the browser bundle**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 6: Format + commit**

```bash
npx biome check --write packages/webapp/src/ui/wc/wc-follower.ts packages/webapp/tests/ui/wc/wc-follower.test.ts
npx prettier --write packages/webapp/src/ui/wc/wc-follower.ts packages/webapp/tests/ui/wc/wc-follower.test.ts
git add -A && git commit -m "feat(ui): mountWcUiFollower — no-worker follower shell + tray (#1107)"
```

---

### Task 4: Page-side CDP navigate-lick watcher

**Files:**
- Create: `packages/webapp/src/ui/follower-navigate-watcher.ts`
- Modify: `packages/webapp/src/ui/wc/wc-follower.ts` (wire it in for non-cherry)
- Test: `packages/webapp/tests/ui/follower-navigate-watcher.test.ts`

**Interfaces:**
- Consumes: `NavigationWatcher` (`packages/webapp/src/cdp/navigation-watcher.ts`, `constructor(transport: CDPTransport, onEvent: NavigationEventHandler)`; `NavigationEvent` has `url`, `verb`, `target`, optional `instruction`/`branch`/`path`/`title`, `links`, `targetId`), `CDPTransport`, `FollowerSyncManager.forwardLick(event: LickEvent)`.
- Produces: `startFollowerNavigateWatcher(transport: CDPTransport, getSync: () => { forwardLick(e: LickEvent): boolean } | null): () => void` — returns a stop function.

- [ ] **Step 1: Write the failing test**

Create `packages/webapp/tests/ui/follower-navigate-watcher.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';

// Capture the onEvent NavigationWatcher is constructed with, and drive it.
let captured: ((e: unknown) => void) | null = null;
vi.mock('../../src/cdp/navigation-watcher.js', () => ({
  NavigationWatcher: class {
    onEvent: (e: unknown) => void;
    constructor(_t: unknown, onEvent: (e: unknown) => void) {
      this.onEvent = onEvent;
      captured = onEvent;
    }
    start() {}
    stop() {}
  },
}));

describe('startFollowerNavigateWatcher', () => {
  it('forwards a navigate lick built from the NavigationEvent to the current sync', async () => {
    const { startFollowerNavigateWatcher } = await import('../../src/ui/follower-navigate-watcher.js');
    const forwardLick = vi.fn(() => true);
    startFollowerNavigateWatcher({} as never, () => ({ forwardLick }));
    captured!({ url: 'https://x/', verb: 'handoff', target: 'https://x/', instruction: 'go', links: [], targetId: 't1' });
    expect(forwardLick).toHaveBeenCalledTimes(1);
    const lick = forwardLick.mock.calls[0][0] as { type: string; navigateUrl: string; body: Record<string, unknown> };
    expect(lick.type).toBe('navigate');
    expect(lick.navigateUrl).toBe('https://x/');
    expect(lick.body.verb).toBe('handoff');
    expect(lick.body.instruction).toBe('go');
  });

  it('drops the event cleanly when no sync is connected', async () => {
    const { startFollowerNavigateWatcher } = await import('../../src/ui/follower-navigate-watcher.js');
    expect(() => {
      startFollowerNavigateWatcher({} as never, () => null);
      captured!({ url: 'https://x/', verb: 'handoff', target: 'https://x/', links: [], targetId: 't1' });
    }).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/webapp/tests/ui/follower-navigate-watcher.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the watcher**

Create `packages/webapp/src/ui/follower-navigate-watcher.ts`. Mirror the `navigate` `LickEvent` shape the worker builds in `kernel/host.ts:startNavigationWatcherForHost`:

```typescript
import type { CDPTransport } from '../cdp/transport.js';
import { NavigationWatcher } from '../cdp/navigation-watcher.js';
import { createLogger } from '../core/logger.js';
import type { LickEvent } from '../scoops/lick-manager.js';

const log = createLogger('follower-navigate-watcher');

interface ForwardSync {
  forwardLick(event: LickEvent): boolean;
}

/**
 * Page-side replacement for the kernel worker's NavigationWatcher → LickManager
 * forwarder. A no-kernel follower has no LickManager, so this watches the page's
 * CDP transport directly and forwards `navigate` licks (handoffs) to the leader
 * via `FollowerSyncManager.forwardLick`. Returns a stop function.
 */
export function startFollowerNavigateWatcher(
  transport: CDPTransport,
  getSync: () => ForwardSync | null
): () => void {
  const watcher = new NavigationWatcher(transport, (event) => {
    const body: Record<string, unknown> = { url: event.url, verb: event.verb, target: event.target };
    if (event.instruction != null) body.instruction = event.instruction;
    if (event.branch != null) body.branch = event.branch;
    if (event.path != null) body.path = event.path;
    if (event.title != null) body.title = event.title;
    const sync = getSync();
    if (!sync) {
      log.warn('navigate lick dropped — no follower sync connected', { url: event.url });
      return;
    }
    sync.forwardLick({
      type: 'navigate',
      navigateUrl: event.url,
      targetScoop: undefined,
      timestamp: new Date().toISOString(),
      body,
    });
  });
  void watcher.start();
  return () => void watcher.stop();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/webapp/tests/ui/follower-navigate-watcher.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire it into `mountWcUiFollower` (non-cherry only)**

In `packages/webapp/src/ui/wc/wc-follower.ts`, replace the `// Tasks 4-5 …` comment with:

```typescript
  if (!isCherry) {
    const { startFollowerNavigateWatcher } = await import('../follower-navigate-watcher.js');
    startFollowerNavigateWatcher(prelude.realCdpTransport, () => follower.currentSync);
  }
```

- [ ] **Step 6: Typecheck + run both affected tests + format + commit**

```bash
npx tsc --noEmit -p tsconfig.json
npx vitest run packages/webapp/tests/ui/follower-navigate-watcher.test.ts packages/webapp/tests/ui/wc/wc-follower.test.ts
npx biome check --write packages/webapp/src/ui/follower-navigate-watcher.ts packages/webapp/src/ui/wc/wc-follower.ts packages/webapp/tests/ui/follower-navigate-watcher.test.ts
npx prettier --write packages/webapp/src/ui/follower-navigate-watcher.ts packages/webapp/src/ui/wc/wc-follower.ts packages/webapp/tests/ui/follower-navigate-watcher.test.ts
git add -A && git commit -m "feat(ui): page-side navigate-lick watcher for no-worker follower (#1107)"
```

---

### Task 5: Cherry fold-in (remove cherry from the live boot)

**Files:**
- Modify: `packages/webapp/src/ui/wc/wc-tray.ts` (drop the `runtimeMode === 'cherry'` follower branch — now handled by `mountWcUiFollower`)
- Modify: `packages/webapp/src/ui/boot/setup-standalone-prelude.ts` only if cherry-specific prelude wiring must move (keep `setupCherryFollower` reachable from `mountWcUiFollower` via the prelude)
- Test: `packages/webapp/tests/ui/wc/wc-follower.test.ts` (add a cherry case)

**Interfaces:**
- Consumes: prelude `cherryJoinUrl` / `cherryTransport` (already wired in Task 3).
- Produces: cherry runs through `mountWcUiFollower`; the live boot (`mountWcUiLive` / `wc-tray.ts`) no longer has a cherry branch.

- [ ] **Step 1: Write the failing test (cherry case)**

Add to `packages/webapp/tests/ui/wc/wc-follower.test.ts`:

```typescript
  it('cherry: wires cherry transport + onCherrySliccEvent, no navigate watcher, no worker', async () => {
    // Re-mock the prelude to return a cherry transport + joinUrl.
    vi.doMock('../../../src/ui/boot/setup-standalone-prelude.js', () => ({
      setupStandalonePrelude: vi.fn(async () => ({
        browser: { getTransport: () => ({}), listPages: async () => [] },
        realCdpTransport: {},
        cherryJoinUrl: 'https://www.sliccy.ai/join/tray-c.cap',
        cherryTransport: { emitSliccEventToHost: vi.fn(), onHostEvent: null },
        instanceId: 'i',
      })),
    }));
    vi.resetModules();
    const { mountWcUiFollower } = await import('../../../src/ui/wc/wc-follower.js');
    const app = document.getElementById('app')!;
    await mountWcUiFollower(app, { stage: () => {} } as never, 'cherry');
    expect(startFollowerSpy).toHaveBeenCalled();
    expect(spawnSpy).not.toHaveBeenCalled();
    // runtime tag is the cherry tag
    const opts = startFollowerSpy.mock.calls.at(-1)![0] as { runtime: string; onCherrySliccEvent?: unknown };
    expect(opts.runtime).toBe('slicc-cherry');
    expect(opts.onCherrySliccEvent).toBeTypeOf('function');
  });
```

- [ ] **Step 2: Run test to verify current behavior**

Run: `npx vitest run packages/webapp/tests/ui/wc/wc-follower.test.ts`
Expected: the cherry case PASSES against Task 3's mount (cherry was already handled there). This task's change is *removing the now-dead live-boot cherry branch* — verify nothing else routes cherry to `mountWcUiLive`.

- [ ] **Step 3: Remove the dead cherry branch from `wc-tray.ts`**

Delete the `if (deps.runtimeMode === 'cherry' && deps.cherryJoinUrl) { … startPageFollowerTray … }` block in `startInitialRole` (it is unreachable now that `main.ts` routes cherry to `mountWcUiFollower` before `mountWcUiLive`). Leave leader/standalone/hosted-leader branches untouched.

- [ ] **Step 4: Verify the full webapp suite + typecheck**

Run: `npx tsc --noEmit -p tsconfig.json && npx vitest run packages/webapp/tests/ui/`
Expected: PASS (no test relied on the removed cherry branch; if one did, update it to expect cherry via the follower mount).

- [ ] **Step 5: Format + commit**

```bash
npx biome check --write packages/webapp/src/ui/wc/wc-tray.ts packages/webapp/tests/ui/wc/wc-follower.test.ts
npx prettier --write packages/webapp/src/ui/wc/wc-tray.ts packages/webapp/tests/ui/wc/wc-follower.test.ts
git add -A && git commit -m "refactor(ui): route cherry through mountWcUiFollower (#1107)"
```

---

### Task 6: Storage-only switch-out (stop following / become leader)

**Files:**
- Create: `packages/webapp/src/ui/follower-switch-out.ts`
- Modify: `packages/webapp/src/ui/wc/wc-follower.ts` (install a follower-only `slicc:tray-leave` listener)
- Test: `packages/webapp/tests/ui/follower-switch-out.test.ts`

**Interfaces:**
- Consumes: `TRAY_JOIN_STORAGE_KEY`, `TRAY_WORKER_STORAGE_KEY` from `tray-runtime-config.ts`.
- Produces: `performFollowerSwitchOut(opts: { workerBaseUrl: string | null }, deps: { storage: RuntimeConfigStorage & { removeItem(k: string): void }; stopFollower: () => void; reload: () => void }): void`.

- [ ] **Step 1: Write the failing test**

Create `packages/webapp/tests/ui/follower-switch-out.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import {
  TRAY_JOIN_STORAGE_KEY,
  TRAY_WORKER_STORAGE_KEY,
} from '../../src/scoops/tray-runtime-config.js';
import { performFollowerSwitchOut } from '../../src/ui/follower-switch-out.js';

function memStorage(entries: Record<string, string> = {}) {
  const map = new Map(Object.entries(entries));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    has: (k: string) => map.has(k),
  };
}

describe('performFollowerSwitchOut', () => {
  it('stop following: clears BOTH keys, stops follower, reloads', () => {
    const storage = memStorage({ [TRAY_JOIN_STORAGE_KEY]: 'j', [TRAY_WORKER_STORAGE_KEY]: 'w' });
    const stopFollower = vi.fn();
    const reload = vi.fn();
    performFollowerSwitchOut({ workerBaseUrl: null }, { storage, stopFollower, reload });
    expect(storage.has(TRAY_JOIN_STORAGE_KEY)).toBe(false);
    expect(storage.has(TRAY_WORKER_STORAGE_KEY)).toBe(false);
    expect(stopFollower).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('become leader: clears join key, sets worker key, reloads (never starts leader in place)', () => {
    const storage = memStorage({ [TRAY_JOIN_STORAGE_KEY]: 'j' });
    const reload = vi.fn();
    performFollowerSwitchOut(
      { workerBaseUrl: 'https://www.sliccy.ai' },
      { storage, stopFollower: vi.fn(), reload }
    );
    expect(storage.has(TRAY_JOIN_STORAGE_KEY)).toBe(false);
    expect(storage.getItem(TRAY_WORKER_STORAGE_KEY)).toBe('https://www.sliccy.ai');
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/webapp/tests/ui/follower-switch-out.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the switch-out**

Create `packages/webapp/src/ui/follower-switch-out.ts`:

```typescript
import {
  type RuntimeConfigStorage,
  TRAY_JOIN_STORAGE_KEY,
  TRAY_WORKER_STORAGE_KEY,
} from '../scoops/tray-runtime-config.js';

type RemovableStorage = RuntimeConfigStorage & { removeItem(key: string): void };

export interface FollowerSwitchOutDeps {
  storage: RemovableStorage;
  stopFollower: () => void;
  reload: () => void;
}

/**
 * Switch a no-kernel follower out of follower mode by REWRITING storage and
 * RELOADING (a no-worker follower cannot promote to leader in place — the
 * leader path needs the kernel worker). `workerBaseUrl: null` → stop following
 * (boot plain standalone); a worker URL → become leader on next boot.
 */
export function performFollowerSwitchOut(
  opts: { workerBaseUrl: string | null },
  deps: FollowerSwitchOutDeps
): void {
  deps.stopFollower();
  deps.storage.removeItem(TRAY_JOIN_STORAGE_KEY);
  if (opts.workerBaseUrl === null) {
    deps.storage.removeItem(TRAY_WORKER_STORAGE_KEY);
  } else {
    deps.storage.setItem(TRAY_WORKER_STORAGE_KEY, opts.workerBaseUrl);
  }
  deps.reload();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/webapp/tests/ui/follower-switch-out.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the follower nav menu (the UI that triggers switch-out)**

A no-worker follower cannot call `wireWcNav` (it requires an `OffscreenClient`, `wc-nav.ts:67`). But the avatar-menu surface is page-side DOM: `refs.avatarMenu.items` is a settable array and it emits `slicc-avatar-action` with `detail.id`. The leader/follower nav already uses `id: 'tray-stop'` → dispatch `slicc:tray-leave` (`wc-nav.ts:280`). Wire a minimal follower-only nav in `mountWcUiFollower` (in `wc-follower.ts`, after the navigate-watcher block). Populate the menu and translate the action:

```typescript
  // Minimal follower nav: a single "Disconnect from leader" action that
  // dispatches the existing slicc:tray-leave event. (wireWcNav needs a worker
  // client; a follower has none, so we set the menu items directly.)
  boot.refs.avatarMenu.items = [
    { kind: 'separator' },
    { id: 'tray-stop', label: 'Disconnect from leader', icon: 'unplug', danger: true },
  ];
  boot.refs.avatarMenu.addEventListener('slicc-avatar-action', (event) => {
    const id = (event as CustomEvent<{ id?: string }>).detail?.id;
    if (id === 'tray-stop') {
      window.dispatchEvent(
        new CustomEvent('slicc:tray-leave', { detail: { workerBaseUrl: null } })
      );
    }
  });
```

- [ ] **Step 6: Install the follower-only `slicc:tray-leave` listener**

Also in `mountWcUiFollower`, add (do NOT call `wireWcTray`, which routes to `performTrayLeave`/`startLeader`):

```typescript
  window.addEventListener('slicc:tray-leave', (ev) => {
    const detail = (ev as CustomEvent<{ workerBaseUrl?: string | null }>).detail ?? {};
    performFollowerSwitchOut(
      { workerBaseUrl: detail.workerBaseUrl ?? null },
      {
        storage: window.localStorage,
        stopFollower: () => follower.stop(),
        reload: () => window.location.reload(),
      }
    );
  });
```

Add the import at the top: `import { performFollowerSwitchOut } from '../follower-switch-out.js';`

> "Become leader" is reachable later via the same event with a non-null `workerBaseUrl` (matching `wc-nav.ts:261`'s `tray-enable` action); the follower menu intentionally ships only "Disconnect" in v1 (YAGNI — a disconnected follower reloads to plain standalone, from which the normal "Enable multi-browser sync" leader flow is available).

- [ ] **Step 7: Typecheck + format + commit**

```bash
npx tsc --noEmit -p tsconfig.json
npx biome check --write packages/webapp/src/ui/follower-switch-out.ts packages/webapp/src/ui/wc/wc-follower.ts packages/webapp/tests/ui/follower-switch-out.test.ts
npx prettier --write packages/webapp/src/ui/follower-switch-out.ts packages/webapp/src/ui/wc/wc-follower.ts packages/webapp/tests/ui/follower-switch-out.test.ts
git add -A && git commit -m "feat(ui): storage-only follower switch-out + nav (#1107)"
```

---

### Task 7: Preview `open()` hook + docs + full verification

**Files:**
- Modify: `packages/webapp/src/ui/sprinkle-follower-controller.ts` (add an `open` option; use it in `createBridge`)
- Modify: `packages/webapp/src/ui/page-follower-tray.ts` (thread an `onOpen?` option through to `SprinkleFollowerController`)
- Modify: `packages/webapp/src/ui/wc/wc-follower.ts` (pass the follower `onOpen`)
- Modify: `packages/webapp/CLAUDE.md` (document the follower mode), `docs/architecture.md` (tray/sync section — note the no-kernel follower mount)
- Test: `packages/webapp/tests/ui/sprinkle-follower-controller.test.ts` (add an `open`-override case; create if absent) + full affected suite

**Interfaces:**
- Consumes: existing `SprinkleFollowerControllerOptions` (`sprinkle-follower-controller.ts:46`), the `createBridge` `open` site (`sprinkle-follower-controller.ts:424`: currently `const url = /^https?:|^chrome-extension:/.test(path) ? path : toPreviewUrl(path); window.open(url, '_blank');`).
- Produces: `SprinkleFollowerControllerOptions.open?: (path: string) => void`; `StartPageFollowerTrayOptions.onOpen?: (path: string) => void`.

> **Why a real hook (codex-verified):** there is **no** `open`/`onOpen` option today, and the current default maps relative paths to `/preview/*` and `window.open`s them — which 404s in a no-worker follower (no page VFS responder). Add the hook and have the follower pass a guard that only opens absolute URLs.

- [ ] **Step 1: Write the failing test**

Add to `packages/webapp/tests/ui/sprinkle-follower-controller.test.ts` a case asserting that when `options.open` is provided, the controller's bridge `open(path)` delegates to it (instead of `window.open` of a preview URL). Use the existing test's controller-construction pattern in that file; the key assertion:

```typescript
it('delegates bridge open() to the provided open option', () => {
  const open = vi.fn();
  // construct the controller with { sync, addSprinkle, removeSprinkle, open }
  // then drive the sprinkle bridge's open('foo/bar.html')
  // (reuse this file's existing helper for reaching the bridge)
  // ...
  expect(open).toHaveBeenCalledWith('foo/bar.html');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/webapp/tests/ui/sprinkle-follower-controller.test.ts`
Expected: FAIL — `open` is not an option / not honored.

- [ ] **Step 3: Add the `open` option + use it in `createBridge`**

In `packages/webapp/src/ui/sprinkle-follower-controller.ts`, add to `SprinkleFollowerControllerOptions`:

```typescript
  /**
   * Optional override for the sprinkle bridge's `open(path)`. A no-kernel
   * follower has no page VFS responder, so the default `/preview/*` mapping
   * 404s; the follower passes a guard that only opens absolute URLs.
   */
  open?: (path: string) => void;
```

Then in `createBridge`, replace the existing `open` with:

```typescript
      open: (path: string) => {
        if (this.#options.open) {
          this.#options.open(path);
          return;
        }
        const url = /^https?:|^chrome-extension:/.test(path) ? path : toPreviewUrl(path);
        window.open(url, '_blank');
      },
```

(Use whatever `this.#options` field name the file already uses for its options; match it.)

- [ ] **Step 4: Thread `onOpen` through `startPageFollowerTray`**

In `packages/webapp/src/ui/page-follower-tray.ts`, add `onOpen?: (path: string) => void;` to `StartPageFollowerTrayOptions` and pass it into the `new SprinkleFollowerController({ … , open: options.onOpen })` construction.

- [ ] **Step 5: Pass the follower `onOpen` from `mountWcUiFollower`**

In `packages/webapp/src/ui/wc/wc-follower.ts`, add to the `startPageFollowerTray({ … })` options:

```typescript
    onOpen: (path) => {
      if (/^https?:\/\//.test(path)) window.open(path, '_blank', 'noopener');
      else log.warn('follower sprinkle open() of a local path is unavailable', { path });
    },
```

- [ ] **Step 6: Run the sprinkle test + verify it passes**

Run: `npx vitest run packages/webapp/tests/ui/sprinkle-follower-controller.test.ts`
Expected: PASS.

- [ ] **Step 7: Update docs**

In `packages/webapp/CLAUDE.md`, under the UI / runtime-mode section, add a sentence: the `'follower'` runtime mode (a validated `/join/` URL or `?tray=`, plus `?cherry=1`) boots `mountWcUiFollower` — a no-kernel-worker page-side follower (chat + sprinkles + leader-driven CDP + page-side navigate-lick forwarding); switch-out is storage-only + reload; `/licks-ws` HTTP injection is not available in this mode.

In `docs/architecture.md` (Multi-Browser Sync / Tray section), add the no-kernel follower mount to the matrix.

- [ ] **Step 8: Run the full pre-PR gate**

```bash
npx tsc --noEmit -p tsconfig.json
npx vitest run packages/webapp/tests/ui/ packages/webapp/tests/scoops/tray-runtime-config.test.ts
npm run lint:docs
npm run build -w @slicc/webapp
```
Expected: all green.

- [ ] **Step 9: Commit**

```bash
npx biome check --write packages/webapp/src/ui/sprinkle-follower-controller.ts packages/webapp/src/ui/page-follower-tray.ts packages/webapp/src/ui/wc/wc-follower.ts packages/webapp/tests/ui/sprinkle-follower-controller.test.ts
npx prettier --write packages/webapp/src/ui/sprinkle-follower-controller.ts packages/webapp/src/ui/page-follower-tray.ts packages/webapp/src/ui/wc/wc-follower.ts packages/webapp/CLAUDE.md docs/architecture.md
git add -A && git commit -m "feat(ui): follower sprinkle open() hook + docs (#1107)"
```

---

## Self-Review

**Spec coverage:**
- Detection (3 shapes, `/join` vs `/tray`) → Task 1 + 2 ✓
- Early dispatch before OAuth bootstrap → Task 2 ✓
- No-worker mount (chat + sprinkles + browserAPI) → Task 3 ✓
- CDP navigate-lick watcher → Task 4 ✓
- Cherry fold-in → Task 5 ✓
- Storage-only switch-out → Task 6 ✓
- Preview `open()` + docs → Task 7 ✓
- `/licks-ws` scope cut → documented (Task 7), no code ✓
- Extension/iOS untouched → Global Constraints + no task touches them ✓

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to". Every code step shows real code against verified APIs (`prepareWcShell`, `WcChatController`, `WcSprinkleZone`, `submittedText`, `NavigationWatcher`, `setupStandalonePrelude` deps, `refs.avatarMenu.items` + `slicc-avatar-action`).

**Type consistency:** `resolveFollowerJoinUrl(href, storage?)` → `string | null` used identically in Tasks 1/2/3. `UiRuntimeMode` extended once (Task 2). `startFollowerNavigateWatcher(transport, getSync)` and `performFollowerSwitchOut(opts, deps)` signatures match their call sites. `LickEvent` navigate shape (`type`/`navigateUrl`/`targetScoop`/`timestamp`/`body`) matches `kernel/host.ts:620`. `SprinkleFollowerControllerOptions.open?` ↔ `StartPageFollowerTrayOptions.onOpen?` threaded consistently (Task 7).

**Post-review revision (codex plan review):** Task 2 null-storage semantics fixed (`storage === undefined` falls back to ambient, explicit `null` does not). Task 3 rewritten against real WC APIs (reuse `prepareWcShell`, never `setClient`; no-op `AgentHandle` swapped via `setChatAgent`; `WcSprinkleZone.callbacks()`; correct `setupStandalonePrelude` deps; jsdom + `installWcDomStubs`; `history.replaceState` not `Object.defineProperty(location)`). Task 6 adds the follower nav menu UI (sets `refs.avatarMenu.items`, handles `slicc-avatar-action`). Task 7 adds a real `open`/`onOpen` hook threaded controller→tray→mount.

**Remaining implementer judgement (called out, not hidden):** exact `WcChatController` method arg order (`addUserMessage`/`loadMessages`) — match `wc-tray.ts:buildFollowerOptions` while implementing; and the jsdom cross-origin URL set (use `@vitest-environment-options` `url` if `history.replaceState` rejects). Both are local, verifiable-at-implementation choices, not architectural unknowns.
