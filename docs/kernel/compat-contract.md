# Kernel compatibility contract (Phase 0)

This is the contract the kernel facade has to satisfy. It enumerates **everything
that crosses today's panel ↔ host boundary**, what the host owns statefully, the
boot side-effects standalone has that extension already encapsulates in the
offscreen document, the shell commands that touch DOM (and how each will be
routed when the kernel runs in a worker), and the explicit ownership decisions
for CDP, the preview Service Worker, and the VFS.

Every entry has a file:line reference to the **commit at which Phase 0 landed**
so the kernel extraction can be reviewed against today's behavior, not a sketch
of it. Line numbers drift as later phases edit the same files; treat the symbol
names as load-bearing and the line numbers as a starting hint — when in doubt,
grep for the symbol.

The companion typed surface is `packages/webapp/src/kernel/types.ts` —
`KernelFacade`, `KernelClientFacade`, and `KernelTransport`. Phase 1 will
prove the contract by making the existing `OffscreenBridge` and
`OffscreenClient` implement these interfaces with **zero behavior change**.

## 1. Wire surface

### 1.1 Panel → host requests (today's `PanelToOffscreenMessage` payload types)

Defined in `packages/chrome-extension/src/messages.ts:140-157`. Handled by
the big `switch (msg.type)` inside `OffscreenBridge.handlePanelMessage`
(`packages/chrome-extension/src/offscreen-bridge.ts`, around lines 644-919
at this snapshot — grep for the case label if the line drifts).

| `msg.type`             | Payload                                   | Bridge handler line                                                              | Notes                                                                                                               |
| ---------------------- | ----------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `user-message`         | `scoopJid, text, messageId, attachments?` | `offscreen-bridge.ts:607`                                                        | Diverted into `followerSync.sendMessage` when a follower is attached (`:611-621`); otherwise persisted then routed. |
| `cone-create`          | `name`                                    | `offscreen-bridge.ts:647`                                                        | One-shot bootstrap; non-cone scoops come from `scoop_scoop` tool inside the orchestrator, not the wire.             |
| `scoop-feed`           | `scoopJid, prompt`                        | `offscreen-bridge.ts:671`                                                        | Always also persists.                                                                                               |
| `scoop-drop`           | `scoopJid`                                | `offscreen-bridge.ts:676`                                                        | Resolves session id and calls `sessionStore.delete(sessionId)` for the dropped scoop (`:684`).                      |
| `abort`                | `scoopJid`                                | `offscreen-bridge.ts:696`                                                        | Cooperative — only cancels retry/backoff today (see Phase 3 fix).                                                   |
| `set-model`            | `provider, model, apiKey, baseUrl?`       | `offscreen-bridge.ts:704`                                                        | Updates per-process provider config.                                                                                |
| `request-state`        | —                                         | `offscreen-bridge.ts:711`                                                        | Triggers `buildStateSnapshot` (`:316`).                                                                             |
| `clear-chat`           | —                                         | `offscreen-bridge.ts:716`                                                        | Clears every per-scoop session and `currentMessageId` map (`:730`); `sessionStore.delete` per session (`:725`).     |
| `clear-filesystem`     | —                                         | `offscreen-bridge.ts:734`                                                        | Wipes the IDB-backed VFS.                                                                                           |
| `refresh-model`        | —                                         | `offscreen-bridge.ts:743`                                                        | Reload provider config from secrets store.                                                                          |
| `set-thinking-level`   | `scoopJid, level?`                        | `offscreen-bridge.ts:750`                                                        | Updates per-scoop persisted config.                                                                                 |
| `sprinkle-lick`        | `sprinkleName, body, targetScoop?`        | `offscreen-bridge.ts:765`                                                        | Routes a sprinkle event into the orchestrator with `persistScoop` afterwards (`:801`).                              |
| `reload-skills`        | —                                         | `offscreen-bridge.ts:807`                                                        | After upskill install.                                                                                              |
| `panel-cdp-command`    | `id, method, params?, sessionId?`         | `offscreen-bridge.ts:814`                                                        | Forwards to `BrowserAPI.getTransport().send` and returns a `panel-cdp-response`.                                    |
| `tool-ui-action`       | `requestId, action, data?`                | `offscreen-bridge.ts:838`                                                        | Routes back to the in-flight tool's UI promise.                                                                     |
| `refresh-tray-runtime` | `joinUrl?, workerBaseUrl?`                | `offscreen.ts:513-538`                                                           | Mirrors panel localStorage into offscreen's localStorage, then re-runs `syncTrayRuntime`.                           |
| `get-session-costs`    | —                                         | `offscreen.ts:150-172`                                                           | Returns `orchestrator.getSessionCosts()`. Direct `chrome.runtime.onMessage` handler outside the bridge switch.      |
| `agent-spawn-request`  | `options: AgentSpawnOptions`              | `offscreen.ts:112-142`                                                           | Routes to `globalThis.__slicc_agent.spawn(options)`. Direct `chrome.runtime.onMessage` handler outside the bridge.  |
| sprinkle-op (proxy)    | various                                   | `chrome-extension/src/sprinkle-proxy.ts`                                         | BroadcastChannel-based proxy host; the bridge does not touch this directly today.                                   |
| lick-\* (proxy)        | various                                   | `chrome-extension/src/lick-manager-proxy.ts` (started by `offscreen.ts:266-267`) | BroadcastChannel-based proxy host.                                                                                  |

### 1.2 Host → panel events (today's `OffscreenToPanelMessage` payload types)

Defined in `packages/chrome-extension/src/messages.ts:381-393`. Emitted via
`OffscreenBridge.emit(...)` inside the orchestrator callbacks
(`offscreen-bridge.ts:113-300`).

| `msg.type`                   | Source                                                                              | Notes                                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `agent-event`                | orchestrator callbacks → bridge `:113-220`                                          | Sub-types: `text_delta`, `tool_start`, `tool_end`, `turn_end`, `response_done`, `tool_ui`, `tool_ui_done`. |
| `scoop-status`               | `:160`                                                                              | Mirrors per-scoop status into panel's `scoopStatuses` map.                                                 |
| `scoop-list`                 | `:300`                                                                              | Used by panel chip bar.                                                                                    |
| `scoop-created`              | `:267`                                                                              | After `registerScoop`.                                                                                     |
| `incoming-message`           | `:206-220`                                                                          | A queued/broadcast message destined for a scoop (cone or otherwise).                                       |
| `state-snapshot`             | `:316` (built), emitted on `request-state` and at boot from `offscreen.ts:550-558`. | Includes `scoops`, `activeScoopJid`, optional `trayRuntimeStatus`.                                         |
| `error`                      | wraps thrown errors during streaming                                                | Per-scoop.                                                                                                 |
| `offscreen-ready`            | `offscreen.ts:541`                                                                  | Sent once after init.                                                                                      |
| `tray-runtime-status`        | `bridge.emitTrayRuntimeStatus()` triggered by `offscreen.ts:90-91`                  | Carries `TrayLeaderStatusSnapshot` + `TrayFollowerStatusSnapshot`.                                         |
| `scoop-messages-replaced`    | `applyFollowerSnapshot` (`:390-430`)                                                | Used when a follower receives a leader snapshot.                                                           |
| `panel-cdp-response`         | reply to `panel-cdp-command`                                                        | Per `id`.                                                                                                  |
| `cdp-event` / `cdp-response` | offscreen-side CDP transport → panel                                                | These belong to the **CDP proxy plane**, not the agent plane (see §6).                                     |

### 1.3 Panel-side dispatch (today's `OffscreenClient`)

Defined in `packages/webapp/src/ui/offscreen-client.ts:302-450`. The kernel
client facade has to provide all of these as either direct event subscriptions
or per-scoop callbacks. Notably the `agent-event` switch fans out into seven
sub-types (`:356-440`); each one corresponds to an existing UI panel callback
(text streaming append, tool-start widget, tool-end widget, tool-UI iframe
mount, tool-UI iframe dismiss, response-done finalization, turn-end). The
contract preserves all seven.

## 2. Stateful host responsibilities

The Phase 1 split must move these from `OffscreenBridge` into the `KernelFacade`
implementation **without changing semantics**:

- **Per-scoop streaming buffer**: the in-flight assistant message buffer used by
  `text_delta` deltas. Today held implicitly via `currentMessageId`
  (`offscreen-bridge.ts:70`) plus the orchestrator's per-scoop append. The
  contract: identical stream → identical sequence of `text_delta` payloads, and
  reading `request-state` after a stream returns the buffer in the right
  shape.
- **`currentMessageId` map**: per-scoop "in-flight assistant message id"
  (`offscreen-bridge.ts:70`, used at `:122`, `:127`, `:163`, `:412`, `:680`,
  `:730`, `:536`).
- **`scoopStatuses` map**: per-scoop status mirror used by `scoop-list` /
  `state-snapshot` (`:72`, `:160-163`, `:310`, `:500`, `:681`, `:730`).
- **`SessionStore`**: persistence of chat history per scoop. Owned by
  `OffscreenBridge` (`:74`). `persistScoop(jid)` is called on user messages,
  agent text, scoop-feed, and follower snapshots. `sessionStore.delete(...)` is
  called on `scoop-drop` (`:684`) and on `clear-chat` (`:725`). The kernel
  retains ownership of all of these calls.
- **`buildStateSnapshot` reconnect contract**: `:316` returns
  `{ scoops, activeScoopJid, trayRuntimeStatus? }` shaped exactly as
  `StateSnapshotMsg` declares (`messages.ts:223-234`). Used at offscreen boot
  (`offscreen.ts:550-558`) and on every panel `request-state`. The reconnect
  test in Phase 1 pins this shape.
- **`FollowerSyncManager`**: `setFollowerSync(...)` (`:381`) installs the
  manager; `applyFollowerSnapshot` (`:390`), `emitFollowerAgentEvent`
  (`:432`), `emitFollowerIncomingMessage` (`:478`), `emitFollowerStatus`
  (`:496`) define how follower data lands in the panel. Phase 1 keeps these
  as bridge methods, surfaced via the facade as a `setFollowerSync(sync |
null)` capability.
- **`scoop-drop` → session delete**: today at `offscreen-bridge.ts:684`.
  Crucially, the bridge first resolves the scoop's session id from the
  orchestrator before deleting; that order matters because the orchestrator's
  in-memory record vanishes on `unregisterScoop` and we'd lose the id.
- **`scoop-wait` / mute / unmute** (orchestrator-internal but exposed via the
  bridge to panels via `incoming-message` and queued message ordering):
  current behavior at `orchestrator.ts` is preserved; the kernel doesn't
  re-implement, it just keeps owning the orchestrator instance.
- **`ScoopObserver` taps**: `orchestrator.observeScoop(jid, handler)` is what
  the agent bridge uses to spawn ephemeral scoops (`agent-bridge.ts`). The
  kernel keeps the observer registry; observer cleanup on `unregisterScoop` /
  `destroyScoopTab` stays in `orchestrator.ts`.
- **Idle timer / dropped-scoop cost flush**: `orchestrator.getSessionCosts()`
  is the canonical accessor. In the extension it's surfaced via a direct
  `chrome.runtime.onMessage` handler outside the bridge switch (see §1.1
  `get-session-costs`). The kernel facade does not declare `getSessionCosts()`
  today — Phase 1 deliberately kept it as an out-of-bridge handler so the
  facade interface stays minimal until a worker home actually owns the
  orchestrator. A later phase that moves the orchestrator into the kernel
  worker can lift it onto `KernelFacade`.

## 3. Standalone boot side-effects (the things `offscreen.ts` already does

inline that `main.ts` will need to delegate to `createKernelHost`)

These live today in `packages/webapp/src/ui/main.ts` between roughly lines
1670 and 2540 (the orchestrator block). Phase 2 moves the **side-effect
list** into `createKernelHost`, so both the standalone kernel-worker entry
and the extension `offscreen.ts` boot through the same factory.

| Side-effect                                    | Standalone today                                                                       | Extension today                                                                  | Kernel home (Phase 2)                                                                                                        |
| ---------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Construct `Orchestrator(container, callbacks)` | `main.ts:1670`                                                                         | `offscreen.ts:77`                                                                | `createKernelHost`                                                                                                           |
| `recoverMounts(entries, fs, log)`              | `main.ts:558` (panel local-fs preview-only path) and `:2561` (orchestrator's sharedFs) | `offscreen.ts:275-294`                                                           | `createKernelHost`                                                                                                           |
| `BshWatchdog` start                            | `main.ts:1939-1941`                                                                    | `offscreen.ts:597-619`                                                           | `createKernelHost`                                                                                                           |
| `LickManager.init()` + `setEventHandler`       | `main.ts:2079-2082` (init), event handler at `routeLickToScoop`                        | `offscreen.ts:175-260`                                                           | `createKernelHost`                                                                                                           |
| `publishAgentBridge(orchestrator, fs, store)`  | `main.ts:1876`                                                                         | `offscreen.ts:101-108`                                                           | `createKernelHost`                                                                                                           |
| `NavigationWatcher` start                      | `main.ts:2526`                                                                         | (not used; offscreen has CDP proxy)                                              | `createKernelHost` (CLI/Electron only — gated by `getBrowserAPI()` provider)                                                 |
| Sprinkle manager bridge + `.shtml` watcher     | `main.ts` (panel-side sprinkle manager)                                                | `offscreen.ts:563-590` (proxy host + .shtml watcher)                             | `createKernelHost` (kernel-side relay only; the panel still owns the rendering UI)                                           |
| `globalThis.__slicc_lickManager`               | `main.ts` (publishes after init)                                                       | `offscreen.ts:263`                                                               | `createKernelHost`                                                                                                           |
| `globalThis.__slicc_agent`                     | via `publishAgentBridge`                                                               | via `publishAgentBridge`                                                         | `createKernelHost`                                                                                                           |
| `registerSessionCostsProvider(() => costs)`    | `main.ts:625-627`                                                                      | `offscreen.ts:144-147`                                                           | `createKernelHost`                                                                                                           |
| Mount-secret env preload                       | `main.ts` (mount-secrets boot)                                                         | implicit via secrets-storage                                                     | `createKernelHost`                                                                                                           |
| Tray runtime sync (`syncTrayRuntime`)          | `main.ts` (cli equivalent)                                                             | `offscreen.ts:374-512`                                                           | `createKernelHost`                                                                                                           |
| Lick → cone routing                            | `main.ts:routeLickToScoop` (helper inside `main()`)                                    | `offscreen.ts:186-260` (inline)                                                  | `createKernelHost` (single shared implementation; the existing `formatLickEventForCone` already de-duplicates the rendering) |
| Upgrade detection lick emission                | `main.ts` (parallel block)                                                             | `offscreen.ts:339-368`                                                           | `createKernelHost`                                                                                                           |
| Preview-VFS BroadcastChannel responder         | `main.ts:1890-1906` (orchestrator path) and `:572-589` (panel-local path)              | (offscreen has its own VFS; preview SW page-side hits offscreen via panel relay) | `kernel-worker.ts` (single canonical responder; see §5)                                                                      |
| Panel-side `WasmShell` for terminal tab        | `main.ts:1929` (orchestrator path) and `:611` (pre-orchestrator path)                  | `chrome-extension/src/main-extension.ts` panel                                   | Replaced by `kernelClient.term.openSession()` over the kernel transport — see §4                                             |
| `startFreezeWatchdog`                          | `main.ts:1394-1455`                                                                    | n/a                                                                              | **Removed** in Phase 2 (root cause goes away when the agent leaves the page main thread)                                     |

## 4. Worker-unsafe shell commands (DOM-touching)

A DedicatedWorker has no DOM. Each command below either has a non-DOM path
that already works, or needs an explicit `host.invokeUiCapability(name, args)`
RPC that the kernel calls back into a UI host context. The contract pins the
routing per command.

| Command                     | DOM use                                          | Today's branch                                                                            | Phase 2+ routing                                                                                                                                                                                                             |
| --------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jsh` (extension path only) | hidden `sandbox.html` iframe for CSP eval        | `packages/webapp/src/shell/jsh-executor.ts:343` (`chrome.runtime.getURL('sandbox.html')`) | Extension: stays in offscreen (offscreen has DOM). Standalone-as-worker: `chrome.runtime.id` is undefined so the iframe branch is never taken; the `Function`/`AsyncFunction` path runs in-worker and is fine.               |
| `node -e` / `node --eval`   | hidden `sandbox.html` iframe for esm.sh import   | `packages/webapp/src/shell/supplemental-commands/node-command.ts:382`                     | Same as `jsh`. Worker path uses the same `Function` fallback.                                                                                                                                                                |
| `imgcat`                    | DOM preview host attached to terminal-panel      | `wasm-shell.ts:1235-1255` (`previewHost`)                                                 | Becomes a `term.event = 'media-preview'` envelope on the terminal RPC; UI-side `terminal-view.ts` materializes the blob. (Phase 2b)                                                                                          |
| `mount --source local`      | `showDirectoryPicker()` requires user activation | `packages/webapp/src/fs/mount/backend-local.ts`                                           | Add `host.invokeUiCapability('fs-picker', args)` RPC. Only this command takes it; everything else is purely data-plane.                                                                                                      |
| `oauth-token`               | `window.open(...)` for the consent flow          | `packages/webapp/src/providers/oauth-service.ts`                                          | Standalone: routed via the existing `LlmProxySw` listener on the panel side; the kernel hands the URL to a `host.invokeUiCapability('open-url', ...)` RPC. Extension: unchanged (already routed through the service worker). |
| `serve` / `open`            | uses `BrowserAPI` (CDP), not DOM                 | `packages/webapp/src/shell/supplemental-commands/{serve,open}-command.ts`                 | No change: `BrowserAPI` already has a transport-pluggable interface and the kernel owns the `BrowserAPI` instance.                                                                                                           |
| `debug` (panel toggle)      | reaches into the panel layout to add/remove tabs | dual-context: `window.__slicc_*` hook then `chrome.runtime.sendMessage`                   | `host.invokeUiCapability('debug-toggle', state)` RPC; the extension dual-context fallback stays as-is.                                                                                                                       |

## 5. CDP transport semantics

The CDP transport (`packages/webapp/src/cdp/transport.ts:10-36`) is a full
event-based interface, not a request/response RPC. The kernel↔UI bridge has to
forward:

- `connect(options?)`, `disconnect()`, `send(method, params?, sessionId?,
timeout?)`, `state` accessor.
- `on(event, listener)`, `off(event, listener)`, `once(event, timeout?)` — and
  the events themselves: `Target.attached*`, `Page.javascriptDialogOpening`,
  navigation events, anything an agent's tool subscribes to.
- Listener lifecycle: `on` followed by `off` must not leak a remote
  registration. The Phase-1 prototype is `OffscreenCdpProxy` /
  `PanelCdpProxy` (`packages/webapp/src/cdp/{offscreen,panel}-cdp-proxy.ts`)
  which already implement this exact contract. Phase 2's `cdp-bridge.ts`
  distills both into a single `CdpTransportBridge` with the existing public
  interface intact.

The panel keeps a real CDP transport in **standalone** (it owns the WebSocket
to `node-server` at `/cdp`); the kernel-worker proxies through this via the
bridge. In **extension**, the kernel (offscreen) keeps owning the
`OffscreenCdpProxy` to the service worker; the panel uses
`PanelCdpProxy` to send commands through the bridge for cases like the
`tool-ui` iframe rendering. Both shapes survive Phase 2.

## 6. Preview Service Worker peer

`packages/webapp/src/ui/preview-sw.ts` intercepts `/preview/*` requests and
posts `{ type: 'preview-vfs-read', id, path }` on `BroadcastChannel('preview-vfs')`,
expecting a `{ type: 'preview-vfs-response', id, content | error }` back.

Today there are **two responders**:

- Standalone panel (pre-orchestrator path): `main.ts:572-589` reads from the
  panel-local `localFs`.
- Standalone orchestrator path: `main.ts:1890-1906` reads from
  `orchestrator.getSharedFS()`.

Extension: the page-side preview SW broadcasts to whichever realm has the
channel registered; today there is **no** offscreen-side responder (the
offscreen lives on a different document but BroadcastChannel is page-scoped
under MV3 — verify in Phase 2's preview-bridge test).

**Decision**: the kernel is the canonical responder in both floats. In
standalone, `kernel-worker.ts` registers the responder against
`orchestrator.getSharedFS()` (BroadcastChannel works in DedicatedWorker). The
panel-local responder at `main.ts:572-589` is removed. In extension, the
offscreen-side responder is added (today it implicitly works because the
panel and offscreen share IDB and the panel has a read-only mirror of the
VFS). The page-side `LocalVfsClient` keeps a fallback responder so a
not-yet-booted kernel-worker doesn't break first-paint preview requests.

## 7. VFS ownership

The kernel owns the canonical `VirtualFS` instance. The page keeps a
**read-only** `LocalVfsClient`:

- Same IndexedDB DB (LightningFS uses idb-keyval under the hood, so a
  separate `VirtualFS` instance over the same name reads the same data; no
  migration needed).
- No mount registration, no `mount-table-store` writes, no `RestrictedFS`.
- File browser panel and memory panel call into it for **reads**.
  All writes route through `kernelClient.fs.write*` RPCs.
- Used as the preview-vfs BroadcastChannel fallback responder when the
  kernel-worker is still spinning up.

Existing test `tests/ui/file-browser-panel.test.ts` constructs a `VirtualFS`
directly. In Phase 2 it will be updated to mock the `KernelClientFacade`'s
`fs` capability instead — the panel itself will only ever see the client
facade.

This resolves today's ambiguity where both standalone (`main.ts:559`) and
extension panel keep a separate `localFs` for the file browser; under the
new contract that becomes a thin read-only mirror that anyone can replace
with a kernel-RPC backend later.

## 8. Out of scope for Phase 0

- No new `{ id, op, args }` envelope. Phase 1 keeps `ExtensionMessage`
  shapes verbatim.
- No new state owner. The bridge keeps everything it owns today.
- No process model. Phase 3 introduces `ProcessManager`.
- No `/proc`. Phase 5.
- No worker. Phase 2.

## 9. Phase 0 done-when

- This file is committed.
- `packages/webapp/src/kernel/types.ts` exists with `KernelFacade`,
  `KernelClientFacade`, and `KernelTransport`. (Earlier drafts called for a
  deliberately-failing `_assertCompat` line that Phase 1 would delete; in
  practice Phase 1 used the structural `implements` clauses on
  `OffscreenBridge` and `OffscreenClient` directly to prove the surface,
  which gives the same compile-time guarantee with less noise.)
- `npm run typecheck` passes.
