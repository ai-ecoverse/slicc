# Extension-leader tray sync wiring

**Issue:** [#682](https://github.com/ai-ecoverse/slicc/issues/682)
**Branch:** `fix/extension-leader-sync-682`
**Date:** 2026-05-20
**Revision:** 3 (second-review corrections — see "Revision history" below)

## Problem

When the Chrome extension runs as a **tray leader** (worker base URL set, no
join URL), followers can complete WebRTC signaling but the leader broadcasts
nothing — no chat snapshots, no agent events, no scoops list, no sprinkles, no
federated CDP. The follower-side data channel opens, then sits silent until its
keepalive trips and tears it down.

The gap site is `packages/chrome-extension/src/offscreen.ts:438-480` — the
`if (trayRuntimeConfig?.workerBaseUrl)` branch in `syncTrayRuntime`. It
constructs `LeaderTrayManager` + `LeaderTrayPeerManager` correctly, but never
constructs a `LeaderSyncManager`, never subscribes to agent events, never
broadcasts scoops/sprinkles lists, and `onPeerConnected` only logs instead of
calling `sync.addFollower(bootstrapId, channel, …)`.

The standalone-leader path was fixed on `feat/browser-follower-sprinkle-sync`
and is the canonical reference: `packages/webapp/src/ui/page-leader-tray.ts`
(helper) + `packages/webapp/src/ui/main.ts:2418-2503` (callbacks).

## Key insight that shapes the design

The issue's scope estimate (~150-200 LoC + 5 panel↔offscreen RPC message
types) assumed every `LeaderSyncManagerOptions` callback would need to be
threaded across the panel↔offscreen boundary. After mapping data sources,
**most of what `LeaderSyncManager` needs already lives in offscreen** — only
three pieces of state are panel-only, and all three are one-way panel→offscreen
pushes. No request/response RPC is required.

| `LeaderSyncManagerOptions` field                                 | Source in extension mode                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getMessages()`                                                  | `OffscreenBridge.getBuffer(activeScoopJid)` cast to `ChatMessage[]` — `BufferedChatMessage` is structurally compatible per the existing cast at `offscreen-bridge.ts:671`                                                                                                                                                                                                                                                                                                     |
| `getMessagesForScoop(jid)`                                       | `OffscreenBridge.getBuffer(jid)` (same cast). Required for `request_snapshot` against non-active scoops (`tray-leader-sync.ts:354-371`)                                                                                                                                                                                                                                                                                                                                       |
| `getScoopJid()`                                                  | new field on the bridge fed by a new panel→offscreen `active-scoop` message (see §5)                                                                                                                                                                                                                                                                                                                                                                                          |
| `getScoops()`                                                    | `orchestrator.getScoops().map(…)` — inline summary projection (no `toScoopSummary` helper exists today)                                                                                                                                                                                                                                                                                                                                                                       |
| `getSprinkles()`                                                 | **panel-only** — `SprinkleManager.available() + opened()`; pushed snapshot                                                                                                                                                                                                                                                                                                                                                                                                    |
| `readSprinkleContent(name)`                                      | `sharedFs.readFile(path)` after name→path lookup from the cached sprinkle snapshot                                                                                                                                                                                                                                                                                                                                                                                            |
| `onSprinkleLick`                                                 | reuse the existing `sprinkle-lick` handler at `offscreen-bridge.ts:924-962` (refactored into a method `OffscreenBridge.routeSprinkleLick(sprinkleName, body, targetScoop)`)                                                                                                                                                                                                                                                                                                   |
| `onFollowerMessage`                                              | three things: (a) buffer-insert + persist + `await orchestrator.handleMessage(channelMsg)` so the cone receives and routes the message; (b) explicit `bridge.notifyPanelIncomingMessage(jid, channelMsg)` because `onIncomingMessage` only fires for external lick channels (`isExternalLickChannel`, lick-formatting.ts:29-37) — `'web'` is excluded, so the panel echo is NOT free; (c) `sync.broadcastUserMessage(text, msgId, atts)` to re-broadcast to sibling followers |
| `onFollowerAbort`                                                | `orchestrator.stopScoop(activeJid)`                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| AgentEvent subscription                                          | tap at the bridge's wire-emit layer; reuse `handleAgentEvent` translation logic from `offscreen-client.ts:495-585`. Details in §1.                                                                                                                                                                                                                                                                                                                                            |
| `browserAPI` / `browserTransport` / `vfs`                        | already in `offscreen.ts:init()`                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `sprinkleManager.setSendToSprinkleHook` (local update broadcast) | **panel-only** — pushed                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `chat.setOnLocalUserMessage` (local echo)                        | **panel-only** — pushed                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `webhook.event` control message                                  | new — extension `lickManager` is in-process; call `orchestrator.handleWebhookEvent(id, headers, body)` directly from `LeaderTrayManager.onControlMessage` (standalone hops through the worker via `lick-webhook-event`; extension doesn't need that hop)                                                                                                                                                                                                                      |

## Approach

### Option A (chosen): offscreen-local sync + 3-message panel push bridge

`LeaderSyncManager` is constructed in offscreen. Its callbacks resolve from
offscreen-local state directly. A narrow panel↔offscreen bridge handles the
three panel-only pieces (sprinkle snapshot, sprinkle update, user echo, all
fire-and-forget — no waiter maps, no timeouts) plus two activation signals
(offscreen→panel) so the panel knows when to install/remove hooks.

### Rejected alternatives

**B — Issue's Option A (request/response RPC for every callback).** Inflates
LoC, adds round-trip latency to every broadcast cycle, requires five new waiter
maps, and invents RPC for state that's already offscreen-side. Strictly worse
than A.

**C — Move `SprinkleManager` to offscreen.** Refactor too large for this fix.
`SprinkleManager` owns DOM rendering. Out of scope.

## Architecture

```text
┌─ Side panel ────────────────────────────────────────────────┐
│  ChatPanel                                                  │
│    .setOnLocalUserMessage(text, msgId, atts)                │
│  SprinkleManager                                            │
│    .setSendToSprinkleHook(name, data)                       │
│    .available() / .opened()  ← refresh/open/close events    │
│  ScoopSwitcher                                              │
│    on selection change → leaderSyncProxy.pushActiveScoop()  │
│                                                             │
│  PanelLeaderSyncProxy (new)                                 │
│    pushSprinklesSnapshot(SprinkleSummary[])  panel→offscreen│
│    pushSprinkleUpdate(name, data)             panel→offscreen│
│    pushUserMessageEcho(text, msgId, atts)     panel→offscreen│
│    pushActiveScoop(jid)                       panel→offscreen│
│    onLeaderModeChange(active: boolean)        offscreen→panel│
└────────┬──────────────────── chrome.runtime, fire-and-forget┘
         │
         ▼
┌─ Offscreen document ────────────────────────────────────────┐
│  connectOffscreenLeaderSyncBridge(hub, syncRef) (new)       │
│    caches latest SprinkleSummary[]                          │
│    caches latest activeScoopJid                             │
│    fans:                                                    │
│      sprinkle.update → syncRef().broadcastSprinkleUpdate    │
│      user.echo       → syncRef().broadcastUserMessage       │
│                                                             │
│  LeaderSyncManager (constructed here)                       │
│    getMessages       → bridge.getBuffer(activeJid) as CM[]  │
│    getMessagesForScoop→ bridge.getBuffer(jid)   as CM[]     │
│    getScoopJid       → bridge.getActiveScoopJid() ?? coneJid│
│    getScoops         → orchestrator.getScoops().map(…)      │
│    getSprinkles      → leaderBridge.getSprinkles()          │
│    readSprinkleContent → sharedFs.readFile(name→path)       │
│    onSprinkleLick    → bridge.routeSprinkleLick(name,body,…)│
│    onFollowerMessage → orchestrator.handleMessage          │
│                        + sync.broadcastUserMessage          │
│    onFollowerAbort   → orchestrator.stopScoop(activeJid)    │
│    browserAPI/transport/vfs → already in init()             │
│                                                             │
│  OffscreenBridge.onAgentEvent(handler) (new)                │
│    sync.broadcastEvent ← handler (AgentEvent)               │
│                                                             │
│  LeaderTrayManager.onControlMessage (extended)              │
│    'webhook.event' → orchestrator.handleWebhookEvent(...)   │
│    else → trayPeers.handleControlMessage(...)               │
│                                                             │
│  LeaderTrayPeerManager.onPeerConnected (fixed)              │
│    sync.addFollower(bootstrapId, channel, {runtime, …})     │
│                                                             │
│  host-command setters (wired)                               │
│    setConnectedFollowersGetter(() => trayPeers.getPeers())  │
│    setTrayResetter(() => /* extension reset */)             │
└─────────────────────────────────────────────────────────────┘
```

## Components

### 1. `OffscreenBridge.onAgentEvent(handler)` — new method

**File:** `packages/chrome-extension/src/offscreen-bridge.ts`

Adds a fan-out tap. The cleanest implementation point is the existing
`bridge.emit(...)` method — when `msg.type === 'agent-event'`, also translate
the wire envelope into a `ui/types.ts AgentEvent` and call every registered
listener. This reuses the bridge's already-correct `currentMessageId` state
and guarantees the leader stream stays in lockstep with what the panel sees.

**Wire→AgentEvent translation must mirror `offscreen-client.ts:495-585`**
(the panel's `handleAgentEvent`). Reproducing the actual logic, not the
synthesized one from revision 1:

| Bridge wire envelope (in `agent-event`)                          | Resulting `AgentEvent`(s) for the leader-side listener                                                                                                                                          |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eventType: 'text_delta', scoopJid, text`                        | if no `currentMessageId.get(jid)`: emit `{ type: 'message_start', messageId }` then `{ type: 'content_delta', messageId, text }`. Otherwise: just `{ type: 'content_delta', messageId, text }`. |
| `eventType: 'tool_start', scoopJid, toolName, toolInput`         | conditional `message_start` (same gating); then `{ type: 'tool_use_start', messageId, toolName, toolInput }`                                                                                    |
| `eventType: 'tool_end', scoopJid, toolName, toolResult, isError` | `{ type: 'tool_result', messageId, toolName, result, isError }` (no `message_start` — only fired when a `messageId` already exists)                                                             |
| `eventType: 'tool_ui', scoopJid, toolName, requestId, html`      | conditional `message_start`; then `{ type: 'tool_ui', messageId, toolName, requestId, html }`                                                                                                   |
| `eventType: 'tool_ui_done', scoopJid, requestId`                 | `{ type: 'tool_ui_done', messageId, requestId }` when a `messageId` exists                                                                                                                      |
| `eventType: 'response_done', scoopJid`                           | `{ type: 'content_done', messageId }` when a `messageId` exists                                                                                                                                 |

The bridge does NOT emit a `turn_end` envelope today — `offscreen-client.ts:578`
synthesizes one on the panel side. The leader tap will mirror that synthesis
where appropriate (or omit if the follower protocol tolerates its absence —
verify by diffing standalone broadcast captures).

For the `onSendMessage` callback (used by `send_message` between scoops) the
bridge emits `text_delta` + `response_done` (offscreen-bridge.ts:188-199),
which already maps cleanly via the table above. No special-casing needed.

API:

```ts
onAgentEvent(handler: (scoopJid: string, event: AgentEvent) => void): () => void;
```

Returns an unsubscribe function. The handler receives the wire envelope's
`scoopJid` so the caller can filter — **the leader tap MUST filter to only
the active scoop** before calling `sync.broadcastEvent`. Reason:
`LeaderSyncManager.broadcastEvent` at tray-leader-sync.ts:300-304 ignores the
event's own `scoopJid` and tags the wire payload with `options.getScoopJid()`
(the active scoop). Without the filter, a background scoop's stream would be
broadcast tagged as the active scoop — wrong content + wrong scope. Mirrors
how standalone implicitly avoids this (the worker-bridge `agentHandle.onEvent`
runs through the panel's `handleAgentEvent` filter at
`offscreen-client.ts:496` before reaching `sync.broadcastEvent`).

In the offscreen leader branch the wiring is:

```ts
const unsubAgent = bridge.onAgentEvent((eventScoopJid, event) => {
  if (eventScoopJid !== getActiveJid()) return;
  sync.broadcastEvent(event);
});
```

**Verification step before coding:** capture standalone-leader's `agent.event`
payloads under a 3-turn scenario (text reply, tool call, error) and diff
against the events this synthesizer produces for the same orchestrator
callbacks. The fallback if the protocol consumer breaks: add a new
non-`AgentEvent`-shaped wire payload to `tray-sync-protocol.ts` and have the
follower handle both shapes.

### 2. `leader-sync-bridge.ts` — new file

**File:** `packages/chrome-extension/src/leader-sync-bridge.ts`

Symmetrical bridge halves modeled on `follower-sprinkle-bridge.ts`. All
panel→offscreen flows are fire-and-forget; offscreen→panel is a single
activation envelope.

#### Panel-side

```ts
export class PanelLeaderSyncProxy {
  constructor(
    sender: PanelMessageSender,
    subscriber: PanelMessageSubscriber,
    listeners: {
      onLeaderModeChange?: (active: boolean) => void;
    }
  );

  /** Push latest sprinkle availability + open state. Idempotent; call after
   *  every SprinkleManager.refresh() / open / close (and eagerly on leader
   *  activation so the offscreen cache isn't empty when the first follower
   *  connects). */
  pushSprinklesSnapshot(sprinkles: SprinkleSummary[]): void;

  /** Forward a local SprinkleManager.sendToSprinkle call to the leader. */
  pushSprinkleUpdate(sprinkleName: string, data: unknown): void;

  /** Forward the leader's locally-typed user message so followers see it. */
  pushUserMessageEcho(text: string, messageId: string, attachments?: MessageAttachment[]): void;

  /** Tell offscreen which scoop the panel is currently viewing — drives
   *  `LeaderSyncManager.getScoopJid()` and `getMessages()`. */
  pushActiveScoop(jid: string): void;

  /** Tear down. Idempotent. */
  dispose(): void;
}
```

#### Offscreen-side

```ts
export interface OffscreenLeaderSyncBridgeHandle {
  /** Return the cached sprinkle snapshot (or [] if none received yet). */
  getSprinkles(): SprinkleSummary[];
  /** Resolve sprinkle name → VFS path from the cached snapshot. */
  resolveSprinklePath(name: string): string | null;
  /** Return the panel's current scoop selection, or null if none received. */
  getActiveScoopJid(): string | null;
  /** Send a one-shot activation/deactivation signal to the panel. */
  signalLeaderMode(active: boolean): void;
  /** Stop listening. Idempotent. */
  detach(): void;
}

export function connectOffscreenLeaderSyncBridge(
  hub: OffscreenMessageHub,
  syncRef: () => LeaderSyncManager | null
): OffscreenLeaderSyncBridgeHandle;
```

The factory takes a `syncRef` getter (not a direct sync reference) to avoid
the circular-init problem from revision 1: the bridge is created before
`LeaderSyncManager` is constructed, but its inbound message handlers don't
fire until peers connect, so by then the closure resolves to a live sync.
Mirrors how `page-leader-tray.ts:141-143` uses forward-declared `let` bindings.

`OffscreenMessageHub` is the same interface already used by
`follower-sprinkle-bridge.ts` — reuse it for symmetry.

### 3. New message types in `messages.ts`

```ts
// Panel → offscreen (fire-and-forget)
export interface LeaderSprinklesSnapshotMsg {
  type: 'leader-sprinkles-snapshot';
  sprinkles: SprinkleSummaryEnvelope[]; // shape-compatible with SprinkleSummary
}

export interface LeaderSprinkleUpdateMsg {
  type: 'leader-sprinkle-update';
  sprinkleName: string;
  data: unknown;
}

export interface LeaderUserMessageEchoMsg {
  type: 'leader-user-message-echo';
  text: string;
  messageId: string;
  attachments?: MessageAttachment[];
}

export interface LeaderActiveScoopMsg {
  type: 'leader-active-scoop';
  scoopJid: string;
}

/** Panel → offscreen: ask offscreen to re-emit its current leader-mode state.
 *  Sent on panel boot / `offscreen-ready` so a popout opening AFTER offscreen
 *  activated still installs leader hooks. */
export interface LeaderRequestLeaderModeStateMsg {
  type: 'leader-request-mode-state';
}

// Offscreen → panel (single envelope)
export interface LeaderModeChangedMsg {
  type: 'leader-mode-changed';
  active: boolean;
}
```

Add the panel→offscreen **five** to `PanelToOffscreenMessage` and the
offscreen→panel one to `OffscreenToPanelMessage`. `OffscreenClient.handleOffscreenMessage`
(or the bridge's panel-side equivalent) must route `leader-mode-changed` to
the `PanelLeaderSyncProxy` listener. Mirror the compile-time assertion
`_AssertSprinkleSummaryEnvelopeMatches` from `follower-sprinkle-bridge.ts` for
the sprinkle envelope.

### 4. `offscreen.ts:438-480` rewrite (the `workerBaseUrl` branch)

Replace the existing logging-only stub with a full mirror of
`page-leader-tray.ts:134-336`. The skeleton below uses forward declarations
(matching the standalone reference) and refers only to symbols verified to
exist in the codebase:

```ts
if (trayRuntimeConfig?.workerBaseUrl) {
  // Forward declarations so closures capture by reference.
  let sync!: LeaderSyncManager;
  let trayLeader!: LeaderTrayManager;
  let trayPeers!: LeaderTrayPeerManager;

  // The leader bridge resolves `sync` lazily via a getter, breaking the
  // circular-init chain.
  const hub: OffscreenMessageHub = /* same hub shape as the follower path uses */;
  const leaderBridge = connectOffscreenLeaderSyncBridge(hub, () => sync ?? null);
  leaderBridge.signalLeaderMode(true);

  // Map orchestrator scoops to wire summaries (no helper exists; inline it).
  const toScoopSummaries = () =>
    orchestrator.getScoops().map((s) => ({
      jid: s.jid,
      name: s.name,
      folder: s.folder,
      isCone: s.isCone,
      assistantLabel: s.assistantLabel,
      trigger: s.trigger,
    }));

  // Cone-jid fallback (extension defaults the active scoop to the cone until
  // the panel pushes a `leader-active-scoop` selection).
  const getActiveJid = () =>
    leaderBridge.getActiveScoopJid() ?? bridge.getConeJid() ?? '';

  sync = new LeaderSyncManager({
    getMessages: () =>
      bridge.getBuffer(getActiveJid()) as unknown as ChatMessage[],
    getMessagesForScoop: (jid) =>
      bridge.getBuffer(jid) as unknown as ChatMessage[],
    getScoopJid: () => getActiveJid(),
    getScoops: toScoopSummaries,
    getSprinkles: () => leaderBridge.getSprinkles(),
    readSprinkleContent: async (name) => {
      const path = leaderBridge.resolveSprinklePath(name);
      if (!path || !host.sharedFs) return null;
      try {
        const raw = await host.sharedFs.readFile(path, { encoding: 'utf-8' });
        return typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
      } catch {
        return null;
      }
    },
    onSprinkleLick: (name, body, targetScoop) => {
      // Reuse the same handler the panel's `sprinkle-lick` envelope drives.
      // Implementation: extract offscreen-bridge.ts:924-962 into a public
      // method `bridge.routeSprinkleLick(name, body, targetScoop)` and call
      // it from both sites.
      void bridge.routeSprinkleLick(name, body, targetScoop);
    },
    onFollowerMessage: async (text, messageId, attachments) => {
      const activeJid = getActiveJid();
      if (!activeJid) return;
      const channelMsg: ChannelMessage = {
        id: messageId,
        chatJid: activeJid,
        senderId: 'user',
        senderName: 'User',
        content: text,
        attachments,
        timestamp: new Date().toISOString(),
        fromAssistant: false,
        channel: 'web',
      };

      // Step 1: panel echo. `'web'` is NOT in EXTERNAL_LICK_CHANNELS
      // (lick-formatting.ts:29-37), so `orchestrator.handleMessage`'s
      // gated `onIncomingMessage` call at orchestrator.ts:1297-1306 does
      // NOT fire for this channel. Without the explicit emit below, the
      // follower's typed message never reaches the leader's panel UI —
      // it just feeds into the agent queue invisibly. Mirrors standalone's
      // `layout.panels.chat.addUserMessage(text, attachments)` at
      // main.ts:2454, but via the bridge's existing wire envelope shape
      // so panel rendering follows the same code path as a normal
      // incoming message.
      bridge.notifyPanelIncomingMessage(activeJid, channelMsg);

      // Step 2: buffer-insert + persist (matches the panel `user-message`
      // path at offscreen-bridge.ts:784-791).
      bridge.getBuffer(activeJid).push({
        id: messageId,
        role: 'user',
        content: text,
        attachments,
        timestamp: Date.now(),
      });
      bridge.persistScoop(activeJid);

      // Step 3: dispatch into the orchestrator and register the scoop tab.
      // `await` first (matches offscreen-bridge.ts:792-793 ordering) so the
      // scoop is fully realized before createScoopTab fires.
      await orchestrator.handleMessage(channelMsg);
      orchestrator.createScoopTab(activeJid);

      // Step 4: rebroadcast to sibling followers so multi-follower setups
      // aren't silently single-direction. Mirrors main.ts:2462.
      sync.broadcastUserMessage(text, messageId, attachments);
    },
    onFollowerAbort: () => {
      const jid = getActiveJid();
      if (jid) orchestrator.stopScoop(jid);
    },
    onFollowerCountChanged: (_count) => {
      // Persist follower list into a localStorage shim so `host` in the
      // terminal can read it. Extension-flavored equivalent of
      // main.ts:2466-2476.
      const peers = trayPeers.getPeers().map((p) => ({
        runtimeId: p.bootstrapId,
        runtime: p.runtime,
        connectedAt: p.connectedAt ?? undefined,
      }));
      window.localStorage.setItem('slicc.leaderTrayFollowers', JSON.stringify(peers));
    },
    browserAPI: browser,
    browserTransport: browser.getTransport(),
    vfs: host.sharedFs ?? undefined,
  });

  browser.setTrayTargetProvider(sync);

  trayPeers = new LeaderTrayPeerManager({
    sendControlMessage: (m) => trayLeader.sendControlMessage(m),
    onPeerConnected: (peer, channel) => {
      log.info('Extension tray follower connected', {
        bootstrapId: peer.bootstrapId,
        runtime: peer.runtime,
      });
      sync.addFollower(peer.bootstrapId, channel, {
        runtime: peer.runtime,
        connectedAt: peer.connectedAt ?? undefined,
      });
    },
    onPeerDisconnected: (bootstrapId, reason) =>
      log.info('Extension tray follower disconnected', { bootstrapId, reason }),
  });

  trayLeader = new LeaderTrayManager({
    workerBaseUrl: trayRuntimeConfig.workerBaseUrl,
    runtime: 'slicc-extension-offscreen',
    webSocketFactory: (url) => new ServiceWorkerLeaderTraySocket(url),
    onControlMessage: (message) => {
      // Extension owns lickManager in-process, so webhook.event can fire
      // directly into the orchestrator (no `lick-webhook-event` hop needed
      // — that's a standalone-only bridge).
      if (message.type === 'webhook.event') {
        orchestrator.handleWebhookEvent(message.webhookId, message.headers, message.body);
        return;
      }
      void trayPeers.handleControlMessage(message).catch((err) => {
        log.warn('Tray leader bootstrap handling failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    },
    onReconnecting: (attempt, lastError) =>
      log.info('Extension leader tray reconnecting', { attempt, lastError }),
    onReconnected: (session) =>
      log.info('Extension leader tray reconnected', { trayId: session.trayId }),
    onReconnectGaveUp: (lastError, attempts) =>
      log.warn('Extension leader tray reconnect gave up', { lastError, attempts }),
  });

  // Agent event tap. Filter by active scoop — see §1.
  const unsubAgent = bridge.onAgentEvent((eventScoopJid, event) => {
    if (eventScoopJid !== getActiveJid()) return;
    sync.broadcastEvent(event);
  });

  // CDP target refresh (throttled, mirrors standalone).
  const cdpThrottle = new ThrottledErrorTracker(log, {
    failureMessage: 'Extension leader CDP target refresh failed (best-effort, throttled)',
    recoveryMessage: 'Extension leader CDP target refresh recovered',
  });
  const refreshLeaderTargets = async () => {
    let pages;
    try {
      pages = await browser.listPages();
    } catch (err) {
      cdpThrottle.reportFailure(err);
      return;
    }
    cdpThrottle.reportSuccess();
    try {
      // setLocalTargets (LeaderSyncManager:725), NOT advertiseTargets (that's
      // the follower API at tray-follower-sync.ts:315).
      sync.setLocalTargets(
        pages.map((p) => ({ targetId: p.targetId, title: p.title, url: p.url }))
      );
    } catch (err) {
      log.error('Extension leader target broadcast failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const intervals: ReturnType<typeof setInterval>[] = [
    setInterval(refreshLeaderTargets, 5000),
    setInterval(() => {
      try {
        sync.broadcastScoopsList();
        sync.broadcastSprinklesList();
      } catch (err) {
        log.error('Failed to broadcast follower lists', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, 5000),
  ];
  void refreshLeaderTargets();

  void trayLeader.start().catch((err) => {
    log.warn('Extension leader tray start failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  // Wire host-command surfaces so `host` in the panel terminal shows
  // follower count + supports `host reset`. Equivalent of main.ts:2513-2522
  // but for the extension. (The setters are module-level singletons in
  // `host-command.ts` — usable from offscreen the same way they're used
  // from the page in standalone.)
  setConnectedFollowersGetter(() =>
    trayPeers.getPeers().map((p) => ({
      runtimeId: p.bootstrapId,
      runtime: p.runtime,
      connectedAt: p.connectedAt ?? undefined,
    }))
  );
  setTrayResetter(async () => {
    sync.stop();
    trayPeers.stop();
    trayLeader.stop();
    await trayLeader.clearSession();
    const session = await trayLeader.start();
    return getLeaderTrayRuntimeStatus();
  });

  // Teardown order matches standalone (page-leader-tray.ts:316-323):
  // unsubAgent → intervals → sync → peers → leader → bridge.
  stopTrayRuntime = () => {
    unsubAgent();
    for (const id of intervals) clearInterval(id);
    sync.stop();
    trayPeers.stop();
    trayLeader.stop();
    leaderBridge.signalLeaderMode(false);
    leaderBridge.detach();
    setConnectedFollowersGetter(null);
    setTrayResetter(null);
  };
  return;
}
```

### 5. `OffscreenBridge` additions

- `onAgentEvent(handler: (scoopJid: string, event: AgentEvent) => void): () => void`
  — see §1. The handler receives the wire envelope's `scoopJid` so the caller
  can filter.
- `getConeJid()` — already exists at offscreen-bridge.ts:476; no new method.
- `routeSprinkleLick(name, body, targetScoop): Promise<void>` — extract from
  the existing `sprinkle-lick` envelope handler at offscreen-bridge.ts:924-962
  into a public method. The envelope handler then calls this method (no
  behavior change to the existing path; just a refactor).
- `notifyPanelIncomingMessage(jid: string, message: ChannelMessage): void` —
  new public helper that wraps the existing `bridge.emit({ type:
'incoming-message', ... })` envelope construction (offscreen-bridge.ts:319-331).
  Used by `onFollowerMessage` to forcibly produce the panel echo since
  `'web'`-channel messages don't trigger `onIncomingMessage` (gated by
  `isExternalLickChannel` at orchestrator.ts:1297). Refactor: move the
  envelope construction out of the `onIncomingMessage` orchestrator callback
  into this helper, then have the callback call it. Single source of truth
  for the wire shape.
- `getBuffer(jid)` is currently `@internal` — drop the marker or expose a
  thin `getMessagesForJid(jid): ChatMessage[]` wrapper that does the
  `as unknown as ChatMessage[]` cast.
- `persistScoop(jid)` likewise — needed by `onFollowerMessage` to persist the
  inserted user message. Drop `@internal` or expose a public alias.
- `getActiveScoopJid(): string | null` — reads the panel-pushed
  `leader-active-scoop` value (cached on the bridge). Falls back to
  `getConeJid()` when no panel selection has been pushed yet.

There is **no scoop-select envelope today** (verified: not in `messages.ts`,
not in the bridge). The new `leader-active-scoop` message is the single
source of truth for the bridge's tracked active scoop in extension-leader
mode. In follower mode and stand-alone-extension mode the cone is the only
active surface, so the absence of a selection signal is fine.

### 6. Panel-side wiring in `main.ts`

Mirror the standalone wiring at `main.ts:2418-2503` for extension-leader mode.
In `mainExtension` (the side-panel boot path), install a long-lived
`PanelLeaderSyncProxy` that listens for the `leader-mode-changed` signal and
installs/removes hooks accordingly:

```ts
const leaderSyncProxy = new PanelLeaderSyncProxy(panelSender, panelSubscriber, {
  onLeaderModeChange: (active) => {
    if (active) installLeaderHooks();
    else removeLeaderHooks();
  },
});

// Named handler refs — anonymous arrows wouldn't unsubscribe (revision 3 fix).
const handleScoopSelected = (jid: string) => leaderSyncProxy.pushActiveScoop(jid);
const handleSprinklesChanged = () => {
  const opened = new Set(sprinkleManager.opened());
  leaderSyncProxy.pushSprinklesSnapshot(
    sprinkleManager.available().map((p) => ({
      name: p.name,
      title: p.title,
      path: p.path,
      open: opened.has(p.name),
      autoOpen: p.autoOpen,
    }))
  );
};
const handleSprinkleUpdate = (name: string, data: unknown) =>
  leaderSyncProxy.pushSprinkleUpdate(name, data);
const handleLocalUserMessage = (
  text: string,
  messageId: string,
  attachments?: MessageAttachment[]
) => leaderSyncProxy.pushUserMessageEcho(text, messageId, attachments);

let leaderHooksInstalled = false;
let offScoopSelected: (() => void) | null = null;
let offSprinklesChanged: (() => void) | null = null;

function installLeaderHooks() {
  if (leaderHooksInstalled) return;
  leaderHooksInstalled = true;

  offScoopSelected = client.onScoopSelected(handleScoopSelected);
  if (client.selectedScoopJid) handleScoopSelected(client.selectedScoopJid);

  offSprinklesChanged = sprinkleManager.onChange(handleSprinklesChanged);
  void sprinkleManager.refresh().then(handleSprinklesChanged);

  sprinkleManager.setSendToSprinkleHook(handleSprinkleUpdate);
  layout.panels.chat.setOnLocalUserMessage(handleLocalUserMessage);
}

function removeLeaderHooks() {
  if (!leaderHooksInstalled) return;
  leaderHooksInstalled = false;
  offScoopSelected?.();
  offScoopSelected = null;
  offSprinklesChanged?.();
  offSprinklesChanged = null;
  sprinkleManager.setSendToSprinkleHook(undefined);
  layout.panels.chat.setOnLocalUserMessage(undefined);
}

// Boot-time state request so popouts opening AFTER offscreen activated
// still install hooks (handled via the new `leader-request-mode-state` →
// `leader-mode-changed` round-trip in §3).
panelSender.send({
  source: 'panel',
  payload: { type: 'leader-request-mode-state' },
});
```

`client.onScoopSelected(handler): () => void` is a new event hook on
`OffscreenClient` — it fires when `selectScoop` sets `selectedScoopJid` and
returns an unsubscribe. Required so we don't poll. Each `on*` hook returns
its own unsubscribe (consistent with `OffscreenMessageHub.onPanelMessage`,
`SprinkleManager.onChange`).

**Detached popout:** because the panel boot path runs every time the side
panel or detached tab opens, and the `leader-mode-changed` envelope is emitted
by offscreen on activation (plus re-emitted in response to
`leader-request-mode-state`), the hooks attach correctly in both UI
surfaces.

### 6a. Panel `host reset` for the extension leader

Standalone wires `setTrayResetter` to `pageLeaderTray.reset()` on the page
where the tray subsystem lives. In extension the tray subsystem lives in
offscreen, and `host-command.ts:222` falls back to `buildPanelRpcResetter()`
— which returns `undefined` when there's no panel-RPC client for tray reset.
Result today: panel `host reset` in extension hits the "no active tray
session" message even when a tray is active.

Wire it via a new panel→offscreen RPC envelope (request/response — one of
the few round-trips this design has):

```ts
export interface LeaderTrayResetRequestMsg {
  type: 'leader-tray-reset';
  requestId: string;
}
export interface LeaderTrayResetResponseMsg {
  type: 'leader-tray-reset-response';
  requestId: string;
  ok: boolean;
  status?: LeaderTrayRuntimeStatus;
  error?: string;
}
```

The offscreen handler runs the same reset path `setTrayResetter` is wired to
in §4 — `sync.stop() → peers.stop() → leader.stop() → leader.clearSession()
→ leader.start()` — and returns the new status. The panel-side
`setTrayResetter` sends this RPC and awaits the response, then surfaces
errors the same way the standalone path does. ~30 LoC of wire glue plus the
existing handler; in scope for this PR.

### 7. `SprinkleManager.onChange`

`SprinkleManager` exposes `setupWatcher` (FsWatcher-driven `refresh()`) but no
`onChange` event today. Add:

```ts
onChange(handler: () => void): () => void;
```

Fires once _after_ every successful `refresh()` and after `open()` / `close()`
state changes. Internally coalesces — multiple `refresh()` invocations within
one tick fire `onChange` once. Used by the panel leader hook to push sprinkle
snapshots without duplicating logic at every callsite.

### 8. Lifecycle and gating

- **Activation:** offscreen takes the `workerBaseUrl` branch → emits
  `leader-mode-changed: active=true` → panel installs hooks.
- **Deactivation:** `stopTrayRuntime` runs (user pasted a join URL via
  `refresh-tray-runtime`, or document unloaded) → emits
  `leader-mode-changed: active=false` → panel removes hooks. `stopTrayRuntime`
  must call `leaderBridge.detach()` so the hub's `onPanelMessage` listener is
  unregistered — otherwise the join-URL switch leaves a stale leader listener
  alongside the new follower listener, and panel→offscreen sprinkle
  messages would be misrouted into the dead leader sync.
- **Panel late-attach (detached popout):** when a new panel boots, it sends
  `leader-request-mode-state` on connect; offscreen responds with the current
  `leader-mode-changed` envelope.
- **Re-entrancy:** `installLeaderHooks` / `removeLeaderHooks` are idempotent;
  the leader-mode listener fires once per state change.
- **Per-panel state:** `leaderHooksInstalled` and the cached unsubscribe
  handles are scoped to each `mainExtension` boot (side panel vs detached
  popout each get their own). The offscreen side is the single global source
  of truth.

## Wire protocol invariants

We add no new tray-protocol messages — every wire payload sent over the data
channel is one that `LeaderSyncManager.broadcast*` already emits. Followers
(standalone webapp, extension-as-follower, iOS native) already understand
them; this fix only makes the extension-leader produce them. The protocol
file (`tray-sync-protocol.ts`) is not touched.

The new envelopes in §3 are intra-extension `chrome.runtime` messages only,
not tray-wire.

## Tests

| Layer                   | Test file                                                           | Coverage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bridge unit             | `packages/chrome-extension/tests/leader-sync-bridge.test.ts` (new)  | proxy↔adapter in-memory pipe: sprinkles snapshot caching + `getSprinkles`, `resolveSprinklePath` hit/miss, active-scoop caching, sprinkle update → mock `sync.broadcastSprinkleUpdate`, user echo → mock `sync.broadcastUserMessage`, leader-mode-changed signal round-trips, `detach()` stops both directions                                                                                                                                                                                                                                                                                                                                                                                                                            |
| AgentEvent tap          | `packages/chrome-extension/tests/offscreen-bridge.test.ts` (extend) | Drive each `agent-event` envelope shape through `bridge.emit(...)` (the tap's actual hook layer, per §1) and assert the synthesized `AgentEvent` plus its `scoopJid` argument; cover `text_delta` (with/without prior `messageId`), `tool_start`, `tool_end`, `tool_ui`, `tool_ui_done`, `response_done`; assert unsubscribe stops emission                                                                                                                                                                                                                                                                                                                                                                                               |
| Follower-message echo   | `packages/chrome-extension/tests/offscreen-bridge.test.ts` (extend) | `bridge.notifyPanelIncomingMessage(jid, channelMsg)` emits the canonical `incoming-message` wire envelope (same shape as offscreen-bridge.ts:319-331); a single end-to-end test asserts the leader factory's `onFollowerMessage` causes a matching envelope to flow into a panel-fake's queue                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Sprinkle-lick refactor  | `packages/chrome-extension/tests/offscreen-bridge.test.ts` (extend) | `routeSprinkleLick` produces identical orchestrator state to the existing `sprinkle-lick` envelope path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Leader factory          | `packages/chrome-extension/tests/leader-factory.test.ts` (new)      | requires extracting `startExtensionLeaderTray(...)` helper (see "Refactoring for testability" below); covers: peer connected → `sync.addFollower`, agent-event tap filters by active scoop AND forwards `broadcastEvent`, broadcast intervals tick scoops + sprinkles, CDP refresh calls `setLocalTargets` (not `advertiseTargets`), `webhook.event` routes to `orchestrator.handleWebhookEvent`, follower-message routes orchestrator + emits panel incoming-message + rebroadcasts, `leader-tray-reset` RPC round-trips and returns post-reset status, teardown order matches standalone, hub `onPanelMessage` listener detached on stop (no leak across leader→follower switch), `setConnectedFollowersGetter`/`setTrayResetter` wired |
| Standalone-leader smoke | `packages/webapp/tests/ui/page-leader-tray.test.ts` (existing)      | no changes — reference path is unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Manual integration      | (no automation)                                                     | See "Manual test plan" below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

### Refactoring for testability

Extract the body of the `workerBaseUrl` branch (~200 LoC) into a new module
`packages/chrome-extension/src/extension-leader-tray.ts` exposing
`startExtensionLeaderTray(options)` — same pattern as `startPageLeaderTray`.
The integration test then targets that helper with stubbed transports and a
mock `RTCDataChannel`, avoiding the need to bootstrap `createKernelHost` or
real Chrome APIs.

## Manual test plan

1. `SLICC_EXT_DEV=1 npm run build -w @slicc/chrome-extension`. Load
   `dist/extension` in Chrome for Testing per `packages/chrome-extension/CLAUDE.md`
   "Local QA" recipe.
2. In the extension side panel, paste a tray worker URL (no join URL).
   Confirm: panel terminal `host` shows leader status active and reports the
   tray join URL.
3. In a separate window, run `npm run dev` and open the standalone webapp.
   Paste the same tray join URL.
4. Standalone follower must show: initial snapshot (any pre-existing
   conversation), full scoops list, sprinkles list.
5. Type in the **leader** chat → follower sees the user message live + agent
   stream tokens.
6. Trigger leader-side `sprinkle send welcome '{"action":"test"}'` from the
   **panel terminal** → follower's welcome sprinkle receives the update.
7. Trigger leader-side `sprinkle send welcome '{...}'` via the **agent bash
   tool** (different code path through the sprinkle proxy) → follower's
   sprinkle still receives the update.
8. Click a sprinkle on the **follower** → leader's lick router fires (verify
   via cone receiving a `sprinkle` channel message in the leader chat).
9. Type a message on the **follower** → leader's cone receives it as a user
   message, **the leader's panel chat ALSO shows the user message** (revision 3
   regression fix — explicit `notifyPanelIncomingMessage` emit), AND a second
   standalone follower (open another browser) ALSO sees the message
   (multi-follower rebroadcast).
10. Switch the **leader** to a sub-scoop in the panel; verify the follower's
    visible scoop list updates and that subsequent agent events for the
    selected scoop reach the follower with the correct `scoopJid`.
11. Fire a tray webhook event against the leader's session (use `curl` against
    the worker's `/webhook/<trayId>/<webhookId>` endpoint) → cone receives the
    webhook lick (proves `webhook.event` control routing works).
12. Paste a join URL into the leader's settings while connected → leader mode
    deactivates, follower mode activates, no zombie WebSocket / data channel
    / interval / agent-event subscription / leader hub listener.
13. In the panel terminal, run `host reset` while the leader is connected →
    the tray clears and re-starts; follower (still connected) re-handshakes
    with the new tray id.

## Open questions to resolve during implementation

1. **AgentEvent fidelity diff against standalone.** Before merging, capture
   the standalone-leader's wire payloads for the same 3-turn scenario and
   diff against the extension-leader's. If the synthesized stream omits a
   field the protocol consumer relies on, either (a) extend the synthesis
   or (b) bypass the `AgentEvent` shape and emit a custom event type on the
   wire.

2. **`SprinkleManager.onChange` and watcher coalescing.** The FsWatcher
   already triggers `refresh()` on `.shtml` changes (sprinkle-manager.ts:469).
   Confirm that wiring `onChange` to fire after `refresh()` completes (rather
   than per-file) doesn't deduplicate event-driven panel pushes. Test by
   installing two sprinkles via the agent in one bash invocation and asserting
   exactly one snapshot push fires.

3. **`onScoopSelected` hook on `OffscreenClient`.** Confirm `selectScoop`
   (main.ts:655-672) is the single panel-side mutation point for
   `selectedScoopJid`; if not, hook earlier.

4. ~~**`request-leader-mode-state` panel→offscreen envelope.**~~ — resolved
   in revision 3 (now defined in §3 as `LeaderRequestLeaderModeStateMsg`).
   Panel sends on `offscreen-ready` / on its own boot;
   offscreen responds with the current `leader-mode-changed`.

## LoC estimate

| File                                                                                                                          |   Source |    Tests |
| ----------------------------------------------------------------------------------------------------------------------------- | -------: | -------: |
| `leader-sync-bridge.ts`                                                                                                       |     ~180 |     ~180 |
| `messages.ts` additions (6 panel→offscreen + 2 offscreen→panel)                                                               |      ~55 |        — |
| `offscreen-bridge.ts` AgentEvent tap + `routeSprinkleLick` extract + `notifyPanelIncomingMessage` + `getMessagesForJid` alias |     ~110 |      ~90 |
| `extension-leader-tray.ts` (extracted helper, incl. `host reset` RPC handler)                                                 |     ~250 |     ~170 |
| `offscreen.ts` (delegation to the helper + `leader-tray-reset` envelope routing)                                              |      ~40 |        — |
| `main.ts` panel-side wiring + activation listener + reset RPC client                                                          |      ~90 |        — |
| `SprinkleManager.onChange`                                                                                                    |      ~20 |      ~30 |
| `OffscreenClient.onScoopSelected`                                                                                             |      ~10 |      ~10 |
| `architecture.md` update                                                                                                      |      ~10 |        — |
| **Total**                                                                                                                     | **~765** | **~480** |

Wider than the issue's ~150-200 estimate because: (a) coverage targets the
existing extension-package coverage floors; (b) the AgentEvent tap, webhook
routing, multi-follower rebroadcast, active-scoop tracking, and host-command
parity are each real plumbing the issue didn't itemize; (c) the leader-branch
body is extracted into a testable helper.

## Documentation updates

- `docs/architecture.md:370-371` — extension leader row currently describes it
  as functional. Update to reflect that sync is now wired through
  `extension-leader-tray.ts` and the panel↔offscreen leader bridge.
- `packages/chrome-extension/CLAUDE.md` — add a "Tray leader" section under
  "Three-Layer Architecture" describing the panel→offscreen push surface and
  the offscreen→panel activation signal.
- `docs/architecture.md` "Multi-Browser Sync (Tray) Architecture" section —
  remove the implicit asymmetry; standalone-leader and extension-leader now
  both broadcast.

## Cross-references

- Standalone reference: `packages/webapp/src/ui/page-leader-tray.ts`
- Standalone caller: `packages/webapp/src/ui/main.ts:2418-2503`
- Gap site: `packages/chrome-extension/src/offscreen.ts:438-480`
- Existing panel↔offscreen RPC patterns: `sprinkle-proxy.ts`,
  `follower-sprinkle-bridge.ts`, `OffscreenBridge.createCallbacks`
- Existing wire→AgentEvent translation reference: `offscreen-client.ts:495-585`
- Existing sprinkle-lick handler to refactor: `offscreen-bridge.ts:924-962`
- Existing webhook handler the standalone path hops to:
  `orchestrator.handleWebhookEvent`
- Protocol: `packages/webapp/src/scoops/tray-sync-protocol.ts` (no changes)
- Architecture: `docs/architecture.md` "Multi-Browser Sync (Tray) Architecture"

## Revision history

**Revision 3 (2026-05-20):** Applied corrections from second review. Verified
each claim against current `main` HEAD via direct code reads. Changes:

1. **Critical — follower-message panel echo.** Revision 2 claimed the panel
   echo was free via `orchestrator.handleMessage`'s gated `onIncomingMessage`.
   That gating only fires for `EXTERNAL_LICK_CHANNELS` (lick-formatting.ts:29-37)
   — `'web'` is excluded. Updated §4 to explicitly call a new bridge helper
   `notifyPanelIncomingMessage(jid, channelMsg)` after the buffer insert,
   mirroring the existing `incoming-message` envelope shape at
   offscreen-bridge.ts:319-331. Manual test step 9 amended to verify the
   leader-panel echo explicitly.
2. **AgentEvent active-scoop filter.** `LeaderSyncManager.broadcastEvent`
   ignores the event's `scoopJid` and tags wire payloads with
   `options.getScoopJid()` (tray-leader-sync.ts:300-304). Without filtering at
   the tap, background-scoop events would be broadcast tagged as the active
   scoop. Changed §1 signature to `onAgentEvent((scoopJid, event) => …)` and
   §4 to filter `eventScoopJid !== getActiveJid()` before
   `sync.broadcastEvent`. Matches standalone's implicit filter via
   `agentHandle.onEvent` → `handleAgentEvent` at offscreen-client.ts:496.
3. **`onFollowerMessage` await + tab ordering.** Now `await
orchestrator.handleMessage(channelMsg)` before `createScoopTab` (matches
   offscreen-bridge.ts:792-793). Function is `async` instead of `void`-call.
4. **Added `leader-request-mode-state` envelope to §3.** Revision 2 mentioned
   it only in §6 and the open-questions list; now formally part of the
   message-type spec.
5. **Added `host reset` plumbing (§6a).** Panel terminal `host reset` in
   extension currently no-ops because `buildPanelRpcResetter` returns
   `undefined` without a panel-RPC client. New `leader-tray-reset` /
   `leader-tray-reset-response` request/response envelope (the only
   round-trip in the design) plus offscreen handler. Tests + manual step 13
   added.
6. **Panel hook removal uses named refs (§6).** Revision 2's pseudocode used
   `/* same handler */` placeholders; replaced with stable `const`
   declarations and returned unsubscribe handles.
7. **Hub listener detach on switch (§8 + tests).** Made it explicit that
   `stopTrayRuntime` must invoke `leaderBridge.detach()` so the leader's hub
   listener is unregistered before the follower's listener attaches.
   Otherwise a sprinkle update sent by the (now-active) follower path could
   double-route. New test row covers it.
8. **`OffscreenBridge` additions clarified (§5).** Added
   `notifyPanelIncomingMessage` and `getActiveScoopJid` to the public surface
   list; called out `getBuffer` / `persistScoop` exposure explicitly so
   implementers don't bypass via `as any`.
9. **AgentEvent tap tests targeted at `emit()` layer** (tests section). Match
   the §1 hook point — driving raw `OrchestratorCallbacks` would test the
   wrong layer.
10. **LoC re-estimated** to reflect the additional `host reset` plumbing and
    `notifyPanelIncomingMessage` helper (~765/480 vs ~670/450).
11. **Revision 2 history item 3 retroactively corrected.** The "panel
    chat-echo via `onIncomingMessage`" claim from revision 2's history was
    wrong — superseded by the explicit emit in item 1 above.

**Revision 2 (2026-05-20):** Applied corrections from first review.
Verified against current `main` HEAD via direct code reads, not the review's
assertions alone. Changes:

1. **`setLocalTargets` not `advertiseTargets`** (§4). `LeaderSyncManager:725`
   has `setLocalTargets`; `advertiseTargets` is `FollowerSyncManager:315`.
2. **Webhook routing added** (§4 `onControlMessage` branch). Extension
   `lickManager` is in-process via `createKernelHost`, so `webhook.event`
   calls `orchestrator.handleWebhookEvent` directly (no `lick-webhook-event`
   hop — that's a standalone artifact).
3. **`onFollowerMessage` expanded** (§4). Now: (a) constructs `ChannelMessage`,
   inserts into buffer, persists, calls `orchestrator.handleMessage` —
   producing the panel chat-echo via the existing `onIncomingMessage`
   callback; (b) calls `sync.broadcastUserMessage` to fan out to sibling
   followers.
4. **Active-scoop tracking** (§3, §5, §6). Added `leader-active-scoop`
   message and `OffscreenClient.onScoopSelected` hook. Replaces revision 1's
   reference to a nonexistent `scoop-select` envelope.
5. **Circular-init fixed** (§4). Bridge factory now takes a `() =>
LeaderSyncManager | null` getter; forward-declared `let sync!` matches
   standalone's pattern.
6. **`CONE_JID` / `toScoopSummary` removed** (§4). Use `bridge.getConeJid()`
   (existing) and inline `orchestrator.getScoops().map(...)`.
7. **AgentEvent mapping rewritten** (§1). Now mirrors
   `offscreen-client.ts:handleAgentEvent` (wire types → UI `AgentEvent`)
   instead of the pi-shaped table from revision 1. Tap point moves to the
   bridge's `emit()` call so it reuses `currentMessageId` state.
8. **Sprinkle-lick path corrected** (§5). Refactor `offscreen-bridge.ts:924-962`
   into `OffscreenBridge.routeSprinkleLick(...)` and call it from both the
   `sprinkle-lick` envelope handler and the leader's `onSprinkleLick`
   callback. Revision 1's claim that follower path uses
   `lickManager.emitEvent` at `offscreen.ts:247` was wrong (that line is
   `navigate`).
9. **`BufferedChatMessage` cast documented** (key-insight table, §4). The
   bridge already uses `buf as unknown as ChatMessage[]` at offscreen-bridge.ts:671.
10. **Teardown order matches standalone** (§4). unsubAgent → intervals →
    sync → peers → leader → bridge.
11. **Offscreen→panel envelopes defined** (§3). `leader-mode-changed` + a
    `request-leader-mode-state` for popout late-attach.
12. **Host / followers / reset wired** (§4). `setConnectedFollowersGetter`,
    `setTrayResetter`, `slicc.leaderTrayFollowers` localStorage shim.
13. **`offscreen.ts` body extracted to `extension-leader-tray.ts`** (§4, tests
    section). Avoids 200-line integration tests against the real `init()`.
14. **Manual test plan expanded** (tests). Added webhook, multi-follower
    rebroadcast, agent-vs-terminal sprinkle send, sub-scoop selection.
15. **architecture.md update tracked** (docs section).
