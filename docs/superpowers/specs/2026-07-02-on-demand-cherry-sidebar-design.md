# On-Demand Per-Page Cherry Sidebar — Design

- **Date:** 2026-07-02
- **Status:** Draft (for review)
- **Branch:** `worktree-feat+on-demand-cherry-sidebar`
- **Author:** Karl + Claude

## 1. Problem & goal

The thin extension currently opens a pinned hosted **leader tab**
(`?slicc=leader&ext=<id>`) and clicking the toolbar icon just focuses it. An
earlier attempt wove a `<slicc-launcher>` cherry follower into **every** page,
which was (a) wasteful (most pages don't need it) and (b) **never actually
connected** to the extension leader. That every-page injection was disabled in
commit `f989f6f48` ("disable content script launcher injection") — the launcher

- `content-script.ts` still build but are injected nowhere.

**Goal:** bring back a per-page SLICC sidebar, but **on demand**: clicking the
extension icon adds a cherry sidebar (opened) to the **current** tab, connected
to the shared leader, controllable via the **real** `chrome.debugger` CDP (not
cherry's crippled synthetic CDP). Closing the sidebar removes it from the page.
This restores the old side-panel feel per-tab, without the every-page cost.

## 2. Current state (verified)

- **Every-page injection is disabled.** No `content_scripts` in `manifest.json`;
  a test asserts `manifest.content_scripts === undefined`
  (`chrome-extension/tests/content-script.test.ts`). `content-script.ts` +
  spoon `<slicc-launcher>` build into `dist/extension/content-script.js` but are
  dormant. No `scripting`/`executeScript`/`registerContentScripts` usage.
- **Icon behavior:** `chrome.action.onClicked` (`service-worker.ts:329`) →
  `focusLeaderTab()` — focuses/creates the pinned leader tab; ignores the
  clicked tab.
- **Why cherry never connected:** the spoon launcher is a **dumb iframe shell**
  — it sets `iframe.src = ".../?cherry=1"` (`content-script.ts:64`,
  `slicc-launcher.ts:500`) with **no joinUrl and no host handshake**. But the
  webapp cherry follower requires a `joinUrl` delivered via the cherry host-SDK
  handshake (`mountSlicc` → `handshake.welcome.joinUrl`; `main-cherry.ts:36`,
  `cherry-host-transport.ts:99`). The launcher never runs `mountSlicc`, has no
  leader joinUrl to give, and SDK provisioning is out of scope
  (`cherry/CLAUDE.md`).
- **Cherry CDP is crippled + would duplicate the real target.** A cherry
  follower **unconditionally** advertises a synthetic `cherry-target` to the
  leader every 5s (`page-follower-tray.ts:67-80`), built from `CherryHostTransport`
  (`main-cherry.ts:22-49`; no off-switch). The extension leader already drives
  every tab via full `chrome.debugger` CDP through the SW bridge
  (`bridge-sw.ts`, `cdpGetTargets` maps `targetId = String(tab.id)`). The
  leader's `BrowserAPI.listAllTargets()` **concatenates** local (`chrome.debugger`)
  - tray/cherry targets and only dedupes `runtimeId === 'leader'` — **cherry
    (`runtimeId = 'slicc-cherry'`) is never deduped** (`browser-api.ts:196-218`).
    Cherry supports only DOM query / `Input` / `Page.navigate` / `Runtime.evaluate`
    / `Target.createTarget` / an html2canvas screenshot; **no `Network.*`**, not the
    real `Page.captureScreenshot` (`cherry/src/cdp-host-handlers.ts:62-154`;
    teleport refuses cherry, `teleport.ts:86`). So a naive cherry embed would give
    the agent a **weak duplicate** target for a tab it already fully controls.
- **Active-tab marker missing in the extension.** `playwright list-tabs` renders
  an ` (active)` marker from `p.active` (`playwright/handlers/tabs.ts:114-120`),
  but the extension's `cdpGetTargets` (`bridge-sw.ts:469`) returns targets with
  **no `active` field** — so the marker never appears in the extension (matches
  the known `currentWindow`-empty-from-a-SW bug).

## 3. Design overview

Re-activate the launcher **programmatically, per-tab, on icon-click**, wired to
actually connect, running the cherry as a **UI-only** follower so control stays
on the real browser CDP:

1. **On-demand injection** — icon-click ensures a leader exists (create the
   pinned tab only if missing; **never navigate to it**) and injects the cherry
   into the **current** tab, opened as a sidebar.
2. **Real connection** — an ISOLATED-world relay carries the leader's tray
   `joinUrl` (live, incl. late delivery + reconnects) to a MAIN-world launcher
   that runs `mountSlicc({ joinToken })`, so the follower joins the shared
   leader.
3. **UI-only cherry** — the follower shows the shared chat but **suppresses its
   CDP target advertisement**, so no weak `cherry-target` is federated. The
   agent drives the tab via full `chrome.debugger` CDP.
4. **Active-tab marker** — the extension's `cdpGetTargets` flags the focused tab
   so a prompt typed in a cherry ("migrate this page") resolves to it.
5. **Sidebar open + close-to-remove** — the sidebar mounts open; closing it (or
   a second icon-click) fully removes the cherry from the tab and untracks it.
6. **Persistence** — an activated tab keeps its cherry across reloads/navigations
   (SW re-injects) until removed.

## 4. UX flow

- **Add:** click the toolbar icon on tab T → SW ensures a leader (creates the
  pinned leader tab only if none exists; does **not** focus/navigate to it) →
  SW injects the relay + launcher into T → the sidebar opens showing the shared
  SLICC conversation, connected to the leader.
  - First-ever click annoyance (accepted, per design): if there was no leader,
    the pinned leader tab is created **and** a cherry lands on the current tab.
    A user who only wanted the leader tab can just switch to the pinned tab.
- **Use:** all cherries are follower views of the one leader (same conversation).
  Typing "migrate this page" resolves "this page" to the **active-tab-marked**
  tab. The agent acts on tabs via real `chrome.debugger` CDP.
- **Remove:** close the sidebar (its close button) **or** click the icon again on
  that tab → the cherry is removed from the page and the tab is untracked (no
  re-injection on reload).
- **Persist:** reloading/navigating an activated tab re-injects the cherry
  (opened) until it is removed.

## 5. Components & changes

### 5.1 Manifest (`chrome-extension/manifest.json`)

Add the **`scripting`** permission and **`activeTab`**. Keep
`host_permissions: <all_urls>` (required so the SW can re-inject on
`tabs.onUpdated` for tracked tabs — a non-gesture context that `activeTab`
alone does not cover). No `content_scripts` entry (injection stays
programmatic; keep the "content_scripts disabled" test).

### 5.2 Service worker (`chrome-extension/src/service-worker.ts`)

- **`action.onClicked(tab)`** — replace `focusLeaderTab()` with: `ensureLeader()`
  (create the pinned leader only if missing; do **not** focus/navigate) then
  **toggle** the cherry on `tab.id`:
  - if `tab.id` is tracked → remove (untrack + fire relay teardown);
  - else → add (track + inject relay + launcher).
- **Activated-tab registry** — a `Set<number>` of tab IDs persisted in
  `chrome.storage.session` (survives SW eviction within a session).
- **`tabs.onUpdated`** (status `complete`) for tracked tabs → re-inject.
  **`tabs.onRemoved`** → untrack.
- **Leader joinUrl cache** — cache the leader's tray `joinUrl`, updated on the
  leader's report (§5.6). Serve it to relay Ports on connect + on change.
- **Relay Port handler** — accept `chrome.runtime.connect({ name: 'cherry-relay' })`
  from injected relays (own-extension `onConnect`); send the current joinUrl and
  push updates; receive `untrack`/`close` from the relay (sidebar close path →
  drop from the activated set).
- `ensureLeaderTab()` already creates the pinned leader with `?slicc=leader&ext=`;
  reuse it. `focusLeaderTab()` is no longer wired to the icon (kept or removed
  per the plan).

### 5.3 Injected ISOLATED relay (`chrome-extension/src/relay-isolated.ts`, new)

ISOLATED-world content script injected via `chrome.scripting.executeScript`.
Opens `chrome.runtime.connect({ name: 'cherry-relay' })` to the SW; on
`{ joinUrl }` (incl. late delivery while a just-created leader boots, and
reconnect updates) dispatches `window.dispatchEvent(new CustomEvent(
'slicc:cherry-joinurl', { detail: { joinUrl } }))` to MAIN. Forwards a
`slicc:cherry-close` MAIN event back to the SW as `untrack`. Small; `chrome.*`
only (no web-component graph).

### 5.4 Injected MAIN launcher (extends `content-script.ts`'s inject path)

MAIN-world script (`world: 'MAIN'`) — required because custom-element
registries are per-world. Mounts `<slicc-launcher>` **opened** and, on the
`slicc:cherry-joinurl` event, drives the launcher's `joinToken` so it runs
`mountSlicc` in **UI-only** mode (§5.5). On the launcher's close event, disposes
`mountSlicc`, removes the element, and dispatches `slicc:cherry-close` (→ relay
→ SW untrack). Idempotent (re-inject on reload reuses/replaces the host node).

### 5.5 Spoon `<slicc-launcher>` (`packages/spoon/`)

Today it dumbly sets `iframe.src`. Add three **opt-in, backward-compatible**
capabilities (legacy `appUrl` consumers — electron/node/swift overlay — keep
today's floating-button + collapse behavior when these are unset):

- **`joinToken` property** — when set, the launcher embeds its `?cherry=1` iframe
  via `mountSlicc({ joinToken, … })` from `@ai-ecoverse/cherry` (the real host
  handshake) instead of a bare `iframe.src`.
- **UI-only mode** — in this mode the launcher loads its iframe at
  **`?cherry=1&ui-only=1`** (the concrete signal, §5.7), so the follower boots
  UI-only: the handshake still delivers the joinUrl and the chat follower still
  runs, but it **skips** `buildAdvertisedTargets` / the synthetic CDP host, so no
  `cherry-target` is federated.
- **`open` on mount + a `close` event** — a mode where the launcher renders the
  sidebar **open** (no initial floating-button step) and, on close, emits a
  `close` event (whose default handler in the injector = full teardown/removal)
  rather than collapsing to a button.

### 5.6 Leader → SW joinUrl report (`webapp` leader side)

The hosted leader tab reports its tray `joinUrl` (`session.joinUrl` =
`capabilities.join.url`, `tray-leader.ts:549`) to the SW — on tray connect and
on change — via `chrome.runtime.sendMessage` over `externally_connectable`
(sliccy.ai/localhost are allowed) or the existing bridge Port. This is the
missing plumbing: the SW is otherwise not in the tray data path and the joinUrl
is not in `chrome.storage` or the leader URL (`?tray=` is the tray identity, a
different string).

### 5.7 Cherry follower UI-only mode (`webapp`)

Read a **`ui-only=1`** query param on the `?cherry=1` follower boot (`main.ts:117`
→ `main-cherry.ts` / `wc-follower.ts` → `page-follower-tray.ts`); when present
(the launcher sets it on the iframe URL, §5.5), **skip CDP target advertisement**
(`buildAdvertisedTargets` / the `targets.advertise` push) and do not stand up the
synthetic CDP host. The chat-follower role (tray sync,
chat mirror + input, using the handshake `joinUrl`) is unaffected — it is
independent of the CDP advertisement. Result: the extension per-tab cherry
never federates a `cherry-target`, so the leader only ever sees the tab as a
real `chrome.debugger` target.

### 5.8 Active-tab marker in the extension (`chrome-extension/src/bridge-sw.ts`)

`cdpGetTargets` determines the focused tab via
`chrome.tabs.query({ active: true, lastFocusedWindow: true })`
(**`lastFocusedWindow`**, since `currentWindow` is empty from a service worker)
and sets `active: true` on that target's info. `playwright list-tabs` then
renders ` (active)` (`playwright/handlers/tabs.ts:114`), letting the agent
resolve "this page" for a prompt typed in a cherry. (Requires the local
`Target.getTargets` → page mapping to carry `active` through to
`BrowserAPI.listPages`; verify the mapping in the plan.)

### 5.9 Removal / teardown

Two convergent paths, both ending in untrack + teardown:

- **Sidebar close button** → launcher `close` event → dispose `mountSlicc` +
  remove element → `slicc:cherry-close` → relay → SW `untrack`.
- **Second icon-click** on a tracked tab → SW untracks + fires the relay
  teardown → launcher removes itself.

## 6. Control model (the key correctness property)

- The per-tab cherry is **UI + chat only**; it advertises **no** CDP target.
- The agent controls the activated tab — and any tab — via the **real
  `chrome.debugger` CDP** (full `Page.captureScreenshot`, `Network.*`, `Input`,
  teleport). No weak cherry target competes.
- The **active-tab marker** disambiguates "this page" for a prompt typed in a
  cherry; all tabs remain controllable (matches the old side-panel model).

## 7. Data flow

```
icon click(tab T)
  → SW: ensureLeader (create pinned only if missing; no navigate) + track(T)
  → SW: executeScript relay(ISOLATED) + launcher(MAIN) into T
  → relay connects Port → SW sends leader joinUrl (when ready; pushes updates)
  → CustomEvent slicc:cherry-joinurl → launcher sets joinToken
  → mountSlicc({ joinToken }, UI-only) → ?cherry=1 iframe handshake
  → follower joins leader tray (shared conversation); NO cherry CDP target
  → user prompt "migrate this page" → leader reads active-tab marker → real
    chrome.debugger CDP on the focused tab
close (button or 2nd icon-click) → dispose + remove + SW untrack
```

## 8. Persistence & removal

- Activated tab IDs live in `chrome.storage.session`. `tabs.onUpdated`
  (complete) re-injects for tracked tabs (sidebar re-opens). `tabs.onRemoved`
  and the two removal paths untrack.

## 9. Testing

- **SW (pure helpers + wiring):** toggle add/remove, activated-set persistence in
  `chrome.storage.session`, `onUpdated` re-inject only for tracked tabs,
  `onRemoved` untrack, joinUrl cache + push, relay-Port serve/update/untrack.
- **Relay:** forwards `{ joinUrl }` → `slicc:cherry-joinurl` CustomEvent;
  forwards `slicc:cherry-close` → SW `untrack`.
- **MAIN launcher inject:** mounts open, sets `joinToken` on the joinUrl event,
  teardown on close (dispose + remove + close event). Idempotent re-inject.
- **Spoon `<slicc-launcher>`:** `joinToken` set → `mountSlicc` invoked (mock);
  unset → legacy `appUrl` behavior unchanged (backward-compat); `open`-on-mount;
  `close` event fires teardown, not collapse.
- **Cherry UI-only:** with the flag, the follower does NOT call
  `buildAdvertisedTargets` / send `targets.advertise`, but still connects the
  chat follower with the handshake joinUrl. Assert no `cherry-target` federated.
- **Active-tab marker:** `cdpGetTargets` sets `active: true` on the
  `lastFocusedWindow` active tab; `playwright list-tabs` renders `(active)`.
- **Manifest:** `scripting` present; `content_scripts` still absent.
- **Live (`dev:extension:fresh`, CfT + CDP :9333):** click icon → sidebar opens
  on current tab, connected (shared conversation); `playwright list-tabs` shows
  `(active)` on the focused tab; a screenshot of the tab uses real CDP (works);
  reload persists the sidebar; close (button and 2nd icon-click) removes it.
- Keep each package at/above its coverage floor.

## 10. Documentation (three gates)

- `packages/chrome-extension/CLAUDE.md` — replace the "launcher injected on every
  page" description with the on-demand per-tab model (icon → inject; toggle/close
  → remove; persistence); document the new `scripting` permission, the ISOLATED
  relay + MAIN launcher split, and the UI-only cherry.
- `packages/spoon/CLAUDE.md` — document the opt-in `joinToken` / UI-only /
  open+close-event launcher capabilities and backward-compat.
- `packages/cherry/CLAUDE.md` / `packages/webapp/CLAUDE.md` — document the cherry
  UI-only mode (chat follower without CDP target advertisement) and that the
  extension controls activated tabs via real `chrome.debugger` CDP + the
  active-tab marker.
- `docs/architecture.md` — reconcile the extension float + cherry-target sections.

## 11. Non-goals

- Not reviving the declarative every-page injection.
- Not per-tab independent agents (one shared leader; cherries are followers).
- Not SDK-provisioning a leader (the leader already exists).
- Not the native `chrome.sidePanel` (we keep the floating cherry sidebar).
- Not changing cherry's third-party-embed behavior (UI-only is opt-in).

## 12. Risks & mitigations

- **Spoon gaining a `@ai-ecoverse/cherry` dependency** — keep the injected MAIN
  bundle lean; verify `check-extension-rhc.sh` (no remote-CDN literals) still
  passes.
- **MAIN/ISOLATED coordination** via `CustomEvent` — same-page, synchronous;
  guard against missing/late relay (launcher shows until joinUrl arrives).
- **joinUrl freshness** on tray reconnect — relay pushes updates; launcher
  re-`mountSlicc`s if the token changes.
- **Duplicate-target regression** — the UI-only cherry must be verified to
  advertise no target (test in §9); otherwise the weak target reappears.
- **Active-tab correctness** across windows — `lastFocusedWindow` is the correct
  query from a SW; test the mapping through to `list-tabs`.
- **Re-inject races** on rapid reloads — debounce/guard the `onUpdated`
  re-injection; idempotent mount.

## 13. File-level change inventory (indicative)

- `packages/chrome-extension/manifest.json` — `scripting` + `activeTab`.
- `packages/chrome-extension/src/service-worker.ts` — icon toggle, activated-set,
  onUpdated/onRemoved, joinUrl cache, relay Port.
- `packages/chrome-extension/src/relay-isolated.ts` — new ISOLATED relay.
- `packages/chrome-extension/src/content-script.ts` (or a new MAIN inject entry)
  — mount-open launcher + `mountSlicc` UI-only + teardown; `vite.config.ts`
  esbuild entry for the relay.
- `packages/chrome-extension/src/bridge-sw.ts` — `cdpGetTargets` active-tab
  marker.
- `packages/spoon/src/slicc-launcher.ts` — `joinToken` / UI-only / open+close
  capabilities.
- `packages/webapp/src/ui/main-cherry.ts` / `wc/wc-follower.ts` /
  `page-follower-tray.ts` — cherry UI-only mode (skip target advertisement).
- `packages/webapp/src/ui/page-leader-tray.ts` (or bridge wiring) — leader→SW
  joinUrl report.
- Tests mirrored under each package's `tests/`.
- Docs per §10.
