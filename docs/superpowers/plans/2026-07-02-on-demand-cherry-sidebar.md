# On-Demand Per-Page Cherry Sidebar — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking the Chrome-extension toolbar icon injects a connected, UI-only SLICC cherry sidebar into the current tab (opened), restoring a per-page sidebar on demand; closing it removes it; the agent still controls tabs via the real `chrome.debugger` CDP.

**Architecture:** The MV3 service worker toggles a per-tab cherry on icon-click. It injects an ISOLATED-world relay + a MAIN-world launcher entry via `chrome.scripting`. The relay carries the leader's tray `joinUrl` (delivered leader→SW over the existing `slicc.cdp-bridge` Port) to the MAIN launcher, which runs `mountSlicc({ iframe, joinToken, uiOnly:true })`. The UI-only cherry keeps its handshake/transport/chat but suppresses CDP target advertisement, so no weak synthetic target competes with the real `chrome.debugger` CDP. An active-tab marker lets the agent resolve "this page."

**Tech Stack:** TypeScript, MV3 (`chrome.scripting`, `chrome.storage.session`, `chrome.runtime` Ports), esbuild (extension bundles), Vitest (jsdom + node), `@ai-ecoverse/cherry` (host SDK), `@ai-ecoverse/spoon` (`<slicc-launcher>`), webapp cherry follower.

## Global Constraints

Every task's requirements implicitly include this section. Copy exact values.

- **Three change gates (mandatory, part of the task — not follow-up):** tests, docs, verification. Update the relevant `CLAUDE.md`/docs in the same task that changes behavior.
- **Four build gates before every commit:** `npm run typecheck`, `npm run test` (or the package's `vitest run`), `npm run build -w @slicc/webapp`, `npm run build -w @slicc/chrome-extension`. All must pass.
- **Lint first:** run `npx prettier --write <changed files>` before every commit (CI rejects unformatted code). Biome complexity gate applies to touched files — keep new functions small.
- **Coverage floors** in `coverage-thresholds.json` must not drop for any package. New source ships with mirrored `tests/`.
- **Framing/DNR invariant (load-bearing):** the cherry iframe URL MUST stay `…/?cherry=1&ui-only=1` — `ui-only=1` is **appended after** `cherry=1`. The static DNR rule relaxing `frame-ancestors` matches `urlFilter: "||sliccy.ai/?cherry=1"` (a prefix substring); reordering/prepending would break framing. The DNR `urlFilter` itself is unchanged.
- **Spoon stays cherry-free:** `packages/spoon/` must import nothing from `@ai-ecoverse/cherry`. The spoon↔cherry wiring lives in the extension's MAIN entry (Task 8).
- **No `content_scripts` in `manifest.json`:** injection stays programmatic; the existing "content_scripts disabled" test must keep passing.
- **Backward compatibility:** existing standalone/electron/third-party cherry-embed consumers must keep working. New spoon options and new `mountSlicc` options are **opt-in** (defaults preserve current behavior).
- **UI-only cherry advertises NO CDP target.** The agent controls tabs via real `chrome.debugger` CDP only.
- **Commit trailer (every commit):** end the message with
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Linear history:** rebase onto base; never merge base in.
- **Ice-cream vocabulary** in comments/docs where it matches (cone/scoop/lick/float/cherry).
- Planning artifacts under `docs/superpowers/` are branch-only (scrubbed from `main` by automation) — do not treat their absence on `main` as a bug.

---

## File Structure

**New files:**

- `packages/chrome-extension/src/relay-isolated.ts` — ISOLATED-world content script: `chrome.runtime.connect({ name: 'cherry-relay' })`, bridges SW ↔ MAIN via window `CustomEvent`s.
- `packages/chrome-extension/src/cherry-sidebar-main.ts` — MAIN-world entry (side-effect-free except element registration): registers `globalThis.__sliccCherrySidebar = { mount, unmount }`; `mount()` mounts `<slicc-launcher>` open + `mountSlicc({ iframe, joinToken, uiOnly:true })`.
- `packages/chrome-extension/src/cherry-relay-protocol.ts` — shared message-kind constants + types for the `cherry-relay` Port and the window `CustomEvent` names (imported by relay, SW, and MAIN; keeps names in one place).
- Test files mirrored under each package's `tests/` (named per task).

**Modified files:**

- `packages/cherry/src/index.ts` — `MountSliccOptions` gains `iframe?` + `uiOnly?`; relax the `container` requirement.
- `packages/cherry/src/mount.ts` — honor `iframe`/`uiOnly`.
- `packages/webapp/src/cdp/cherry-host-transport.ts` **or** the follower boot chain — read `ui-only=1` (see Task 2 for the exact site).
- `packages/webapp/src/ui/wc/wc-follower.ts` + `packages/webapp/src/ui/page-follower-tray.ts` — thread `uiOnly` to skip only the advertise loop.
- `packages/spoon/src/slicc-launcher.ts` — `open`-on-mount, `close` event, managed-iframe mode + iframe getter.
- `packages/chrome-extension/src/bridge-sw.ts` — active-tab marker in `cdpGetTargets`; `leader.join-url` branch in `handleBridgeMessage`.
- `packages/webapp/src/cdp/extension-bridge-protocol.ts` — new `leader.join-url` envelope kind.
- `packages/webapp/src/cdp/extension-bridge-transport.ts` — `sendLeaderJoinUrl(joinUrl)`.
- `packages/webapp/src/ui/wc/wc-tray.ts` + `packages/webapp/src/ui/page-leader-tray.ts` — fire `sendLeaderJoinUrl` on `onLeaderReady`/`onReconnected` (extension-bridge leader only).
- `packages/chrome-extension/manifest.json` — add `scripting` + `activeTab`.
- `packages/chrome-extension/src/chrome.d.ts` — declare `chrome.scripting`; add `port.sender` typing if missing.
- `packages/chrome-extension/src/service-worker.ts` — icon toggle, activated-set, `onUpdated`/`onRemoved`, joinUrl cache, `cherry-relay` Port handler.
- `packages/chrome-extension/vite.config.ts` — esbuild `closeBundle` plugins for the relay + MAIN entry (MAIN aliases `@ai-ecoverse/cherry`→src, marks `html2canvas-pro` external).
- `packages/chrome-extension/package.json` — add `@ai-ecoverse/cherry` dependency.
- Root `package.json` — add `@ai-ecoverse/cherry` to the `postinstall` pre-build list.
- Docs: `packages/chrome-extension/CLAUDE.md`, `packages/spoon/CLAUDE.md`, `packages/cherry/CLAUDE.md`, `packages/webapp/CLAUDE.md`, `docs/architecture.md`.

**Build/dependency note (settled):** the root `build` chain already builds `@ai-ecoverse/cherry` before `@slicc/chrome-extension`. To make isolated builds/typecheck robust, Task 10 adds cherry to the `postinstall` pre-builds (mirroring `@ai-ecoverse/spoon`) and declares the dependency; Task 8's esbuild MAIN plugin aliases `@ai-ecoverse/cherry` → `packages/cherry/src/index.ts` (mirroring the existing `@slicc/shared-ts` alias) and marks `html2canvas-pro` **external** (UI-only sets `screenshot:'none'`, so the lazy `import('html2canvas-pro')` path is never reached).

---

## Task 1: Cherry `mountSlicc` — `iframe` + `uiOnly` options

**Files:**

- Modify: `packages/cherry/src/index.ts` (`MountSliccOptions`, `mountSlicc` guard)
- Modify: `packages/cherry/src/mount.ts:25-33` (iframe creation)
- Test: `packages/cherry/tests/mount.test.ts` (add cases; create if absent — check for existing mount test first)

**Interfaces:**

- Produces: `MountSliccOptions` with optional `iframe?: HTMLIFrameElement` and `uiOnly?: boolean`; when `iframe` is given, `container` is optional and the provided iframe is used (not created/appended); when `uiOnly` is true the iframe URL is `…/?cherry=1&ui-only=1`.
- Consumed by: Task 8 (`cherry-sidebar-main.ts`).

- [ ] **Step 1: Write failing tests**

Add to `packages/cherry/tests/mount.test.ts` (jsdom). Use the `__test_post` seam already present.

```ts
import { mountSlicc } from '../src/index.js';

describe('mountSlicc iframe + uiOnly options', () => {
  it('uses a caller-provided iframe instead of creating one', () => {
    const iframe = document.createElement('iframe');
    const container = document.createElement('div');
    container.appendChild(iframe); // caller owns placement
    const before = document.querySelectorAll('iframe').length;
    const handle = mountSlicc({
      iframe,
      sliccOrigin: 'https://app.example.test',
      capabilities: { navigate: false, screenshot: 'none', openUrl: false },
      joinToken: 'https://w.example.test/join/tray.secret',
    });
    expect(handle.iframe).toBe(iframe); // same element, not a new one
    expect(document.querySelectorAll('iframe').length).toBe(before); // none created
    handle.destroy();
  });

  it('appends ui-only=1 AFTER cherry=1 when uiOnly is set', () => {
    const iframe = document.createElement('iframe');
    mountSlicc({
      iframe,
      uiOnly: true,
      sliccOrigin: 'https://app.example.test',
      capabilities: { navigate: false, screenshot: 'none', openUrl: false },
      joinToken: 'https://w.example.test/join/tray.secret',
    });
    const url = new URL(iframe.src);
    expect(url.searchParams.get('cherry')).toBe('1');
    expect(url.searchParams.get('ui-only')).toBe('1');
    // cherry must be the FIRST search param so the DNR ||sliccy.ai/?cherry=1 prefix matches
    expect(iframe.src).toContain('?cherry=1');
    expect(iframe.src.indexOf('cherry=1')).toBeLessThan(iframe.src.indexOf('ui-only=1'));
  });

  it('default (no uiOnly) does not append ui-only', () => {
    const iframe = document.createElement('iframe');
    mountSlicc({
      iframe,
      sliccOrigin: 'https://app.example.test',
      capabilities: { navigate: false, screenshot: 'none', openUrl: false },
      joinToken: 'https://w.example.test/join/tray.secret',
    });
    expect(new URL(iframe.src).searchParams.get('ui-only')).toBeNull();
  });

  it('still creates + appends an iframe when only container is given (backward compat)', () => {
    const container = document.createElement('div');
    const handle = mountSlicc({
      container,
      sliccOrigin: 'https://app.example.test',
      capabilities: { navigate: false, screenshot: 'none', openUrl: false },
      joinToken: 'https://w.example.test/join/tray.secret',
    });
    expect(container.querySelector('iframe')).toBe(handle.iframe);
    handle.destroy();
    expect(container.querySelector('iframe')).toBeNull(); // SDK-created iframe removed
  });

  it('destroy() does NOT remove a caller-provided iframe (caller owns it)', () => {
    const container = document.createElement('div');
    const iframe = document.createElement('iframe');
    container.appendChild(iframe);
    const handle = mountSlicc({
      iframe,
      sliccOrigin: 'https://app.example.test',
      capabilities: { navigate: false, screenshot: 'none', openUrl: false },
      joinToken: 'https://w.example.test/join/tray.secret',
    });
    handle.destroy();
    expect(container.querySelector('iframe')).toBe(iframe); // still attached
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm test -w @ai-ecoverse/cherry -- mount`
Expected: FAIL (new options not honored; provided-iframe case creates a second iframe or throws on missing container).

- [ ] **Step 3: Update the types** in `packages/cherry/src/index.ts`

In `MountSliccOptions` (currently L56-78), change `container` to optional and add the two options:

```ts
export interface MountSliccOptions {
  /** Element the follower iframe is appended to. Optional when `iframe` is provided. */
  container?: HTMLElement;
  /**
   * Caller-provided iframe to drive instead of creating one. When set, the SDK
   * uses this element (already placed in the DOM by the caller) and does not
   * create or append an iframe. Used by the extension's managed-launcher sidebar.
   */
  iframe?: HTMLIFrameElement;
  sliccOrigin: string;
  capabilities: HostCapabilities;
  hooks?: HostHooks;
  features?: CherryFeatures;
  theme?: SliccTheme;
  joinToken: string;
  /**
   * UI-only mode: append `ui-only=1` AFTER `cherry=1` to the follower URL so the
   * follower renders chat/UI but advertises no CDP target. MUST stay after
   * `cherry=1` (the DNR frame-ancestors relaxation matches the `?cherry=1` prefix).
   */
  uiOnly?: boolean;
}
```

Update the `mountSlicc` wrapper guard (L92-97) to require `container` **or** `iframe`:

```ts
export function mountSlicc(options: MountSliccOptions): SliccHandle {
  if (!options?.container && !options?.iframe) {
    throw new Error('mountSlicc: either options.container or options.iframe is required');
  }
  return mountSliccImpl(options);
}
```

- [ ] **Step 4: Honor the options** in `packages/cherry/src/mount.ts` — replace the iframe-creation block (L26-33)

```ts
const sdkCreatedIframe = !options.iframe;
const iframe = options.iframe ?? document.createElement('iframe');
const src = new URL(options.sliccOrigin);
src.searchParams.set('cherry', '1');
if (options.uiOnly) src.searchParams.set('ui-only', '1'); // appended AFTER cherry=1
iframe.src = src.toString();
if (sdkCreatedIframe) {
  // Only style + append an iframe the SDK created; a caller-provided iframe is
  // placed and sized by the caller (e.g. the spoon launcher's shadow DOM).
  iframe.style.border = '0';
  iframe.style.width = '100%';
  iframe.style.height = '100%';
  options.container?.appendChild(iframe);
}
```

(`URLSearchParams.set` preserves insertion order, so `cherry` stays first.)

- [ ] **Step 4b: Fix `destroy()` ownership** in `packages/cherry/src/mount.ts` (L181-184)

`destroy()` currently always calls `iframe.remove()`. A caller-provided iframe is owned by the caller (the spoon launcher), and Task 8 calls `destroy()` on every joinUrl change to remount — so it must NOT detach a borrowed iframe. Change:

```ts
    destroy() {
      window.removeEventListener('message', onMessage);
      if (sdkCreatedIframe) iframe.remove(); // never remove a caller-provided iframe
    },
```

- [ ] **Step 5: Run tests, verify pass**

Run: `npm test -w @ai-ecoverse/cherry -- mount`
Expected: PASS (all four cases).

- [ ] **Step 6: Docs** — update `packages/cherry/CLAUDE.md` "The `mountSlicc` surface" block to list `iframe?` and `uiOnly?` (opt-in, backward compatible; `ui-only=1` appended after `cherry=1`).

- [ ] **Step 7: Prettier + verify + commit**

```bash
npx prettier --write packages/cherry/src/index.ts packages/cherry/src/mount.ts packages/cherry/tests/mount.test.ts packages/cherry/CLAUDE.md
npm run typecheck && npm test -w @ai-ecoverse/cherry && npm run build -w @ai-ecoverse/cherry
git add packages/cherry docs # spec/plan may also be staged elsewhere
git commit -m "feat(cherry): mountSlicc iframe + uiOnly options for managed sidebar

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Cherry follower UI-only mode (webapp)

**Files:**

- Modify: `packages/webapp/src/ui/wc/wc-follower.ts` (read `ui-only=1`; thread a `uiOnly` flag into `startPageFollowerTray`)
- Modify: `packages/webapp/src/ui/page-follower-tray.ts` (skip ONLY the advertise loop when `uiOnly`)
- Test: `packages/webapp/tests/ui/page-follower-tray.test.ts` (advertise-suppression), `packages/webapp/tests/ui/wc/wc-follower.test.ts` (param read) — mirror existing test files; check names first.

**Interfaces:**

- Consumes: the `?cherry=1&ui-only=1` URL (Task 1 produces it; the follower loads inside the iframe).
- Produces: a follower that keeps handshake + transport + chat sync but sends **no** `targets.advertise`. Later verified live in Task 11.

**Background (verified):** `refreshTargets` (L297-320) calls `sync.advertiseTargets(buildAdvertisedTargets(...))` and is triggered by **two** paths: (a) the periodic `setInterval(() => void refreshTargets(), refreshIntervalMs)` at `page-follower-tray.ts:329-330`, and (b) the `onTargetsChanged: () => void refreshTargets()` callback wired at `page-follower-tray.ts:267`, which `FollowerSyncManager` invokes after a local `tab.open` (`tray-follower-sync.ts:968`). **Guarding only the interval is insufficient** — the `onTargetsChanged` path would still advertise. Chat sync (`setChatAgent` + `requestSnapshot`, L322-327) is independent. The cherry join/features flow through `prelude.cherryTransport` in `wc-follower.ts` (L179-211); `startPageFollowerTray` is called at L277-323.

- [ ] **Step 1: Write failing test — advertise suppression** in `packages/webapp/tests/ui/page-follower-tray.test.ts`

Add a case that wires the follower sync with a new `uiOnly: true` option and asserts `advertiseTargets` is never called while chat sync still runs. Use the existing test harness/mocks in that file (fake `browserAPI.listPages`, a fake `FollowerSyncManager` capturing `advertiseTargets`/`setChatAgent`/`requestSnapshot`). Skeleton:

```ts
it('uiOnly follower does not advertise targets but still syncs chat', async () => {
  const advertiseTargets = vi.fn();
  const requestSnapshot = vi.fn();
  const setChatAgent = vi.fn();
  // ... build options with uiOnly: true, a fake sync exposing the spies,
  //     _refreshIntervalMs: 5, browserAPI.listPages resolving to [{targetId,title,url}]
  // start the follower sync, advance timers past the refresh interval
  await vi.advanceTimersByTimeAsync(20);
  expect(advertiseTargets).not.toHaveBeenCalled(); // NO target advertised (interval path)
  expect(setChatAgent).toHaveBeenCalled(); // chat still wired
  expect(requestSnapshot).toHaveBeenCalled(); // transcript still pulled
});

it('uiOnly follower suppresses the onTargetsChanged advertise path too', async () => {
  const advertiseTargets = vi.fn();
  // build uiOnly options; capture the onTargetsChanged callback passed to the fake
  // FollowerSyncManager (it is wired at page-follower-tray.ts:267).
  const onTargetsChanged = captureOnTargetsChanged(); // from the fake sync ctor args
  await onTargetsChanged(); // simulate a local tab.open triggering a refresh
  expect(advertiseTargets).not.toHaveBeenCalled(); // guarded refreshTargets bails
});
```

Also add the mirror positive-control assertion in an existing non-uiOnly case (advertise IS called on the interval AND when `onTargetsChanged` fires) if not already covered, so the suppression is meaningful.

- [ ] **Step 2: Run test, verify fail**

Run: `npm test -w @slicc/webapp -- page-follower-tray`
Expected: FAIL (`uiOnly` option unknown; advertise still fires).

- [ ] **Step 3: Add `uiOnly` to the follower-sync options + suppress every advertise path** in `page-follower-tray.ts`

- Add `uiOnly?: boolean` to the options type consumed by `wireFollowerSync`/`startPageFollowerTray` (find the options interface near the top of the file).
- **Guard `refreshTargets` itself** so BOTH trigger paths (the interval AND `onTargetsChanged`) are suppressed. At the top of `refreshTargets` (L297):

```ts
const refreshTargets = async () => {
  if (options.uiOnly) return; // UI-only follower advertises no CDP target
  // ...existing body unchanged...
};
```

- Also skip creating the interval (avoid a pointless 5s no-op timer) — wrap L329-330:

```ts
if (!options.uiOnly) {
  targetRefreshInterval = setInterval(() => void refreshTargets(), refreshIntervalMs);
  void refreshTargets();
}
```

Guarding `refreshTargets` is the load-bearing fix; skipping the interval is a minor optimization. Leave `detachSync`'s `clearInterval` as-is (harmless when the interval was never set). The `onTargetsChanged: () => void refreshTargets()` wiring at L267 stays — it becomes a no-op under `uiOnly` via the guard.

- Do NOT touch the chat-sync block (L322-327: `activeSync`, `setTrayTargetProvider`, `setChatAgent`, `onForwardingToggle`, `onConnectionChange`, `requestSnapshot`). `setTrayTargetProvider(sync)` at L323 is fine to keep (it only wires the provider; no target is federated without an advertise push).

- [ ] **Step 4: Read `ui-only=1` and thread it** in `wc-follower.ts`

After `const isCherry = runtimeMode === 'cherry';` (L174), derive:

```ts
const uiOnly = isCherry && new URLSearchParams(window.location.search).get('ui-only') === '1';
```

Pass `uiOnly` into the `startPageFollowerTray({ ... })` call (L277-323): add `uiOnly,` to the options object. (Keep everything else, including `onCherrySliccEvent` and the host-event wiring at L325-327, unchanged.)

- [ ] **Step 5: Run tests, verify pass**

Run: `npm test -w @slicc/webapp -- page-follower-tray wc-follower`
Expected: PASS.

- [ ] **Step 6: Docs** — in `packages/webapp/CLAUDE.md`, add a short note under the cherry/follower section: `?cherry=1&ui-only=1` boots a chat-only follower (handshake + transport + chat retained; target advertisement suppressed) so the extension controls the tab via real `chrome.debugger` CDP.

- [ ] **Step 7: Prettier + verify + commit**

```bash
npx prettier --write packages/webapp/src/ui/wc/wc-follower.ts packages/webapp/src/ui/page-follower-tray.ts packages/webapp/tests/ui/page-follower-tray.test.ts packages/webapp/CLAUDE.md
npm run typecheck && npm test -w @slicc/webapp -- page-follower-tray wc-follower && npm run build -w @slicc/webapp
git add packages/webapp
git commit -m "feat(webapp): cherry ui-only follower suppresses CDP target advertisement

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Spoon `<slicc-launcher>` — open-on-mount, close event, managed iframe

**Files:**

- Modify: `packages/spoon/src/slicc-launcher.ts`
- Test: `packages/spoon/tests/slicc-launcher.test.ts` (mirror existing; check name)

**Interfaces:**

- Produces (all opt-in, backward compatible):
  - `open-on-mount`: setting the `open` attribute before `connectedCallback` (or a new `open-on-connect` attribute) makes the sidebar render open. (The existing reflected `open` attribute already gates the CSS; verify that setting it before connect shows the sidebar without a click.)
  - a **`slicc-launcher-close`** event (detail `void`, `bubbles:true, composed:true`) fired when the user closes the sidebar; the consumer's default is teardown/removal (NOT collapse-to-button).
  - a **managed-iframe** mode: a boolean attribute/property `managed` (or `managed-iframe`) that makes the launcher NOT set `iframe.src` from `app-url`, and a public getter `get managedIframe(): HTMLIFrameElement` returning its internal iframe so an external caller (the extension MAIN entry) can drive it via `mountSlicc({ iframe })`.
- Consumed by: Task 8.

**Constraint:** spoon imports nothing from cherry. Legacy `appUrl` consumers keep the floating-button + collapse behavior when the new opts are unset.

- [ ] **Step 1: Write failing tests** in `packages/spoon/tests/slicc-launcher.test.ts` (jsdom)

```ts
import '../src/slicc-launcher.js'; // registers <slicc-launcher>

function mount(attrs: Record<string, string> = {}) {
  const el = document.createElement('slicc-launcher');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  return el as any;
}

describe('slicc-launcher new capabilities', () => {
  afterEach(() => (document.body.innerHTML = ''));

  it('open-on-mount: renders open when the open attribute is present at connect', () => {
    const el = mount({ open: '' });
    expect(el.hasAttribute('open')).toBe(true);
    expect(el.open).toBe(true);
  });

  it('fires slicc-launcher-close when the sidebar is closed via the close affordance', () => {
    const el = mount({ open: '' });
    const onClose = vi.fn();
    el.addEventListener('slicc-launcher-close', onClose);
    el.requestClose(); // new public method invoked by the close affordance
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('managed mode does NOT set iframe.src from app-url and exposes a visible iframe', () => {
    const el = mount({ managed: '', 'app-url': 'https://should-be-ignored.test/' });
    const iframe = el.managedIframe as HTMLIFrameElement;
    expect(iframe).toBeInstanceOf(HTMLIFrameElement);
    expect(iframe.getAttribute('src')).toBeNull(); // launcher did not set src in managed mode
    expect(iframe.hidden).toBe(false); // iframe revealed for the external owner
    // the "Set the app-url…" empty placeholder must be hidden so it can't cover the iframe
    const empty = el.shadowRoot!.querySelector('.empty') as HTMLElement;
    expect(empty.hidden).toBe(true);
  });

  it('backward compat: non-managed launcher still sets iframe.src from app-url', () => {
    const el = mount({ 'app-url': 'https://app.test/x' });
    expect((el.managedIframe as HTMLIFrameElement).src).toContain('https://app.test/x');
  });

  it('backward compat: default (no open) stays collapsed to the button', () => {
    const el = mount();
    expect(el.open).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests, verify fail**

Run: `npm test -w @ai-ecoverse/spoon -- slicc-launcher`
Expected: FAIL (`managed`, `managedIframe`, `requestClose`, `slicc-launcher-close` absent).

- [ ] **Step 3: Implement in `slicc-launcher.ts`**

- Add `'managed'` to `observedAttributes`.
- Add a `managed` boolean getter/setter reflecting the attribute (mirror the `open` getter/setter at L370-377).
- Add `get managedIframe(): HTMLIFrameElement { return this.#iframe; }`.
- In `#syncIframe()` (L489-502), handle managed mode: do NOT set/remove `src` from `app-url` (the external owner drives it), but still **reveal the iframe and hide the `.empty` placeholder** — otherwise the "Set the app-url…" placeholder covers the externally-driven iframe (verify the exact show/hide toggles the existing method uses — e.g. `this.#empty.hidden`/a CSS class — and mirror them):

```ts
  #syncIframe(): void {
    if (this.managed) {
      // External owner (mountSlicc) drives the iframe src; just show the iframe
      // and hide the empty-state placeholder so it isn't covered.
      this.#empty.hidden = true;
      this.#iframe.hidden = false; // match whatever visibility toggle the file uses
      return;
    }
    // ...existing app-url logic unchanged...
  }
```

- Add a `requestClose()` public method and a `#emitClose()` that dispatches the new event, then closes:

```ts
  requestClose(): void {
    this.open = false;             // collapse the CSS
    this.#emitClose();
  }
  #emitClose(): void {
    this.dispatchEvent(
      new CustomEvent('slicc-launcher-close', { bubbles: true, composed: true })
    );
  }
```

- Wire the existing close affordance: the backdrop click currently calls `hide()` (see `#build`, backdrop `click→hide`). For managed sidebars we want a close _button_. Add a close button inside the sidebar header in `#build()` whose click calls `this.requestClose()`. Keep `hide()`/backdrop behavior for legacy consumers (backdrop `click` should call `requestClose()` too so managed consumers get the close event; verify legacy collapse still works because the consumer that wants collapse simply does not listen for `slicc-launcher-close`). Export a `LauncherCloseDetail = void` type if the file exports detail types (it exports `LauncherToggleDetail`/`LauncherMoveDetail`).
- `open-on-mount`: confirm `connectedCallback` (L~333) does not clear a pre-set `open` attribute. If `#build`/connect currently forces collapsed, adjust so a pre-set `open` attribute renders open. Add the tiny fix only if the test in Step 1 fails on it.

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test -w @ai-ecoverse/spoon -- slicc-launcher`
Expected: PASS.

- [ ] **Step 5: Update the spoon barrel** — if a new detail type is exported, add it to `packages/spoon/src/index.ts` exports from `./slicc-launcher.js`.

- [ ] **Step 6: Docs** — `packages/spoon/CLAUDE.md`: document the opt-in `open`-on-mount, the `slicc-launcher-close` event (consumer default = teardown), and `managed`/`managedIframe` (external iframe ownership). State spoon stays cherry-free.

- [ ] **Step 7: Prettier + verify + commit**

```bash
npx prettier --write packages/spoon/src/slicc-launcher.ts packages/spoon/src/index.ts packages/spoon/tests/slicc-launcher.test.ts packages/spoon/CLAUDE.md
npm run typecheck && npm test -w @ai-ecoverse/spoon && npm run build -w @ai-ecoverse/spoon
git add packages/spoon
git commit -m "feat(spoon): launcher open-on-mount, close event, managed-iframe mode

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Active-tab marker in the extension

**Files:**

- Modify: `packages/chrome-extension/src/bridge-sw.ts` (`cdpGetTargets`, `deps`, `buildDefaultBridgeSwDeps`)
- Verify/modify: `packages/webapp/src/cdp/browser-api.ts` (`listPages` must carry `active` from targetInfo to page) and confirm `playwright/handlers/tabs.ts:114` reads `p.active`.
- Test: `packages/chrome-extension/tests/bridge-sw.test.ts` (cdpGetTargets marks active), and a webapp `list-tabs` render test if the mapping needs a change.

**Interfaces:**

- Produces: `cdpGetTargets` sets `active: true` on the focused tab's targetInfo (via `chrome.tabs.query({ active:true, lastFocusedWindow:true })`); the marker flows through `BrowserAPI.listPages` so `playwright list-tabs` renders ` (active)`.
- Consumed by: the agent resolving "this page" (behavioral; verified in Task 11).

**Background (verified):** `cdpGetTargets` (bridge-sw.ts L469-484) maps tabs to `{ targetId: String(t.id), type:'page', title, url, attached:false }` with no `active`. `deps.queryTabs = () => chrome.tabs.query({})` (L238). `currentWindow` is empty from a SW → must use `lastFocusedWindow`.

- [ ] **Step 1: Write failing test** in `packages/chrome-extension/tests/bridge-sw.test.ts`

Add a `deps` mock with a new `queryActiveTabId` and assert marking:

```ts
it('cdpGetTargets marks the lastFocusedWindow active tab', async () => {
  const deps = makeDeps({
    queryTabs: async () => [
      { id: 1, title: 'a', url: 'https://a.test' },
      { id: 2, title: 'b', url: 'https://b.test' },
    ],
    queryActiveTabId: async () => 2,
  });
  const { targetInfos } = await cdpGetTargets(makeState(), deps);
  expect(targetInfos.find((t) => t.targetId === '2')?.active).toBe(true);
  expect(targetInfos.find((t) => t.targetId === '1')?.active).toBe(false);
});
```

- [ ] **Step 2: Run test, verify fail**

Run: `npm test -w @slicc/chrome-extension -- bridge-sw`
Expected: FAIL (`queryActiveTabId` unknown; no `active` field).

- [ ] **Step 3: Implement** in `bridge-sw.ts`

- Add `queryActiveTabId: () => Promise<number | undefined>` to `BridgeSwDeps`.
- In `buildDefaultBridgeSwDeps` (L238-ish) wire it:

```ts
    queryActiveTabId: async () => {
      const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return typeof t?.id === 'number' ? t.id : undefined;
    },
```

- In `cdpGetTargets` add the marker:

```ts
async function cdpGetTargets(
  _state: PortState,
  deps: BridgeSwDeps
): Promise<Record<string, unknown>> {
  const [tabs, activeId] = await Promise.all([deps.queryTabs(), deps.queryActiveTabId()]);
  const targetInfos = tabs
    .filter((t): t is ChromeTab & { id: number } => typeof t.id === 'number')
    .map((t) => ({
      targetId: String(t.id),
      type: 'page' as const,
      title: t.title ?? '',
      url: t.url ?? '',
      attached: false,
      active: t.id === activeId,
    }));
  return { targetInfos };
}
```

- [ ] **Step 4: Carry `active` through `BrowserAPI.listPages`** (webapp)

Inspect `packages/webapp/src/cdp/browser-api.ts` `listPages`/`listAllTargets` (L196-218) mapping from `Target.getTargets` `targetInfos` to page objects. Ensure the page object includes `active: info.active ?? false`. If `playwright/handlers/tabs.ts:114` reads `p.active` and the page type lacks it, add `active?: boolean` to the page type and map it. Add/adjust the smallest mapping needed.

- [ ] **Step 5: `list-tabs` render test** (webapp) — if Step 4 changed the mapping, add/extend a test in `packages/webapp/tests/.../tabs.test.ts` asserting a page with `active:true` renders the ` (active)` marker.

- [ ] **Step 6: Run tests, verify pass**

Run: `npm test -w @slicc/chrome-extension -- bridge-sw && npm test -w @slicc/webapp -- tabs browser-api`
Expected: PASS.

- [ ] **Step 7: Docs** — note in `packages/chrome-extension/CLAUDE.md` that `cdpGetTargets` marks the `lastFocusedWindow` active tab so `list-tabs` shows `(active)` and cherry prompts can resolve "this page."

- [ ] **Step 8: Prettier + verify + commit**

```bash
npx prettier --write packages/chrome-extension/src/bridge-sw.ts packages/webapp/src/cdp/browser-api.ts packages/chrome-extension/tests/bridge-sw.test.ts packages/chrome-extension/CLAUDE.md
npm run typecheck && npm test -w @slicc/chrome-extension -- bridge-sw && npm test -w @slicc/webapp -- tabs browser-api && npm run build -w @slicc/webapp && npm run build -w @slicc/chrome-extension
git add packages/chrome-extension packages/webapp
git commit -m "feat(extension): active-tab marker in cdpGetTargets for list-tabs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Leader → SW joinUrl over the bridge Port

**Files:**

- Modify: `packages/webapp/src/cdp/extension-bridge-protocol.ts` (new envelope kind)
- Modify: `packages/webapp/src/cdp/extension-bridge-transport.ts` (`sendLeaderJoinUrl`)
- Modify: `packages/webapp/src/ui/wc/wc-tray.ts` + `packages/webapp/src/ui/page-leader-tray.ts` (fire on ready/reconnect)
- Modify: `packages/chrome-extension/src/bridge-sw.ts` (`handleBridgeMessage` branch; store joinUrl into state; expose it to the SW)
- Test: `packages/webapp/tests/cdp/extension-bridge-protocol.test.ts`, `.../extension-bridge-transport.test.ts`, `packages/chrome-extension/tests/bridge-sw.test.ts`

**Interfaces:**

- Produces: SW-side `leaderJoinUrl` (string | null) received from the pinned leader tab's bridge Port; a `BridgeSwDeps.onLeaderJoinUrl(joinUrl, tabId)` callback the SW (Task 9) supplies to cache + push it.
- Consumes: `session.joinUrl` from `LeaderTraySession` (produced by `LeaderTrayManager` `onLeaderReady`/`onReconnected`), and the `ExtensionBridgeTransport` instance in `wc-tray.ts` `leaderOptions` scope.

**Background (verified):** `EXTENSION_BRIDGE_PORT_NAME = 'slicc.cdp-bridge'`, protocol version `1` in `extension-bridge-protocol.ts` (has an `ExtensionBridgeEnvelope` union + `KINDS` set + `isExtensionBridgeEnvelope`). `ExtensionBridgeTransport` holds `portHolder.port` (private) + `channelId` (private); `connect()` posts the handshake via `port.postMessage`. SW `handleBridgeMessage` (bridge-sw.ts L350-440): after handshake it only accepts `cdp.request` (`if (env.kind !== 'cdp.request') return;` L418) after a channelId check (L419). The extension-bridge leader and the tray `LeaderTrayManager` coexist in the pinned tab; `wc-tray.ts` `leaderOptions` already holds `deps.browser`/`deps.realCdpTransport` (the ExtensionBridgeTransport).

- [ ] **Step 1: Write failing protocol test** in `extension-bridge-protocol.test.ts`

```ts
it('accepts a leader.join-url envelope', () => {
  expect(
    isExtensionBridgeEnvelope({
      bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
      channelId: 'c1',
      kind: 'leader.join-url',
      joinUrl: 'https://w.test/join/t.secret',
    })
  ).toBe(true);
});
it('accepts a leader.join-url envelope with null joinUrl (tray dropped)', () => {
  expect(
    isExtensionBridgeEnvelope({
      bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
      channelId: 'c1',
      kind: 'leader.join-url',
      joinUrl: null,
    })
  ).toBe(true);
});
```

- [ ] **Step 2: Run, verify fail** — `npm test -w @slicc/webapp -- extension-bridge-protocol` → FAIL.

- [ ] **Step 3: Add the kind** in `extension-bridge-protocol.ts`

- Extend the `ExtensionBridgeEnvelope` union with:

```ts
  | {
      bridge: typeof EXTENSION_BRIDGE_PROTOCOL_VERSION;
      channelId: string;
      kind: 'leader.join-url';
      joinUrl: string | null;
    }
```

- Add `'leader.join-url'` to the `KINDS` set (L107-115) so `isExtensionBridgeEnvelope` accepts it.

- [ ] **Step 4: Run, verify pass** — protocol test PASS.

- [ ] **Step 5: Write failing transport tests** in `extension-bridge-transport.test.ts`

```ts
it('sendLeaderJoinUrl posts a leader.join-url envelope over the port', async () => {
  // use the existing connect() test harness (fake connectFn returning a fake port
  // that records postMessage). connect(), then:
  transport.sendLeaderJoinUrl('https://w.test/join/t.secret');
  expect(fakePort.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'leader.join-url', joinUrl: 'https://w.test/join/t.secret' })
  );
});
it('sendLeaderJoinUrl before connect remembers the value and does not throw', () => {
  expect(() => transport.sendLeaderJoinUrl('https://w.test/join/t.secret')).not.toThrow();
});
it('re-sends the last joinUrl automatically after a bridge reconnect', async () => {
  await transport.connect(); // first connect + handshake
  transport.sendLeaderJoinUrl('https://w.test/join/t.secret');
  fakePort.disconnect(); // simulate SW eviction dropping the port
  fakePort.postMessage.mockClear();
  await transport.connect(); // reconnect + fresh handshake
  // the transport must re-deliver the remembered joinUrl to the freshly-woken SW
  expect(fakePort.postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'leader.join-url', joinUrl: 'https://w.test/join/t.secret' })
  );
});
```

- [ ] **Step 6: Implement `sendLeaderJoinUrl` + reconnect re-send** in `extension-bridge-transport.ts`

Add a private `#lastJoinUrl: string | null = null` field. `sendLeaderJoinUrl` remembers it (so a reconnect can replay) and posts if connected:

```ts
  /** Push the leader's tray joinUrl to the SW so injected cherry sidebars can join. */
  sendLeaderJoinUrl(joinUrl: string | null): void {
    this.#lastJoinUrl = joinUrl; // remembered so a Port reconnect can replay it
    const port = this.portHolder.port;
    if (!port) return; // not connected yet; replayed on the next successful connect()
    port.postMessage({
      bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
      channelId: this.channelId,
      kind: 'leader.join-url',
      joinUrl,
    });
  }
```

Then, in `connect()` — **after** the handshake completes (the SW pins `channelId` on `handshake.welcome`, and the SW's `leader.join-url` branch is post-handshake) — replay the remembered value so a Port that reconnected after SW eviction re-delivers it without waiting for the tray to re-fire:

```ts
// ...existing connect()/handshake body...
if (this.#lastJoinUrl !== null) {
  // MV3: the SW can be evicted and lose its joinUrl cache while the tray
  // session (and this transport) stay alive. Replay on every (re)connect.
  this.sendLeaderJoinUrl(this.#lastJoinUrl);
}
```

(Confirm the exact post-handshake point in `connect()` — insert the replay after the `await` that resolves on `handshake.welcome`, before `connect()` returns.)

- [ ] **Step 7: Run, verify pass** — transport test PASS.

- [ ] **Step 8: Fire it from the tray leader callbacks** (webapp UI)

In `wc-tray.ts` `leaderOptions(workerBaseUrl)` (L124-198), the transport is available as `deps.realCdpTransport`. It is a generic transport type; guard on the new method so only the extension-bridge leader sends:

```ts
const pushJoinUrl = (session: LeaderTraySession) => {
  const t = deps.realCdpTransport as { sendLeaderJoinUrl?: (u: string | null) => void };
  t?.sendLeaderJoinUrl?.(session.joinUrl);
};
```

Compose `pushJoinUrl` into the existing `onLeaderReady` and `onReconnected` options (do NOT overwrite an existing callback — call both). `onReconnected` is currently set in `page-leader-tray.ts:285`; ensure that path also calls `pushJoinUrl`. If `onLeaderReady`/`onReconnected` are only assembled in one place, add `pushJoinUrl(session)` there; otherwise thread a small `onSession` hook. Also send `null` on `onReconnectGaveUp` (tray dropped) so the SW clears its cache.

- [ ] **Step 9: SW-side receive branch** in `bridge-sw.ts` `handleBridgeMessage`

Add `onLeaderJoinUrl?: (joinUrl: string | null, tabId: number | undefined) => void` to `BridgeSwDeps`. After the post-handshake channelId check (L419), before the `cdp.request` handling, add:

```ts
if (env.kind === 'leader.join-url') {
  deps.onLeaderJoinUrl?.(env.joinUrl, port.sender?.tab?.id);
  return;
}
```

(Keep the existing `if (env.kind !== 'cdp.request') return;` after this branch.) The SW (Task 9) validates `tabId === storedLeaderTabId` before caching.

- [ ] **Step 10: Write failing SW-branch test** in `bridge-sw.test.ts`

Send a `leader.join-url` envelope through the handled port after handshake; assert `deps.onLeaderJoinUrl` is called with the joinUrl and the sender tab id; assert `cdp.request` handling is unaffected.

- [ ] **Step 11: Run all touched tests, verify pass**

Run: `npm test -w @slicc/webapp -- extension-bridge && npm test -w @slicc/chrome-extension -- bridge-sw`
Expected: PASS.

- [ ] **Step 12: `chrome.d.ts`** — ensure `port.sender?.tab?.id` typechecks. Add `sender?: { tab?: { id?: number }; origin?: string }` to the Port type in `packages/chrome-extension/src/chrome.d.ts` if absent.

- [ ] **Step 13: Docs** — `packages/chrome-extension/CLAUDE.md`: document the `leader.join-url` bridge-Port control message (leader → SW, over the existing `slicc.cdp-bridge` Port; validated against the stored leader tab id).

- [ ] **Step 14: Prettier + verify + commit**

```bash
npx prettier --write packages/webapp/src/cdp/extension-bridge-protocol.ts packages/webapp/src/cdp/extension-bridge-transport.ts packages/webapp/src/ui/wc/wc-tray.ts packages/webapp/src/ui/page-leader-tray.ts packages/chrome-extension/src/bridge-sw.ts packages/chrome-extension/src/chrome.d.ts packages/chrome-extension/CLAUDE.md packages/webapp/tests/cdp/extension-bridge-protocol.test.ts packages/webapp/tests/cdp/extension-bridge-transport.test.ts packages/chrome-extension/tests/bridge-sw.test.ts
npm run typecheck && npm test -w @slicc/webapp -- extension-bridge && npm test -w @slicc/chrome-extension -- bridge-sw && npm run build -w @slicc/webapp && npm run build -w @slicc/chrome-extension
git add packages/webapp packages/chrome-extension
git commit -m "feat(extension): deliver leader tray joinUrl to SW over the bridge port

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Manifest + `chrome.scripting` types

**Files:**

- Modify: `packages/chrome-extension/manifest.json` (add `scripting`, `activeTab`)
- Modify: `packages/chrome-extension/src/chrome.d.ts` (declare `chrome.scripting`)
- Test: `packages/chrome-extension/tests/manifest.test.ts` (or the existing manifest/content-script test)

**Interfaces:**

- Produces: the `chrome.scripting.executeScript` capability and its types used by Task 9.

- [ ] **Step 1: Write failing test** — extend the manifest test:

```ts
it('declares scripting + activeTab and still no content_scripts', () => {
  const m = readManifest();
  expect(m.permissions).toContain('scripting');
  expect(m.permissions).toContain('activeTab');
  expect(m.content_scripts).toBeUndefined(); // injection stays programmatic
});
```

- [ ] **Step 2: Run, verify fail** — `npm test -w @slicc/chrome-extension -- manifest` → FAIL.

- [ ] **Step 3: Edit `manifest.json`** — add `"scripting"` and `"activeTab"` to `permissions` (keep the rest). Do NOT add `content_scripts`.

- [ ] **Step 4: Declare `chrome.scripting`** in `chrome.d.ts` — add to the `ChromeAPI` interface:

```ts
  scripting: {
    executeScript(injection: {
      target: { tabId: number; allFrames?: boolean };
      files?: string[];
      func?: () => void;
      world?: 'ISOLATED' | 'MAIN';
      injectImmediately?: boolean;
    }): Promise<Array<{ result?: unknown }>>;
  };
```

- [ ] **Step 5: Run tests + typecheck, verify pass**

Run: `npm test -w @slicc/chrome-extension -- manifest && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Docs** — mention the new `scripting`/`activeTab` permissions in `packages/chrome-extension/CLAUDE.md` (why: programmatic per-tab injection).

- [ ] **Step 7: Prettier + commit**

```bash
npx prettier --write packages/chrome-extension/manifest.json packages/chrome-extension/src/chrome.d.ts packages/chrome-extension/tests/manifest.test.ts packages/chrome-extension/CLAUDE.md
npm run typecheck && npm test -w @slicc/chrome-extension -- manifest
git add packages/chrome-extension
git commit -m "feat(extension): add scripting + activeTab permissions and scripting types

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: ISOLATED relay + shared relay protocol

**Files:**

- Create: `packages/chrome-extension/src/cherry-relay-protocol.ts`
- Create: `packages/chrome-extension/src/relay-isolated.ts`
- Modify: `packages/chrome-extension/vite.config.ts` (esbuild closeBundle for the relay)
- Test: `packages/chrome-extension/tests/relay-isolated.test.ts`

**Interfaces:**

- Produces the relay contract:
  - Port name `'cherry-relay'`.
  - SW→relay Port messages: `{ kind: 'join-url'; joinUrl: string | null }`, `{ kind: 'teardown' }`.
  - relay→SW Port messages: `{ kind: 'close' }`.
  - window `CustomEvent`s (relay ↔ MAIN, Task 8): `slicc:cherry-joinurl` (`{ joinUrl }`), `slicc:cherry-teardown` (void), `slicc:cherry-close` (void, MAIN→relay), `slicc:cherry-mounted` (void, MAIN→relay "ready" ping).
- Consumed by: Task 8 (MAIN) and Task 9 (SW).

- [ ] **Step 1: Write the protocol module** `cherry-relay-protocol.ts`

```ts
// Shared names/types for the cherry-relay Port (SW ↔ ISOLATED relay) and the
// window CustomEvents (ISOLATED relay ↔ MAIN launcher entry). One source of truth.
export const CHERRY_RELAY_PORT_NAME = 'cherry-relay';

export type SwToRelayMessage = { kind: 'join-url'; joinUrl: string | null } | { kind: 'teardown' };
export type RelayToSwMessage = { kind: 'close' };

export const CHERRY_EVT = {
  joinUrl: 'slicc:cherry-joinurl',
  teardown: 'slicc:cherry-teardown',
  close: 'slicc:cherry-close',
  mounted: 'slicc:cherry-mounted',
} as const;

export interface CherryJoinUrlDetail {
  joinUrl: string;
}
```

- [ ] **Step 2: Write failing relay test** `relay-isolated.test.ts` (jsdom; mock `chrome.runtime.connect`)

Assert: on module init the relay `connect`s with `{ name: 'cherry-relay' }`; a Port `join-url` message dispatches a `slicc:cherry-joinurl` window event with the joinUrl; a Port `teardown` dispatches `slicc:cherry-teardown`; a window `slicc:cherry-close` posts `{ kind:'close' }` to the Port; a window `slicc:cherry-mounted` triggers a re-request/re-emit of the last joinUrl (buffer). Skeleton:

```ts
it('relays SW join-url to a MAIN CustomEvent', async () => {
  const evt = new Promise<CustomEvent>((res) =>
    window.addEventListener('slicc:cherry-joinurl', (e) => res(e as CustomEvent), { once: true })
  );
  fakePort.onMessage.emit({ kind: 'join-url', joinUrl: 'https://w/join/t.s' });
  expect((await evt).detail.joinUrl).toBe('https://w/join/t.s');
});
it('forwards MAIN close to the SW port', () => {
  window.dispatchEvent(new CustomEvent('slicc:cherry-close'));
  expect(fakePort.postMessage).toHaveBeenCalledWith({ kind: 'close' });
});
it('re-emits the buffered joinUrl when MAIN signals mounted', () => {
  fakePort.onMessage.emit({ kind: 'join-url', joinUrl: 'https://w/join/t.s' });
  const spy = vi.fn();
  window.addEventListener('slicc:cherry-joinurl', spy);
  window.dispatchEvent(new CustomEvent('slicc:cherry-mounted'));
  expect(spy).toHaveBeenCalled(); // handles MAIN mounting after joinUrl arrived
});
```

Design the relay for testability: export an `initRelay(connect = chrome.runtime.connect, win = window)` that the module calls at top level with defaults; the test calls `initRelay(fakeConnect, window)`.

- [ ] **Step 3: Run, verify fail** — FAIL (module absent).

- [ ] **Step 4: Implement `relay-isolated.ts`**

```ts
import {
  CHERRY_RELAY_PORT_NAME,
  CHERRY_EVT,
  type SwToRelayMessage,
} from './cherry-relay-protocol.js';

// The ISOLATED content-script world is REUSED across repeated executeScript
// injections on the same live document (off→on toggle without a reload). Re-running
// initRelay would stack Ports + window listeners → stale joinUrl replays + double
// close. Guard with a per-world cleanup sentinel: tear the previous relay down first.
interface RelayGlobal {
  __sliccCherryRelayCleanup?: () => void;
}

export function initRelay(
  connect: typeof chrome.runtime.connect = chrome.runtime.connect,
  win: Window = window,
  scope: RelayGlobal = globalThis as RelayGlobal
): void {
  scope.__sliccCherryRelayCleanup?.(); // idempotent: drop any prior relay in this world

  const port = connect({ name: CHERRY_RELAY_PORT_NAME });
  let lastJoinUrl: string | null = null;

  const onPortMessage = (msg: SwToRelayMessage) => {
    if (msg?.kind === 'join-url') {
      lastJoinUrl = msg.joinUrl;
      if (msg.joinUrl) {
        win.dispatchEvent(
          new CustomEvent(CHERRY_EVT.joinUrl, { detail: { joinUrl: msg.joinUrl } })
        );
      }
    } else if (msg?.kind === 'teardown') {
      win.dispatchEvent(new CustomEvent(CHERRY_EVT.teardown));
    }
  };
  // MAIN mounted after we already had a joinUrl → replay it (ordering guard).
  const onMounted = () => {
    if (lastJoinUrl) {
      win.dispatchEvent(new CustomEvent(CHERRY_EVT.joinUrl, { detail: { joinUrl: lastJoinUrl } }));
    }
  };
  // MAIN close button → tell the SW to untrack this tab.
  const onClose = () => {
    try {
      port.postMessage({ kind: 'close' });
    } catch {
      /* port already gone; SW onDisconnect handles cleanup */
    }
  };

  port.onMessage.addListener(onPortMessage);
  win.addEventListener(CHERRY_EVT.mounted, onMounted);
  win.addEventListener(CHERRY_EVT.close, onClose);

  scope.__sliccCherryRelayCleanup = () => {
    try {
      port.disconnect();
    } catch {
      /* already disconnected */
    }
    win.removeEventListener(CHERRY_EVT.mounted, onMounted);
    win.removeEventListener(CHERRY_EVT.close, onClose);
    scope.__sliccCherryRelayCleanup = undefined;
  };
}

initRelay();
```

- [ ] **Step 5: Add a repeat-injection test** — assert that calling `initRelay(fakeConnect, window, scope)` twice on the same `scope` disconnects the first Port and leaves exactly one live Port + one set of listeners (a `join-url` after the second init dispatches exactly one `slicc:cherry-joinurl`; a `close` posts to only the current Port). Then run all relay tests, verify pass.

- [ ] **Step 6: esbuild entry** in `vite.config.ts`

Add a `buildRelayIsolatedPlugin()` mirroring `buildContentScriptPlugin` (spread `PROD_IIFE_DEFAULTS`, `entryPoints:['src/relay-isolated.ts']`, `outfile: relay-isolated.js`). No SVG/raw plugin needed (no web-component graph). Register it in the `plugins:` array.

- [ ] **Step 7: Build extension, verify artifact** — `npm run build -w @slicc/chrome-extension` then confirm `dist/extension/relay-isolated.js` exists and `bash packages/dev-tools/tools/check-extension-rhc.sh` passes.

- [ ] **Step 8: Prettier + commit**

```bash
npx prettier --write packages/chrome-extension/src/cherry-relay-protocol.ts packages/chrome-extension/src/relay-isolated.ts packages/chrome-extension/vite.config.ts packages/chrome-extension/tests/relay-isolated.test.ts
npm run typecheck && npm test -w @slicc/chrome-extension -- relay-isolated && npm run build -w @slicc/chrome-extension
git add packages/chrome-extension
git commit -m "feat(extension): ISOLATED cherry-relay bridging SW joinUrl to the page

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: MAIN entry — mount launcher + connected UI-only cherry

**Files:**

- Create: `packages/chrome-extension/src/cherry-sidebar-main.ts`
- Modify: `packages/chrome-extension/vite.config.ts` (esbuild closeBundle for the MAIN entry; alias cherry→src; `html2canvas-pro` external; keep `rawSvgEsbuildPlugin()` for the launcher SVGs)
- Test: `packages/chrome-extension/tests/cherry-sidebar-main.test.ts`

**Interfaces:**

- Consumes: `mountSlicc` from `@ai-ecoverse/cherry` (Task 1 `iframe`+`uiOnly`), `<slicc-launcher>` + `managedIframe`/`requestClose`/`slicc-launcher-close` from `@ai-ecoverse/spoon` (Task 3), the relay CustomEvent contract (Task 7).
- Produces: `globalThis.__sliccCherrySidebar = { mount, unmount }` (idempotent; NO top-level auto-mount). Consumed by the SW (Task 9) which invokes `mount()` via a follow-up `executeScript({ func })`.

**Why a new file:** `content-script.ts` auto-runs `bootstrap(location.origin)` on import (L109) and mounts the legacy disconnected, target-advertising `?cherry=1` iframe (L81-98) — reusing it recreates the broken cherry. This entry has NO top-level bootstrap (custom-element registration from importing spoon is fine).

- [ ] **Step 1: Write failing test** `cherry-sidebar-main.test.ts` (jsdom; mock `mountSlicc`)

Mock the cherry module so `mountSlicc` is a spy returning `{ iframe, emitHostEvent, destroy }`. Import the module; assert:

```ts
it('registers a global controller without mounting on import (side-effect-free)', async () => {
  await import('../src/cherry-sidebar-main.js');
  expect(mountSliccSpy).not.toHaveBeenCalled();
  expect(document.querySelector('slicc-launcher')).toBeNull();
  expect(typeof (globalThis as any).__sliccCherrySidebar?.mount).toBe('function');
});

it('mount() adds an open launcher and, on joinUrl event, calls mountSlicc with iframe+uiOnly', async () => {
  (globalThis as any).__sliccCherrySidebar.mount();
  const launcher = document.querySelector('slicc-launcher') as any;
  expect(launcher).not.toBeNull();
  expect(launcher.open).toBe(true); // opened as sidebar
  expect(launcher.managed).toBe(true); // managed iframe mode
  // dispatch the relay's joinUrl event
  window.dispatchEvent(
    new CustomEvent('slicc:cherry-joinurl', { detail: { joinUrl: 'https://w/join/t.s' } })
  );
  expect(mountSliccSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      iframe: launcher.managedIframe,
      joinToken: 'https://w/join/t.s',
      uiOnly: true,
      capabilities: { navigate: false, screenshot: 'none', openUrl: false },
    })
  );
});

it('close event tears down (dispose + remove launcher + dispatch slicc:cherry-close)', async () => {
  const closeSpy = vi.fn();
  window.addEventListener('slicc:cherry-close', closeSpy);
  document
    .querySelector('slicc-launcher')!
    .dispatchEvent(new CustomEvent('slicc-launcher-close', { bubbles: true, composed: true }));
  expect(destroySpy).toHaveBeenCalled(); // mountSlicc handle disposed
  expect(document.querySelector('slicc-launcher')).toBeNull();
  expect(closeSpy).toHaveBeenCalled();
});

it('mount() is idempotent (second call does not create a second launcher)', async () => {
  (globalThis as any).__sliccCherrySidebar.mount();
  (globalThis as any).__sliccCherrySidebar.mount();
  expect(document.querySelectorAll('slicc-launcher').length).toBe(1);
});

it('slicc:cherry-teardown unmounts', () => {
  window.dispatchEvent(new CustomEvent('slicc:cherry-teardown'));
  expect(document.querySelector('slicc-launcher')).toBeNull();
});
```

- [ ] **Step 2: Run, verify fail** — FAIL (module absent).

- [ ] **Step 3: Implement `cherry-sidebar-main.ts`**

```ts
import { mountSlicc, type SliccHandle } from '@ai-ecoverse/cherry';
import '@ai-ecoverse/spoon'; // registers <slicc-launcher> (benign top-level registration)
import { CHERRY_EVT, type CherryJoinUrlDetail } from './cherry-relay-protocol.js';

// Production hosted origin for the follower iframe. DEV points at the local
// wrangler UI. (Mirror how content-script.ts derives dev vs prod.)
const PROD_SLICC_ORIGIN = 'https://www.sliccy.ai';
const DEV_SLICC_ORIGIN = 'http://localhost:8787';
const sliccOrigin = __SLICC_EXT_DEV__ ? DEV_SLICC_ORIGIN : PROD_SLICC_ORIGIN;

const HOST_ID = 'slicc-cherry-sidebar-host';

interface Controller {
  mount(): void;
  unmount(): void;
}

function createController(win: Window = window, doc: Document = document): Controller {
  let launcher: HTMLElement | null = null;
  let handle: SliccHandle | null = null;
  let currentJoinUrl: string | null = null;

  const onJoinUrl = (e: Event) => {
    const joinUrl = (e as CustomEvent<CherryJoinUrlDetail>).detail?.joinUrl;
    if (!joinUrl || !launcher) return;
    if (joinUrl === currentJoinUrl && handle) return; // unchanged
    currentJoinUrl = joinUrl;
    handle?.destroy();
    const iframe = (launcher as unknown as { managedIframe: HTMLIFrameElement }).managedIframe;
    handle = mountSlicc({
      iframe,
      joinToken: joinUrl,
      uiOnly: true,
      sliccOrigin,
      // UI-only: the agent drives the tab via real chrome.debugger CDP, so the
      // cherry needs no page powers and never invokes html2canvas.
      capabilities: { navigate: false, screenshot: 'none', openUrl: false },
    });
  };

  const onClose = () => teardown(/* notifySw */ true);
  const onTeardown = () => teardown(/* notifySw */ false);

  function teardown(notifySw: boolean) {
    handle?.destroy();
    handle = null;
    currentJoinUrl = null;
    if (launcher) {
      launcher.removeEventListener('slicc-launcher-close', onClose);
      launcher.remove();
      launcher = null;
    }
    win.removeEventListener(CHERRY_EVT.joinUrl, onJoinUrl);
    win.removeEventListener(CHERRY_EVT.teardown, onTeardown);
    if (notifySw) win.dispatchEvent(new CustomEvent(CHERRY_EVT.close)); // → relay → SW untrack
  }

  return {
    mount() {
      if (launcher) return; // idempotent
      launcher = doc.createElement('slicc-launcher');
      launcher.id = HOST_ID;
      launcher.setAttribute('managed', '');
      launcher.setAttribute('open', ''); // open-on-mount sidebar
      launcher.addEventListener('slicc-launcher-close', onClose);
      doc.documentElement.appendChild(launcher); // outside body so page reflow can't drop it
      win.addEventListener(CHERRY_EVT.joinUrl, onJoinUrl);
      win.addEventListener(CHERRY_EVT.teardown, onTeardown);
      // Tell the relay we're ready so it replays a joinUrl that arrived first.
      win.dispatchEvent(new CustomEvent(CHERRY_EVT.mounted));
    },
    unmount() {
      teardown(false);
    },
  };
}

// Registration only — NO auto-mount (avoids the content-script.ts auto-bootstrap trap).
const existing = (globalThis as { __sliccCherrySidebar?: Controller }).__sliccCherrySidebar;
(globalThis as { __sliccCherrySidebar?: Controller }).__sliccCherrySidebar =
  existing ?? createController();
```

(If `__SLICC_EXT_DEV__` is not already a global `define`, it is — the digest confirms `vite.config.ts` defines `__SLICC_EXT_DEV__`. Declare it in a `.d.ts` or `declare const` if typecheck complains.)

- [ ] **Step 4: Run, verify pass** — `npm test -w @slicc/chrome-extension -- cherry-sidebar-main` → PASS.

- [ ] **Step 5: esbuild entry** in `vite.config.ts`

Add `buildCherrySidebarMainPlugin(mode)` mirroring `buildContentScriptPlugin`:

```ts
function buildCherrySidebarMainPlugin(mode: string) {
  return {
    name: 'build-cherry-sidebar-main',
    async closeBundle() {
      const esbuild = await import('esbuild');
      await esbuild.build({
        ...PROD_IIFE_DEFAULTS,
        entryPoints: [resolve(Dirname, 'src/cherry-sidebar-main.ts')],
        outfile: resolve(outDir, 'cherry-sidebar-main.js'),
        alias: {
          // Bundle cherry from source → no build-order dependency on cherry/dist.
          '@ai-ecoverse/cherry': resolve(repoRoot, 'packages/cherry/src/index.ts'),
          '@slicc/shared-ts': resolve(repoRoot, 'packages/shared-ts/src/index.ts'),
        },
        // UI-only never triggers the screenshot strategy, so the lazy html2canvas
        // import is dead code — keep it out of the injected bundle.
        external: ['html2canvas-pro'],
        plugins: [rawSvgEsbuildPlugin()], // launcher SVG logos
        define: { ...PROD_IIFE_DEFAULTS.define, __SLICC_EXT_DEV__: JSON.stringify(isExtDev) },
      });
    },
  };
}
```

Register it in `plugins:`.

- [ ] **Step 6: Build extension, verify artifact + RHC**

Run: `npm run build -w @slicc/chrome-extension && bash packages/dev-tools/tools/check-extension-rhc.sh`
Expected: `dist/extension/cherry-sidebar-main.js` exists; RHC (no remote-CDN literals) passes.

- [ ] **Step 7: Prettier + commit**

```bash
npx prettier --write packages/chrome-extension/src/cherry-sidebar-main.ts packages/chrome-extension/vite.config.ts packages/chrome-extension/tests/cherry-sidebar-main.test.ts
npm run typecheck && npm test -w @slicc/chrome-extension -- cherry-sidebar-main && npm run build -w @slicc/chrome-extension
git add packages/chrome-extension
git commit -m "feat(extension): MAIN entry mounting an open, connected UI-only cherry sidebar

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Service worker wiring (integration)

**Files:**

- Modify: `packages/chrome-extension/src/service-worker.ts`
- Test: `packages/chrome-extension/tests/service-worker-cherry.test.ts` (new), extend `service-worker-leader-tab.test.ts` as needed.

**Interfaces:**

- Consumes: `ensureLeaderTab()` (existing), `chrome.scripting` (Task 6), the relay Port + `join-url`/`teardown`/`close` protocol (Task 7), `mount()` global (Task 8), `onLeaderJoinUrl` from the bridge (Task 5), `readStoredLeaderTabIdFromSession`/`writeStoredLeaderTabId` (existing).
- Produces: the full on-demand toggle behavior.

**Background (verified):** `chrome.action.onClicked` (L329) → `focusLeaderTab()` (ignores clicked tab). `ensureLeaderTab()` (L204-261) creates the pinned leader `active:false, pinned:true` if missing (does not navigate). Leader tab id in `chrome.storage.session` key `slicc_leader_tab_id` (L79). `chrome.runtime.onConnect` (L1278) currently handles only internal `fetch-proxy.fetch`. The bridge deps are built at L1125-1147 (`buildDefaultBridgeSwDeps`).

Design decision (per spec §5.2): factor SW cherry logic into small pure/injectable helpers so it is unit-testable without a live SW. Prefer a `cherry-sidebar-sw.ts` module exporting the helpers, imported by `service-worker.ts` (keeps the SW file's biome complexity down). Confirm the extension SW build inlines imports (esbuild bundles) — it does (SW is bundled IIFE).

- [ ] **Step 1: Write failing tests** `service-worker-cherry.test.ts`

Cover the pure helpers (inject `chrome.*` and storage mocks):

- `toggleCherryTab(tabId, ctx)`:
  - untracked tab → tracks it (adds to the activated set in `chrome.storage.session`), calls `ensureLeader`, bumps the generation, injects relay(ISOLATED) + main(MAIN) via `executeScript`, then invokes `mount()` via `executeScript({ func })`.
  - already-tracked tab → bumps the generation, untracks it, sends `{ kind:'teardown' }` to that tab's relay Port (if connected), does NOT inject.
- **concurrency guard:** a rapid untrack (2nd click) while the first `injectCherry` is mid-flight aborts the injection before `mount()` — assert the final `executeScript({ func })` (mount) is NOT called when the generation was bumped between inject steps (drive with an `executeScript` mock whose first call untracks the tab, then assert the mount `func` call never happens; the injected sidebar count stays 0).
- **injection-failure rollback:** when an `executeScript` call rejects (restricted page) AND the failing inject is still the current generation, the tab is removed from the activated set (assert the set no longer contains it) — no tab left tracked-but-unmounted.
- **stale-failure-after-supersede:** a rejected inject whose generation was already bumped (a newer inject mounted) must NOT untrack the tab (assert the set still contains it; the newer mount survives).
- **restricted-URL / leader guard:** `canInjectInto('chrome://extensions', isLeaderUrl)` is false; `canInjectInto('https://chrome.google.com/webstore/…', isLeaderUrl)` is false; `canInjectInto('https://chromewebstore.google.com/detail/…', isLeaderUrl)` is false; `canInjectInto(leaderUrl, isLeaderUrl)` is false (leader rejected by URL, not just id); `canInjectInto('https://example.com', () => false)` is true. The icon handler no-ops on any of these (assert no `executeScript`, no track).
- activated-set persistence: `readActivatedTabs`/`writeActivatedTabs` round-trip through a fake `chrome.storage.session` (key e.g. `slicc_cherry_tabs`, an array of numbers).
- `onTabUpdated(tabId,'complete')`: re-injects only for tracked tabs AND injectable URLs; untracked or restricted → no injection. The generation bump supersedes an earlier in-flight inject (assert only the latest `complete` results in a mount).
- `onTabRemoved(tabId)`: untracks + bumps generation + drops the relay Port.
- `onLeaderJoinUrl(joinUrl, tabId)`: caches only when `tabId === storedLeaderTabId` (assert a non-leader tab id is ignored); pushes `{ kind:'join-url', joinUrl }` to all connected `cherry-relay` Ports.
- relay Port `onConnect` (name `'cherry-relay'`): registers the Port keyed by `port.sender.tab.id`; immediately sends the cached `join-url`; on `{ kind:'close' }` bumps generation + untracks the sender tab + tears down; on `onDisconnect` deregisters only (does NOT untrack).

- [ ] **Step 2: Run, verify fail** — FAIL (helpers absent).

- [ ] **Step 3: Implement the helpers** (`cherry-sidebar-sw.ts`) and wire them in `service-worker.ts`

Key pieces:

```ts
// cherry-sidebar-sw.ts
import { CHERRY_RELAY_PORT_NAME } from './cherry-relay-protocol.js';

const ACTIVATED_TABS_KEY = 'slicc_cherry_tabs';

export async function readActivatedTabs(): Promise<Set<number>> {
  const r = await chrome.storage.session.get(ACTIVATED_TABS_KEY);
  return new Set<number>((r?.[ACTIVATED_TABS_KEY] as number[] | undefined) ?? []);
}
export async function writeActivatedTabs(tabs: Set<number>): Promise<void> {
  await chrome.storage.session.set({ [ACTIVATED_TABS_KEY]: [...tabs] });
}

// A per-tab generation counter. Each track/untrack bumps the tab's generation;
// an in-flight injection that discovers a newer generation aborts before mount()
// so a rapid untrack (2nd click) cannot leave an orphan sidebar.
const tabGeneration = new Map<number, number>();
function bumpGeneration(tabId: number): number {
  const next = (tabGeneration.get(tabId) ?? 0) + 1;
  tabGeneration.set(tabId, next);
  return next;
}

/**
 * Chrome forbids injection into chrome://, both Web Store hosts, view-source, etc.
 * Also refuse the leader tab (the leader is the UI host, not a cherry surface) —
 * `isLeaderUrl` wraps the SW's existing `isLeaderTabUrl` so a restored/unpinned
 * leader (whose stored id may have changed) is still rejected by URL.
 */
function canInjectInto(url: string | undefined, isLeaderUrl: (u: string) => boolean): boolean {
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

export async function injectCherry(tabId: number, generation: number): Promise<void> {
  const stillCurrent = () => tabGeneration.get(tabId) === generation;
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    files: ['relay-isolated.js'],
  });
  if (!stillCurrent()) return; // untracked mid-inject → abort before mounting
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    files: ['cherry-sidebar-main.js'],
  });
  if (!stillCurrent()) return;
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () =>
      (globalThis as { __sliccCherrySidebar?: { mount(): void } }).__sliccCherrySidebar?.mount(),
  });
}
```

- Icon handler: change `chrome.action.onClicked.addListener((tab) => …)` to receive the clicked tab; ignore clicks where `!canInjectInto(tab.url, isLeaderTabUrl)` (covers chrome://, both web-store hosts, AND the leader tab by URL) with a no-op; otherwise call `ensureLeaderTab()` (create-if-missing, no focus/navigate — do NOT call `focusLeaderTab()`), then `toggleCherryTab(tab.id)`.
- `toggleCherryTab(tabId)`: read the activated set. If present → remove from set + persist, `bumpGeneration(tabId)` (cancels any in-flight inject), `postTeardown(tabId)` (send `{kind:'teardown'}` to that tab's relay Port). Else → add to set, persist, `const gen = bumpGeneration(tabId)`, then `injectCherry(tabId, gen)` wrapped in try/catch: **on failure, roll back ONLY if still the current generation** — `if (tabGeneration.get(tabId) === gen) { remove from set + persist }`. This is load-bearing: a stale rejected inject (superseded by a newer generation that already mounted) must NOT untrack the newer mount. Persist the set before the async inject so a concurrent read sees the intended state; the generation guard (not the set) is what prevents the orphan mount.
- Relay Port registry: a `Map<number, Port>` keyed by sender tab id. In `chrome.runtime.onConnect` (L1278) add a branch: `if (port.name === CHERRY_RELAY_PORT_NAME) return handleCherryRelayConnect(port)`. `handleCherryRelayConnect`: read `tabId = port.sender?.tab?.id`; register (replace any prior Port for that tab); send `{ kind:'join-url', joinUrl: cachedLeaderJoinUrl }`; `onMessage {kind:'close'}` → `bumpGeneration(tabId)` + untrack tab + persist + `postTeardown`; `onDisconnect` → deregister only (leave tracked-set alone; disconnect ≠ close — the tab may just have navigated and will re-inject on `onUpdated`).
- `onLeaderJoinUrl(joinUrl, tabId)`: `if (tabId !== (await readStoredLeaderTabIdFromSession())) return;` cache in a module `let cachedLeaderJoinUrl`; push to all registered relay Ports. Wire it into `bridgeSwDeps` at L1125-1147 (`onLeaderJoinUrl`).
- `tabs.onUpdated` (status `complete`): if the tab is in the activated set AND `canInjectInto(tab.url, isLeaderTabUrl)` → `const gen = bumpGeneration(tabId); injectCherry(tabId, gen).catch(() => { if (tabGeneration.get(tabId) === gen) untrack(tabId); })`. The generation bump debounces rapid reloads (each `complete` supersedes the prior in-flight inject), and the generation-guarded catch prevents a stale failure from untracking a newer mount.
- `tabs.onRemoved`: `bumpGeneration(tabId)` + remove from the activated set + drop the relay Port (the existing L289 handler clears the leader-tab id — add the cherry-untrack alongside).

- [ ] **Step 4: Run, verify pass** — `npm test -w @slicc/chrome-extension -- service-worker-cherry` → PASS.

- [ ] **Step 5: Full extension test + build**

Run: `npm test -w @slicc/chrome-extension && npm run build -w @slicc/chrome-extension && bash packages/dev-tools/tools/check-extension-rhc.sh`
Expected: PASS; `focusLeaderTab` either removed or left unused (if unused, delete it and its test to satisfy lint/dead-code — verify no other caller first).

- [ ] **Step 6: Docs** — `packages/chrome-extension/CLAUDE.md`: replace the "launcher injected on every page" description with the on-demand per-tab model: icon → `ensureLeader` (create-only) + toggle-inject; `tabs.onUpdated` re-inject for tracked tabs; `tabs.onRemoved`/close-button/2nd-click → untrack; the `cherry-relay` Port + `leader.join-url` cache; UI-only cherry controlled via real `chrome.debugger` CDP.

- [ ] **Step 7: Prettier + verify + commit**

```bash
npx prettier --write packages/chrome-extension/src/service-worker.ts packages/chrome-extension/src/cherry-sidebar-sw.ts packages/chrome-extension/tests/service-worker-cherry.test.ts packages/chrome-extension/CLAUDE.md
npm run typecheck && npm test -w @slicc/chrome-extension && npm run build -w @slicc/webapp && npm run build -w @slicc/chrome-extension
git add packages/chrome-extension
git commit -m "feat(extension): on-demand per-tab cherry sidebar toggle in the service worker

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: Build wiring + cross-package docs

**Files:**

- Modify: `packages/chrome-extension/package.json` (add `@ai-ecoverse/cherry` dependency)
- Modify: root `package.json` (`postinstall` pre-build list gains `@ai-ecoverse/cherry`)
- Modify: `docs/architecture.md` (reconcile extension-float + cherry-target sections)
- (Per-package `CLAUDE.md` docs were updated in Tasks 1–9; this task is the cross-cutting reconciliation.)

**Interfaces:** none (build/docs only). Produces a clean `npm install` → typecheck/build without relying on the workspace symlink masking a missing cherry build.

- [ ] **Step 1: Declare the dependency** — add `"@ai-ecoverse/cherry": "*"` to `@slicc/chrome-extension` `dependencies` in its `package.json` (mirrors `@ai-ecoverse/spoon`).

- [ ] **Step 2: Pre-build cherry on install** — in root `package.json` `postinstall` (currently builds shared-ts, cloud-core, spoon, webcomponents), add `@ai-ecoverse/cherry` to the pre-build sequence AFTER webapp is not required (cherry has no webapp build dep) — place it after `@ai-ecoverse/spoon`/`@slicc/webcomponents`. This guarantees cherry's `dist/` + `.d.ts` exist for the extension typecheck even without a full `npm run build`.

- [ ] **Step 3: Clean-build verification**

```bash
# From the worktree root (already npm-installed):
npm run build -w @ai-ecoverse/cherry
npm run typecheck
npm run build -w @slicc/webapp
npm run build -w @slicc/chrome-extension
bash packages/dev-tools/tools/check-extension-rhc.sh
```

Expected: all pass. (The esbuild MAIN alias already bundles cherry from src; this step confirms typecheck resolves cherry types via the pre-built dist.)

- [ ] **Step 4: `docs/architecture.md`** — update the "Extension Thin-Bridge Architecture" + cherry-target notes to describe: icon → on-demand per-tab UI-only cherry; the cherry advertises no CDP target; control via real `chrome.debugger` CDP + active-tab marker; the `leader.join-url` bridge-Port message and the `cherry-relay` injection path.

- [ ] **Step 5: Prettier + verify + commit**

```bash
npx prettier --write packages/chrome-extension/package.json package.json docs/architecture.md
npm run typecheck && npm run build -w @slicc/chrome-extension
git add packages/chrome-extension/package.json package.json docs/architecture.md
git commit -m "chore(extension): declare + pre-build cherry dep; reconcile architecture docs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 11: Live verification (controller-run, not a subagent)

**Goal:** prove the feature end-to-end in a real extension over CDP. Run by the controller after all tasks pass review.

- [ ] **Step 1: Stand up the fresh extension harness**

Run: `npm run dev:extension:fresh` (CfT + wrangler :8787 + CDP :9333). It boots the thin-extension leader tab.

- [ ] **Step 2: Drive via the debug helper**

Use `SLICC_CDP_PORT=9333 node packages/dev-tools/tools/slicc-debug.mjs <targets|logs|shell|eval>`.

Verify, in order:

- Open a normal page tab (e.g. example.com). Click the extension icon (simulate via `chrome.action.onClicked` or the real toolbar) → a sidebar opens **on that tab**, showing the shared SLICC conversation, **connected to the leader** (not a spinning handshake).
- `playwright list-tabs` shows ` (active)` on the focused tab.
- Ask the cone to screenshot the tab → uses **real** `chrome.debugger` CDP (`Page.captureScreenshot` works; no cherry `html2canvas` fallback).
- Confirm the leader's target list shows **no** `cherry`/`slicc-cherry` target (A/B: only real `chrome.debugger` page targets).
- Reload the tab → the sidebar re-opens (persistence).
- Close via the sidebar close button → cherry removed. Re-open, then click the icon again → cherry removed (2nd-click path).
- Console clean: no endless `wss://…/licks-ws` or handshake-timeout loops.

- [ ] **Step 3: Record results** in the PR description. If any check fails, open a fix task (implementer + review loop) before the final whole-branch review.

---

## Verification (whole-branch, before PR)

Run the full pre-push pass from the worktree root:

```bash
npx prettier --check .        # or --write then re-stage
npm run typecheck
npm run test
npm run build -w @slicc/webapp
npm run build -w @slicc/chrome-extension
bash packages/dev-tools/tools/check-extension-rhc.sh
# touched-file complexity gate (biome) — see docs/verification.md
```

All green + coverage floors held per `coverage-thresholds.json`. Then the final whole-branch code review (superpowers:requesting-code-review), then finishing-a-development-branch → PR.

---

## Self-Review (completed by plan author)

- **Spec coverage:** §5.1→T6, §5.2→T9, §5.3→T7, §5.4→T8, §5.5→T1+T3, §5.6→T5, §5.7→T2, §5.8→T4, §5.9→T8+T9, §10 docs→woven per task + T10, §12 build-order→T8 alias + T10 postinstall. All spec sections mapped.
- **Type consistency:** relay/MAIN/SW share `cherry-relay-protocol.ts` (one source for `CHERRY_RELAY_PORT_NAME`, message kinds, `CHERRY_EVT`). `sendLeaderJoinUrl(string|null)` matches the `leader.join-url` envelope `{ joinUrl: string|null }` and the SW `onLeaderJoinUrl(joinUrl, tabId)`. `mountSlicc({ iframe, joinToken, uiOnly, capabilities })` matches Task 1's `MountSliccOptions`. `managedIframe`/`managed`/`requestClose`/`slicc-launcher-close` consistent between T3 and T8.
- **No placeholders:** every code step carries real code or exact edit anchors + snippets; large-file edits name exact functions and line anchors from the verified digest.
- **Ordering guard:** MAIN↔relay `slicc:cherry-mounted` replay handles joinUrl-before-mount races (T7/T8).
- **Backward compat:** cherry `container`-only path (T1), spoon legacy `appUrl` (T3), non-cherry follower advertise (T2) all retained by opt-in defaults.
