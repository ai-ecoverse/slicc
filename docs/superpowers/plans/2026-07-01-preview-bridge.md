# Driveable Preview Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `serve --bridge <dir>` turn an opted-in worker-relayed preview into a live, leader-driveable synthetic-CDP target: any browser that opens the URL auto-connects back to the leader over the existing controller WebSocket (via the tray Durable Object, WebSocket-hibernated), and the cone can navigate / eval / DOM / input / screenshot it and receive page events as webhook licks.

**Architecture:** Cherry's synthetic-CDP model, relocated into the preview page's own origin and re-backhauled over the existing preview worker-WS relay instead of WebRTC. The visitor bootstrap runs Cherry's `createCdpHostHandler` against its own `document`; the DO relays `bridge.cdp.*` between a new hibernatable bridge WebSocket and the leader's controller WS; the leader drives it through the existing federated-CDP path via a new `PreviewBridgeCdpTransport` (a `CherryHostTransport` with a WS backhaul). Page→cone events reuse the webhook lick path via a same-origin `/__slicc/emit` relay; cone→page uses `Runtime.evaluate`.

**Tech Stack:** TypeScript. Cloudflare Workers + Durable Objects (WebSocket Hibernation API, `HTMLRewriter`). Vitest (node + jsdom). esbuild/rollup for the bootstrap bundle. No new runtime dependencies beyond the existing `html2canvas-pro` (already used by Cherry).

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-01-preview-bridge-design.md` — the authoritative source; every task traces to it.
- **Node >= 22.13.0.** Prettier must pass before every commit (husky `lint-staged` runs it; CI rejects unformatted code).
- **Four build gates before any merge:** `npm run typecheck`, `npm run test`, `npm run build -w @slicc/webapp`, `npm run build -w @slicc/chrome-extension`. Coverage stays at/above each package floor in `coverage-thresholds.json`.
- **Driveability is explicit-only:** `PreviewRecord.bridge = !noBridge && bridgeFlag` — NEVER inherit from `allowLive` / `hasCherryFollower`. A plain `serve` must stay read-only.
- **The bootstrap bundle must NOT import `@slicc/webapp`** (same rule as the Cherry SDK). It may import from `@ai-ecoverse/cherry`.
- **No `Network.*`** on a preview target; exclude `'preview'` from both teleport paths.
- **Dual-mode:** the leader may be any float (standalone / extension / Electron / cloud). The relay rides the controller WS the tray leader already holds; no float-specific branches.
- **Worker control-message types are mirrored:** any change to `packages/cloudflare-worker/src/tray-signaling.ts` must be mirrored in `packages/webapp/src/scoops/tray-types.ts`.
- **Cross-subdomain cookie risk is an accepted, documented residual** (spec §7) — no test enforces it.
- **`codex exec` for reviews:** run with `< /dev/null` (it hangs on stdin in background).

---

## File Structure

**Worker (`packages/cloudflare-worker/`)**

- Modify `src/shared.ts` — extend `DurableObjectStateLike` (`getTags`, `setWebSocketAutoResponse`) and `TrayWebSocketLike` (`serializeAttachment`, `deserializeAttachment`).
- Modify `src/tray-signaling.ts` — add `bridge.*` control messages + `'preview'` target kind.
- Modify `src/session-tray-preview.ts` — `PreviewRecord` fields (`bridge`, `maxTabs`, `webhookId`); DO-internal mint returns `previewToken`; stop/revoke response returns `webhookId`.
- Modify `src/preview-routes.ts` — the public `/api/tray/:trayId/preview` mint/stop wrappers forward `bridge`/`maxTabs`/`webhookId` and relay `previewToken`/`webhookId` (Task 17).
- Modify `src/session-tray.ts` (the DO — only it owns sockets) — `handleBridgeWebSocket`, role-routing in `webSocketMessage`, `bridge.*` relay, auto-response, close→`bridge.disconnected`, `/internal/preview/emit`, and `closeBridgeSocketsForPreview` on a successful stop.
- New `src/preview-bridge-routes.ts` — shared `/__slicc/*` route handling + `injectBridge`, called by both `preview-worker.ts` and `preview-handler.ts` (Tasks 8–9).
- Modify `src/preview-worker.ts` + `src/preview-handler.ts` — call the shared `/__slicc/*` pre-resolve routes + `HTMLRewriter` injection + CSP augmentation.
- New `src/preview-bridge-assets.ts` — generated: the embedded single-IIFE bootstrap bytes (html2canvas bundled in; no separate chunk).
- Modify `tests/index.test.ts` — extend the fake DO state (tags/attachments/auto-response).

**Bootstrap (`packages/cherry/`)**

- New `src/preview-bootstrap.ts` — the injected client (WS + `createCdpHostHandler` + `window.slicc`).
- Modify build (`package.json` / a small esbuild script `scripts/build-preview-bootstrap.mjs`) to emit a single classic IIFE `dist/preview-bridge.js` (html2canvas bundled in; no splitting).

**Webapp (`packages/webapp/src/`)**

- New `cdp/synthetic-cdp-transport.ts` — `SyntheticCdpTransport` base (extracted from `CherryHostTransport`).
- Modify `cdp/cherry-host-transport.ts` — subclass the base.
- New `cdp/preview-bridge-cdp-transport.ts` — `PreviewBridgeCdpTransport`.
- Modify `cdp/types.ts` — `PageInfo.kind` gains `'preview'`.
- Modify `scoops/tray-types.ts` — mirror `bridge.*` + `'preview'` kind.
- Modify `scoops/tray-sync-protocol.ts` — `RemoteTargetInfo` + `TrayTargetEntry` kind unions.
- Modify `scoops/tray-leader-sync.ts` — bridge-conn registry, mint map, `sendControl` option, target surfacing, teleport exclusion, and the `runtimeId === 'preview'` case in `createRemoteTransport` (page-side; the worker-side `panel-rpc-tray-provider` tunnels transparently, so it needs no change — see Task 15).
- Modify `ui/page-leader-tray.ts` — `bridge.*` dispatch in `onControlMessage`; wire `sendControl` in `buildSyncManager`; `preview.revoked` drops the mint entry.
- Modify `scoops/lick-manager.ts` — `'preview'` lick type.
- Modify `scoops/lick-formatting.ts` + `kernel/host.ts` — render plumbing for `'preview'`.
- Modify `shell/supplemental-commands/serve-command.ts` — flags + `serve --stop` + worker-realm webhook provision/delete.
- Modify `shell/supplemental-commands/playwright/teleport.ts` — `armTeleportWatcher` rejects the `'preview'` runtime (covers navigation/tabs/teleport handlers).
- Modify the mint contract: `scoops/preview-minter.ts`, `shell/supplemental-commands/preview-mint-client.ts`, `kernel/panel-rpc.ts`, `ui/panel-rpc-handlers.ts`, `ui/boot/setup-standalone-panel-rpc.ts` (see Task 17).

**Docs:** root/webapp/worker/cherry `CLAUDE.md`, `docs/architecture.md`, `docs/shell-reference.md`, `README.md`, `packages/vfs-root/workspace/skills/*` serve skill.

---

## Task 1: Extend the DO WebSocket abstraction (tags, attachments, auto-response)

**Files:**

- Modify: `packages/cloudflare-worker/src/shared.ts` — extend `DurableObjectStateLike` (`:36`) **and move `TrayWebSocketLike` here and export it** (it is currently private in `session-tray.ts:58`, so the test can't import it and the extension has no home).
- Modify: `packages/cloudflare-worker/src/session-tray.ts` — remove the local `interface TrayWebSocketLike` (`:58`) and `import { TrayWebSocketLike } from './shared.js'` instead (no behavior change).
- Test: `packages/cloudflare-worker/tests/do-ws-abstraction.test.ts` (create)

**Interfaces:**

- Produces: `DurableObjectStateLike.getTags?(ws: unknown): string[]`, `DurableObjectStateLike.setWebSocketAutoResponse?(pair: unknown): void`; exported `TrayWebSocketLike` gains `serializeAttachment?(v: unknown): void`, `deserializeAttachment?(): unknown`. All optional (`?:`) so existing runtimes without them still typecheck, mirroring the existing optional `acceptWebSocket?`/`getWebSockets?`.

- [ ] **Step 1: Write the failing test** — a fake WS records attachment + tags round-trip.

`packages/cloudflare-worker/tests/do-ws-abstraction.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { TrayWebSocketLike, DurableObjectStateLike } from '../src/shared.js';

// A minimal fake implementing the extended seam, proving the shape compiles + round-trips.
function makeFakeWs(): TrayWebSocketLike {
  let attachment: unknown;
  return {
    send: () => {},
    close: () => {},
    serializeAttachment: (v: unknown) => {
      attachment = v;
    },
    deserializeAttachment: () => attachment,
  };
}

describe('DO WS abstraction extensions', () => {
  it('round-trips a serialized attachment', () => {
    const ws = makeFakeWs();
    ws.serializeAttachment?.({ connId: 'c1', previewToken: 't.s' });
    expect(ws.deserializeAttachment?.()).toEqual({ connId: 'c1', previewToken: 't.s' });
  });

  it('state exposes getTags and setWebSocketAutoResponse as optional members', () => {
    const state: Partial<DurableObjectStateLike> = {
      getTags: (_ws: unknown) => ['leader'],
      setWebSocketAutoResponse: (_pair: unknown) => {},
    };
    expect(state.getTags?.({})).toEqual(['leader']);
    expect(() => state.setWebSocketAutoResponse?.({})).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cloudflare-worker && npx vitest run tests/do-ws-abstraction.test.ts`
Expected: FAIL — `serializeAttachment`/`getTags` not on the types.

- [ ] **Step 3: Move + export `TrayWebSocketLike` to `src/shared.ts` and extend both interfaces.** Cut the `interface TrayWebSocketLike { ... }` block from `session-tray.ts:58`, paste it into `shared.ts` with `export`, and add the new members; extend `DurableObjectStateLike` (`:36`) too:

```ts
// src/shared.ts
export interface DurableObjectStateLike {
  // ...existing members (acceptWebSocket?, getWebSockets?, storage, etc.)...
  getTags?(ws: unknown): string[];
  setWebSocketAutoResponse?(pair: unknown): void;
}

export interface TrayWebSocketLike {
  // ...the exact members moved from session-tray.ts (send, close, ...)...
  serializeAttachment?(value: unknown): void;
  deserializeAttachment?(): unknown;
}
```

- [ ] **Step 4: Re-import in `session-tray.ts`.** Delete the now-moved local interface and add `import { type TrayWebSocketLike } from './shared.js';` (it is used ~15× there — `:70`, `:85`, `:90`, `:201`, `:210`, etc.). No behavior change.

- [ ] **Step 5: Run test + typecheck**

Run: `cd packages/cloudflare-worker && npx vitest run tests/do-ws-abstraction.test.ts && npx tsc --noEmit -p tsconfig.worker.json 2>/dev/null || cd ../.. && npm run typecheck`
Expected: PASS + clean typecheck (session-tray.ts still compiles against the moved type).

- [ ] **Step 6: Commit**

```bash
git add packages/cloudflare-worker/src/shared.ts packages/cloudflare-worker/src/session-tray.ts packages/cloudflare-worker/tests/do-ws-abstraction.test.ts
git commit -m "feat(worker): export+extend TrayWebSocketLike + DO state (tags/attachments/auto-response)"
```

---

## Task 2: Add `bridge.*` control messages + `'preview'` target kind (worker + webapp mirror)

**Files:**

- Modify: `packages/cloudflare-worker/src/tray-signaling.ts`
- Modify: `packages/webapp/src/scoops/tray-types.ts`
- Modify: `packages/webapp/src/scoops/tray-sync-protocol.ts` (`RemoteTargetInfo`, `TrayTargetEntry` kind unions)
- Modify: `packages/webapp/src/cdp/types.ts` (`PageInfo.kind`)
- Test: `packages/cloudflare-worker/tests/bridge-signaling.test.ts` (create)

**Interfaces:**

- Produces (worker `WorkerToLeaderControlMessage`): `{ type:'bridge.connected'; connId:string; previewToken:string; origin:string; userAgent:string; connectedAt:string }`, `{ type:'bridge.disconnected'; connId:string; reason?:string }`, `{ type:'bridge.cdp.response'; connId:string; id:number; result?:Record<string,unknown>; error?:{code:number;message:string} }`, `{ type:'bridge.cdp.event'; connId:string; method:string; params?:Record<string,unknown> }`.
- Produces (worker `LeaderToWorkerControlMessage`): `{ type:'bridge.cdp.request'; connId:string; id:number; method:string; params?:Record<string,unknown>; sessionId?:string }`.
- Produces: target `kind` union gains `'preview'` in `RemoteTargetInfo`, `TrayTargetEntry`, `PageInfo`.

- [ ] **Step 1: Write the failing test** — a type-guard round-trip for the new messages.

`packages/cloudflare-worker/tests/bridge-signaling.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type {
  WorkerToLeaderControlMessage,
  LeaderToWorkerControlMessage,
} from '../src/tray-signaling.js';

describe('bridge control messages', () => {
  it('constructs a bridge.connected + bridge.cdp.request', () => {
    const connected: WorkerToLeaderControlMessage = {
      type: 'bridge.connected',
      connId: 'c1',
      previewToken: 'tray.secret',
      origin: 'https://x.sliccy.now',
      userAgent: 'UA',
      connectedAt: new Date().toISOString(),
    };
    const req: LeaderToWorkerControlMessage = {
      type: 'bridge.cdp.request',
      connId: 'c1',
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression: '1+1' },
    };
    expect(connected.type).toBe('bridge.connected');
    expect(req.method).toBe('Runtime.evaluate');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cloudflare-worker && npx vitest run tests/bridge-signaling.test.ts`
Expected: FAIL — types not in the union.

- [ ] **Step 3: Add the message variants** to the `WorkerToLeaderControlMessage` and `LeaderToWorkerControlMessage` unions in `packages/cloudflare-worker/src/tray-signaling.ts` (using the exact shapes in Interfaces above), and mirror them verbatim in `packages/webapp/src/scoops/tray-types.ts`.

- [ ] **Step 4: Add `'preview'` to the kind unions** in `packages/webapp/src/scoops/tray-sync-protocol.ts` (`RemoteTargetInfo.kind`, `TrayTargetEntry.kind` → `'browser' | 'cherry' | 'preview'`) and `packages/webapp/src/cdp/types.ts` (`PageInfo.kind`).

- [ ] **Step 5: Run test + typecheck**

Run: `cd packages/cloudflare-worker && npx vitest run tests/bridge-signaling.test.ts && cd ../.. && npm run typecheck`
Expected: PASS + clean typecheck (mirror kept in sync).

- [ ] **Step 6: Commit**

```bash
git add packages/cloudflare-worker/src/tray-signaling.ts packages/webapp/src/scoops/tray-types.ts packages/webapp/src/scoops/tray-sync-protocol.ts packages/webapp/src/cdp/types.ts packages/cloudflare-worker/tests/bridge-signaling.test.ts
git commit -m "feat(worker,webapp): add bridge.* control messages and 'preview' target kind"
```

---

## Task 3: `PreviewRecord` gains `bridge` / `maxTabs` / `webhookId` (mint + resolve)

**Files:**

- Modify: `packages/cloudflare-worker/src/session-tray-preview.ts` (`PreviewRecord`, `mintPreview`, `resolvePreview`)
- Modify: `packages/cloudflare-worker/src/preview-worker.ts` (resolve payload type at `:39`)
- Test: `packages/cloudflare-worker/tests/session-tray-preview.test.ts` (extend existing, or create if absent)

**Interfaces:**

- Produces: `PreviewRecord` gains `bridge: boolean`, `maxTabs: number`, `webhookId?: string`. `mintPreview` accepts them in its body; `resolvePreview` returns them alongside `servedRoot`/`entryPath`/`allowLive`/`cacheVersion`.

- [ ] **Step 1: Write the failing test** — mint with `bridge:true, maxTabs:5, webhookId:'wh1'` then resolve returns them.

```ts
// in tests/session-tray-preview.test.ts
it('persists and resolves bridge fields', async () => {
  const { stub } = makeTrayWithLeader(); // existing helper pattern in this test file
  const mint = await stub.fetch(
    new Request('https://internal/internal/preview/mint', {
      method: 'POST',
      // controllerToken + workerBaseUrl are REQUIRED by the internal mint (session-tray-preview.ts:175,312) — mirror the existing mint tests
      body: JSON.stringify({
        controllerToken,
        workerBaseUrl,
        servedRoot: '/workspace/dist',
        entryPath: '/workspace/dist/index.html',
        allowLive: true,
        bridge: true,
        maxTabs: 5,
        webhookId: 'wh1',
      }),
    })
  );
  const { previewToken } = await mint.json();
  const res = await stub.fetch(
    new Request(
      `https://internal/internal/preview/resolve?token=${encodeURIComponent(previewToken)}`
    )
  );
  const rec = await res.json();
  expect(rec.bridge).toBe(true);
  expect(rec.maxTabs).toBe(5);
  expect(rec.webhookId).toBe('wh1');
});
```

> If the mint internal route differs, mirror the exact request shape used by the existing mint tests in this file.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cloudflare-worker && npx vitest run tests/session-tray-preview.test.ts -t "bridge fields"`
Expected: FAIL — fields undefined.

- [ ] **Step 3: Add the fields** to `PreviewRecord` and thread them through `mintPreview` (read from the POST body, default `bridge:false`, `maxTabs:20`) and `resolvePreview` (include in the JSON response). Update the resolve payload type in `preview-worker.ts:39` to include `bridge`, `maxTabs`, `webhookId`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cloudflare-worker && npx vitest run tests/session-tray-preview.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cloudflare-worker/src/session-tray-preview.ts packages/cloudflare-worker/src/preview-worker.ts packages/cloudflare-worker/tests/session-tray-preview.test.ts
git commit -m "feat(worker): persist bridge/maxTabs/webhookId on PreviewRecord"
```

---

## Task 4: Extend the fake DO state in tests (tags + attachments + auto-response)

**Files:**

- Modify: `packages/cloudflare-worker/tests/index.test.ts` (the `FakeDurableObjectState` around `:35`) — or extract a shared test helper `tests/fake-do-state.ts` if that reduces duplication.
- Test: covered by Task 5/6 (this task makes the harness capable; verify it compiles + a smoke assertion).

**Interfaces:**

- Produces: the fake state now stores per-socket tags and per-socket attachments, implements `getTags(ws)`, `getWebSockets(tag?)` filtered by tag, `serializeAttachment`/`deserializeAttachment` on fake sockets, and records `setWebSocketAutoResponse(pair)`.

- [ ] **Step 1: Write the failing test** — accept two tagged sockets, retrieve by tag.

```ts
// tests/fake-do-state.test.ts (create)
import { describe, it, expect } from 'vitest';
import { FakeDurableObjectState } from './fake-do-state.js';

describe('FakeDurableObjectState WS hibernation modeling', () => {
  it('filters sockets by tag and round-trips attachments', () => {
    const state = new FakeDurableObjectState();
    const leader = state.makeSocket();
    const bridge = state.makeSocket();
    state.acceptWebSocket(leader, ['leader']);
    state.acceptWebSocket(bridge, ['bridge', 'conn:c1']);
    bridge.serializeAttachment({ connId: 'c1' });
    expect(state.getWebSockets('bridge')).toEqual([bridge]);
    expect(state.getTags(bridge)).toContain('conn:c1');
    expect(bridge.deserializeAttachment()).toEqual({ connId: 'c1' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cloudflare-worker && npx vitest run tests/fake-do-state.test.ts`
Expected: FAIL — no `fake-do-state.ts`.

- [ ] **Step 3: Extract + extend the fake** into `packages/cloudflare-worker/tests/fake-do-state.ts`, capturing the existing behavior from `index.test.ts` plus:

```ts
export class FakeDurableObjectState {
  private sockets = new Map<unknown, { tags: string[]; attachment: unknown }>();
  autoResponse: unknown;
  makeSocket() {
    const self = this;
    const ws = {
      send: (_: string) => {},
      close: () => {
        self.sockets.delete(ws);
      },
      serializeAttachment(v: unknown) {
        self.sockets.get(ws)!.attachment = v;
      },
      deserializeAttachment() {
        return self.sockets.get(ws)?.attachment;
      },
    };
    return ws;
  }
  acceptWebSocket(ws: unknown, tags: string[] = []) {
    this.sockets.set(ws, { tags, attachment: undefined });
  }
  getWebSockets(tag?: string) {
    const all = [...this.sockets.keys()];
    return tag ? all.filter((w) => this.sockets.get(w)!.tags.includes(tag)) : all;
  }
  getTags(ws: unknown) {
    return this.sockets.get(ws)?.tags ?? [];
  }
  setWebSocketAutoResponse(pair: unknown) {
    this.autoResponse = pair;
  }
  // ...port over storage + any other members index.test.ts relied on...
}
```

Then update `index.test.ts` to import from the shared helper (keep existing tests green).

- [ ] **Step 4: Create the bridge test harness** `packages/cloudflare-worker/tests/preview-bridge-harness.ts` with the concrete, executable helpers Tasks 5–7 rely on (no placeholders). Build on `FakeDurableObjectState` + a real `SessionTrayDurableObject` instance, following the existing `createTrayAndAttachLeader` pattern in `tests/session-tray-preview.test.ts:197`:

```ts
import { SessionTrayDurableObject } from '../src/session-tray.js';
import { FakeDurableObjectState } from './fake-do-state.js';

export interface BridgeHarness {
  do: SessionTrayDurableObject;
  state: FakeDurableObjectState;
  stub: { fetch: (req: Request) => Promise<Response> };
  leaderSent: any[]; // messages the DO sent to the leader socket (captured)
  previewToken: string; // a real minted token (bridged per opts)
  bridgeUrl: (path?: string) => string; // valid preview host for previewToken via buildPreviewUrl() (public); default path /__slicc/bridge
  mintBridgedPreview: (opts: {
    bridge: boolean;
    maxTabs?: number;
    webhookId?: string;
  }) => Promise<string>;
  openBridge: () => Promise<{ ws: any; connId: string; sent: any[]; closed: boolean }>;
  deliverLeaderMessage: (msg: any) => Promise<void>; // simulates the leader → DO control frame
  deliverBridgeMessage: (b: { ws: any }, msg: any) => Promise<void>; // bridge tab → DO frame
  closeBridge: (b: { ws: any }) => Promise<void>;
  revokePreview: (token: string) => Promise<void>; // hits the DO revoke route
}

// makeTrayWithConnectedLeader: creates the DO with a FakeDurableObjectState, attaches a leader
// socket (capturing every send into leaderSent), mints a preview per opts, and returns the harness.
export async function makeTrayWithConnectedLeader(opts: {
  bridge: boolean;
  maxTabs?: number;
  webhookId?: string;
}): Promise<BridgeHarness> {
  const state = new FakeDurableObjectState();
  const do_ = new SessionTrayDurableObject(state as any, makeFakeEnv());
  const stub = { fetch: (req: Request) => do_.fetch(req) };
  // 1. create tray + attach leader (reuse the existing create/attach requests used by session-tray-preview.test.ts)
  // 2. capture leader sends: the leader socket's `send` pushes JSON.parse(data) into leaderSent
  // 3. mint a preview: POST /internal/preview/mint with { controllerToken, workerBaseUrl, servedRoot, entryPath, allowLive: opts.bridge, bridge: opts.bridge, maxTabs: opts.maxTabs ?? 20, webhookId: opts.webhookId }
  //    (controllerToken + workerBaseUrl are REQUIRED — session-tray-preview.ts:175,312; the harness holds them from the leader-attach step)
  // Return the concrete helpers that drive do_.webSocketMessage/webSocketClose directly.
  // ...implement per the existing harness in session-tray-preview.test.ts...
}
```

Implement each helper concretely (openBridge → `stub.fetch(new Request(bridgeUrl(), { headers: { Upgrade:'websocket', origin:'https://x.sliccy.now' } }))` then read `connId` from the `welcome` frame the fake server socket received; `deliverLeaderMessage` → `await do_.webSocketMessage(leaderSocket, JSON.stringify(msg))`; `deliverBridgeMessage` → `await do_.webSocketMessage(b.ws, JSON.stringify(msg))`; `closeBridge` → `await do_.webSocketClose(b.ws)`). Build `bridgeUrl(path='/__slicc/bridge')` from the real minted token via the **public** `buildPreviewUrl(workerBase, previewToken, path)` (`preview-url.ts`) — never the private `encodeTokenForSubdomain` — so `previewTokenFromHost` resolves the host.

- [ ] **Step 5: Run tests to verify pass**

Run: `cd packages/cloudflare-worker && npx vitest run tests/fake-do-state.test.ts tests/index.test.ts`
Expected: PASS (both the new smoke test and the existing suite).

- [ ] **Step 6: Commit**

```bash
git add packages/cloudflare-worker/tests/fake-do-state.ts packages/cloudflare-worker/tests/fake-do-state.test.ts packages/cloudflare-worker/tests/preview-bridge-harness.ts packages/cloudflare-worker/tests/index.test.ts
git commit -m "test(worker): shared fake DO state + preview-bridge test harness"
```

---

## Task 5: DO `handleBridgeWebSocket` — accept, cap, reject non-bridge, welcome, notify

**Files:**

- Modify: `packages/cloudflare-worker/src/session-tray.ts` (add `BRIDGE_WS_TAG`, `handleBridgeWebSocket`, route in `fetch()` pre-`loadTray` block near the existing preview routes ~`:137`)
- Test: `packages/cloudflare-worker/tests/bridge-ws.test.ts` (create)

**Interfaces:**

- Consumes: `PreviewRecord.bridge`, `.maxTabs` (Task 3); the extended state seam (Task 1) + fake (Task 4); `sendToLeader` (existing, `:1015`).
- Produces: `handleBridgeWebSocket(previewToken, request): Promise<Response>` returning a 101 with the client socket, or 4xx (token parsed from the Host by the `fetch()` router before dispatch). Accepts the server socket with tags `[BRIDGE_WS_TAG, 'tok:'+previewToken, 'conn:'+connId]`, `serializeAttachment({connId, previewToken, origin, userAgent, connectedAt})`, sends `{t:'welcome',connId}`, and `sendToLeader({type:'bridge.connected', ...})`. `BRIDGE_WS_TAG = 'bridge'`.

- [ ] **Step 1: Write the failing test** — a bridged token accepts + notifies leader; a non-bridged token 403s; over-cap 429s.

```ts
// tests/bridge-ws.test.ts
import { describe, it, expect } from 'vitest';
import { makeTrayWithConnectedLeader } from './preview-bridge-harness.js';

const upgrade = { Upgrade: 'websocket', origin: 'https://x.sliccy.now', 'user-agent': 'UA' };

describe('handleBridgeWebSocket', () => {
  it('accepts a bridged token and notifies the leader', async () => {
    const h = await makeTrayWithConnectedLeader({ bridge: true, maxTabs: 2 });
    const res = await h.stub.fetch(new Request(h.bridgeUrl(), { headers: upgrade }));
    expect(res.status).toBe(101);
    expect(h.leaderSent.some((m) => m.type === 'bridge.connected')).toBe(true);
  });

  it('rejects a non-bridged token with 403', async () => {
    const h = await makeTrayWithConnectedLeader({ bridge: false });
    const res = await h.stub.fetch(new Request(h.bridgeUrl(), { headers: upgrade }));
    expect(res.status).toBe(403);
  });

  it('rejects over the maxTabs cap', async () => {
    const h = await makeTrayWithConnectedLeader({ bridge: true, maxTabs: 1 });
    const first = await h.stub.fetch(new Request(h.bridgeUrl(), { headers: upgrade }));
    expect(first.status).toBe(101);
    const second = await h.stub.fetch(new Request(h.bridgeUrl(), { headers: upgrade }));
    expect(second.status).toBe(429);
  });
});
```

> The preview token reaches the DO from the Host (`previewTokenFromHost`), exactly like the HTTP preview path — no `x-preview-token` header. `h.bridgeUrl()` builds a **valid** preview host from the real minted token via the public `buildPreviewUrl()` (not the private `encodeTokenForSubdomain`), so `previewTokenFromHost` accepts it (the compact UUID is 32 chars — `preview-host.ts:36`).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cloudflare-worker && npx vitest run tests/bridge-ws.test.ts`
Expected: FAIL — no `handleBridgeWebSocket`.

- [ ] **Step 3: Implement** in `session-tray.ts`:

```ts
const BRIDGE_WS_TAG = 'bridge';

private async handleBridgeWebSocket(previewToken: string, request: Request): Promise<Response> {
  const record = await this.resolvePreviewRecord(previewToken); // existing resolve helper
  if (!record || !record.bridge) {
    return jsonResponse({ error: 'Bridge not enabled', code: 'BRIDGE_DISABLED' }, 403);
  }
  const existing = (this.state.getWebSockets?.(BRIDGE_WS_TAG) ?? [])
    .filter((w) => this.state.getTags?.(w)?.includes(`tok:${previewToken}`));
  if (existing.length >= (record.maxTabs ?? 20)) {
    return jsonResponse({ error: 'Too many bridged tabs', code: 'BRIDGE_CAP' }, 429);
  }
  const { client, server } = this.webSocketPairFactory();
  const connId = crypto.randomUUID();
  this.state.acceptWebSocket!(server, [BRIDGE_WS_TAG, `tok:${previewToken}`, `conn:${connId}`]);
  const origin = request.headers.get('origin') ?? '';
  const userAgent = request.headers.get('user-agent') ?? '';
  const connectedAt = this.isoNow();
  server.serializeAttachment?.({ connId, previewToken, origin, userAgent, connectedAt });
  server.send(JSON.stringify({ t: 'welcome', connId }));
  this.sendToLeader({ type: 'bridge.connected', connId, previewToken, origin, userAgent, connectedAt });
  return websocketResponse(client);
}
```

Route it in `fetch()` beside the existing preview routes (before `loadTray()`), matching `url.pathname === '/__slicc/bridge'` with an `Upgrade: websocket` header. Add `resolvePreviewRecord` if not already a private helper (reuse the logic behind `/internal/preview/resolve`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cloudflare-worker && npx vitest run tests/bridge-ws.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cloudflare-worker/src/session-tray.ts packages/cloudflare-worker/tests/bridge-ws.test.ts packages/cloudflare-worker/tests/fake-do-state.ts
git commit -m "feat(worker): DO handleBridgeWebSocket (accept/cap/reject/welcome/notify)"
```

---

## Task 6: DO role routing + relay + auto-response + disconnect

**Files:**

- Modify: `packages/cloudflare-worker/src/session-tray.ts` (`webSocketMessage` at `:201`, `webSocketClose` at `:210`, and where the leader socket is first accepted `:566` to set the auto-response pair)
- Test: `packages/cloudflare-worker/tests/bridge-relay.test.ts` (create)

**Interfaces:**

- Consumes: `handleBridgeWebSocket` (Task 5), `sendToLeader`, the fake (Task 4).
- Produces: `webSocketMessage` branches on `getTags(ws)`: a `BRIDGE_WS_TAG` socket parses `{t:'cdp.res'|'cdp.evt'}` and calls `sendToLeader({type:'bridge.cdp.response'|'bridge.cdp.event', connId, ...})` (connId from `deserializeAttachment`); the leader socket path additionally handles `{type:'bridge.cdp.request', connId, ...}` → find bridge WS by `conn:<connId>` tag → `send({t:'cdp.req', id, method, params, sessionId})`. `webSocketClose` on a bridge socket → `sendToLeader({type:'bridge.disconnected', connId})`. Auto-response pair `('ping','pong')` set once when the DO first accepts any socket.

- [ ] **Step 1: Write the failing test** — leader `bridge.cdp.request` reaches the matching bridge socket; bridge `cdp.res` reaches the leader; close notifies disconnect.

```ts
// tests/bridge-relay.test.ts
it('relays cdp.request from leader to the right bridge socket and cdp.res back', async () => {
  const h = await makeTrayWithConnectedLeader({ bridge: true });
  const bridgeWs = await h.openBridge(); // helper: opens a bridge socket, returns the server-side fake + connId
  // leader → bridge
  await h.deliverLeaderMessage({
    type: 'bridge.cdp.request',
    connId: bridgeWs.connId,
    id: 7,
    method: 'Runtime.evaluate',
    params: { expression: '1' },
  });
  expect(bridgeWs.sent).toContainEqual(
    expect.objectContaining({ t: 'cdp.req', id: 7, method: 'Runtime.evaluate' })
  );
  // bridge → leader
  await h.deliverBridgeMessage(bridgeWs, { t: 'cdp.res', id: 7, result: { value: 1 } });
  expect(h.leaderSent).toContainEqual(
    expect.objectContaining({ type: 'bridge.cdp.response', connId: bridgeWs.connId, id: 7 })
  );
});

it('emits bridge.disconnected on bridge socket close', async () => {
  const h = await makeTrayWithConnectedLeader({ bridge: true });
  const bridgeWs = await h.openBridge();
  await h.closeBridge(bridgeWs);
  expect(h.leaderSent).toContainEqual(
    expect.objectContaining({ type: 'bridge.disconnected', connId: bridgeWs.connId })
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cloudflare-worker && npx vitest run tests/bridge-relay.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement role routing.** In `webSocketMessage(ws, message)`, before the existing leader logic:

```ts
const tags = this.state.getTags?.(ws) ?? [];
if (tags.includes(BRIDGE_WS_TAG)) {
  const { connId } = (ws.deserializeAttachment?.() ?? {}) as { connId?: string };
  const msg = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message));
  if (msg.t === 'cdp.res') {
    this.sendToLeader({
      type: 'bridge.cdp.response',
      connId: connId!,
      id: msg.id,
      result: msg.result,
      error: msg.error,
    });
  } else if (msg.t === 'cdp.evt') {
    this.sendToLeader({
      type: 'bridge.cdp.event',
      connId: connId!,
      method: msg.method,
      params: msg.params,
    });
  }
  return;
}
// ...existing leader handling continues...
```

In the leader message handler (`handleLeaderMessage`), add a `bridge.cdp.request` case:

```ts
case 'bridge.cdp.request': {
  const target = (this.state.getWebSockets?.(BRIDGE_WS_TAG) ?? [])
    .find((w) => this.state.getTags?.(w)?.includes(`conn:${msg.connId}`));
  target?.send(JSON.stringify({ t: 'cdp.req', id: msg.id, method: msg.method, params: msg.params, sessionId: msg.sessionId }));
  break;
}
```

In `webSocketClose(ws)` add, before existing leader-close handling:

```ts
const tags = this.state.getTags?.(ws) ?? [];
if (tags.includes(BRIDGE_WS_TAG)) {
  const { connId } = (ws.deserializeAttachment?.() ?? {}) as { connId?: string };
  if (connId) this.sendToLeader({ type: 'bridge.disconnected', connId });
  return;
}
```

Add a shared `ensureWebSocketAutoResponse()` and call it from **both** accept paths — the leader accept (`session-tray.ts:566`) and `handleBridgeWebSocket` (Task 5), so bridge-only trays still get the auto-response even before a leader socket exists:

```ts
private autoResponseSet = false;
private ensureWebSocketAutoResponse(): void {
  if (this.autoResponseSet) return;
  if (typeof WebSocketRequestResponsePair !== 'undefined') {
    this.state.setWebSocketAutoResponse?.(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  this.autoResponseSet = true; // the fake records the call; the guard keeps tests without the global safe
}
```

Call `this.ensureWebSocketAutoResponse()` at the top of both accept sites (and add a `this.ensureWebSocketAutoResponse()` call in Task 5's `handleBridgeWebSocket` before `acceptWebSocket`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cloudflare-worker && npx vitest run tests/bridge-relay.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cloudflare-worker/src/session-tray.ts packages/cloudflare-worker/tests/bridge-relay.test.ts
git commit -m "feat(worker): DO bridge role routing, cdp relay, disconnect, auto-response"
```

---

## Task 7: DO `/internal/preview/emit` → webhook.event; revocation closes bridge sockets

**Files:**

- Modify: `packages/cloudflare-worker/src/session-tray.ts` — `/internal/preview/emit` route in `handleInternalPreviewRoute`; **and** close bridge sockets on revoke **here in the DO** (it owns `state.getWebSockets`). `dispatchPreviewRoute` (the free helper, `session-tray-preview.ts:156`) handles the stop internally and can't touch sockets, so in `handleInternalPreviewRoute` the DO detects the stop route, `await`s `dispatchPreviewRoute`, and — **on a success response** — calls `this.closeBridgeSocketsForPreview(previewToken)` (parsing the token from the stop request) before returning the response.
- Test: `packages/cloudflare-worker/tests/bridge-emit-revoke.test.ts` (create)

**Interfaces:**

- Consumes: `PreviewRecord.webhookId`; `sendToLeader`; `getWebSockets(BRIDGE_WS_TAG)` (DO-level).
- Produces: `POST /internal/preview/emit` body `{ previewToken, body }` → looks up record → `sendToLeader({ type:'webhook.event', webhookId: record.webhookId, headers: {}, body, timestamp })` (matching `handleWebhook` `:648`). `SessionTrayDurableObject.closeBridgeSocketsForPreview(previewToken)` closes every bridge socket tagged `tok:<previewToken>`; each close fires `webSocketClose` → `bridge.disconnected` to the leader (Task 6).

- [ ] **Step 1: Write the failing test.**

```ts
it('forwards /internal/preview/emit to the leader as webhook.event', async () => {
  const h = await makeTrayWithConnectedLeader({ bridge: true, webhookId: 'wh1' });
  await h.stub.fetch(
    new Request('https://internal/internal/preview/emit', {
      method: 'POST',
      body: JSON.stringify({
        previewToken: h.previewToken,
        body: { name: 'clicked', detail: { id: 3 } },
      }),
    })
  );
  expect(h.leaderSent).toContainEqual(
    expect.objectContaining({
      type: 'webhook.event',
      webhookId: 'wh1',
      body: { name: 'clicked', detail: { id: 3 } },
    })
  );
});

it('closes bridge sockets on revoke', async () => {
  const h = await makeTrayWithConnectedLeader({ bridge: true });
  const bridgeWs = await h.openBridge();
  await h.revokePreview(h.previewToken);
  expect(bridgeWs.closed).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cloudflare-worker && npx vitest run tests/bridge-emit-revoke.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the `/internal/preview/emit` branch in `handleInternalPreviewRoute`, and add a DO method `closeBridgeSocketsForPreview`. In `handleInternalPreviewRoute`, for the stop route, **read the `previewToken` from `request.clone().json()` first** (the current stop handler consumes `request.json()` at `session-tray-preview.ts:198`, so the body must be cloned before delegating), then `await dispatchPreviewRoute(...)`, and on a **successful stop** response call `this.closeBridgeSocketsForPreview(previewToken)` — `dispatchPreviewRoute` is the free helper and can't touch sockets:

```ts
private closeBridgeSocketsForPreview(previewToken: string): void {
  for (const ws of (this.state.getWebSockets?.(BRIDGE_WS_TAG) ?? []) as TrayWebSocketLike[]) {
    if (this.state.getTags?.(ws)?.includes(`tok:${previewToken}`)) ws.close(1000, 'preview revoked');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cloudflare-worker && npx vitest run tests/bridge-emit-revoke.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cloudflare-worker/src/session-tray.ts packages/cloudflare-worker/tests/bridge-emit-revoke.test.ts
git commit -m "feat(worker): /internal/preview/emit relay + revoke closes bridge sockets"
```

---

## Task 8: Shared `/__slicc/*` route handling on preview-worker **and** hub preview path

**Files:**

- Create: `packages/cloudflare-worker/src/preview-bridge-routes.ts` — a shared helper both entry points call.
- Modify: `packages/cloudflare-worker/src/preview-worker.ts` (dedicated `*.sliccy.now/*` entry) — call the helper before token-resolve.
- Modify: `packages/cloudflare-worker/src/preview-handler.ts` (hub path, reached from `index.ts:351` `handlePreviewRequest`) — call the same helper so any preview hosts the hub serves (staging `*.sliccy.dev` / dev) get the bridge routes too (spec §5.1 parity requirement).
- Test: `packages/cloudflare-worker/tests/preview-bridge-routes.test.ts` (create)

**Interfaces:**

- Consumes: `previewTokenFromHost`, `parseCapabilityToken` (existing); the embedded bootstrap bytes from `preview-bridge-assets.ts` (Task 10); the DO stub.
- Produces: `handleBridgeRoute(request, url, env, previewToken): Promise<Response | null>` — returns a `Response` when `url.pathname` is a `/__slicc/*` bridge route, else `null` (caller falls through to today's behavior). Routes: `GET /__slicc/preview-bridge.js` → embedded IIFE bytes (`content-type: application/javascript`, immutable, same-origin); `POST /__slicc/emit` → forward to DO `/internal/preview/emit` with `{previewToken, body}`; `/__slicc/bridge` `Upgrade: websocket` → `stub.fetch(request)` (DO reads the token from the Host). There is **no** `pv-*.js` route — html2canvas is bundled into the single IIFE (spec §5.3).

- [ ] **Step 1: Write the failing test.**

```ts
import { handleBridgeRoute } from '../src/preview-bridge-routes.js';
const token = 'tray.secret';
it('serves the bootstrap JS same-origin', async () => {
  const res = await handleBridgeRoute(
    new Request('https://tok--sec.sliccy.now/__slicc/preview-bridge.js'),
    new URL('https://tok--sec.sliccy.now/__slicc/preview-bridge.js'),
    fakeEnv(),
    token
  );
  expect(res).not.toBeNull();
  expect(res!.headers.get('content-type')).toMatch(/javascript/);
  expect(await res!.text()).toContain('__slicc');
});
it('forwards /__slicc/emit POST to the DO', async () => {
  const env = fakeEnv();
  const res = await handleBridgeRoute(
    new Request('https://tok--sec.sliccy.now/__slicc/emit', {
      method: 'POST',
      body: '{"name":"x"}',
    }),
    new URL('https://tok--sec.sliccy.now/__slicc/emit'),
    env,
    token
  );
  expect(res!.status).toBeLessThan(500);
  expect(env.stubCalls.some((u) => u.includes('/internal/preview/emit'))).toBe(true);
});
it('returns null for a normal preview path', async () => {
  const res = await handleBridgeRoute(
    new Request('https://tok--sec.sliccy.now/index.html'),
    new URL('https://tok--sec.sliccy.now/index.html'),
    fakeEnv(),
    token
  );
  expect(res).toBeNull();
});
```

> `handleBridgeRoute` receives `previewToken` as a **parameter** (the caller already parsed it from the Host), so it never calls `previewTokenFromHost` — the host string in these unit tests is cosmetic and need not be a valid 32-char compact token. (Task 9's `worker.fetch` tests, which do parse the host, use `env.previewHost` from `fakeEnv`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cloudflare-worker && npx vitest run tests/preview-bridge-routes.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `handleBridgeRoute`** in `preview-bridge-routes.ts` (import the IIFE bytes from `./preview-bridge-assets.js`, Task 10; for `/__slicc/bridge` upgrades forward the original `request` to the stub — the DO reads the token from the Host). Then call it **before** token-resolve in both entry points:
  - `preview-worker.ts` `fetch`: after `parseCapabilityToken`, `const bridged = await handleBridgeRoute(request, url, env, previewToken); if (bridged) return bridged;`
  - `preview-handler.ts` `handlePreviewRequest`: the same call, before it maps the path to VFS.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cloudflare-worker && npx vitest run tests/preview-bridge-routes.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cloudflare-worker/src/preview-bridge-routes.ts packages/cloudflare-worker/src/preview-worker.ts packages/cloudflare-worker/src/preview-handler.ts packages/cloudflare-worker/tests/preview-bridge-routes.test.ts
git commit -m "feat(worker): shared /__slicc/* routes on preview-worker + hub preview path"
```

---

## Task 9: HTMLRewriter injection + CSP augmentation for bridged HTML

**Files:**

- Modify: `packages/cloudflare-worker/src/preview-bridge-routes.ts` (add the shared `injectBridge` helper)
- Modify: `packages/cloudflare-worker/src/preview-worker.ts` — wrap the `cachedPreviewFetch` response with `injectBridge` when `record.bridge` and `text/html`.
- Modify: `packages/cloudflare-worker/src/preview-handler.ts` — same wrap on the hub path (parity).
- Test: `packages/cloudflare-worker/tests/preview-inject.test.ts` (create)

**Interfaces:**

- Consumes: `record.bridge`; the resolved `previewToken`; the request scheme (`ws`/`wss`).
- Produces: a shared helper `injectBridge(response, { previewToken, host, scheme }): Response` (in `preview-bridge-routes.ts`) that uses `HTMLRewriter` to append `<script src="/__slicc/preview-bridge.js" data-slicc-token data-slicc-ws>` into `<head>` and rewrites the `content-security-policy` header to add `connect-src 'self' <scheme>://<host>` (scheme = `ws` for http hosts, `wss` for https). Applied only for `text/html` bridged responses; non-HTML / non-bridged pass through unchanged. Both entry points call it.

- [ ] **Step 1: Write the failing test.**

```ts
// fakeEnv({bridge}) returns { env, previewHost } where previewHost is a VALID host built via
// buildPreviewUrl() for a real 32-char-compact token whose DO resolve returns { bridge }.
it('injects the bootstrap script + connect-src only for bridged html', async () => {
  const { env, previewHost } = fakeEnv({ bridge: true });
  const res = await worker.fetch(new Request(`https://${previewHost}/`), env);
  const html = await res.text();
  expect(html).toContain('/__slicc/preview-bridge.js');
  expect(html).toContain('data-slicc-token="');
  expect(res.headers.get('content-security-policy')).toMatch(/connect-src 'self' wss:\/\//);
});
it('does not inject for non-bridged previews', async () => {
  const { env, previewHost } = fakeEnv({ bridge: false });
  const res = await worker.fetch(new Request(`https://${previewHost}/`), env);
  expect(await res.text()).not.toContain('/__slicc/preview-bridge.js');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cloudflare-worker && npx vitest run tests/preview-inject.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** `injectBridge` in `preview-bridge-routes.ts` using `HTMLRewriter` (`.on('head', { element(e) { e.append(scriptTag, { html: true }); } })`). Derive `ws` vs `wss` from `new URL(request.url).protocol`. Only wrap when `record.bridge && contentType.includes('text/html')`. Call it from both `preview-worker.ts` and `preview-handler.ts` where the response comes back from `cachedPreviewFetch` / the DO fetch.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cloudflare-worker && npx vitest run tests/preview-inject.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cloudflare-worker/src/preview-bridge-routes.ts packages/cloudflare-worker/src/preview-worker.ts packages/cloudflare-worker/src/preview-handler.ts packages/cloudflare-worker/tests/preview-inject.test.ts
git commit -m "feat(worker): inject bridge bootstrap + connect-src CSP for bridged html (both paths)"
```

---

## Task 10: Visitor bootstrap bundle (`preview-bridge.js`)

**Files:**

- Create: `packages/cherry/src/preview-bootstrap.ts`
- Create: `packages/cherry/scripts/build-preview-bootstrap.mjs` (esbuild → a **single classic IIFE** `dist/preview-bridge.js`, html2canvas-pro bundled in)
- Create (generated at build): `packages/cloudflare-worker/src/preview-bridge-assets.ts` (exports the bundle text as a string; generated by the build script)
- Modify: `packages/cherry/package.json` (build script)
- Test: `packages/cherry/tests/preview-bootstrap.test.ts` (create, jsdom)

**Interfaces:**

- Consumes: `createCdpHostHandler` from `@ai-ecoverse/cherry` (`src/cdp-host-handlers.ts`), `document`, `window`.
- Produces: a single classic IIFE (no code-splitting, no `type="module"`) that reads `data-slicc-token`/`data-slicc-ws` from its own `<script>`, opens the WS, on `{t:'cdp.req'}` runs the handler and replies `{t:'cdp.res'}`, exposes `window.slicc.emit(name, detail)` → `navigator.sendBeacon('/__slicc/emit', JSON.stringify({name, detail}))` and `window.slicc.on(name, cb)` → `addEventListener`, and sends `ping` on an interval. `html2canvas-pro` is bundled inline so `Page.captureScreenshot` works without a separate chunk.

- [ ] **Step 1: Write the failing test** (jsdom) — a fake WS drives a `cdp.req` and asserts a `cdp.res`; `slicc.emit` calls `sendBeacon`.

```ts
// packages/cherry/tests/preview-bootstrap.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createPreviewBridge } from '../src/preview-bootstrap.js';

describe('preview bootstrap', () => {
  it('answers Runtime.evaluate cdp.req with a cdp.res', async () => {
    const sent: any[] = [];
    const fakeWs = {
      send: (s: string) => sent.push(JSON.parse(s)),
      addEventListener: () => {},
      close: () => {},
    };
    const bridge = createPreviewBridge({
      ws: fakeWs as any,
      capabilities: { navigate: true, screenshot: 'none', openUrl: true },
    });
    await bridge.handleFrame({
      t: 'cdp.req',
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression: '1+1' },
    });
    expect(sent).toContainEqual(expect.objectContaining({ t: 'cdp.res', id: 1 }));
  });

  it('slicc.emit beacons to /__slicc/emit', () => {
    const beacon = vi.fn();
    (navigator as any).sendBeacon = beacon;
    const bridge = createPreviewBridge({
      ws: { send: () => {}, addEventListener: () => {}, close: () => {} } as any,
    });
    bridge.installWindowApi();
    (window as any).slicc.emit('clicked', { id: 3 });
    expect(beacon).toHaveBeenCalledWith('/__slicc/emit', expect.stringContaining('clicked'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cherry && npx vitest run tests/preview-bootstrap.test.ts`
Expected: FAIL — no `preview-bootstrap.ts`.

- [ ] **Step 3: Implement** `createPreviewBridge` in `packages/cherry/src/preview-bootstrap.ts` (unit-testable factory, plus a bottom-of-file IIFE that reads the script tag + opens the real WS and calls it). Reuse `createCdpHostHandler` for `cdp.req`. Its screenshot branch's `await import('html2canvas-pro')` gets **bundled inline** by esbuild (no dynamic chunk), so it resolves synchronously from the same IIFE.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cherry && npx vitest run tests/preview-bootstrap.test.ts`
Expected: PASS

- [ ] **Step 5: Wire the build** — `build-preview-bootstrap.mjs` runs esbuild with `{ bundle: true, format: 'iife', splitting: false, platform: 'browser' }` on `preview-bootstrap.ts` → a single `dist/preview-bridge.js` (html2canvas-pro included), then writes `packages/cloudflare-worker/src/preview-bridge-assets.ts` exporting the file contents as a `export const PREVIEW_BRIDGE_JS = \`…\``. Add it to the `@ai-ecoverse/cherry`build script and the root build chain (so`preview-bridge-assets.ts` exists before the worker typechecks/builds).

Run: `npm run build -w @ai-ecoverse/cherry`
Expected: `dist/preview-bridge.js` exists (single file); `preview-bridge-assets.ts` regenerated.

- [ ] **Step 6: Commit**

```bash
git add packages/cherry/src/preview-bootstrap.ts packages/cherry/scripts/build-preview-bootstrap.mjs packages/cherry/package.json packages/cherry/tests/preview-bootstrap.test.ts packages/cloudflare-worker/src/preview-bridge-assets.ts
git commit -m "feat(cherry): preview-bridge bootstrap bundle + worker asset embed"
```

---

## Task 11: Extract `SyntheticCdpTransport` base from `CherryHostTransport`

**Files:**

- Create: `packages/webapp/src/cdp/synthetic-cdp-transport.ts`
- Modify: `packages/webapp/src/cdp/cherry-host-transport.ts` (extend the base)
- Test: `packages/webapp/tests/cdp/synthetic-cdp-transport.test.ts` (create); existing cherry-host-transport tests must stay green.

**Interfaces:**

- Produces: `abstract class SyntheticCdpTransport implements CDPTransport` constructed with `{ targetUrl: string; targetOrigin: string; title: string; ids?: { target; session; frame; loader } }` (the synthetic `Target.getTargets`/`getFrameTree` use `targetUrl`/`targetOrigin`/`title` from these opts — **not** `location.href`, since a preview transport runs in the _leader_ page, not the target page). It synthesizes the session lifecycle (`Target.getTargets`/`attachToTarget`/`detach`/`close`, `Page`/`Runtime`/`DOM.enable`, `Page.getFrameTree`, `Runtime.createIsolatedWorld`, and `Page.frameNavigated`+`Page.loadEventFired` after a `Page.navigate`), delegating non-synthetic methods to `protected abstract forward(method, params, sessionId, timeout?): Promise<Record<string,unknown>>` — **timeout is threaded through** (`CDPTransport.send` passes it, `transport.ts:21`). Synthetic ids default to `cherry-*` unless overridden; preview uses `preview-*`.

- [ ] **Step 1: Write the failing test** — a trivial subclass with a stub `forward` returns synthesized lifecycle results (using the injected metadata) and forwards `Runtime.evaluate`.

```ts
it('synthesizes lifecycle from injected metadata and forwards real methods', async () => {
  const forwarded: any[] = [];
  class T extends SyntheticCdpTransport {
    protected async forward(m: string, p?: any) {
      forwarded.push([m, p]);
      return { ok: true };
    }
  }
  const t = new T({
    targetUrl: 'https://x.sliccy.now/',
    targetOrigin: 'https://x.sliccy.now',
    title: 'Preview',
  });
  await t.connect();
  const targets = await t.send('Target.getTargets');
  expect((targets.targetInfos as any[])[0].url).toBe('https://x.sliccy.now/');
  await t.send('Runtime.evaluate', { expression: '1' });
  expect(forwarded).toContainEqual(['Runtime.evaluate', { expression: '1' }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/webapp && npx vitest run tests/cdp/synthetic-cdp-transport.test.ts`
Expected: FAIL.

- [ ] **Step 3: Extract** the synthetic-lifecycle logic from `cherry-host-transport.ts` (`handleSynthetic` `:300` + `synthesizeNavigationLifecycle` `:334`) into the base, parameterizing the synthetic ids + target metadata. Make `CherryHostTransport extends SyntheticCdpTransport`, calling `super({ targetUrl: typeof location !== 'undefined' ? location.href : 'about:blank', targetOrigin: opts.targetOrigin, title: 'Cherry Host Page', ids: { target:'cherry-target', session:'cherry-session', frame:'cherry-frame', loader:'cherry-loader' } })` — read the **constructor parameter** `opts` (NOT `this.opts`; `this` is unavailable before `super()`, and `this.opts` is only assigned after construction today at `cherry-host-transport.ts:86`), and **keep the existing `typeof location !== 'undefined'` guard** (`cherry-host-transport.ts:312`) so the Node-based Vitest suite (`cherry-host-transport.test.ts:8`) still constructs it. This preserves today's behavior (cherry runs _in_ the target page, so `location.href` is correct). Implement `forward()` as the postMessage `cdp.request` path (threading `timeout`). Keep its public surface unchanged.

- [ ] **Step 4: Run tests to verify pass** (new + existing cherry transport suite)

Run: `cd packages/webapp && npx vitest run tests/cdp/synthetic-cdp-transport.test.ts tests/cdp/cherry-host-transport.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/cdp/synthetic-cdp-transport.ts packages/webapp/src/cdp/cherry-host-transport.ts packages/webapp/tests/cdp/synthetic-cdp-transport.test.ts
git commit -m "refactor(webapp): extract SyntheticCdpTransport base from CherryHostTransport"
```

---

## Task 12: `PreviewBridgeCdpTransport` (WS backhaul, keyed by connId)

**Files:**

- Create: `packages/webapp/src/cdp/preview-bridge-cdp-transport.ts`
- Test: `packages/webapp/tests/cdp/preview-bridge-cdp-transport.test.ts` (create)

**Interfaces:**

- Consumes: `SyntheticCdpTransport` (Task 11).
- Produces: `class PreviewBridgeCdpTransport extends SyntheticCdpTransport` constructed with `{ connId: string; targetUrl: string; targetOrigin: string; title: string; send: (msg: LeaderToWorkerControlMessage)=>void }` (target metadata forwarded to `super(...)`, `ids` = `preview-*`). `forward(method, params, sessionId, timeout?)` posts `{type:'bridge.cdp.request', connId, id, method, params, sessionId}` via `send` and resolves on `deliverResponse(id, payload)` — with a **timeout** that rejects and evicts the pending entry (default from `PANEL_RPC`/CDP norms; mirror `CherryHostTransport`'s reject-on-timeout at `cherry-host-transport.ts:178`). `deliverResponse(id: number, payload: { result?: Record<string,unknown>; error?: {code:number;message:string} })` and `deliverEvent(method, params)` emits a CDP event. The owner (Task 13) calls them when `bridge.cdp.response`/`bridge.cdp.event` arrive.

- [ ] **Step 1: Write the failing test** — a `send` capture + `deliverResponse` resolves; a never-answered call rejects on timeout.

```ts
const opts = {
  connId: 'c1',
  targetUrl: 'https://x.sliccy.now/',
  targetOrigin: 'https://x.sliccy.now',
  title: 'Preview',
};
it('forwards over the WS backhaul and resolves on deliverResponse', async () => {
  const sent: any[] = [];
  const t = new PreviewBridgeCdpTransport({ ...opts, send: (m) => sent.push(m) });
  await t.connect();
  const p = t.send('Runtime.evaluate', { expression: '1' });
  const req = sent.find((m) => m.type === 'bridge.cdp.request');
  expect(req).toMatchObject({ connId: 'c1', method: 'Runtime.evaluate' });
  t.deliverResponse(req.id, { result: { value: 1 } });
  expect(await p).toEqual({ value: 1 }); // send() resolves the UNWRAPPED CDP result (like CherryHostTransport)
});
it('rejects a pending call on timeout', async () => {
  const t = new PreviewBridgeCdpTransport({ ...opts, send: () => {} });
  await t.connect();
  await expect(t.send('Runtime.evaluate', { expression: '1' }, undefined, 10)).rejects.toThrow(
    /timeout/i
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/webapp && npx vitest run tests/cdp/preview-bridge-cdp-transport.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the class with an incrementing `id`, a `Map<number, {resolve,reject,timer}>` of pending calls (each with a `setTimeout` reject that deletes the entry). `deliverResponse(id, payload)` clears the timer and **resolves with the unwrapped `payload.result ?? {}`** (matching `CherryHostTransport`'s `env.result` unwrap at `cherry-host-transport.ts:414`, which `BrowserAPI.evaluate` at `browser-api.ts:662` depends on) or rejects with `payload.error`. `deliverEvent(method, params)` → `this.emit(method, params)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/webapp && npx vitest run tests/cdp/preview-bridge-cdp-transport.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/cdp/preview-bridge-cdp-transport.ts packages/webapp/tests/cdp/preview-bridge-cdp-transport.test.ts
git commit -m "feat(webapp): PreviewBridgeCdpTransport over the controller-WS backhaul"
```

---

## Task 13: Leader control dispatch + bridge-conn registry (`page-leader-tray.ts` + `tray-leader-sync.ts`)

**Files:**

- Modify: `packages/webapp/src/ui/page-leader-tray.ts` — `onControlMessage` (`:234`, add `bridge.*` cases) **and** `buildSyncManager()` (`:160`, pass the new `sendControl` closure).
- Modify: `packages/webapp/src/scoops/tray-leader-sync.ts` — add `sendControl` to `LeaderSyncManagerOptions` (`:40`); track conns; own the per-conn transports; send `bridge.cdp.request` via that closure.
- Test: `packages/webapp/tests/scoops/bridge-leader-sync.test.ts` (create)

**Interfaces:**

- Consumes: `PreviewBridgeCdpTransport` (Task 12); the `bridge.*` control messages (Task 2); `LeaderTrayManager.sendControlMessage` (`tray-leader.ts:477`).
- Produces: `LeaderSyncManagerOptions` gains `sendControl(msg: LeaderToWorkerControlMessage): void` (wired by `buildSyncManager` to `leaderTray.sendControlMessage`). `LeaderSyncManager` gains `registerMintedPreview(previewToken, { url, title, quiet })` + `dropMintedPreview(previewToken)` (Task 17 calls them), a mint map `Map<previewToken, { url, title, quiet }>` (**no** `webhookId` here — the webhook lives worker-side, §Task 17), `onBridgeConnected/Disconnected/CdpResponse/CdpEvent(msg)`, a bridge-conn `Map<connId, { previewToken, origin, userAgent, connectedAt, url, title, quiet, transport }>` (`userAgent`/`connectedAt` carried from `bridge.connected`; `url`/`title`/**`quiet`** **snapshotted from the mint map at connect** — falling back to `origin` / `'Preview'` / `false` — so the **disconnect** lick still honors `quiet` after the mint entry is dropped on stop), and `getBridgeTransport(connId)`. On connect the transport is built with the resolved metadata. `page-leader-tray.ts` `onControlMessage` routes `bridge.*` to these.

- [ ] **Step 1: Write the failing test.**

```ts
it('tracks a bridge conn and routes cdp.response to its transport', () => {
  const sent: any[] = [];
  const mgr = new LeaderSyncManager({
    sendControl: (m) => sent.push(m) /* ...other deps stubbed... */,
  });
  mgr.onBridgeConnected({
    type: 'bridge.connected',
    connId: 'c1',
    previewToken: 't.s',
    origin: 'https://x',
    userAgent: 'UA',
    connectedAt: 'now',
  });
  const t = mgr.getBridgeTransport('c1')!;
  const p = t.send('Runtime.evaluate', { expression: '1' });
  expect(sent).toContainEqual(
    expect.objectContaining({ type: 'bridge.cdp.request', connId: 'c1' })
  );
  const id = sent.find((m) => m.type === 'bridge.cdp.request').id;
  mgr.onBridgeCdpResponse({ type: 'bridge.cdp.response', connId: 'c1', id, result: { value: 1 } });
  return expect(p).resolves.toEqual({ value: 1 }); // unwrapped result
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/webapp && npx vitest run tests/scoops/bridge-leader-sync.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the mint map + registry + handlers in `tray-leader-sync.ts`. On `onBridgeConnected`, resolve `{ url, title }` from the mint map (fallback `url = origin`, `title = 'Preview'`) and build `new PreviewBridgeCdpTransport({ connId, targetUrl: url, targetOrigin: origin, title, send: (m) => this.sendControl(m) })`; `onBridgeCdpResponse` → `transport.deliverResponse(msg.id, { result: msg.result, error: msg.error })`; `onBridgeCdpEvent` → `transport.deliverEvent(msg.method, msg.params)`; disconnect drops the entry + disposes the transport. Wire `page-leader-tray.ts` `onControlMessage` `bridge.*` cases to call them.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/webapp && npx vitest run tests/scoops/bridge-leader-sync.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/scoops/tray-leader-sync.ts packages/webapp/src/ui/page-leader-tray.ts packages/webapp/tests/scoops/bridge-leader-sync.test.ts
git commit -m "feat(webapp): leader bridge-conn registry + control dispatch"
```

---

## Task 14: Target surfacing + teleport exclusion

**Files:**

- Modify: `packages/webapp/src/scoops/tray-leader-sync.ts` (`getConnectedEntries` `:917`; `selectTeleportPool` / `canRuntimeServeTeleport` `:151`/`:1026`)
- Modify: `packages/webapp/src/shell/supplemental-commands/playwright/teleport.ts` (`armTeleportWatcher` `:249` — the single choke point that `handlers/teleport.ts`, `handlers/navigation.ts:63`, and `handlers/tabs.ts:63` all call)
- Test: extend `packages/webapp/tests/scoops/bridge-leader-sync.test.ts`; add `packages/webapp/tests/shell/teleport-preview-guard.test.ts`

**Interfaces:**

- Consumes: the bridge-conn registry (Task 13).
- Produces: bridge conns surface as targets `{ targetId:'preview:<token>:<connId>', kind:'preview', url:<registry url>, title:<registry title> }` in the list returned by the public `getTargets()` (`:913`) — add them in its internal `getConnectedEntries` helper (`:917`); `selectTeleportPool` excludes `kind:'preview'`; `armTeleportWatcher` rejects fail-closed when its `teleport-runtime` argument is the `'preview'` runtime (or resolves to a `kind:'preview'` target) — covering all three call sites at once.

- [ ] **Step 1: Write the failing tests** — a connected bridge conn appears in the target list with `kind:'preview'`; arming teleport against the `preview` runtime throws.

```ts
it('surfaces bridge conns as preview targets', () => {
  const mgr = buildLeaderSyncWithConn('c1', 't.s'); // reuse the Task 13 setup helper
  const targets = mgr.getTargets(); // public accessor (tray-leader-sync.ts:913); getConnectedEntries is private
  expect(targets).toContainEqual(
    expect.objectContaining({ targetId: expect.stringMatching(/^preview:/), kind: 'preview' })
  );
});
```

```ts
// teleport-preview-guard.test.ts — the explicit runtime is a runtime id (not a target id)
it('refuses to arm teleport against the preview runtime', () => {
  expect(() =>
    armTeleportWatcher(stubBrowser(), /*start*/ /a/, /*return*/ /b/, /*teleportRuntime*/ 'preview')
  ).toThrow(/cannot teleport/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/webapp && npx vitest run tests/scoops/bridge-leader-sync.test.ts tests/shell/teleport-preview-guard.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** by emitting the registry conns (with stored url/title) into `getConnectedEntries` so the public `getTargets()` lists them; add `kind:'preview'` exclusion in `selectTeleportPool`; and add a fail-closed guard at the top of `armTeleportWatcher` (`if (teleportRuntime === 'preview') throw new Error('cannot teleport to a preview target (no Network.*)')`) so navigation/tabs/teleport handlers are all covered.

- [ ] **Step 4: Run tests to verify pass**

Run: `cd packages/webapp && npx vitest run tests/scoops/bridge-leader-sync.test.ts tests/shell/teleport-preview-guard.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/scoops/tray-leader-sync.ts packages/webapp/src/shell/supplemental-commands/playwright/teleport.ts packages/webapp/tests/scoops/bridge-leader-sync.test.ts packages/webapp/tests/shell/teleport-preview-guard.test.ts
git commit -m "feat(webapp): surface preview targets + exclude them from teleport (all arm sites)"
```

---

## Task 15: `preview:` scheme routing (page-side `LeaderSyncManager.createRemoteTransport`)

**Files:**

- Modify: `packages/webapp/src/scoops/tray-leader-sync.ts` (`createRemoteTransport` `:929`)
- Test: `packages/webapp/tests/scoops/preview-scheme-routing.test.ts` (create)

**Interfaces:**

- Consumes: `BrowserAPI.attachToPage` splits on the **first** `:` (`browser-api.ts:402`) → `runtimeId='preview'`, `localTargetId='<token>:<connId>'`. The worker-side `panel-rpc-tray-provider` (`:30`) transparently tunnels to the page via `PanelRpcCdpTransport`, and `remote-cdp-page-bridge.ts:79` calls `sync.createRemoteTransport(runtimeId, localTargetId)` — so **the only change needed is page-side**, in `LeaderSyncManager.createRemoteTransport`. No worker-side change (`panel-rpc-tray-provider` is untouched).
- Produces: `createRemoteTransport` special-cases `targetRuntimeId === 'preview'` → returns `getBridgeTransport(connId)` where `connId` is the substring **after the first `:`** of `localTargetId` (`'<token>:<connId>'`). Its declared return type widens from `RemoteCDPTransport` to `CDPTransport` (the `TrayTargetProvider` interface at `remote-cdp-page-bridge.ts:26` already types it as `CDPTransport`). Never `split(':', 2)`.

- [ ] **Step 1: Write the failing test** — `createRemoteTransport('preview', 't.s:c1')` returns the registered bridge transport, not a follower lookup.

```ts
it('routes runtimeId=preview to the bridge transport', () => {
  const mgr = buildLeaderSyncWithConn('c1', 't.s'); // Task 13 helper; connId 'c1'
  const t = mgr.createRemoteTransport('preview', 't.s:c1');
  expect(t).toBe(mgr.getBridgeTransport('c1'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/webapp && npx vitest run tests/scoops/preview-scheme-routing.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the `targetRuntimeId === 'preview'` branch in `createRemoteTransport` (`const connId = localTargetId.slice(localTargetId.indexOf(':') + 1); return this.getBridgeTransport(connId);`), widening the return type to `CDPTransport`. Leave the follower `runtimeToBootstrap` path unchanged for non-preview runtimes.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/webapp && npx vitest run tests/scoops/preview-scheme-routing.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/scoops/tray-leader-sync.ts packages/webapp/tests/scoops/preview-scheme-routing.test.ts
git commit -m "feat(webapp): route preview: scheme to the bridge transport (page-side)"
```

---

## Task 16: `'preview'` lifecycle lick + render plumbing

**Files:**

- Modify: `packages/webapp/src/scoops/lick-manager.ts` (`LickEvent['type']` `:37`; fields `previewConnId`, `previewOrigin`, `previewToken`, `previewUserAgent`, `previewConnectedAt`, `previewLifecycle: 'connected'|'disconnected'` — `userAgent`/`connectedAt` per spec §5.2 lick fields)
- Modify: `packages/webapp/src/scoops/lick-formatting.ts` (`EXTERNAL_LICK_CHANNELS` `:29` + channel label + formatter branch)
- Modify: `packages/webapp/src/kernel/host.ts` (`resolveLickEventName`/`resolveLickEventId` fallbacks `:194`)
- Modify: `packages/webapp/src/scoops/tray-leader-sync.ts` (emit the lick on connect/disconnect; rate-limit; `quiet`)
- Test: `packages/webapp/tests/scoops/preview-lick.test.ts` (create)

**Interfaces:**

- Consumes: the bridge-conn handlers (Task 13). `quiet`/`userAgent`/`connectedAt` are read from the **per-conn registry entry** (snapshotted at connect), NOT the mint map — so a `quiet` disconnect lick stays suppressed even after the mint entry is dropped on stop.
- Produces: on `bridge.connected`/`bridge.disconnected` (unless `quiet`), a `LickEvent` `{ type:'preview', previewLifecycle, previewConnId, previewOrigin, previewToken, previewUserAgent, previewConnectedAt, timestamp, body:{} }` routed to the cone; rendered with channel label "Preview".

- [ ] **Step 1: Write the failing test** — a connect emits a formatted `'preview'` lick; `quiet` suppresses it.

```ts
it('emits a preview lifecycle lick on connect', () => {
  const licks: any[] = [];
  const mgr = buildLeaderSync({ emitLick: (e) => licks.push(e), quietFor: () => false });
  mgr.onBridgeConnected({
    type: 'bridge.connected',
    connId: 'c1',
    previewToken: 't.s',
    origin: 'https://x',
    userAgent: 'UA',
    connectedAt: 'now',
  });
  expect(licks).toContainEqual(
    expect.objectContaining({ type: 'preview', previewLifecycle: 'connected', previewConnId: 'c1' })
  );
});
it('formats a preview lick to non-null content', () => {
  expect(
    formatLickEventForCone({
      type: 'preview',
      previewLifecycle: 'connected',
      previewOrigin: 'https://x',
      timestamp: 'now',
      body: {},
    } as any)
  ).not.toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/webapp && npx vitest run tests/scoops/preview-lick.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the type + fields, add `'preview'` to `EXTERNAL_LICK_CHANNELS` + a label + a `formatLickEventForCone` branch ("Preview tab connected from <origin>" / "disconnected"), add `resolveLickEventName`/`resolveLickEventId` fallbacks, and emit from the bridge handlers with a simple per-token rate-limiter (e.g., collapse bursts within N ms).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/webapp && npx vitest run tests/scoops/preview-lick.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/scoops/lick-manager.ts packages/webapp/src/scoops/lick-formatting.ts packages/webapp/src/kernel/host.ts packages/webapp/src/scoops/tray-leader-sync.ts packages/webapp/tests/scoops/preview-lick.test.ts
git commit -m "feat(webapp): 'preview' lifecycle lick + render plumbing"
```

---

## Task 17: `serve --bridge` flags + webhook auto-provision + `serve --stop` + registry

**Files:**

- Modify: `packages/webapp/src/scoops/preview-minter.ts` — `MintPreviewOpts` (`:16`) gains `maxTabs?`, `quiet?`, `webhookId?` (bridge already there); `MintPreviewResult` (`:30`) gains `previewToken` (currently `{url,pushed}`).
- Modify: `packages/cloudflare-worker/src/preview-routes.ts` — the **public** `/api/tray/:trayId/preview` mint wrapper (`handlePreviewMint`, `:31`, used by `mintPreviewViaWorker`) currently forwards only `servedRoot`/`entryPath`/`allowLive` to `/internal/preview/mint`, so it would **strip** `bridge`/`maxTabs`/`webhookId` — forward those too and return `previewToken`; the public stop wrapper (`handlePreviewStop`) must return the `webhookId` from the DO stop response. **This is the load-bearing hop** — without it `serve --bridge` mints a non-bridged record.
- Modify: `packages/cloudflare-worker/src/session-tray-preview.ts` (DO-internal mint/stop, complements Task 3) — the mint response includes `previewToken`; the stop/revoke response includes the record's `webhookId` (e.g. `{ revoked: true, webhookId }`).
- Modify: `packages/cloudflare-worker/tests/index.test.ts` — the existing stop-route assertions that expect exactly `{ revoked: true }` / `{ revoked: false }` (`:1668`, `:1683`) must be updated to allow the new `webhookId` field (use `toMatchObject`/`objectContaining`), and add an assertion that stop returns the record's `webhookId`. Add a **public-API mint test** asserting `POST /api/tray/:trayId/preview` forwards `bridge`/`maxTabs`/`webhookId` to `/internal/preview/mint` and returns `previewToken` (the `preview-routes.ts` regression). Add a `revokePreviewViaWorker` client test (webapp) asserting it parses `webhookId` from the stop response.
- Modify: `packages/webapp/src/shell/supplemental-commands/preview-mint-client.ts` — `mintPreviewViaWorker` args (`:12`) + body (`:41`) carry `bridge`/`maxTabs`/`webhookId` and parse `previewToken` from the response; `revokePreviewViaWorker` (`:51`) parses `webhookId` from the stop response.
- Modify: `packages/webapp/src/kernel/panel-rpc.ts` (`:204`) + `packages/webapp/src/ui/panel-rpc-handlers.ts` (`:61`) — extend the `tray-open-preview` payload with `bridge`/`maxTabs`/`quiet`/`webhookId` and its result with `previewToken`; **add a new `tray-stop-preview` op** payload `{ previewToken }` → result `{ revoked, webhookId }` (page-side, has the controllerToken). `quiet` rides to the page handler (consumed by `registerMintedPreview`), not the DO record.
- Modify: `packages/webapp/src/shell/supplemental-commands/serve-command.ts` — flag parsing (`:56-105`, add `--max-tabs`, `--quiet`); **provision the webhook here (worker realm)** via the same `getLickManagerSurface()` accessor `webhook-command.ts:123` uses (works in-worker AND thin-extension), named `preview-bridge` (the token isn't known until mint), **before** the mint, and pass its `webhookId` into the mint opts; **implement `serve --stop <token>`** (deferred today, `:191`) → invoke the `tray-stop-preview` panel-RPC, which returns the record's `webhookId` from the worker stop route, then `deleteWebhook(webhookId)` (do NOT find-by-name).
- Modify: `packages/webapp/src/ui/boot/setup-standalone-panel-rpc.ts` — `mintPreview` (`:77-101`): compute the **explicit** `bridge`, forward `maxTabs`/`webhookId` to `mintPreviewViaWorker`, and call `sync.registerMintedPreview(previewToken, { url, title, quiet })` (Task 13; **no** webhook work here — that's worker-realm). Add a `tray-stop-preview` handler → `revokePreviewViaWorker(...)` + `sync.dropMintedPreview(token)`.
- Modify: `packages/webapp/src/ui/page-leader-tray.ts` (`preview.revoked` handler `:267`) — drop the page mint-registry entry (`sync.dropMintedPreview`). No webhook work here: the only worker-initiated revoke is tray expiry, at which point the leader + its `LickManager`/webhooks are already gone (spec §7), so there is no live webhook to delete; explicit `serve --stop` handles the live-leader case in the worker realm.
- Test: `packages/webapp/tests/shell/serve-bridge.test.ts` (create)

**Interfaces:**

- Consumes: `getLickManagerSurface()` — **export it** from `webhook-command.ts:123` (module-private today) or extract to a shared `lick-surface.ts` so `serve-command.ts` can import it — → `createWebhook(name, scoop?)` / `deleteWebhook(id)` (both already on the surface + `LickManager` at `:259`); `mintPreviewViaWorker` / `revokePreviewViaWorker` (`preview-mint-client.ts`); `LeaderSyncManager.registerMintedPreview` / `dropMintedPreview` (Task 13).
- Produces: `serve --bridge` → `bridge = !noBridge && bridgeFlag` (explicit only — NOT `hasCherryFollower`). **Ordering (resolves the token↔webhook chicken-and-egg, since the worker mints the token):** (1) `createWebhook('preview-bridge')` → `webhookId`; (2) mint with `{ bridge, maxTabs (default 20), webhookId }` — the worker stores `webhookId` on the record and **returns `previewToken`** (new field on `MintPreviewResult` + the worker mint response + the `tray-open-preview` result); (3) page-side `registerMintedPreview(previewToken, { url, title, quiet })`; on mint failure, `deleteWebhook(webhookId)` to avoid an orphan. `--no-bridge` forces `bridge=false`. `serve --stop <token>` → `tray-stop-preview` (page realm) → `revokePreviewViaWorker(token)`, whose worker stop route **returns the record's `webhookId`**; serve then `deleteWebhook(webhookId)` (worker realm). The DO closes bridge sockets on the stop (Task 7).

- [ ] **Step 1: Write the failing test** — `serve --bridge dir` marks the record bridge + provisions a webhook; plain `serve` does neither; `--no-bridge` with a cherry follower stays non-bridge.

```ts
it('serve --bridge provisions a webhook and marks the mint bridged', async () => {
  const { mintArgs, createdWebhooks } = await runServe(['--bridge', '/workspace/dist']);
  expect(mintArgs.bridge).toBe(true);
  expect(mintArgs.webhookId).toBeTruthy();
  expect(createdWebhooks.length).toBe(1);
});
it('plain serve is not bridged and creates no webhook', async () => {
  const { mintArgs, createdWebhooks } = await runServe(['/workspace/dist']);
  expect(mintArgs.bridge).toBe(false);
  expect(createdWebhooks.length).toBe(0);
});
it('--no-bridge beats a connected cherry follower', async () => {
  const { mintArgs } = await runServe(['--no-bridge', '/workspace/dist'], { cherryFollower: true });
  expect(mintArgs.bridge).toBe(false);
});
it('serve --stop deletes the auto-provisioned webhook', async () => {
  const { deletedWebhooks } = await runServe(['--stop', 'tray.secret'], {
    minted: { token: 'tray.secret', webhookId: 'wh1' },
  });
  expect(deletedWebhooks).toContain('wh1');
});
```

> Define `runServe(argv, opts?)` at the top of the test file: it wires the serve command's `ctx` with a stubbed `getLickManagerSurface()` (recording `createWebhook`/`deleteWebhook` into `createdWebhooks`/`deletedWebhooks`), a stubbed minter capturing `mintArgs` and returning a `previewToken`, a stubbed `tray-stop-preview`/`revokePreviewViaWorker` returning `{ revoked: true, webhookId: opts.minted?.webhookId }`, and an optional `cherryFollower` flag on the connected-followers stub. Returns `{ mintArgs, createdWebhooks, deletedWebhooks }`. The `--stop` test asserts `deletedWebhooks` contains the `webhookId` the stubbed stop response returned (not a name lookup).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/webapp && npx vitest run tests/shell/serve-bridge.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** across the contract chain, respecting the realm split:
  - `serve-command.ts` (**worker realm** — same as `webhook-command.ts`): parse `--max-tabs`/`--quiet`; compute the explicit `bridge = !noBridge && bridgeFlag` (do NOT fold in `hasCherryFollower` for `bridge`; that stays only for `allowLive`); on `--bridge`, `getLickManagerSurface().createWebhook('preview-bridge')` → `webhookId` **before** mint; pass `bridge`/`maxTabs`/`quiet`/`webhookId` into the mint opts (the mint returns `previewToken`); on mint failure `deleteWebhook(webhookId)`. For `serve --stop <token>`: invoke the `tray-stop-preview` panel-RPC → it returns `{ revoked, webhookId }` from the worker stop route → `deleteWebhook(webhookId)` (do NOT find-by-name).
  - `preview-minter.ts` / `preview-mint-client.ts` / `panel-rpc.ts` / `panel-rpc-handlers.ts`: extend the mint contract with the new fields; add the `tray-stop-preview` op.
  - `setup-standalone-panel-rpc.ts` (**page realm**): forward the fields to `mintPreviewViaWorker`; `sync.registerMintedPreview(token, { url, title, quiet })`; add the `tray-stop-preview` handler → `revokePreviewViaWorker` + `sync.dropMintedPreview(token)`.
  - `page-leader-tray.ts`: `preview.revoked` → `sync.dropMintedPreview(token)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/webapp && npx vitest run tests/shell/serve-bridge.test.ts`
Expected: PASS

- [ ] **Step 5: Full gate + commit**

Run: `npm run typecheck && npm run test`
Expected: PASS

```bash
git add packages/webapp/src/scoops/preview-minter.ts packages/cloudflare-worker/src/preview-routes.ts packages/cloudflare-worker/src/session-tray-preview.ts packages/cloudflare-worker/tests/index.test.ts packages/webapp/src/shell/supplemental-commands/preview-mint-client.ts packages/webapp/src/shell/supplemental-commands/webhook-command.ts packages/webapp/src/kernel/panel-rpc.ts packages/webapp/src/ui/panel-rpc-handlers.ts packages/webapp/src/shell/supplemental-commands/serve-command.ts packages/webapp/src/ui/boot/setup-standalone-panel-rpc.ts packages/webapp/src/ui/page-leader-tray.ts packages/webapp/tests/shell/serve-bridge.test.ts
git commit -m "feat(webapp,worker): serve --bridge/--stop flags + webhook provision/delete + full mint contract"
```

---

## Task 18: Documentation + agent skill

**Files:**

- Modify: `CLAUDE.md` (preview section), `packages/webapp/CLAUDE.md`, `packages/cloudflare-worker/CLAUDE.md`, `packages/cherry/CLAUDE.md`
- Modify: `docs/architecture.md` (synthetic-CDP matrix + tray/sync matrix rows for `preview:` + `bridge.*`; note `SyntheticCdpTransport`)
- Modify: `docs/shell-reference.md` (`serve --bridge/--no-bridge/--max-tabs/--quiet` + `window.slicc` API + security warning)
- Modify: `README.md` (driveable-preview note with the security warning in **bold**)
- Modify: `packages/vfs-root/workspace/skills/playwright-cli/SKILL.md` — `serve` is documented here (`:165`); there is **no** `serve` skill directory. Add the `--bridge`/`--no-bridge`/`--max-tabs`/`--quiet`/`--stop` flags, the `window.slicc` page API, and the security posture. (Grep for other skill files mentioning `serve` and update any hits.)

- [ ] **Step 1: Update the docs** listed above. Copy the security posture verbatim from spec §7 (accepted cross-subdomain cookie risk; opt-in; honest capability). Add the `bridge.*` rows to the tray/sync matrix and a `preview:` row to the synthetic-CDP matrix.

- [ ] **Step 2: Verify no stale references** — grep the skills tree + docs for `serve` to confirm `--bridge` is documented wherever `serve` appears.

Run: `grep -rln "serve" packages/vfs-root/workspace/skills/ docs/shell-reference.md README.md`
Expected: `playwright-cli/SKILL.md` + shell-reference + README all now mention `--bridge`.

- [ ] **Step 3: Prettier + commit**

```bash
npx prettier --write CLAUDE.md packages/webapp/CLAUDE.md packages/cloudflare-worker/CLAUDE.md packages/cherry/CLAUDE.md docs/architecture.md docs/shell-reference.md README.md
git add -A
git commit -m "docs(preview): document serve --bridge driveable preview + security posture"
```

---

## Task 19: Full-gate integration pass

**Files:** none (verification only)

- [ ] **Step 1: Lint first (most common CI failure), then typecheck/test/builds + the touched-file complexity gate.**

Run (in this order — see root `CLAUDE.md:265` / `docs/verification.md:7`):

```bash
npm run lint                                              # ALWAYS first
node packages/dev-tools/tools/check-touched-exemptions.mjs   # touched-file complexity gate
npm run typecheck
npm run test
npm run build                                             # full repo build gate (docs/verification.md:14) — revalidates the root chain incl. the Cherry-generated worker asset
npm run build -w @slicc/webapp
npm run build -w @slicc/chrome-extension
```

Expected: all PASS; coverage at/above floors.

- [ ] **Step 2: Coverage floors for ALL touched packages + BOTH worker dry-runs.**

Run:

```bash
npm run test:coverage:cloudflare-worker
npm run test:coverage:webapp
npm run test:coverage:cherry
npm run build -w @slicc/cloudflare-worker                                            # dry-runs the HUB (wrangler.jsonc)
cd packages/cloudflare-worker && npx wrangler deploy --dry-run --config wrangler-preview.jsonc && cd ../..   # dry-runs the PREVIEW worker
```

Expected: all PASS. The embedded IIFE (html2canvas bundled) lives in the preview worker **script**, so the relevant limit is the Workers script-size limit (not the 25 MiB static-asset cap); the preview dry-run confirms it builds. `npm run build -w @slicc/cloudflare-worker` only validates the hub config, so the explicit `wrangler-preview.jsonc` dry-run is required.

- [ ] **Step 3: Manual smoke (staging, from the main repo).**

```bash
npm run dev -- --lead https://slicc-tray-hub-staging.minivelos.workers.dev
# in the Slicc shell:
echo '<h1>hi</h1><button onclick="slicc.emit(\'clicked\',{})">go</button>' > /workspace/b/index.html
serve --bridge /workspace/b
```

Expected: URL prints; opening it in a second browser → a `preview:` target appears in `playwright-cli list-remote-targets`, a "Preview tab connected" lick lands, driving it (`open`/`playwright-cli`) works, clicking the button lands a webhook lick, and an idle tab does not keep the DO billed (hibernation).

- [ ] **Step 4: Commit any fixups, then open the PR.**

---

## Self-Review Notes (traceability to spec)

- Spec §3 (product surface, `PreviewRecord.bridge`/`maxTabs`/`webhookId`, registry) → Tasks 3, 17.
- Spec §4/§5.2 (transport, routing, target surfacing, control mirrors) → Tasks 2, 11–15.
- Spec §5.1 (DO seams, role routing, hibernation, preview-worker routes, injection, CSP) → Tasks 1, 4–9.
- Spec §5.3 (bootstrap, bundling, `window.slicc`) → Task 10.
- Spec §6 (page→cone via same-origin `/__slicc/emit`; cone→page via eval) → Tasks 7, 8, 10.
- Spec §7 (security: opt-in decoupling, revocation, accepted cookie risk) → Tasks 3, 7, 17, 18.
- Spec §5.2 lick + §6 → Task 16.
- Spec §10/§11 (tests, docs) → per-task tests + Tasks 18, 19.
