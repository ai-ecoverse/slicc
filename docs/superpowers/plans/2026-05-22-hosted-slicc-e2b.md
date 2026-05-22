# Hosted SLICC on e2b — MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a fourth "hosted-leader" float that runs the existing SLICC webapp inside an e2b.dev sandbox, started by `slicc --cloud start`. Followers attach via the existing tray hub. Pause/resume across days works.

**Architecture:** The webapp inside cloud Chromium is the cone + tray leader (same shape as standalone CLI, with boot-time deltas). It connects outbound to the existing Cloudflare worker; followers join via `/join/:token`. The CLI calls e2b via a `SandboxSubstrate` interface so the substrate is swappable. Worker change is bounded to a gated `kind: 'desktop' | 'hosted'` extension that bumps reclaim TTL to 30 days for hosted trays.

**Tech Stack:** TypeScript, Vitest, Cloudflare Workers + Durable Objects, e2b TS SDK, Chromium, Express, CDP.

**Reference:** Spec at `docs/superpowers/specs/2026-05-22-hosted-slicc-e2b-design.md`. Implementation phases below match the spec's §"Phasing".

---

## Phase 1 — Worker `kind` plumbing + 30-day reclaim TTL

Lands first so subsequent phases can assume the worker knows about hosted trays. Smallest reviewable diff.

### Task 1.1: Add `HOSTED_TRAY_RECLAIM_TTL_MS` and `kind` to shared types

**Files:**

- Modify: `packages/cloudflare-worker/src/shared.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/cloudflare-worker/tests/index.test.ts` (in an existing or new `describe('shared types')` block):

```typescript
import {
  HOSTED_TRAY_RECLAIM_TTL_MS,
  TRAY_RECLAIM_TTL_MS,
  type CreateTrayRequest,
  type TrayRecord,
} from '../src/shared.js';

describe('shared types — hosted tray', () => {
  it('HOSTED_TRAY_RECLAIM_TTL_MS is 30 days', () => {
    expect(HOSTED_TRAY_RECLAIM_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('TRAY_RECLAIM_TTL_MS unchanged at 1 hour', () => {
    expect(TRAY_RECLAIM_TTL_MS).toBe(60 * 60 * 1000);
  });

  it('CreateTrayRequest.kind is an optional string-literal union', () => {
    const desktop: CreateTrayRequest = {
      trayId: 't',
      createdAt: 'now',
      joinToken: 'j',
      controllerToken: 'c',
      webhookToken: 'w',
    };
    const hosted: CreateTrayRequest = { ...desktop, kind: 'hosted' };
    const explicit: CreateTrayRequest = { ...desktop, kind: 'desktop' };
    expect(desktop.kind).toBeUndefined();
    expect(hosted.kind).toBe('hosted');
    expect(explicit.kind).toBe('desktop');
  });

  it('TrayRecord.kind is part of the persisted shape', () => {
    const rec = {
      trayId: 't',
      createdAt: 'now',
      joinToken: 'j',
      controllerToken: 'c',
      webhookToken: 'w',
      controllers: {},
      bootstraps: {},
      leader: null,
      kind: 'hosted',
    } as TrayRecord;
    expect(rec.kind).toBe('hosted');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd packages/cloudflare-worker && npx vitest run tests/index.test.ts -t "hosted tray"
```

Expected: FAIL — `HOSTED_TRAY_RECLAIM_TTL_MS` not exported, `kind` not in types.

- [ ] **Step 3: Implement the shared type changes**

Edit `packages/cloudflare-worker/src/shared.ts`:

```typescript
export const TRAY_RECLAIM_TTL_MS = 60 * 60 * 1000;
export const HOSTED_TRAY_RECLAIM_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface CreateTrayRequest {
  trayId: string;
  createdAt: string;
  joinToken: string;
  controllerToken: string;
  webhookToken: string;
  kind?: 'desktop' | 'hosted';
}

export interface TrayRecord {
  trayId: string;
  createdAt: string;
  joinToken: string;
  controllerToken: string;
  webhookToken: string;
  controllers: Record<string, ControllerRecord>;
  bootstraps: Record<string, TrayBootstrapRecord>;
  leader: LeaderRecord | null;
  expiredAt?: string;
  kind?: 'desktop' | 'hosted';
}
```

Keep `kind` optional everywhere — legacy desktop clients send no body, so absence means `'desktop'`.

- [ ] **Step 4: Run test to verify it passes**

```
cd packages/cloudflare-worker && npx vitest run tests/index.test.ts -t "hosted tray"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cloudflare-worker/src/shared.ts packages/cloudflare-worker/tests/index.test.ts
git commit -m "feat(worker): add HOSTED_TRAY_RECLAIM_TTL_MS and kind on tray types"
```

---

### Task 1.2: `POST /tray` parses request body for optional `kind`

**Files:**

- Modify: `packages/cloudflare-worker/src/index.ts:287` (`createTray` function)
- Modify: `packages/cloudflare-worker/tests/index.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/cloudflare-worker/tests/index.test.ts`:

```typescript
describe('POST /tray — kind plumbing', () => {
  it('accepts an empty body and defaults kind to desktop', async () => {
    const response = await handleWorkerRequest(
      new Request('https://www.sliccy.ai/tray', { method: 'POST' }),
      makeTestEnv()
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty('joinUrl');
    // No way to read the DO's stored `kind` from outside without poking the DO directly,
    // so this test pins the public contract: empty body returns 200.
  });

  it('accepts kind=hosted in a JSON body and persists it on the DO', async () => {
    // The DO has no public introspection route today (only /internal/create
    // is exercised by tests). Drive the DO directly with a FakeDurableObjectState
    // and assert against the persisted record — mirrors the existing test
    // pattern at the top of this file.
    const state = new FakeDurableObjectState();
    const tray = new SessionTrayDurableObject(state, makeTestEnv());

    const initResp = await tray.fetch(
      new Request('https://internal/internal/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          trayId: 't1',
          createdAt: new Date().toISOString(),
          joinToken: 'j',
          controllerToken: 'c',
          webhookToken: 'w',
          kind: 'hosted',
        }),
      })
    );
    expect(initResp.status).toBe(200);

    const stored = (await state.storage.get('tray')) as TrayRecord;
    expect(stored.kind).toBe('hosted');
  });

  it('rejects malformed JSON with 400', async () => {
    const response = await handleWorkerRequest(
      new Request('https://www.sliccy.ai/tray', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      }),
      makeTestEnv()
    );
    expect(response.status).toBe(400);
  });
});
```

`makeTestEnv()` is the same env factory used elsewhere in the file. The hosted-kind test drives the DO directly (`SessionTrayDurableObject` + `FakeDurableObjectState`) and asserts against `state.storage.get('tray')`. The two `handleWorkerRequest`-based tests around it pin the public POST /tray contract (empty body and malformed JSON).

If you want a third end-to-end test that POSTs to /tray and verifies the resulting tray's persisted `kind`, follow this pattern — `makeTestEnv()` returns a `TRAY_HUB` namespace whose `.get(id).fetch(...)` reaches `SessionTrayDurableObject` instances backed by `FakeDurableObjectState`s held inside the namespace; after `handleWorkerRequest('https://www.sliccy.ai/tray', kind=hosted)`, reach into the namespace for the freshly-minted tray and `await state.storage.get('tray')`. Reuse whatever holder the existing tests use for the namespace (look for the existing `TRAY_HUB`/`FakeDurableObjectNamespace` plumbing already at the top of the test file). This catches a regression where worker `POST /tray` parses the body but forgets to forward `kind` into the DO `CreateTrayRequest`.

- [ ] **Step 2: Run test to verify it fails**

```
cd packages/cloudflare-worker && npx vitest run tests/index.test.ts -t "kind plumbing"
```

Expected: FAIL — `kind` always undefined.

- [ ] **Step 3: Implement the body-parsing change**

Edit `packages/cloudflare-worker/src/index.ts` at `createTray` (around line 287):

```typescript
async function createTray(request: Request, env: WorkerEnv): Promise<Response> {
  let kind: 'desktop' | 'hosted' = 'desktop';
  const contentLength = request.headers.get('content-length');
  if (contentLength && contentLength !== '0') {
    try {
      const body = (await request.json()) as { kind?: unknown };
      if (body.kind === 'hosted' || body.kind === 'desktop') {
        kind = body.kind;
      } else if (body.kind !== undefined) {
        return jsonError(400, 'INVALID_KIND', 'kind must be "desktop" or "hosted"');
      }
    } catch {
      return jsonError(400, 'INVALID_BODY', 'request body must be valid JSON');
    }
  }

  const url = new URL(request.url);
  const trayId = crypto.randomUUID();
  const payload: CreateTrayRequest = {
    trayId,
    createdAt: new Date().toISOString(),
    joinToken: createCapabilityToken(trayId),
    controllerToken: createCapabilityToken(trayId),
    webhookToken: createCapabilityToken(trayId),
    kind,
  };

  const stub = env.TRAY_HUB.get(env.TRAY_HUB.idFromName(trayId));
  const initResponse = await stub.fetch(
    new Request(new URL('/internal/create', url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  );

  if (initResponse.status >= 400) {
    return initResponse;
  }
  // ... rest unchanged
}
```

Reuse the existing `jsonError(status, code, message)` helper (or whatever the worker uses for JSON error responses). If no helper exists, use `new Response(JSON.stringify({error: ...}), {status, headers})`.

- [ ] **Step 4: Run test to verify it passes**

```
cd packages/cloudflare-worker && npx vitest run tests/index.test.ts -t "kind plumbing"
```

Expected: PASS for all three cases.

- [ ] **Step 5: Commit**

```bash
git add packages/cloudflare-worker/src/index.ts packages/cloudflare-worker/tests/index.test.ts
git commit -m "feat(worker): POST /tray accepts optional kind in JSON body"
```

---

### Task 1.3: DO persists `kind`, branches reclaim TTL at both sites

**Files:**

- Modify: `packages/cloudflare-worker/src/session-tray.ts` (the `SessionTrayDurableObject`)
- Modify: `packages/cloudflare-worker/tests/index.test.ts`

- [ ] **Step 1: Write the failing test (pure helper + persistence)**

The cleanest way to test the branching logic is via a pure helper. Both reclaim sites (the disconnect-grace branch at ~line 1106, and `leaderSummary().reconnectDeadline` at ~line 698) will use this helper. The helper is trivially testable without route mocking.

Add to `packages/cloudflare-worker/tests/index.test.ts`:

```typescript
import {
  HOSTED_TRAY_RECLAIM_TTL_MS,
  TRAY_RECLAIM_TTL_MS,
  reclaimMsForTray,
  type TrayRecord,
} from '../src/shared.js';

describe('reclaimMsForTray', () => {
  it('returns 30 days for kind=hosted', () => {
    expect(reclaimMsForTray({ kind: 'hosted' } as TrayRecord)).toBe(HOSTED_TRAY_RECLAIM_TTL_MS);
  });

  it('returns 1 hour for kind=desktop', () => {
    expect(reclaimMsForTray({ kind: 'desktop' } as TrayRecord)).toBe(TRAY_RECLAIM_TTL_MS);
  });

  it('returns 1 hour for absent kind (back-compat)', () => {
    expect(reclaimMsForTray({} as TrayRecord)).toBe(TRAY_RECLAIM_TTL_MS);
  });

  it('returns 1 hour for null/undefined (defensive)', () => {
    expect(reclaimMsForTray(null)).toBe(TRAY_RECLAIM_TTL_MS);
    expect(reclaimMsForTray(undefined)).toBe(TRAY_RECLAIM_TTL_MS);
  });
});

describe('SessionTrayDurableObject — kind persistence', () => {
  it('persists kind=hosted on the tray record after /internal/create', async () => {
    const state = new FakeDurableObjectState();
    const tray = new SessionTrayDurableObject(state, makeTestEnv());

    await tray.fetch(
      new Request('https://internal/internal/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          trayId: 't1',
          createdAt: new Date().toISOString(),
          joinToken: 'j',
          controllerToken: 'c',
          webhookToken: 'w',
          kind: 'hosted',
        }),
      })
    );

    const stored = (await state.storage.get('tray')) as TrayRecord;
    expect(stored.kind).toBe('hosted');
    expect(reclaimMsForTray(stored)).toBe(HOSTED_TRAY_RECLAIM_TTL_MS);
  });

  it('defaults to kind=desktop when /internal/create payload omits it', async () => {
    const state = new FakeDurableObjectState();
    const tray = new SessionTrayDurableObject(state, makeTestEnv());

    await tray.fetch(
      new Request('https://internal/internal/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          trayId: 't2',
          createdAt: new Date().toISOString(),
          joinToken: 'j2',
          controllerToken: 'c2',
          webhookToken: 'w2',
        }),
      })
    );

    const stored = (await state.storage.get('tray')) as TrayRecord;
    expect(stored.kind ?? 'desktop').toBe('desktop');
    expect(reclaimMsForTray(stored)).toBe(TRAY_RECLAIM_TTL_MS);
  });
});
```

Note on `LeaderRecord` shape: the real type at `shared.ts:40-47` is `{controllerId, leaderKey, claimedAt, lastSeenAt, connected, disconnectedAt?}` — there is **no** `runtime` field (that lives on `ControllerRecord`) and **no** `attachedAt` field. The pure-helper test sidesteps `LeaderRecord` construction entirely; the persistence test only inspects `tray.kind`.

- [ ] **Step 2: Run test to verify it fails**

```
cd packages/cloudflare-worker && npx vitest run tests/index.test.ts -t "hosted reclaim TTL"
```

Expected: FAIL — hosted tray still computes 1h.

- [ ] **Step 3: Add the pure helper to shared.ts**

Edit `packages/cloudflare-worker/src/shared.ts`:

```typescript
export function reclaimMsForTray(tray: TrayRecord | null | undefined): number {
  return tray?.kind === 'hosted' ? HOSTED_TRAY_RECLAIM_TTL_MS : TRAY_RECLAIM_TTL_MS;
}
```

- [ ] **Step 4: Wire the helper through the DO**

Edit `packages/cloudflare-worker/src/session-tray.ts`:

1. Import `reclaimMsForTray` from `./shared.js`.

2. In the internal create handler, persist `kind` from the payload:

```typescript
// Inside the /internal/create handler:
const payload = (await request.json()) as CreateTrayRequest;
const record: TrayRecord = {
  trayId: payload.trayId,
  createdAt: payload.createdAt,
  joinToken: payload.joinToken,
  controllerToken: payload.controllerToken,
  webhookToken: payload.webhookToken,
  controllers: {},
  bootstraps: {},
  leader: null,
  kind: payload.kind ?? 'desktop',
};
await this.state.storage.put('tray', record);
```

3. Replace both `TRAY_RECLAIM_TTL_MS` call sites with `reclaimMsForTray(this.tray)`:

```typescript
// At ~line 698 (inside leaderSummary):
reconnectDeadline: leader.disconnectedAt
  ? new Date(Date.parse(leader.disconnectedAt) + reclaimMsForTray(this.tray)).toISOString()
  : null,

// At ~line 1106 (disconnect-grace branch):
const expiresAt = Date.parse(tray.leader.disconnectedAt) + reclaimMsForTray(tray);
```

- [ ] **Step 5: Run test to verify it passes**

```
cd packages/cloudflare-worker && npx vitest run tests/index.test.ts -t "reclaimMsForTray|kind persistence"
```

Expected: PASS for all helper + persistence cases.

- [ ] **Step 6: Run the full worker test suite to catch regressions**

```
cd packages/cloudflare-worker && npx vitest run
```

Expected: all pre-existing tests still pass.

- [ ] **Step 7: Commit**

```bash
git add packages/cloudflare-worker/src/shared.ts \
        packages/cloudflare-worker/src/session-tray.ts \
        packages/cloudflare-worker/tests/index.test.ts
git commit -m "feat(worker): persist tray kind and branch reclaim TTL via reclaimMsForTray helper"
```

---

### Task 1.4: Mirror the smoke check in `deployed.test.ts`

**Files:**

- Modify: `packages/cloudflare-worker/tests/deployed.test.ts`

- [ ] **Step 1: Add a hosted-kind smoke check**

Append to `packages/cloudflare-worker/tests/deployed.test.ts`:

```typescript
it('POST /tray with kind=hosted returns a tray and reports a 30-day reconnect deadline shape', async () => {
  if (!WORKER_BASE_URL) return; // existing pattern — skips when no deployed URL
  const resp = await fetch(`${WORKER_BASE_URL}/tray`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'hosted' }),
  });
  expect(resp.status).toBe(200);
  const body = await resp.json();
  expect(body).toHaveProperty('joinUrl');
  expect(body).toHaveProperty('controllerUrl');
  // We don't have a leader to disconnect here; just assert the create path works
  // against the deployed worker. The unit test in index.test.ts pins the
  // 30-day deadline shape.
});

it('POST /tray with no body still creates a desktop tray (back-compat)', async () => {
  if (!WORKER_BASE_URL) return;
  const resp = await fetch(`${WORKER_BASE_URL}/tray`, { method: 'POST' });
  expect(resp.status).toBe(200);
  const body = await resp.json();
  expect(body).toHaveProperty('joinUrl');
});
```

- [ ] **Step 2: Commit**

```bash
git add packages/cloudflare-worker/tests/deployed.test.ts
git commit -m "test(worker): deployed smoke check for hosted-kind tray creation"
```

---

### Task 1.5: Phase 1 verification + worker CLAUDE.md update

**Files:**

- Modify: `packages/cloudflare-worker/CLAUDE.md`

- [ ] **Step 1: Run all worker gates**

```
npx prettier --write packages/cloudflare-worker/src packages/cloudflare-worker/tests
cd packages/cloudflare-worker && npm run typecheck
cd packages/cloudflare-worker && npx vitest run
```

Expected: all green.

- [ ] **Step 2: Document the new branch in worker CLAUDE.md**

Append a section to `packages/cloudflare-worker/CLAUDE.md` under "Tray Hub Architecture":

```markdown
### Tray kind (desktop / hosted)

`TrayRecord.kind` is `'desktop' | 'hosted'`, defaulting to `'desktop'` when absent.
`POST /tray` reads an optional `kind` from the request body (no body = desktop;
malformed body = 400). The reclaim TTL is `HOSTED_TRAY_RECLAIM_TTL_MS = 30 days`
for hosted trays, `TRAY_RECLAIM_TTL_MS = 1 hour` for desktop trays — branched
through `SessionTrayDurableObject.reclaimMs()`. Hosted trays support
laptop-orchestrated sandboxes that pause for days at a time.
```

- [ ] **Step 3: Commit**

```bash
git add packages/cloudflare-worker/CLAUDE.md
git commit -m "docs(worker): document tray kind branch in CLAUDE.md"
```

---

## Phase 2 — Webapp hosted-leader boot path

The cloud Chromium loads `localhost:5710/?runtime=hosted-leader`. Make the webapp boot as a leader unconditionally in that mode, fire `onLeaderReady` on initial create, include `kind: 'hosted'` in `POST /tray`.

**Verification scope.** Phase 2 ships unit-test coverage only. The full browser/e2b smoke (loading `?runtime=hosted-leader` and observing a hosted tray minted on the deployed worker) requires Phase 3 because the webapp's `onLeaderReady` posts to `/api/cloud-status`, which doesn't exist until Phase 3 lands. End-to-end dogfood happens in Phase 4.

### Task 2.1: Add `'hosted-leader'` to `UiRuntimeMode`

**Files:**

- Modify: `packages/webapp/src/ui/runtime-mode.ts`
- Modify or create: `packages/webapp/tests/ui/runtime-mode.test.ts`

- [ ] **Step 1: Write the failing test**

Create or extend `packages/webapp/tests/ui/runtime-mode.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  resolveUiRuntimeMode,
  shouldUseRuntimeModeTrayDefaults,
  type UiRuntimeMode,
} from '../../src/ui/runtime-mode.js';

describe('runtime-mode — hosted-leader', () => {
  it('resolves ?runtime=hosted-leader to hosted-leader (non-extension)', () => {
    const mode = resolveUiRuntimeMode(
      'http://localhost:5710/?runtime=hosted-leader',
      /* isExtension */ false
    );
    expect(mode).toBe<UiRuntimeMode>('hosted-leader');
  });

  it('extension context never returns hosted-leader', () => {
    const mode = resolveUiRuntimeMode(
      'chrome-extension://abc/index.html?runtime=hosted-leader',
      true
    );
    expect(mode).not.toBe('hosted-leader');
  });

  it('shouldUseRuntimeModeTrayDefaults is true for hosted-leader', () => {
    expect(shouldUseRuntimeModeTrayDefaults('hosted-leader', true)).toBe(true);
    expect(shouldUseRuntimeModeTrayDefaults('hosted-leader', false)).toBe(true);
  });

  it('falls back to standalone for missing runtime param', () => {
    expect(resolveUiRuntimeMode('http://localhost:5710/', false)).toBe('standalone');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd packages/webapp && npx vitest run tests/ui/runtime-mode.test.ts
```

Expected: FAIL — `'hosted-leader'` not a member of `UiRuntimeMode`.

- [ ] **Step 3: Implement runtime-mode extension**

Edit `packages/webapp/src/ui/runtime-mode.ts`:

```typescript
export type UiRuntimeMode =
  | 'standalone'
  | 'extension'
  | 'electron-overlay'
  | 'extension-detached'
  | 'hosted-leader';

const HOSTED_LEADER_RUNTIME_QUERY_VALUE = 'hosted-leader';

export function resolveUiRuntimeMode(locationHref: string, isExtension: boolean): UiRuntimeMode {
  if (isExtension) {
    // Existing extension branch — unchanged.
    // ...existing code...
  }
  try {
    const url = new URL(locationHref);
    if (url.searchParams.get('runtime') === HOSTED_LEADER_RUNTIME_QUERY_VALUE) {
      return 'hosted-leader';
    }
    return isElectronOverlayUrl(url) ? 'electron-overlay' : 'standalone';
  } catch {
    return 'standalone';
  }
}

export function shouldUseRuntimeModeTrayDefaults(
  runtimeMode: UiRuntimeMode,
  hasRuntimeConfigEndpoint: boolean
): boolean {
  return (
    runtimeMode === 'electron-overlay' ||
    runtimeMode === 'hosted-leader' ||
    (runtimeMode === 'standalone' && hasRuntimeConfigEndpoint)
  );
}
```

Leave the existing extension branch logic intact — only add the hosted-leader recognition in the non-extension path and in the tray-defaults predicate.

- [ ] **Step 4: Run test to verify it passes**

```
cd packages/webapp && npx vitest run tests/ui/runtime-mode.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/ui/runtime-mode.ts packages/webapp/tests/ui/runtime-mode.test.ts
git commit -m "feat(webapp): add hosted-leader to UiRuntimeMode"
```

---

### Task 2.2: `LeaderTrayManager` — add `onLeaderReady` callback fired on initial create

**Files:**

- Modify: `packages/webapp/src/scoops/tray-leader.ts`
- Modify: `packages/webapp/tests/scoops/tray-leader.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/webapp/tests/scoops/tray-leader.test.ts`:

```typescript
describe('LeaderTrayManager — onLeaderReady callback', () => {
  it('fires onLeaderReady once after the first successful start()', async () => {
    const fakeWebSocket = makeFakeOpenWebSocket();
    const fetchImpl = makeFakeFetch({
      tray: { joinUrl: 'https://w.example.com/join/jt' /* ... */ },
      attach: { role: 'leader', leaderKey: 'lk', websocket: { url: 'wss://w/' } },
    });
    const onLeaderReady = vi.fn();
    const mgr = new LeaderTrayManager({
      workerBaseUrl: 'https://w.example.com',
      runtime: 'slicc-standalone',
      store: new MemorySessionStore(),
      fetchImpl,
      webSocketFactory: () => fakeWebSocket,
      onLeaderReady,
      reconnect: false,
    });

    const session = await mgr.start();
    expect(onLeaderReady).toHaveBeenCalledTimes(1);
    expect(onLeaderReady).toHaveBeenCalledWith(session);
  });

  it('fires onLeaderReady on every successful reconnect as well', async () => {
    const onLeaderReady = vi.fn();
    const onReconnected = vi.fn();
    // ... build a manager that survives one drop and reconnects once ...
    // After reconnect: onLeaderReady called twice; onReconnected called once.
    // (Use existing reconnect-test scaffolding in this file as a template.)
  });

  it('does not fire onLeaderReady when start() throws', async () => {
    const onLeaderReady = vi.fn();
    const fetchImpl = makeFakeFetch({ tray: 'error' }); // force a failure
    const mgr = new LeaderTrayManager({
      workerBaseUrl: 'https://w.example.com',
      runtime: 'slicc-standalone',
      store: new MemorySessionStore(),
      fetchImpl,
      onLeaderReady,
      reconnect: false,
    });
    await expect(mgr.start()).rejects.toThrow();
    expect(onLeaderReady).not.toHaveBeenCalled();
  });
});
```

(Use the existing helpers `MemorySessionStore`, `makeFakeOpenWebSocket`, `makeFakeFetch` already present in this test file. If a helper is missing, build it minimally from the existing patterns.)

- [ ] **Step 2: Run test to verify it fails**

```
cd packages/webapp && npx vitest run tests/scoops/tray-leader.test.ts -t "onLeaderReady"
```

Expected: FAIL — option not recognized; callback never fires.

- [ ] **Step 3: Implement `onLeaderReady`**

Edit `packages/webapp/src/scoops/tray-leader.ts`:

```typescript
export interface LeaderTrayManagerOptions {
  // ... existing fields ...
  /** Fired once after the first successful start(), and again on each successful reconnect. */
  onLeaderReady?: (session: LeaderTraySession) => void;
}

export class LeaderTrayManager {
  // ... existing fields ...

  async start(): Promise<LeaderTraySession> {
    this.stopped = false;
    if (this.currentSession && this.socket) {
      setLeaderTrayRuntimeStatus({ state: 'leader', session: this.currentSession, error: null });
      return this.currentSession;
    }

    setLeaderTrayRuntimeStatus({ state: 'connecting', session: null, error: null });
    this.currentSession = null;

    try {
      const session = await this.connectOnce();
      log.info('Leader joined tray', {
        trayId: session.trayId,
        controllerId: session.controllerId,
        runtime: session.runtime,
      });
      this.options.onLeaderReady?.(session); // NEW
      return session;
    } catch (error) {
      setLeaderTrayRuntimeStatus({
        state: 'error',
        session: this.currentSession,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  // Inside the reconnect loop (where `onReconnected` is called):
  // After this.options.onReconnected?.(session), also call:
  //   this.options.onLeaderReady?.(session);
}
```

- [ ] **Step 4: Run test to verify it passes**

```
cd packages/webapp && npx vitest run tests/scoops/tray-leader.test.ts -t "onLeaderReady"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/scoops/tray-leader.ts packages/webapp/tests/scoops/tray-leader.test.ts
git commit -m "feat(webapp): LeaderTrayManager fires onLeaderReady on initial start and reconnect"
```

---

### Task 2.3: `LeaderTrayManager` — add `kind` option, include in `POST /tray` body

**Files:**

- Modify: `packages/webapp/src/scoops/tray-leader.ts`
- Modify: `packages/webapp/tests/scoops/tray-leader.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/webapp/tests/scoops/tray-leader.test.ts`:

```typescript
describe('LeaderTrayManager — kind in POST /tray body', () => {
  it('omits kind from POST /tray body when not provided', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = makeFakeFetch(
      {
        // capture requests via a wrapping fetch
      },
      requests
    );
    const mgr = new LeaderTrayManager({
      workerBaseUrl: 'https://w.example.com',
      runtime: 'slicc-standalone',
      store: new MemorySessionStore(),
      fetchImpl,
      webSocketFactory: () => makeFakeOpenWebSocket(),
      reconnect: false,
    });
    await mgr.start();
    const trayPost = requests.find((r) => r.url.endsWith('/tray') && r.init.method === 'POST');
    expect(trayPost).toBeDefined();
    const body = trayPost!.init.body ? JSON.parse(String(trayPost!.init.body)) : {};
    expect(body.kind).toBeUndefined();
  });

  it('includes kind=hosted in POST /tray body when set', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = makeFakeFetch(
      {
        /* same shape as above */
      },
      requests
    );
    const mgr = new LeaderTrayManager({
      workerBaseUrl: 'https://w.example.com',
      runtime: 'slicc-hosted-leader',
      kind: 'hosted',
      store: new MemorySessionStore(),
      fetchImpl,
      webSocketFactory: () => makeFakeOpenWebSocket(),
      reconnect: false,
    });
    await mgr.start();
    const trayPost = requests.find((r) => r.url.endsWith('/tray') && r.init.method === 'POST');
    expect(trayPost).toBeDefined();
    const body = JSON.parse(String(trayPost!.init.body));
    expect(body.kind).toBe('hosted');
  });
});
```

If the existing `makeFakeFetch` doesn't expose request-capture, extend it inline to push each call into the optional `requests` array.

- [ ] **Step 2: Run test to verify it fails**

```
cd packages/webapp && npx vitest run tests/scoops/tray-leader.test.ts -t "kind in POST"
```

Expected: FAIL — `kind` not recognized; body never includes it.

- [ ] **Step 3: Implement `kind` option in `createTraySession`**

Edit `packages/webapp/src/scoops/tray-leader.ts`:

```typescript
export interface LeaderTrayManagerOptions {
  // ... existing fields ...
  /** Persisted on the tray; controls reclaim TTL on the worker. */
  kind?: 'desktop' | 'hosted';
}

// In createTraySession (~line 465):
private async createTraySession(): Promise<LeaderTraySession> {
  const url = buildTrayWorkerUrl(this.options.workerBaseUrl, 'tray');
  const body = this.options.kind ? JSON.stringify({ kind: this.options.kind }) : undefined;
  const response = await this.fetchImpl(url, {
    method: 'POST',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body,
  });
  // ... rest unchanged: parse response, extract joinUrl, etc.
}
```

The legacy desktop path passes no `kind` and sends no body — back-compat preserved (Task 1.2 made the worker tolerate empty body).

- [ ] **Step 4: Run test to verify it passes**

```
cd packages/webapp && npx vitest run tests/scoops/tray-leader.test.ts -t "kind in POST"
```

Expected: PASS for both cases.

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/scoops/tray-leader.ts packages/webapp/tests/scoops/tray-leader.test.ts
git commit -m "feat(webapp): LeaderTrayManager threads kind through POST /tray body"
```

---

### Task 2.4: `page-leader-tray.ts` — parameterize `runtime` and `kind`

**Files:**

- Modify: `packages/webapp/src/ui/page-leader-tray.ts`

- [ ] **Step 1: Read the current shape**

The file at `page-leader-tray.ts:190` hardcodes `runtime: 'slicc-standalone'`. Change to accept both `runtime` and `kind` via the options object that `startPageLeaderTray` already receives.

- [ ] **Step 2: Modify `StartPageLeaderTrayOptions` and the `new LeaderTrayManager(...)` call**

Edit `packages/webapp/src/ui/page-leader-tray.ts`:

```typescript
export interface StartPageLeaderTrayOptions {
  workerBaseUrl: string;
  // ... existing fields (sendWebhookEvent, _storeOverride, _webSocketFactory) ...
  /** Tray attach runtime string. Default 'slicc-standalone'. */
  runtime?: string;
  /** Tray kind. Default omitted (desktop). */
  kind?: 'desktop' | 'hosted';
}

export function startPageLeaderTray(options: StartPageLeaderTrayOptions): PageLeaderTrayHandle {
  // ... existing setup ...
  leader = new LeaderTrayManager({
    workerBaseUrl: options.workerBaseUrl,
    runtime: options.runtime ?? 'slicc-standalone',
    ...(options.kind ? { kind: options.kind } : {}),
    fetchImpl,
    ...(options._storeOverride ? { store: options._storeOverride } : {}),
    ...(options._webSocketFactory ? { webSocketFactory: options._webSocketFactory } : {}),
    // ... rest of existing options unchanged ...
  });
  // ... rest unchanged ...
}
```

- [ ] **Step 3: Run existing standalone tests to confirm no regression**

```
cd packages/webapp && npx vitest run
```

Expected: all green; default behavior unchanged for the standalone path (no callers pass `runtime` or `kind` yet, so they get the existing defaults).

- [ ] **Step 4: Commit**

```bash
git add packages/webapp/src/ui/page-leader-tray.ts
git commit -m "feat(webapp): page-leader-tray accepts runtime and kind options"
```

---

### Task 2.5: `main.ts` — thread `runtimeMode` into `mainStandaloneWorker`

**Files:**

- Modify: `packages/webapp/src/ui/main.ts`

- [ ] **Step 1: Change `mainStandaloneWorker` signature**

Edit `packages/webapp/src/ui/main.ts` at the existing `mainStandaloneWorker` definition (~line 1683) and its call site (~line 3190):

Before:

```typescript
async function mainStandaloneWorker(app: HTMLElement, isElectronOverlay: boolean): Promise<void> {
  // ...
}

// At call site (~3190):
return mainStandaloneWorker(app, runtimeMode === 'electron-overlay');
```

After:

```typescript
async function mainStandaloneWorker(app: HTMLElement, runtimeMode: UiRuntimeMode): Promise<void> {
  const isElectronOverlay = runtimeMode === 'electron-overlay';
  // ... existing body uses isElectronOverlay and now also has access to runtimeMode ...
}

// At call site (~3190):
return mainStandaloneWorker(app, runtimeMode);
```

`UiRuntimeMode` is already imported (line 98–99 imports `resolveUiRuntimeMode` and `shouldUseRuntimeModeTrayDefaults` from `./runtime-mode.js`). Add the type import:

```typescript
import {
  resolveUiRuntimeMode,
  shouldUseRuntimeModeTrayDefaults,
  type UiRuntimeMode,
} from './runtime-mode.js';
```

- [ ] **Step 2: Run typecheck**

```
cd packages/webapp && npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 3: Run tests to catch regressions**

```
cd packages/webapp && npx vitest run
```

Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add packages/webapp/src/ui/main.ts
git commit -m "refactor(webapp): thread runtimeMode through mainStandaloneWorker"
```

---

### Task 2.6: `main.ts` — hosted-leader boot branch (always-start, clears stale joinUrl)

**Files:**

- Modify: `packages/webapp/src/ui/main.ts`

- [ ] **Step 1: Add the hosted-leader branch in the tray block**

Edit `packages/webapp/src/ui/main.ts` in the tray block around `main.ts:2654`. Insert a hosted-leader short-circuit BEFORE the existing `storedJoinUrl` check:

```typescript
// Inside mainStandaloneWorker, in the tray block, BEFORE the existing
// `if (storedJoinUrl) { ... } else if (storedWorkerBaseUrl) { ... }` block:
if (runtimeMode === 'hosted-leader') {
  // A persisted /data/profile (which survives e2b pause/resume) could carry
  // a stale TRAY_JOIN_STORAGE_KEY from a prior follower role. For hosted-leader
  // we ALWAYS start as leader; clear the join key so the existing branch
  // below cannot route us into the follower path on this or any subsequent
  // boot.
  window.localStorage.removeItem(TRAY_JOIN_STORAGE_KEY);

  // `resolveTrayRuntimeConfig` already ran earlier in `mainStandaloneWorker`
  // (~main.ts:1706) — by the time we reach the tray block, it has fetched
  // /api/runtime-config (which node-server's --hosted mode populates from
  // SLICC_TRAY_WORKER_BASE_URL) and seeded TRAY_WORKER_STORAGE_KEY in
  // localStorage. Reuse that value rather than re-fetching.
  const workerBaseUrl = window.localStorage.getItem(TRAY_WORKER_STORAGE_KEY);
  if (!workerBaseUrl) {
    throw new Error(
      'hosted-leader: TRAY_WORKER_STORAGE_KEY not seeded — runtime-config resolution failed'
    );
  }

  pageLeaderTray = startPageLeaderTray({
    ...buildLeaderTrayOptions(workerBaseUrl),
    runtime: 'slicc-hosted-leader',
    kind: 'hosted',
    onLeaderReady: (session) => {
      void fetch('/api/cloud-status', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          joinUrl: session.joinUrl,
          trayId: session.trayId,
          controllerUrl: session.controllerUrl,
          webhookUrl: session.webhookUrl,
          runtime: session.runtime,
          sliccVersion: SLICC_VERSION, // compiled-in constant; see Step 2
        }),
      }).catch((err) => {
        log.error('failed to POST /api/cloud-status', { error: String(err) });
      });
    },
  });
  wireLeaderHooks(pageLeaderTray);
} else if (storedJoinUrl) {
  // ... existing follower path unchanged ...
} else if (storedWorkerBaseUrl) {
  // ... existing leader path unchanged ...
}
```

- [ ] **Step 2: Add a compiled-in `SLICC_VERSION` constant**

If a version constant doesn't already exist, add one. Simplest path: import the root `package.json` version at build time via Vite's `define`. In `packages/webapp/vite.config.ts`:

```typescript
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf-8')) as {
  version: string;
};

export default defineConfig({
  // ... existing config ...
  define: {
    // ... existing defines ...
    SLICC_VERSION: JSON.stringify(pkg.version),
  },
});
```

Add an ambient declaration in `packages/webapp/src/types/globals.d.ts` (create if absent):

```typescript
declare const SLICC_VERSION: string;
```

Reference it as `SLICC_VERSION` directly inside `main.ts`. The build-time replacement produces a literal string.

- [ ] **Step 3: Extend `LeaderTrayManagerOptions` plumbing through `startPageLeaderTray`**

`startPageLeaderTray` already accepts `runtime`/`kind` (Task 2.4). Add `onLeaderReady` to `StartPageLeaderTrayOptions` if not present, and pass it through to the `LeaderTrayManager` constructor:

```typescript
// page-leader-tray.ts:
export interface StartPageLeaderTrayOptions {
  // ... existing ...
  onLeaderReady?: (session: LeaderTraySession) => void;
}

// inside startPageLeaderTray, in the LeaderTrayManager construction:
leader = new LeaderTrayManager({
  // ... existing ...
  ...(options.onLeaderReady ? { onLeaderReady: options.onLeaderReady } : {}),
});
```

- [ ] **Step 4: Run all webapp tests + typecheck**

```
cd packages/webapp && npx tsc --noEmit
cd packages/webapp && npx vitest run
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/ui/main.ts \
        packages/webapp/src/ui/page-leader-tray.ts \
        packages/webapp/vite.config.ts \
        packages/webapp/src/types/globals.d.ts
git commit -m "feat(webapp): hosted-leader boot branch (always-start, clears stale joinUrl, posts cloud-status)"
```

---

## Phase 3 — node-server `--hosted` + e2b template

The cloud-side runtime: node-server boots Chromium with container flags against `?runtime=hosted-leader`, exposes `/api/cloud-status` and `/api/leader-restart`, and the e2b template wraps it all.

### Task 3.1: `chrome-launch.ts` — container flags on a `--hosted` code path

**Files:**

- Modify: `packages/node-server/src/chrome-launch.ts`
- Modify: `packages/node-server/tests/chrome-launch.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

Add to `packages/node-server/tests/chrome-launch.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { buildChromeLaunchArgs } from '../src/chrome-launch.js';

const baseOpts = {
  cdpPort: 9222,
  launchUrl: 'http://localhost:5710/',
  profile: { userDataDir: '/tmp/x' },
};

describe('buildChromeLaunchArgs — hosted mode', () => {
  it('default mode does not include container flags', () => {
    const args = buildChromeLaunchArgs(baseOpts);
    expect(args).not.toContain('--no-sandbox');
    expect(args).not.toContain('--disable-dev-shm-usage');
    expect(args).not.toContain('--headless=new');
  });

  it('hosted: true appends container flags', () => {
    const args = buildChromeLaunchArgs({ ...baseOpts, hosted: true });
    expect(args).toContain('--no-sandbox');
    expect(args).toContain('--disable-dev-shm-usage');
    expect(args).toContain('--disable-gpu');
    expect(args).toContain('--headless=new');
    expect(args).toContain('--font-render-hinting=none');
  });

  it('hosted mode preserves existing flags (user-data-dir, etc.)', () => {
    const args = buildChromeLaunchArgs({ ...baseOpts, hosted: true });
    expect(args).toContain('--user-data-dir=/tmp/x');
    expect(args).toContain(`--remote-debugging-port=9222`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd packages/node-server && npx vitest run tests/chrome-launch.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `hosted` option**

Edit `packages/node-server/src/chrome-launch.ts`:

```typescript
export function buildChromeLaunchArgs(options: {
  cdpPort: number;
  launchUrl: string;
  profile: ChromeLaunchProfile;
  hosted?: boolean;
}): string[] {
  const args = [
    `--remote-debugging-port=${options.cdpPort}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-crash-reporter',
    '--disable-background-tracing',
    '--disable-blink-features=AutomationControlled',
    `--user-data-dir=${options.profile.userDataDir}`,
  ];

  if (options.hosted) {
    args.push(
      '--headless=new',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--font-render-hinting=none'
    );
  }

  if (options.profile.extensionPath) {
    args.push(`--disable-extensions-except=${options.profile.extensionPath}`);
    args.push(`--load-extension=${options.profile.extensionPath}`);
  }

  args.push(options.launchUrl);
  return args;
}
```

- [ ] **Step 4: Run test to verify it passes**

```
cd packages/node-server && npx vitest run tests/chrome-launch.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/node-server/src/chrome-launch.ts packages/node-server/tests/chrome-launch.test.ts
git commit -m "feat(node-server): chrome-launch hosted flag adds container args"
```

---

### Task 3.2: `runtime-flags.ts` + dispatch — add `--hosted` flag

**Files:**

- Modify: `packages/node-server/src/runtime-flags.ts`
- Modify: `packages/node-server/src/index.ts`
- Modify: `packages/node-server/tests/runtime-flags.test.ts` (if exists)

- [ ] **Step 1: Add `--hosted` to the flag parser**

Edit `packages/node-server/src/runtime-flags.ts`. Add a `hosted: boolean` field to whatever interface holds parsed flags, and recognize `--hosted` as boolean:

```typescript
export interface RuntimeFlags {
  // ... existing fields ...
  hosted: boolean;
}

// In the parser, recognize:
if (arg === '--hosted') {
  flags.hosted = true;
  continue;
}
```

- [ ] **Step 2: Wire `--hosted` semantics in `index.ts`**

In `packages/node-server/src/index.ts`, where `chromeArgs` are built (around line 571) and where auto-open / Vite HMR are decided, branch on `RUNTIME_FLAGS.hosted`:

```typescript
const chromeArgs = buildChromeLaunchArgs({
  cdpPort,
  launchUrl,
  profile,
  hosted: RUNTIME_FLAGS.hosted,
});

// Disable auto-opening the user's local browser in hosted mode:
if (!RUNTIME_FLAGS.hosted) {
  // ... existing auto-open logic ...
}

// Disable Vite HMR in hosted mode:
const enableHmr = DEV_MODE && !RUNTIME_FLAGS.hosted;
```

Also change the chrome launch URL to include `?runtime=hosted-leader` when `--hosted`:

```typescript
const launchUrl = RUNTIME_FLAGS.hosted
  ? `http://localhost:${SERVE_PORT}/?runtime=hosted-leader`
  : `http://localhost:${SERVE_PORT}/`;
```

And use a persistent profile dir in hosted mode (from `CHROME_USER_DATA_DIR` env, defaulting to `/data/profile`):

```typescript
const userDataDir = RUNTIME_FLAGS.hosted
  ? (process.env['CHROME_USER_DATA_DIR'] ?? '/data/profile')
  : existingPerPortTempDir; // existing logic
```

- [ ] **Step 3: Update `/api/runtime-config` to honor `SLICC_TRAY_WORKER_BASE_URL`**

Edit `packages/node-server/src/index.ts` at the `/api/runtime-config` handler (around line 813):

```typescript
app.get('/api/runtime-config', (_req, res) => {
  res.json({
    trayWorkerBaseUrl:
      // Hosted mode source: env var injected at sandbox-create time.
      (RUNTIME_FLAGS.hosted ? process.env['SLICC_TRAY_WORKER_BASE_URL']?.trim() : null) ??
      RUNTIME_FLAGS.leadWorkerBaseUrl ??
      (process.env['WORKER_BASE_URL']?.trim() || null) ??
      (DEV_MODE ? 'https://slicc-tray-hub-staging.minivelos.workers.dev' : 'https://www.sliccy.ai'),
    trayJoinUrl: discoveredTrayJoinUrl ?? null,
  });
});
```

- [ ] **Step 4: Verify `--hosted` smoke**

```
cd packages/node-server && npm run typecheck
cd packages/node-server && npx vitest run
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add packages/node-server/src/runtime-flags.ts packages/node-server/src/index.ts
git commit -m "feat(node-server): --hosted flag (headless chromium, persistent profile, env worker URL)"
```

---

### Task 3.3: `/api/cloud-status` endpoint (hosted-only)

**Files:**

- Modify: `packages/node-server/src/index.ts`
- Create: `packages/node-server/tests/cloud-status.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/node-server/tests/cloud-status.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { registerCloudStatusEndpoint } from '../src/cloud-status.js';

let tmpFile: string;

beforeEach(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slicc-cloud-status-'));
  tmpFile = path.join(dir, 'slicc-join.json');
});

describe('POST /api/cloud-status', () => {
  it('writes a JSON payload to the configured path', async () => {
    const app = express();
    registerCloudStatusEndpoint(app, { joinFilePath: tmpFile });

    const payload = {
      joinUrl: 'https://www.sliccy.ai/join/abc',
      trayId: 't1',
      controllerUrl: 'wss://w/controller/c',
      webhookUrl: 'https://w/webhook/wb/wid',
      runtime: 'slicc-hosted-leader',
      sliccVersion: '3.2.2',
    };
    const response = await fetch
      .bind(globalThis)('http://localhost:0/api/cloud-status', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      .catch(() => null); // bind to a supertest-style call; use whatever helper your repo uses

    // Replace the fetch line above with whatever in-process request helper the
    // existing node-server tests use (likely supertest or a manual Express
    // listener on an ephemeral port). The assertion is the same:

    const written = JSON.parse(await fs.readFile(tmpFile, 'utf-8'));
    expect(written.joinUrl).toBe(payload.joinUrl);
    expect(written.trayId).toBe('t1');
    expect(written.sliccVersion).toBe('3.2.2');
    expect(typeof written.updatedAt).toBe('string');
    expect(Date.parse(written.updatedAt)).not.toBeNaN();
  });

  it('rejects missing joinUrl with 400', async () => {
    const app = express();
    registerCloudStatusEndpoint(app, { joinFilePath: tmpFile });
    // ... send a POST with {trayId: 't'} (no joinUrl) — expect 400
  });

  it('rejects requests from a non-loopback remoteAddress with 403', async () => {
    // Call the middleware directly with a synthetic request/response pair —
    // simpler than spinning up an Express listener bound to a non-loopback
    // address (which would require root for low ports anyway). Match the
    // Express request surface that requireLoopback inspects.
    const { requireLoopback } = await import('../src/cloud-status.js');
    let statusCode = 0;
    let body: unknown = null;
    const req = { socket: { remoteAddress: '10.0.0.5' } } as unknown as Parameters<
      typeof requireLoopback
    >[0];
    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(payload: unknown) {
        body = payload;
        return this;
      },
    } as unknown as Parameters<typeof requireLoopback>[1];
    let nextCalled = false;
    requireLoopback(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(false);
    expect(statusCode).toBe(403);
    expect(body).toEqual({ error: 'localhost only' });
  });

  it('accepts each known loopback shape', async () => {
    const { requireLoopback } = await import('../src/cloud-status.js');
    for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      let nextCalled = false;
      const req = { socket: { remoteAddress: addr } } as never;
      const res = { status: () => res, json: () => res } as never;
      requireLoopback(req, res, () => {
        nextCalled = true;
      });
      expect(nextCalled).toBe(true);
    }
  });
});
```

(Use the existing test harness pattern from other node-server test files. If they use supertest, follow suit.)

- [ ] **Step 2: Run test to verify it fails**

```
cd packages/node-server && npx vitest run tests/cloud-status.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `/api/cloud-status` (localhost-only)**

Create `packages/node-server/src/cloud-status.ts`:

```typescript
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { promises as fs } from 'node:fs';

export interface CloudStatusEndpointOptions {
  joinFilePath: string;
}

/**
 * Reject non-loopback requests. The sandbox is a private execution boundary,
 * but defense in depth: someone might wire a port-forward and we want this
 * endpoint to be unreachable from the outside.
 */
export function requireLoopback(req: Request, res: Response, next: NextFunction): void {
  const addr = req.socket.remoteAddress ?? '';
  const isLoopback =
    addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr === 'localhost';
  if (!isLoopback) {
    res.status(403).json({ error: 'localhost only' });
    return;
  }
  next();
}

export function registerCloudStatusEndpoint(
  app: Express,
  options: CloudStatusEndpointOptions
): void {
  app.post('/api/cloud-status', requireLoopback, express.json(), async (req, res) => {
    const body = req.body as Partial<{
      joinUrl: string;
      trayId: string;
      controllerUrl: string;
      webhookUrl: string;
      runtime: string;
      sliccVersion: string;
    }>;
    if (typeof body.joinUrl !== 'string' || !body.joinUrl) {
      res.status(400).json({ error: 'joinUrl required' });
      return;
    }
    const payload = {
      joinUrl: body.joinUrl,
      trayId: body.trayId ?? null,
      controllerUrl: body.controllerUrl ?? null,
      webhookUrl: body.webhookUrl ?? null,
      runtime: body.runtime ?? null,
      sliccVersion: body.sliccVersion ?? null,
      updatedAt: new Date().toISOString(),
    };
    await fs.writeFile(options.joinFilePath, JSON.stringify(payload, null, 2));
    res.json({ ok: true });
  });
}
```

In `packages/node-server/src/index.ts`, register the endpoint only when `--hosted`:

```typescript
import { registerCloudStatusEndpoint } from './cloud-status.js';

// G4: register BEFORE Chromium launches. The webapp's first action after
// `?runtime=hosted-leader` boot is to mint a tray and POST /api/cloud-status.
// If the route doesn't exist yet, the post 404s and the CLI poll times out.
// Concretely: this block goes after the Express app is constructed and all
// middleware is mounted, but BEFORE `launchChromium(...)` (or the equivalent
// boot step that triggers Chrome).
if (RUNTIME_FLAGS.hosted) {
  registerCloudStatusEndpoint(app, { joinFilePath: '/tmp/slicc-join.json' });
}
```

- [ ] **Step 4: Run test to verify it passes**

```
cd packages/node-server && npx vitest run tests/cloud-status.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/node-server/src/cloud-status.ts \
        packages/node-server/src/index.ts \
        packages/node-server/tests/cloud-status.test.ts
git commit -m "feat(node-server): /api/cloud-status writes join info to /tmp/slicc-join.json"
```

---

### Task 3.4: `/api/leader-restart` endpoint (hosted-only, CDP `Page.reload`)

**Files:**

- Create: `packages/node-server/src/leader-restart.ts`
- Modify: `packages/node-server/src/index.ts`
- Create: `packages/node-server/tests/leader-restart.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/node-server/tests/leader-restart.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { findSliccPageTarget, restartLeader } from '../src/leader-restart.js';

describe('findSliccPageTarget', () => {
  it('returns the page target whose URL starts with the local URL', () => {
    const targets = [
      { id: 'a', type: 'page', url: 'chrome://newtab/', attached: true },
      {
        id: 'b',
        type: 'page',
        url: 'http://localhost:5710/?runtime=hosted-leader',
        attached: true,
      },
      { id: 'c', type: 'background_page', url: 'http://localhost:5710/', attached: true },
    ];
    const t = findSliccPageTarget(targets, 'http://localhost:5710/');
    expect(t?.id).toBe('b');
  });

  it('returns null when no page target matches', () => {
    expect(findSliccPageTarget([], 'http://localhost:5710/')).toBeNull();
    expect(
      findSliccPageTarget(
        [{ id: 'a', type: 'page', url: 'chrome://newtab/', attached: true }],
        'http://localhost:5710/'
      )
    ).toBeNull();
  });

  it('prefers attached page targets when multiple match', () => {
    const targets = [
      { id: 'a', type: 'page', url: 'http://localhost:5710/x', attached: false },
      { id: 'b', type: 'page', url: 'http://localhost:5710/y', attached: true },
    ];
    expect(findSliccPageTarget(targets, 'http://localhost:5710/')?.id).toBe('b');
  });
});

describe('restartLeader', () => {
  it('calls CDP Page.reload against the SLICC page', async () => {
    const reloads: string[] = [];
    const fakeCdp = {
      send: vi.fn(async (method: string, _params: unknown, sessionId?: string) => {
        if (method === 'Target.getTargets') {
          return {
            targetInfos: [
              {
                targetId: 'tgt',
                type: 'page',
                url: 'http://localhost:5710/?runtime=hosted-leader',
                attached: true,
              },
            ],
          };
        }
        if (method === 'Target.attachToTarget') {
          return { sessionId: 'sess' };
        }
        if (method === 'Page.reload') {
          reloads.push(sessionId ?? 'none');
          return {};
        }
        return {};
      }),
    };
    const result = await restartLeader(fakeCdp, 'http://localhost:5710/');
    expect(result.ok).toBe(true);
    expect(reloads).toEqual(['sess']);
  });

  it('returns 503 NO_LEADER_TAB shape when no SLICC page exists', async () => {
    const fakeCdp = {
      send: vi.fn(async (method: string) => {
        if (method === 'Target.getTargets') return { targetInfos: [] };
        return {};
      }),
    };
    const result = await restartLeader(fakeCdp, 'http://localhost:5710/');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('NO_LEADER_TAB');
  });
});

describe('registerLeaderRestartEndpoint — localhost guard', () => {
  it('returns 403 for a non-loopback remoteAddress', async () => {
    // Same synthetic-request approach as the cloud-status 403 test.
    // requireLoopback is imported from cloud-status.ts and reused here, so
    // the assertion is symmetric.
    const { requireLoopback } = await import('../src/cloud-status.js');
    let statusCode = 0;
    let body: unknown = null;
    const req = { socket: { remoteAddress: '10.0.0.5' } } as never;
    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(payload: unknown) {
        body = payload;
        return this;
      },
    } as never;
    let nextCalled = false;
    requireLoopback(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(false);
    expect(statusCode).toBe(403);
    expect(body).toEqual({ error: 'localhost only' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd packages/node-server && npx vitest run tests/leader-restart.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement `leader-restart.ts`**

Create `packages/node-server/src/leader-restart.ts`:

```typescript
import express, { type Express } from 'express';

export interface CdpTargetInfo {
  id?: string;
  targetId?: string;
  type: string;
  url: string;
  attached: boolean;
}

export interface CdpLike {
  send(method: string, params?: unknown, sessionId?: string): Promise<unknown>;
}

export function findSliccPageTarget(
  targets: CdpTargetInfo[],
  localUrlPrefix: string
): CdpTargetInfo | null {
  const candidates = targets.filter((t) => t.type === 'page' && t.url.startsWith(localUrlPrefix));
  if (candidates.length === 0) return null;
  return candidates.find((t) => t.attached) ?? candidates[0];
}

export interface RestartResult {
  ok: boolean;
  code?: 'NO_LEADER_TAB' | 'CDP_NOT_READY' | 'INTERNAL';
  message?: string;
}

export async function restartLeader(cdp: CdpLike, localUrlPrefix: string): Promise<RestartResult> {
  let targets: CdpTargetInfo[];
  try {
    const result = (await cdp.send('Target.getTargets')) as { targetInfos: CdpTargetInfo[] };
    targets = result.targetInfos;
  } catch (err) {
    return { ok: false, code: 'CDP_NOT_READY', message: String(err) };
  }
  const target = findSliccPageTarget(targets, localUrlPrefix);
  if (!target) return { ok: false, code: 'NO_LEADER_TAB' };

  const tid = target.targetId ?? target.id;
  if (!tid) return { ok: false, code: 'INTERNAL', message: 'target missing id' };

  try {
    const { sessionId } = (await cdp.send('Target.attachToTarget', {
      targetId: tid,
      flatten: true,
    })) as { sessionId: string };
    await cdp.send('Page.reload', { ignoreCache: false }, sessionId);
    return { ok: true };
  } catch (err) {
    return { ok: false, code: 'INTERNAL', message: String(err) };
  }
}

import { requireLoopback } from './cloud-status.js';

export function registerLeaderRestartEndpoint(
  app: Express,
  options: { cdp: CdpLike; localUrlPrefix: string }
): void {
  app.post('/api/leader-restart', requireLoopback, async (_req, res) => {
    const result = await restartLeader(options.cdp, options.localUrlPrefix);
    if (result.ok) {
      res.json({ ok: true });
      return;
    }
    const status = result.code === 'NO_LEADER_TAB' || result.code === 'CDP_NOT_READY' ? 503 : 500;
    res.status(status).json({ error: result.code, message: result.message ?? null });
  });
}
```

**CDP wiring guidance.** node-server does not expose a reusable `cdpClient`; it talks to CDP via HTTP at `http://127.0.0.1:${cdpPort}/json` (see `findPageTarget` at `packages/node-server/src/index.ts:232` and `attachConsoleForwarder` at `~line 251` for the existing patterns). Implement `CdpLike` as a small wrapper inside `leader-restart.ts`:

```typescript
export function createHttpCdp(cdpPort: number): CdpLike {
  return {
    async send(method, _params, _sessionId) {
      if (method === 'Target.getTargets') {
        const res = await fetch(`http://127.0.0.1:${cdpPort}/json`);
        const list = (await res.json()) as Array<{
          id: string;
          type: string;
          url: string;
          webSocketDebuggerUrl?: string;
        }>;
        return {
          targetInfos: list.map((t) => ({
            id: t.id,
            type: t.type,
            url: t.url,
            attached: Boolean(t.webSocketDebuggerUrl),
          })),
        };
      }
      // Target.attachToTarget + Page.reload need a CDP WebSocket session.
      // Reuse the ws pattern from attachConsoleForwarder (~index.ts:251):
      // open ws to the target's webSocketDebuggerUrl, send the protocol
      // message with a request id, await the matching response.
      throw new Error(`createHttpCdp: ${method} not yet implemented`);
    },
  };
}
```

The full `Target.attachToTarget` + `Page.reload` over WebSocket is verbose but mechanical. Use the `ws` package (already a node-server dependency) and follow `attachConsoleForwarder`'s pattern. Keep the implementation in `leader-restart.ts` so `restartLeader`'s testability via the abstract `CdpLike` is preserved.

In `packages/node-server/src/index.ts`, register only when `--hosted`. Unlike `/api/cloud-status` (which must be live before Chromium boots), `/api/leader-restart` is only called by the CLI on resume — it's safe to register after `waitForCDP` resolves. Concretely: this block goes after `launchChromium(...)` and after `await waitForCDP(...)`:

```typescript
import { createHttpCdp, registerLeaderRestartEndpoint } from './leader-restart.js';

if (RUNTIME_FLAGS.hosted) {
  await waitForCDP(CDP_PORT, 40, 500);
  registerLeaderRestartEndpoint(app, {
    cdp: createHttpCdp(CDP_PORT),
    localUrlPrefix: `http://localhost:${SERVE_PORT}/`,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

```
cd packages/node-server && npx vitest run tests/leader-restart.test.ts
```

Expected: PASS — page-target resolution, `restartLeader` against a fake CDP, and the 403 loopback guard.

- [ ] **Step 5: Commit (CdpLike fake; ws transport lands in Task 3.4b)**

```bash
git add packages/node-server/src/leader-restart.ts \
        packages/node-server/src/index.ts \
        packages/node-server/tests/leader-restart.test.ts
git commit -m "feat(node-server): /api/leader-restart against CdpLike fake (ws transport pending)"
```

---

### Task 3.4b: `createHttpCdp` real WebSocket transport

Task 3.4 stops at the `CdpLike` fake. Phase 4's `slicc --cloud resume` dogfood depends on `/api/leader-restart` actually reloading the page in a real Chromium. This task lands the WebSocket implementation, with a roundtrip test against a real `ws` server that simulates a CDP target.

**Files:**

- Modify: `packages/node-server/src/leader-restart.ts`
- Modify: `packages/node-server/tests/leader-restart.test.ts`

- [ ] **Step 1: Write the failing roundtrip test**

Append to `packages/node-server/tests/leader-restart.test.ts`:

```typescript
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { createHttpCdp } from '../src/leader-restart.js';

describe('createHttpCdp — real WebSocket roundtrip', () => {
  it('attaches to a target and sends Page.reload', async () => {
    // Stand up a fake CDP target: HTTP /json returns a target descriptor;
    // a ws server accepts the connection and echoes Target.attachToTarget +
    // Page.reload responses by request id.
    const received: Array<{ id: number; method: string; params?: unknown; sessionId?: string }> =
      [];
    const httpServer = createServer((req, res) => {
      if (req.url === '/json') {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify([
            {
              id: 'page-1',
              type: 'page',
              url: 'http://localhost:5710/?runtime=hosted-leader',
              webSocketDebuggerUrl: `ws://127.0.0.1:${(httpServer.address() as { port: number }).port}/devtools/page/page-1`,
            },
          ])
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const port = (httpServer.address() as { port: number }).port;

    const wss = new WebSocketServer({ server: httpServer });
    wss.on('connection', (sock) => {
      sock.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as {
          id: number;
          method: string;
          params?: unknown;
          sessionId?: string;
        };
        received.push(msg);
        if (msg.method === 'Target.attachToTarget') {
          sock.send(JSON.stringify({ id: msg.id, result: { sessionId: 'sess-1' } }));
        } else if (msg.method === 'Page.reload') {
          sock.send(JSON.stringify({ id: msg.id, result: {} }));
        }
      });
    });

    try {
      const cdp = createHttpCdp(port);
      const result = await restartLeader(cdp, 'http://localhost:5710/');
      expect(result.ok).toBe(true);
      expect(received.map((m) => m.method)).toEqual(['Target.attachToTarget', 'Page.reload']);
      expect(received[1].sessionId).toBe('sess-1');
    } finally {
      wss.close();
      httpServer.close();
    }
  });

  it('returns CDP_NOT_READY when /json is unreachable', async () => {
    const cdp = createHttpCdp(/* port that nothing is listening on */ 1);
    const result = await restartLeader(cdp, 'http://localhost:5710/');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('CDP_NOT_READY');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd packages/node-server && npx vitest run tests/leader-restart.test.ts -t "real WebSocket roundtrip"
```

Expected: FAIL — current `createHttpCdp` throws for `Target.attachToTarget`.

- [ ] **Step 3: Implement the ws transport**

Replace the stub branch of `createHttpCdp` in `packages/node-server/src/leader-restart.ts`. Pattern lifted from `attachConsoleForwarder` at `packages/node-server/src/index.ts:251`:

```typescript
import { WebSocket } from 'ws';

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  constructor(private readonly socket: WebSocket) {
    socket.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
      };
      if (msg.id === undefined) return; // event, not a response
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    });
  }
  async send(method: string, params?: unknown, sessionId?: string): Promise<unknown> {
    const id = this.nextId++;
    const frame = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(frame, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }
  close(): void {
    this.socket.close();
  }
}

async function openCdpClient(webSocketDebuggerUrl: string): Promise<CdpClient> {
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', (err) => reject(err));
  });
  return new CdpClient(socket);
}

export function createHttpCdp(cdpPort: number): CdpLike {
  let cachedClient: CdpClient | null = null;
  let cachedWebSocketUrl: string | null = null;

  return {
    async send(method, params, sessionId) {
      if (method === 'Target.getTargets') {
        const res = await fetch(`http://127.0.0.1:${cdpPort}/json`);
        const list = (await res.json()) as Array<{
          id: string;
          type: string;
          url: string;
          webSocketDebuggerUrl?: string;
        }>;
        // Stash the first page's ws url for subsequent send() calls in
        // the same restartLeader cycle. Caller will issue
        // Target.attachToTarget → Page.reload right after.
        cachedWebSocketUrl =
          list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)?.webSocketDebuggerUrl ??
          null;
        return {
          targetInfos: list.map((t) => ({
            id: t.id,
            type: t.type,
            url: t.url,
            attached: Boolean(t.webSocketDebuggerUrl),
          })),
        };
      }
      if (!cachedClient) {
        if (!cachedWebSocketUrl)
          throw new Error('createHttpCdp: no ws url cached — call Target.getTargets first');
        cachedClient = await openCdpClient(cachedWebSocketUrl);
      }
      try {
        return await cachedClient.send(method, params, sessionId);
      } finally {
        if (method === 'Page.reload') {
          // Reload severs the session; drop the client so the next
          // restartLeader cycle re-opens.
          cachedClient.close();
          cachedClient = null;
          cachedWebSocketUrl = null;
        }
      }
    },
  };
}
```

- [ ] **Step 4: Run tests**

```
cd packages/node-server && npx vitest run tests/leader-restart.test.ts
```

Expected: PASS — fake-CDP unit tests, 403 guard, AND the real-WebSocket roundtrip.

- [ ] **Step 5: Commit**

```bash
git add packages/node-server/src/leader-restart.ts packages/node-server/tests/leader-restart.test.ts
git commit -m "feat(node-server): real CDP WebSocket transport for /api/leader-restart"
```

---

### Task 3.5: e2b template — Dockerfile, e2b.toml, start.sh

**Files:**

- Create: `packages/dev-tools/e2b-template/e2b.Dockerfile`
- Create: `packages/dev-tools/e2b-template/e2b.toml`
- Create: `packages/dev-tools/e2b-template/start.sh`
- Create: `packages/dev-tools/e2b-template/README.md`

- [ ] **Step 1: Verify the dist layout the template depends on**

```
npm run build && ls -la dist/node-server/index.js dist/ui/index.html
```

Expected: both files exist after a full root build.

- [ ] **Step 2: Create the Dockerfile**

`packages/dev-tools/e2b-template/e2b.Dockerfile`:

```dockerfile
FROM e2bdev/code-interpreter:latest

RUN apt-get update && apt-get install -y \
    chromium fonts-liberation libnss3 libatk-bridge2.0-0 \
    libgtk-3-0 libxss1 libasound2 \
 && rm -rf /var/lib/apt/lists/*
# NOTE: The Chromium apt package name varies by base image. On Debian-derived
# images it is usually `chromium`; on Ubuntu it has historically been
# `chromium-browser`. If `apt-get install chromium` fails at template build
# time, swap to `chromium-browser` (and add `apt list --installed | grep -i
# chrom` to verify the binary path is at `/usr/bin/chromium` or
# `/usr/bin/chromium-browser`, then update start.sh and chrome-launch.ts
# accordingly).

COPY dist/node-server  /opt/slicc/node-server
COPY dist/ui           /opt/slicc/ui
COPY packages/dev-tools/e2b-template/start.sh /usr/local/bin/slicc-start
RUN chmod +x /usr/local/bin/slicc-start

RUN mkdir -p /data/profile /slicc

ENV SLICC_HOSTED=1
ENV SLICC_SECRETS_FILE=/slicc/secrets.env
ENV CHROME_USER_DATA_DIR=/data/profile

EXPOSE 5710
```

- [ ] **Step 3: Create `e2b.toml`**

`packages/dev-tools/e2b-template/e2b.toml`:

```toml
template_name = "slicc"
cpu_count = 2
memory_mb = 2048
start_cmd = "slicc-start"
# team_id is set via the build script's e2b CLI invocation, not committed here.
```

- [ ] **Step 4: Create `start.sh`**

`packages/dev-tools/e2b-template/start.sh`:

```bash
#!/bin/sh
set -e

# Redirect node-server stderr to a known path so the CLI can surface it on
# create-failure timeouts.
exec /opt/slicc/node-server/index.js --hosted --port 5710 --no-open 2>/tmp/slicc-stderr.log
```

- [ ] **Step 5: Create `README.md`**

`packages/dev-tools/e2b-template/README.md`:

````markdown
# SLICC e2b template

Container image that runs `node-server --hosted` + headless Chromium + the
bundled webapp. Used by the `slicc --cloud` CLI.

## Build

Requires the e2b CLI authenticated to the right team:

```bash
# From the repo root, after `npm run build` has produced dist/node-server and dist/ui:
packages/dev-tools/e2b-template/scripts/build-template.sh
```
````

The script tags the published template with the SLICC version from the root
`package.json`.

## Verify

```bash
SLICC_TEST_E2B_API_KEY=... packages/dev-tools/e2b-template/scripts/verify-template.sh
```

Creates one sandbox, polls `/tmp/slicc-join.json`, kills the sandbox.

## Notes

- Not an npm workspace. Invoke the scripts directly.
- Chromium is pinned to the version in the base image's apt repositories at
  build time. Updating Chromium requires a template rebuild.
- The webapp + node-server binaries are copied from `dist/` produced by the
  monorepo's root `npm run build`. Always build before publishing the template.

````

- [ ] **Step 6: Commit**

```bash
git add packages/dev-tools/e2b-template
git commit -m "feat(e2b-template): Dockerfile, e2b.toml, start.sh, README"
````

---

### Task 3.6: Template build + verify scripts

**Files:**

- Create: `packages/dev-tools/e2b-template/scripts/build-template.sh`
- Create: `packages/dev-tools/e2b-template/scripts/verify-template.sh`

- [ ] **Step 1: Create `build-template.sh`**

`packages/dev-tools/e2b-template/scripts/build-template.sh`:

```bash
#!/bin/bash
set -euo pipefail

# Build the SLICC e2b template, tagging with the root package.json version.

ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./package.json').version")"

if [ ! -f dist/node-server/index.js ]; then
  echo "dist/node-server/index.js not found. Run 'npm run build' first." >&2
  exit 1
fi

if [ ! -f dist/ui/index.html ]; then
  echo "dist/ui/index.html not found. Run 'npm run build' first." >&2
  exit 1
fi

if ! command -v e2b >/dev/null 2>&1; then
  echo "e2b CLI not found. Install: npm i -g @e2b/cli" >&2
  exit 1
fi

cd packages/dev-tools/e2b-template

e2b template build \
  --name "slicc" \
  --dockerfile e2b.Dockerfile \
  --metadata "sliccVersion=$VERSION" \
  --root "$ROOT"

echo "Published template slicc (sliccVersion=$VERSION)"
```

- [ ] **Step 2: Create `verify-template.sh`**

`packages/dev-tools/e2b-template/scripts/verify-template.sh`:

```bash
#!/bin/bash
set -euo pipefail

if [ -z "${SLICC_TEST_E2B_API_KEY:-}" ]; then
  echo "SLICC_TEST_E2B_API_KEY env var required" >&2
  exit 1
fi

export E2B_API_KEY="$SLICC_TEST_E2B_API_KEY"

# Spin one sandbox, poll for /tmp/slicc-join.json, kill.
node --input-type=module -e '
import { Sandbox } from "e2b";

const sbx = await Sandbox.create("slicc", { autoPause: false });
console.log("created", sbx.sandboxId);

const start = Date.now();
let joinJson = null;
while (Date.now() - start < 60_000) {
  try {
    const text = await sbx.files.read("/tmp/slicc-join.json");
    joinJson = JSON.parse(text);
    if (joinJson.joinUrl) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 500));
}

await sbx.kill();
if (!joinJson?.joinUrl) {
  console.error("FAIL: /tmp/slicc-join.json never produced joinUrl");
  process.exit(1);
}
console.log("OK", joinJson.joinUrl);
'
```

- [ ] **Step 3: Make scripts executable + commit**

```bash
chmod +x packages/dev-tools/e2b-template/scripts/build-template.sh
chmod +x packages/dev-tools/e2b-template/scripts/verify-template.sh
git add packages/dev-tools/e2b-template/scripts
git commit -m "feat(e2b-template): build + verify scripts"
```

---

## Phase 4 — `--cloud` CLI surface

### Task 4.1: `SandboxSubstrate` interface + in-memory fake

**Files:**

- Create: `packages/node-server/src/cloud/substrate.ts`
- Create: `packages/node-server/tests/cloud/substrate.test.ts`
- Create: `packages/node-server/tests/cloud/fake-substrate.ts` (test helper)

- [ ] **Step 1: Define the interface**

Create `packages/node-server/src/cloud/substrate.ts`:

```typescript
// MVP recognizes only 'e2b'. Future substrates extend this union when they
// actually exist. Do not enumerate speculative values.
export type SubstrateId = 'e2b';

export interface SubstrateConfig {
  /** Credential for the substrate (e.g. E2B_API_KEY). */
  apiKey: string;
}

export interface CreateOpts {
  template: string;
  envVars: Record<string, string>;
  metadata: Record<string, string>;
  autoPauseOnCap: boolean;
  name?: string;
}

export interface SandboxInfo {
  sandboxId: string;
  state: 'running' | 'paused' | 'dead';
  metadata: Record<string, string>;
  createdAt: string;
}

export interface SandboxSummary {
  sandboxId: string;
  name?: string;
  state: 'running' | 'paused' | 'dead';
  metadata: Record<string, string>;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SandboxHandle {
  readonly sandboxId: string;
  readonly substrate: SubstrateId;
  pause(): Promise<void>;
  kill(): Promise<void>;
  getInfo(): Promise<SandboxInfo>;
  writeFile(path: string, contents: string | Uint8Array): Promise<void>;
  readFile(path: string): Promise<string>;
  run(cmd: string): Promise<RunResult>;
}

export interface SandboxSubstrate {
  readonly id: SubstrateId;
  create(opts: CreateOpts): Promise<SandboxHandle>;
  connect(sandboxId: string): Promise<SandboxHandle>;
  list(): Promise<SandboxSummary[]>;
}

export interface SubstrateFactory {
  (id: SubstrateId, cfg: SubstrateConfig): SandboxSubstrate;
}
```

- [ ] **Step 2: Build an in-memory fake for tests**

Create `packages/node-server/tests/cloud/fake-substrate.ts`:

```typescript
import type {
  SandboxSubstrate,
  SandboxHandle,
  CreateOpts,
  SandboxInfo,
  SandboxSummary,
  RunResult,
} from '../../src/cloud/substrate.js';

interface FakeSandboxData {
  id: string;
  state: 'running' | 'paused' | 'dead';
  metadata: Record<string, string>;
  files: Map<string, string>;
  name?: string;
  createdAt: string;
  runResponses: Array<RunResult | ((cmd: string) => RunResult)>;
}

export class FakeSubstrate implements SandboxSubstrate {
  readonly id = 'e2b' as const;
  readonly sandboxes = new Map<string, FakeSandboxData>();
  private nextId = 0;

  async create(opts: CreateOpts): Promise<SandboxHandle> {
    const id = `fake-${++this.nextId}`;
    const data: FakeSandboxData = {
      id,
      state: 'running',
      metadata: { ...opts.metadata },
      files: new Map(),
      name: opts.name,
      createdAt: new Date().toISOString(),
      runResponses: [],
    };
    this.sandboxes.set(id, data);
    return this.handle(data);
  }

  async connect(sandboxId: string): Promise<SandboxHandle> {
    const data = this.sandboxes.get(sandboxId);
    if (!data) throw new Error(`unknown sandbox ${sandboxId}`);
    if (data.state === 'paused') data.state = 'running';
    return this.handle(data);
  }

  async list(): Promise<SandboxSummary[]> {
    return Array.from(this.sandboxes.values()).map((d) => ({
      sandboxId: d.id,
      name: d.name,
      state: d.state,
      metadata: d.metadata,
    }));
  }

  /** Seed a file that will be readable via handle.readFile. */
  seedFile(sandboxId: string, path: string, contents: string): void {
    this.sandboxes.get(sandboxId)!.files.set(path, contents);
  }

  /** Queue a response for the next handle.run() call. */
  queueRun(sandboxId: string, response: RunResult | ((cmd: string) => RunResult)): void {
    this.sandboxes.get(sandboxId)!.runResponses.push(response);
  }

  private handle(data: FakeSandboxData): SandboxHandle {
    return {
      sandboxId: data.id,
      substrate: 'e2b',
      pause: async () => {
        data.state = 'paused';
      },
      kill: async () => {
        data.state = 'dead';
        this.sandboxes.delete(data.id);
      },
      getInfo: async (): Promise<SandboxInfo> => ({
        sandboxId: data.id,
        state: data.state,
        metadata: data.metadata,
        createdAt: data.createdAt,
      }),
      writeFile: async (path, contents) => {
        data.files.set(
          path,
          typeof contents === 'string' ? contents : new TextDecoder().decode(contents)
        );
      },
      readFile: async (path) => {
        const v = data.files.get(path);
        if (v === undefined) throw new Error(`ENOENT ${path}`);
        return v;
      },
      run: async (cmd) => {
        const next = data.runResponses.shift();
        if (!next) return { stdout: '', stderr: '', exitCode: 0 };
        return typeof next === 'function' ? next(cmd) : next;
      },
    };
  }
}
```

- [ ] **Step 3: Write a substrate-interface contract test**

Create `packages/node-server/tests/cloud/substrate.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { FakeSubstrate } from './fake-substrate.js';

describe('SandboxSubstrate contract (FakeSubstrate)', () => {
  it('create returns a handle whose sandboxId appears in list()', async () => {
    const sub = new FakeSubstrate();
    const handle = await sub.create({
      template: 'slicc',
      envVars: {},
      metadata: { sliccVersion: '3.2.2' },
      autoPauseOnCap: true,
    });
    expect(handle.sandboxId).toMatch(/^fake-/);
    const list = await sub.list();
    expect(list.map((s) => s.sandboxId)).toContain(handle.sandboxId);
  });

  it('writeFile then readFile round-trips', async () => {
    const sub = new FakeSubstrate();
    const handle = await sub.create({
      template: 'slicc',
      envVars: {},
      metadata: {},
      autoPauseOnCap: true,
    });
    await handle.writeFile('/slicc/secrets.env', 'KEY=value');
    expect(await handle.readFile('/slicc/secrets.env')).toBe('KEY=value');
  });

  it('pause then connect resumes the same sandbox', async () => {
    const sub = new FakeSubstrate();
    const handle = await sub.create({
      template: 'slicc',
      envVars: {},
      metadata: {},
      autoPauseOnCap: true,
    });
    await handle.pause();
    expect((await handle.getInfo()).state).toBe('paused');
    const resumed = await sub.connect(handle.sandboxId);
    expect((await resumed.getInfo()).state).toBe('running');
  });

  it('kill removes the sandbox from list()', async () => {
    const sub = new FakeSubstrate();
    const handle = await sub.create({
      template: 'slicc',
      envVars: {},
      metadata: {},
      autoPauseOnCap: true,
    });
    await handle.kill();
    const list = await sub.list();
    expect(list.map((s) => s.sandboxId)).not.toContain(handle.sandboxId);
  });
});
```

- [ ] **Step 4: Run and verify**

```
cd packages/node-server && npx vitest run tests/cloud/substrate.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/node-server/src/cloud/substrate.ts \
        packages/node-server/tests/cloud/substrate.test.ts \
        packages/node-server/tests/cloud/fake-substrate.ts
git commit -m "feat(node-server): SandboxSubstrate interface + in-memory test fake"
```

---

### Task 4.2: e2b substrate implementation

**Files:**

- Create: `packages/node-server/src/cloud/substrates/e2b.ts`
- Modify: `packages/node-server/package.json` (add e2b dependency)

- [ ] **Step 1: Add the e2b SDK dependency**

In `packages/node-server/package.json`:

```json
{
  "dependencies": {
    "@slicc/shared-ts": "*",
    "e2b": "^2.3.0"
  }
}
```

Then run from the repo root:

```bash
npm install
```

- [ ] **Step 2: Implement the e2b substrate**

Create `packages/node-server/src/cloud/substrates/e2b.ts`:

```typescript
import { Sandbox } from 'e2b';
import type {
  CreateOpts,
  RunResult,
  SandboxHandle,
  SandboxInfo,
  SandboxSubstrate,
  SandboxSummary,
  SubstrateConfig,
} from '../substrate.js';

export function createE2bSubstrate(cfg: SubstrateConfig): SandboxSubstrate {
  // The e2b SDK reads E2B_API_KEY from env by default; set it explicitly so the
  // CLI can run from a process with no other env mutation.
  process.env['E2B_API_KEY'] = cfg.apiKey;

  return {
    id: 'e2b',
    async create(opts: CreateOpts): Promise<SandboxHandle> {
      const sbx = await Sandbox.create(opts.template, {
        autoPause: opts.autoPauseOnCap,
        envs: opts.envVars,
        metadata: opts.metadata,
      });
      return wrap(sbx);
    },
    async connect(sandboxId: string): Promise<SandboxHandle> {
      const sbx = await Sandbox.connect(sandboxId);
      return wrap(sbx);
    },
    async list(): Promise<SandboxSummary[]> {
      // The e2b SDK's list() shape is not yet pinned in this spec; we filter
      // to sandboxes whose template name is 'slicc'. If the SDK lacks a
      // server-side template filter, the CLI's --cloud list path supplements
      // with a per-entry getInfo() call against the local registry.
      const items = await Sandbox.list();
      return items
        .filter((s) => (s.templateId ?? s.template) === 'slicc')
        .map((s) => ({
          sandboxId: s.sandboxId,
          name: s.metadata?.name as string | undefined,
          state: mapState(s.state),
          metadata: (s.metadata as Record<string, string>) ?? {},
        }));
    },
  };
}

function wrap(sbx: Sandbox): SandboxHandle {
  return {
    sandboxId: sbx.sandboxId,
    substrate: 'e2b',
    async pause(): Promise<void> {
      await sbx.pause();
    },
    async kill(): Promise<void> {
      await sbx.kill();
    },
    async getInfo(): Promise<SandboxInfo> {
      const info = await sbx.getInfo();
      return {
        sandboxId: sbx.sandboxId,
        state: mapState(info.state),
        metadata: (info.metadata as Record<string, string>) ?? {},
        createdAt: info.createdAt ?? new Date().toISOString(),
      };
    },
    async writeFile(path, contents): Promise<void> {
      await sbx.files.write(path, contents);
    },
    async readFile(path): Promise<string> {
      return sbx.files.read(path);
    },
    async run(cmd): Promise<RunResult> {
      const result = await sbx.commands.run(cmd);
      return {
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        exitCode: result.exitCode ?? 0,
      };
    },
  };
}

function mapState(s: unknown): 'running' | 'paused' | 'dead' {
  if (s === 'running' || s === 'paused' || s === 'dead') return s;
  // Conservative default for any state we don't recognize.
  return 'dead';
}
```

If the e2b SDK shape differs (field names, list signature, getInfo return shape), patch `wrap()` and `createE2bSubstrate.list()` to match — but keep the `SandboxSubstrate` interface intact.

- [ ] **Step 3: Add a substrate factory**

Append to `packages/node-server/src/cloud/substrate.ts`:

```typescript
import { createE2bSubstrate } from './substrates/e2b.js';

export const createSubstrate: SubstrateFactory = (id, cfg) => {
  if (id === 'e2b') return createE2bSubstrate(cfg);
  // SubstrateId is currently the literal 'e2b'; this is unreachable today.
  throw new Error(`unknown substrate: ${id}`);
};
```

- [ ] **Step 4: Typecheck + commit**

```
cd packages/node-server && npm run typecheck
```

Expected: clean.

```bash
git add packages/node-server/package.json \
        packages/node-server/src/cloud/substrate.ts \
        packages/node-server/src/cloud/substrates/e2b.ts \
        package-lock.json
git commit -m "feat(node-server): e2b substrate implementation"
```

---

### Task 4.3: `registry.ts` — `~/.slicc/cloud-sessions.json` I/O

**Files:**

- Create: `packages/node-server/src/cloud/registry.ts`
- Create: `packages/node-server/tests/cloud/registry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/node-server/tests/cloud/registry.test.ts`:

```typescript
import { describe, expect, it, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CloudSessionRegistry } from '../../src/cloud/registry.js';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slicc-reg-'));
  file = path.join(dir, 'cloud-sessions.json');
});

describe('CloudSessionRegistry', () => {
  it('returns an empty list when the file is missing', async () => {
    const reg = new CloudSessionRegistry(file);
    expect(await reg.list()).toEqual([]);
  });

  it('appends, lists, and removes entries with stable ordering', async () => {
    const reg = new CloudSessionRegistry(file);
    await reg.append({
      substrate: 'e2b',
      sandboxId: 'a',
      name: 'one',
      createdAt: '2026-05-22T00:00:00Z',
      joinUrl: 'https://w/join/aa',
      lastSeen: '2026-05-22T00:00:00Z',
      state: 'running',
    });
    await reg.append({
      substrate: 'e2b',
      sandboxId: 'b',
      name: 'two',
      createdAt: '2026-05-22T00:01:00Z',
      joinUrl: 'https://w/join/bb',
      lastSeen: '2026-05-22T00:01:00Z',
      state: 'running',
    });

    expect((await reg.list()).map((s) => s.sandboxId)).toEqual(['a', 'b']);

    await reg.remove('a');
    expect((await reg.list()).map((s) => s.sandboxId)).toEqual(['b']);
  });

  it('update merges fields by sandboxId', async () => {
    const reg = new CloudSessionRegistry(file);
    await reg.append({
      substrate: 'e2b',
      sandboxId: 'a',
      name: 'one',
      createdAt: '2026-05-22T00:00:00Z',
      joinUrl: 'https://w/join/old',
      lastSeen: '2026-05-22T00:00:00Z',
      state: 'running',
    });
    await reg.update('a', { joinUrl: 'https://w/join/new', state: 'paused' });
    const entry = (await reg.list()).find((s) => s.sandboxId === 'a');
    expect(entry?.joinUrl).toBe('https://w/join/new');
    expect(entry?.state).toBe('paused');
  });

  it('findByNameOrId resolves both name and sandboxId', async () => {
    const reg = new CloudSessionRegistry(file);
    await reg.append({
      substrate: 'e2b',
      sandboxId: 'sb-abc',
      name: 'task-1',
      createdAt: '2026-05-22T00:00:00Z',
      joinUrl: 'https://w/join/x',
      lastSeen: '2026-05-22T00:00:00Z',
      state: 'running',
    });
    expect((await reg.findByNameOrId('task-1'))?.sandboxId).toBe('sb-abc');
    expect((await reg.findByNameOrId('sb-abc'))?.sandboxId).toBe('sb-abc');
    expect(await reg.findByNameOrId('nope')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd packages/node-server && npx vitest run tests/cloud/registry.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `registry.ts`**

Create `packages/node-server/src/cloud/registry.ts`:

```typescript
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SubstrateId } from './substrate.js';

export interface CloudSessionEntry {
  substrate: SubstrateId;
  sandboxId: string;
  name?: string;
  createdAt: string;
  joinUrl: string;
  /** `Date.now()`-style timestamp of the last `--cloud` interaction with this entry. */
  lastSeen: string;
  state: 'running' | 'paused' | 'dead';
  /**
   * Last-known tray identity from `/tmp/slicc-join.json`. Set by `runStart`
   * after the initial cloud-status read; preserved by `runPause` (do NOT
   * overwrite this on pause — it is the comparison baseline that lets
   * `runResume` detect tray rebuilds). `runResume` overwrites it after a
   * successful refresh.
   */
  trayId?: string;
  /**
   * `updatedAt` from the last successful `/tmp/slicc-join.json` read.
   * `runResume` polls for an `updatedAt` strictly newer than this value, so
   * resume only declares success after the kick produced a fresh refresh.
   * Preserved across `runPause` for the same reason as `trayId`.
   */
  lastJoinUpdatedAt?: string;
}

interface RegistryFile {
  sessions: CloudSessionEntry[];
}

export class CloudSessionRegistry {
  constructor(private readonly filePath: string) {}

  static defaultPath(): string {
    const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '.';
    return path.join(home, '.slicc', 'cloud-sessions.json');
  }

  async list(): Promise<CloudSessionEntry[]> {
    const data = await this.read();
    return data.sessions;
  }

  async append(entry: CloudSessionEntry): Promise<void> {
    const data = await this.read();
    data.sessions = data.sessions.filter((s) => s.sandboxId !== entry.sandboxId);
    data.sessions.push(entry);
    await this.write(data);
  }

  async update(sandboxId: string, patch: Partial<CloudSessionEntry>): Promise<void> {
    const data = await this.read();
    const idx = data.sessions.findIndex((s) => s.sandboxId === sandboxId);
    if (idx === -1) return;
    data.sessions[idx] = { ...data.sessions[idx], ...patch, sandboxId };
    await this.write(data);
  }

  async remove(sandboxId: string): Promise<void> {
    const data = await this.read();
    data.sessions = data.sessions.filter((s) => s.sandboxId !== sandboxId);
    await this.write(data);
  }

  async findByNameOrId(query: string): Promise<CloudSessionEntry | null> {
    const data = await this.read();
    return (
      data.sessions.find((s) => s.sandboxId === query) ??
      data.sessions.find((s) => s.name === query) ??
      null
    );
  }

  private async read(): Promise<RegistryFile> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as RegistryFile;
      if (!parsed.sessions || !Array.isArray(parsed.sessions)) return { sessions: [] };
      return parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { sessions: [] };
      throw err;
    }
  }

  private async write(data: RegistryFile): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(data, null, 2));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```
cd packages/node-server && npx vitest run tests/cloud/registry.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/node-server/src/cloud/registry.ts packages/node-server/tests/cloud/registry.test.ts
git commit -m "feat(node-server): CloudSessionRegistry for ~/.slicc/cloud-sessions.json"
```

---

### Task 4.4: `slicc --cloud start` subcommand

**Files:**

- Create: `packages/node-server/src/cloud/start.ts`
- Create: `packages/node-server/tests/cloud/start.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/node-server/tests/cloud/start.test.ts`:

```typescript
import { describe, expect, it, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runStart } from '../../src/cloud/start.js';
import { CloudSessionRegistry } from '../../src/cloud/registry.js';
import { FakeSubstrate } from './fake-substrate.js';

let dir: string;
let envFile: string;
let registryPath: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slicc-start-'));
  envFile = path.join(dir, 'secrets.env');
  await fs.writeFile(
    envFile,
    [
      'ANTHROPIC_API_KEY=sk-test',
      'ANTHROPIC_API_KEY_DOMAINS=api.anthropic.com',
      // E2B creds intentionally in the source file — runStart must strip them
      // before upload (G1: do not leak substrate creds into the cloud).
      'E2B_API_KEY=e2b-secret',
      'E2B_API_KEY_DOMAINS=e2b.dev',
    ].join('\n') + '\n'
  );
  registryPath = path.join(dir, 'cloud-sessions.json');
});

describe('slicc --cloud start', () => {
  it('creates a sandbox, uploads secrets.env, polls cloud-status, registers entry', async () => {
    const substrate = new FakeSubstrate();

    // Seed the file the CLI will poll for AFTER create completes.
    // The fake substrate would need the join file written by the webapp
    // inside the sandbox; here we simulate by pre-seeding via a create hook.
    const result = await runStart({
      substrate,
      envFilePath: envFile,
      registryPath,
      name: 'task-1',
      sliccVersion: '3.2.2',
      workerBaseUrl: 'https://www.sliccy.ai',
      pollTimeoutMs: 5_000,
      pollIntervalMs: 10,
      onAfterCreate: async (handle) => {
        // Simulate the webapp inside the sandbox having posted /api/cloud-status.
        await handle.writeFile(
          '/tmp/slicc-join.json',
          JSON.stringify({
            joinUrl: 'https://www.sliccy.ai/join/tok',
            trayId: 't1',
            controllerUrl: 'wss://w/controller/c',
            webhookUrl: 'https://w/webhook/wb/wid',
            runtime: 'slicc-hosted-leader',
            sliccVersion: '3.2.2',
            updatedAt: new Date().toISOString(),
          })
        );
      },
    });

    expect(result.joinUrl).toBe('https://www.sliccy.ai/join/tok');
    expect(result.sandboxId).toMatch(/^fake-/);
    expect(result.name).toBe('task-1');

    const sandboxes = await substrate.list();
    expect(sandboxes).toHaveLength(1);

    const handle = await substrate.connect(result.sandboxId);
    const uploaded = await handle.readFile('/slicc/secrets.env');
    expect(uploaded).toContain('ANTHROPIC_API_KEY=sk-test');
    // G1: E2B credentials must NOT be uploaded to the cloud sandbox.
    expect(uploaded).not.toContain('E2B_API_KEY=');
    expect(uploaded).not.toContain('E2B_API_KEY_DOMAINS=');

    const reg = new CloudSessionRegistry(registryPath);
    const entries = await reg.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      substrate: 'e2b',
      sandboxId: result.sandboxId,
      name: 'task-1',
      joinUrl: 'https://www.sliccy.ai/join/tok',
      state: 'running',
    });
  });

  it('kills the sandbox and includes stderr-tail in the error when cloud-status never appears', async () => {
    const substrate = new FakeSubstrate();

    // G2: on poll timeout, runStart should fetch /tmp/slicc-stderr.log and
    // include its tail in the surfaced error. Seed the file via onAfterCreate.
    const start = runStart({
      substrate,
      envFilePath: envFile,
      registryPath,
      sliccVersion: '3.2.2',
      workerBaseUrl: 'https://www.sliccy.ai',
      pollTimeoutMs: 200,
      pollIntervalMs: 10,
      onAfterCreate: async (handle) => {
        await handle.writeFile(
          '/tmp/slicc-stderr.log',
          'Error: Failed to launch Chromium\n  cause: missing libnss3\n'
        );
        // Intentionally do NOT write /tmp/slicc-join.json — force the poll
        // to time out.
      },
    });

    await expect(start).rejects.toThrow(/missing libnss3/);
    expect(await substrate.list()).toHaveLength(0);
  });

  it('falls back gracefully when /tmp/slicc-stderr.log is absent', async () => {
    const substrate = new FakeSubstrate();
    const start = runStart({
      substrate,
      envFilePath: envFile,
      registryPath,
      sliccVersion: '3.2.2',
      workerBaseUrl: 'https://www.sliccy.ai',
      pollTimeoutMs: 200,
      pollIntervalMs: 10,
      // No onAfterCreate; no stderr file, no join file.
    });
    await expect(start).rejects.toThrow(/no \/tmp\/slicc-stderr\.log produced/);
    expect(await substrate.list()).toHaveLength(0);
  });

  it('throws if env file is unreadable', async () => {
    const substrate = new FakeSubstrate();
    await expect(
      runStart({
        substrate,
        envFilePath: '/nonexistent/path/secrets.env',
        registryPath,
        sliccVersion: '3.2.2',
        workerBaseUrl: 'https://www.sliccy.ai',
        pollTimeoutMs: 100,
        pollIntervalMs: 10,
      })
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd packages/node-server && npx vitest run tests/cloud/start.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement `start.ts`**

Create `packages/node-server/src/cloud/start.ts`:

```typescript
import { promises as fs } from 'node:fs';
import { CloudSessionRegistry, type CloudSessionEntry } from './registry.js';
import type { SandboxHandle, SandboxSubstrate } from './substrate.js';

export interface RunStartOpts {
  substrate: SandboxSubstrate;
  envFilePath: string;
  registryPath: string;
  workerBaseUrl: string;
  sliccVersion: string;
  template?: string;
  name?: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  /** Test-only hook: invoked after substrate.create returns. */
  onAfterCreate?: (handle: SandboxHandle) => Promise<void>;
}

export interface StartResult {
  sandboxId: string;
  joinUrl: string;
  name?: string;
}

/**
 * Strip locally-only keys from secrets.env before upload. `E2B_API_KEY` is
 * the user's substrate credential — there is no reason for it to live inside
 * the cloud sandbox where the cone could use it to spawn additional
 * sandboxes against the user's e2b account. Keep this list narrow.
 */
const SECRETS_STRIP_KEYS = ['E2B_API_KEY', 'E2B_API_KEY_DOMAINS'] as const;

export function filterSecretsEnv(contents: string): string {
  const out: string[] = [];
  for (const line of contents.split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m && (SECRETS_STRIP_KEYS as readonly string[]).includes(m[1])) continue;
    out.push(line);
  }
  return out.join('\n');
}

/** Fetch the last `n` lines of /tmp/slicc-stderr.log from inside the sandbox. */
async function tailStderr(handle: SandboxHandle, n: number): Promise<string> {
  try {
    const raw = await handle.readFile('/tmp/slicc-stderr.log');
    const lines = raw.split('\n');
    return lines.slice(Math.max(0, lines.length - n)).join('\n');
  } catch {
    return '(no /tmp/slicc-stderr.log produced)';
  }
}

export async function runStart(opts: RunStartOpts): Promise<StartResult> {
  const rawEnv = await fs.readFile(opts.envFilePath, 'utf-8');
  const envContents = filterSecretsEnv(rawEnv);

  const handle = await opts.substrate.create({
    template: opts.template ?? 'slicc',
    autoPauseOnCap: true,
    envVars: {
      SLICC_TRAY_WORKER_BASE_URL: opts.workerBaseUrl,
    },
    metadata: {
      sliccVersion: opts.sliccVersion,
      createdBy: process.env['USER'] ?? 'unknown',
      ...(opts.name ? { name: opts.name } : {}),
    },
    name: opts.name,
  });

  try {
    await handle.writeFile('/slicc/secrets.env', envContents);

    if (opts.onAfterCreate) await opts.onAfterCreate(handle);

    let status: CloudStatusPayload;
    try {
      status = await pollCloudStatus(handle, {
        timeoutMs: opts.pollTimeoutMs ?? 60_000,
        intervalMs: opts.pollIntervalMs ?? 500,
      });
    } catch (pollErr) {
      // Surface boot diagnostics before tearing down. Spec failure mode #7.
      const stderr = await tailStderr(handle, 50);
      throw new Error(
        `${pollErr instanceof Error ? pollErr.message : String(pollErr)}\n` +
          `--- last 50 lines of /tmp/slicc-stderr.log ---\n${stderr}`
      );
    }

    const reg = new CloudSessionRegistry(opts.registryPath);
    const nowIso = new Date().toISOString();
    const entry: CloudSessionEntry = {
      substrate: opts.substrate.id,
      sandboxId: handle.sandboxId,
      name: opts.name,
      createdAt: nowIso,
      joinUrl: status.joinUrl,
      lastSeen: nowIso,
      state: 'running',
      // These two are the comparison baseline for `runResume`. Set them at
      // start so resume can detect (a) a stale read after the kick (via
      // updatedAt strictly newer than this) and (b) a tray rebuild (via
      // trayId mismatch).
      trayId: status.trayId,
      lastJoinUpdatedAt: status.updatedAt,
    };
    await reg.append(entry);

    return { sandboxId: handle.sandboxId, joinUrl: status.joinUrl, name: opts.name };
  } catch (err) {
    // Best-effort cleanup; ignore errors during teardown.
    try {
      await handle.kill();
    } catch {
      /* swallow */
    }
    throw err;
  }
}

interface CloudStatusPayload {
  joinUrl: string;
  trayId?: string;
  updatedAt?: string;
}

async function pollCloudStatus(
  handle: SandboxHandle,
  opts: { timeoutMs: number; intervalMs: number }
): Promise<CloudStatusPayload> {
  const start = Date.now();
  while (Date.now() - start < opts.timeoutMs) {
    try {
      const raw = await handle.readFile('/tmp/slicc-join.json');
      const parsed = JSON.parse(raw) as CloudStatusPayload;
      if (parsed.joinUrl) return parsed;
    } catch {
      // file not yet present
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
  throw new Error(
    `cloud-status did not appear within ${opts.timeoutMs}ms; sandbox may have failed to boot`
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

```
cd packages/node-server && npx vitest run tests/cloud/start.test.ts
```

Expected: PASS for all three cases.

- [ ] **Step 5: Commit**

```bash
git add packages/node-server/src/cloud/start.ts packages/node-server/tests/cloud/start.test.ts
git commit -m "feat(node-server): slicc --cloud start"
```

---

### Task 4.5: `slicc --cloud list`

**Files:**

- Create: `packages/node-server/src/cloud/list.ts`
- Create: `packages/node-server/tests/cloud/list.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/node-server/tests/cloud/list.test.ts`:

```typescript
import { describe, expect, it, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runList } from '../../src/cloud/list.js';
import { CloudSessionRegistry } from '../../src/cloud/registry.js';
import { FakeSubstrate } from './fake-substrate.js';

let dir: string;
let registryPath: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slicc-list-'));
  registryPath = path.join(dir, 'cloud-sessions.json');
});

describe('slicc --cloud list', () => {
  it('returns an empty list when no sessions registered', async () => {
    const result = await runList({
      substrate: new FakeSubstrate(),
      registryPath,
    });
    expect(result).toEqual([]);
  });

  it('enriches each registry entry with live state from the substrate', async () => {
    const sub = new FakeSubstrate();
    const handleA = await sub.create({
      template: 'slicc',
      envVars: {},
      metadata: {},
      autoPauseOnCap: true,
      name: 'task-1',
    });
    const handleB = await sub.create({
      template: 'slicc',
      envVars: {},
      metadata: {},
      autoPauseOnCap: true,
      name: 'task-2',
    });
    await handleB.pause();

    const reg = new CloudSessionRegistry(registryPath);
    for (const h of [handleA, handleB]) {
      await reg.append({
        substrate: 'e2b',
        sandboxId: h.sandboxId,
        name: (await h.getInfo()).metadata.name as string | undefined,
        createdAt: new Date().toISOString(),
        joinUrl: `https://w/join/${h.sandboxId}`,
        lastSeen: new Date().toISOString(),
        state: 'running', // stale; live state should override
      });
    }

    const result = await runList({ substrate: sub, registryPath });
    const a = result.find((s) => s.sandboxId === handleA.sandboxId);
    const b = result.find((s) => s.sandboxId === handleB.sandboxId);
    expect(a?.state).toBe('running');
    expect(b?.state).toBe('paused');
  });

  it('marks an entry as dead when the substrate no longer knows about it', async () => {
    const sub = new FakeSubstrate();
    const reg = new CloudSessionRegistry(registryPath);
    await reg.append({
      substrate: 'e2b',
      sandboxId: 'stale-id',
      name: 'gone',
      createdAt: new Date().toISOString(),
      joinUrl: 'https://w/join/g',
      lastSeen: new Date().toISOString(),
      state: 'running',
    });
    const result = await runList({ substrate: sub, registryPath });
    expect(result[0].state).toBe('dead');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd packages/node-server && npx vitest run tests/cloud/list.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `list.ts`**

Create `packages/node-server/src/cloud/list.ts`:

```typescript
import { CloudSessionRegistry, type CloudSessionEntry } from './registry.js';
import type { SandboxSubstrate } from './substrate.js';

export interface RunListOpts {
  substrate: SandboxSubstrate;
  registryPath: string;
}

export async function runList(opts: RunListOpts): Promise<CloudSessionEntry[]> {
  const reg = new CloudSessionRegistry(opts.registryPath);
  const entries = await reg.list();
  if (entries.length === 0) return [];

  const live = await opts.substrate.list();
  const liveById = new Map(live.map((s) => [s.sandboxId, s] as const));

  return entries.map((e) => {
    const liveEntry = liveById.get(e.sandboxId);
    if (!liveEntry) return { ...e, state: 'dead' as const };
    return { ...e, state: liveEntry.state };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

```
cd packages/node-server && npx vitest run tests/cloud/list.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/node-server/src/cloud/list.ts packages/node-server/tests/cloud/list.test.ts
git commit -m "feat(node-server): slicc --cloud list"
```

---

### Task 4.6: `slicc --cloud pause`

**Files:**

- Create: `packages/node-server/src/cloud/pause.ts`
- Create: `packages/node-server/tests/cloud/pause.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/node-server/tests/cloud/pause.test.ts`:

```typescript
import { describe, expect, it, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runPause } from '../../src/cloud/pause.js';
import { CloudSessionRegistry } from '../../src/cloud/registry.js';
import { FakeSubstrate } from './fake-substrate.js';

let dir: string;
let registryPath: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slicc-pause-'));
  registryPath = path.join(dir, 'cloud-sessions.json');
});

describe('slicc --cloud pause', () => {
  it('pauses the sandbox and updates registry state', async () => {
    const sub = new FakeSubstrate();
    const h = await sub.create({
      template: 'slicc',
      envVars: {},
      metadata: {},
      autoPauseOnCap: true,
      name: 'task-1',
    });
    const reg = new CloudSessionRegistry(registryPath);
    await reg.append({
      substrate: 'e2b',
      sandboxId: h.sandboxId,
      name: 'task-1',
      createdAt: new Date().toISOString(),
      joinUrl: 'https://w/j',
      lastSeen: new Date().toISOString(),
      state: 'running',
    });

    await runPause({ substrate: sub, registryPath, query: 'task-1' });

    expect((await sub.connect(h.sandboxId)).sandboxId).toBe(h.sandboxId);
    expect((await sub.list())[0].state).toBe('paused');
    expect((await reg.list())[0].state).toBe('paused');
  });

  it('throws when the query matches no registry entry', async () => {
    await expect(
      runPause({ substrate: new FakeSubstrate(), registryPath, query: 'nope' })
    ).rejects.toThrow(/not found/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd packages/node-server && npx vitest run tests/cloud/pause.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `pause.ts`**

Create `packages/node-server/src/cloud/pause.ts`:

```typescript
import { CloudSessionRegistry } from './registry.js';
import type { SandboxSubstrate } from './substrate.js';

export interface RunPauseOpts {
  substrate: SandboxSubstrate;
  registryPath: string;
  query: string;
}

export async function runPause(opts: RunPauseOpts): Promise<void> {
  const reg = new CloudSessionRegistry(opts.registryPath);
  const entry = await reg.findByNameOrId(opts.query);
  if (!entry) throw new Error(`cloud session not found: ${opts.query}`);

  const handle = await opts.substrate.connect(entry.sandboxId);
  await handle.pause();
  // Update ONLY state + lastSeen. trayId and lastJoinUpdatedAt are baseline
  // values for the next resume — preserving them is load-bearing.
  await reg.update(entry.sandboxId, { state: 'paused', lastSeen: new Date().toISOString() });
}
```

- [ ] **Step 4: Run test to verify it passes**

```
cd packages/node-server && npx vitest run tests/cloud/pause.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/node-server/src/cloud/pause.ts packages/node-server/tests/cloud/pause.test.ts
git commit -m "feat(node-server): slicc --cloud pause"
```

---

### Task 4.7: `slicc --cloud resume`

**Files:**

- Create: `packages/node-server/src/cloud/resume.ts`
- Create: `packages/node-server/tests/cloud/resume.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/node-server/tests/cloud/resume.test.ts`:

```typescript
import { describe, expect, it, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runResume } from '../../src/cloud/resume.js';
import { CloudSessionRegistry } from '../../src/cloud/registry.js';
import { FakeSubstrate } from './fake-substrate.js';

let dir: string;
let registryPath: string;

const oldJoin = JSON.stringify({
  joinUrl: 'https://w/join/old',
  trayId: 'tray-old',
  runtime: 'slicc-hosted-leader',
  sliccVersion: '3.2.2',
  updatedAt: '2026-05-22T00:00:00Z',
});

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slicc-resume-'));
  registryPath = path.join(dir, 'cloud-sessions.json');
});

describe('slicc --cloud resume', () => {
  it('connects, kicks leader-restart, and returns the refreshed joinUrl', async () => {
    const sub = new FakeSubstrate();
    const h = await sub.create({
      template: 'slicc',
      envVars: {},
      metadata: { sliccVersion: '3.2.2' },
      autoPauseOnCap: true,
    });
    await h.pause();
    sub.seedFile(h.sandboxId, '/tmp/slicc-join.json', oldJoin);

    const reg = new CloudSessionRegistry(registryPath);
    await reg.append({
      substrate: 'e2b',
      sandboxId: h.sandboxId,
      name: 'task-1',
      createdAt: '2026-05-22T00:00:00Z',
      joinUrl: 'https://w/join/old',
      lastSeen: '2026-05-22T00:00:00Z',
      state: 'paused',
      // Baseline that runResume compares against — matches the oldJoin file
      // seeded above. Without these, the poll would accept the first read
      // (the stale pre-kick file) and resume would falsely report success.
      trayId: 'tray-old',
      lastJoinUpdatedAt: '2026-05-22T00:00:00Z',
    });

    // Queue the response the curl/leader-restart call will produce, then a
    // refreshed join file with a newer updatedAt.
    sub.queueRun(h.sandboxId, (cmd) => {
      if (cmd.includes('leader-restart')) {
        // Simulate the webapp's onLeaderReady firing again with a refreshed updatedAt.
        sub.seedFile(
          h.sandboxId,
          '/tmp/slicc-join.json',
          JSON.stringify({
            joinUrl: 'https://w/join/new',
            trayId: 'tray-old',
            runtime: 'slicc-hosted-leader',
            sliccVersion: '3.2.2',
            updatedAt: '2026-05-22T01:00:00Z',
          })
        );
      }
      return { stdout: '200', stderr: '', exitCode: 0 };
    });

    const result = await runResume({
      substrate: sub,
      registryPath,
      query: 'task-1',
      localSliccVersion: '3.2.2',
      pollIntervalMs: 5,
      pollTimeoutMs: 1000,
    });

    expect(result.joinUrl).toBe('https://w/join/new');
    expect(result.trayRebuilt).toBe(false);
    const updated = (await reg.list())[0];
    expect(updated.state).toBe('running');
    expect(updated.joinUrl).toBe('https://w/join/new');
    // Baseline gets advanced on success — next resume will compare against
    // these values.
    expect(updated.trayId).toBe('tray-old');
    expect(updated.lastJoinUpdatedAt).toBe('2026-05-22T01:00:00Z');
  });

  it('detects tray rebuild when trayId changes', async () => {
    const sub = new FakeSubstrate();
    const h = await sub.create({
      template: 'slicc',
      envVars: {},
      metadata: { sliccVersion: '3.2.2' },
      autoPauseOnCap: true,
    });
    sub.seedFile(h.sandboxId, '/tmp/slicc-join.json', oldJoin);

    const reg = new CloudSessionRegistry(registryPath);
    await reg.append({
      substrate: 'e2b',
      sandboxId: h.sandboxId,
      name: 'task-1',
      createdAt: '2026-05-22T00:00:00Z',
      joinUrl: 'https://w/join/old',
      lastSeen: '2026-05-22T00:00:00Z',
      state: 'paused',
      // Baseline that runResume compares against — matches the oldJoin file
      // seeded above. Without these, the poll would accept the first read
      // (the stale pre-kick file) and resume would falsely report success.
      trayId: 'tray-old',
      lastJoinUpdatedAt: '2026-05-22T00:00:00Z',
    });

    sub.queueRun(h.sandboxId, () => {
      sub.seedFile(
        h.sandboxId,
        '/tmp/slicc-join.json',
        JSON.stringify({
          joinUrl: 'https://w/join/rebuilt',
          trayId: 'tray-new', // ← changed
          runtime: 'slicc-hosted-leader',
          sliccVersion: '3.2.2',
          updatedAt: '2026-05-22T01:00:00Z',
        })
      );
      return { stdout: '200', stderr: '', exitCode: 0 };
    });

    const result = await runResume({
      substrate: sub,
      registryPath,
      query: 'task-1',
      localSliccVersion: '3.2.2',
      pollIntervalMs: 5,
      pollTimeoutMs: 1000,
    });

    expect(result.joinUrl).toBe('https://w/join/rebuilt');
    expect(result.trayRebuilt).toBe(true);
  });

  it('returns a versionMismatch warning when the running version differs from local', async () => {
    const sub = new FakeSubstrate();
    const h = await sub.create({
      template: 'slicc',
      envVars: {},
      metadata: { sliccVersion: '3.2.0' },
      autoPauseOnCap: true,
    });
    sub.seedFile(h.sandboxId, '/tmp/slicc-join.json', oldJoin);

    const reg = new CloudSessionRegistry(registryPath);
    await reg.append({
      substrate: 'e2b',
      sandboxId: h.sandboxId,
      name: 'task-1',
      createdAt: '2026-05-22T00:00:00Z',
      joinUrl: 'https://w/join/old',
      lastSeen: '2026-05-22T00:00:00Z',
      state: 'paused',
      // Baseline that runResume compares against — matches the oldJoin file
      // seeded above. Without these, the poll would accept the first read
      // (the stale pre-kick file) and resume would falsely report success.
      trayId: 'tray-old',
      lastJoinUpdatedAt: '2026-05-22T00:00:00Z',
    });

    sub.queueRun(h.sandboxId, () => {
      sub.seedFile(
        h.sandboxId,
        '/tmp/slicc-join.json',
        JSON.stringify({
          joinUrl: 'https://w/join/new',
          trayId: 'tray-old',
          runtime: 'slicc-hosted-leader',
          sliccVersion: '3.2.0',
          updatedAt: '2026-05-22T01:00:00Z',
        })
      );
      return { stdout: '200', stderr: '', exitCode: 0 };
    });

    const result = await runResume({
      substrate: sub,
      registryPath,
      query: 'task-1',
      localSliccVersion: '3.2.2',
      pollIntervalMs: 5,
      pollTimeoutMs: 1000,
    });
    expect(result.versionMismatch).toEqual({ running: '3.2.0', local: '3.2.2' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd packages/node-server && npx vitest run tests/cloud/resume.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `resume.ts`**

Create `packages/node-server/src/cloud/resume.ts`:

```typescript
import { CloudSessionRegistry } from './registry.js';
import type { SandboxHandle, SandboxSubstrate } from './substrate.js';

export interface RunResumeOpts {
  substrate: SandboxSubstrate;
  registryPath: string;
  query: string;
  localSliccVersion: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

export interface ResumeResult {
  sandboxId: string;
  joinUrl: string;
  trayRebuilt: boolean;
  versionMismatch?: { running: string; local: string };
}

// curl writes its body to /dev/null and prints the HTTP status code on stdout.
// We DO want curl to return non-zero on connection errors (so the retry loop
// can distinguish "node-server not up yet" from "200/503 response received").
// Therefore: no `|| true`; we parse status from stdout AND check exitCode.
const KICK_CMD =
  'curl -sS -X POST http://localhost:5710/api/leader-restart -o /dev/null -w "%{http_code}"';

export async function runResume(opts: RunResumeOpts): Promise<ResumeResult> {
  const reg = new CloudSessionRegistry(opts.registryPath);
  const entry = await reg.findByNameOrId(opts.query);
  if (!entry) throw new Error(`cloud session not found: ${opts.query}`);

  // Baseline from the registry — `runStart` stored these at create, and
  // `runPause` preserves them across pause. Resume requires a strictly
  // newer `updatedAt` than `entry.lastJoinUpdatedAt`, so we only declare
  // success once the kick has produced a fresh refresh.
  const baselineUpdatedAt = entry.lastJoinUpdatedAt;
  const baselineTrayId = entry.trayId;

  const handle = await opts.substrate.connect(entry.sandboxId);

  // Kick the leader to recover from a possible onReconnectGaveUp state.
  // 5×1s retry covers the CDP-cold-start race after a long pause.
  // Success = curl exited 0 AND status is 200. 503 means the SLICC page
  // target isn't ready yet — retry. Any other status is a hard error.
  let kicked = false;
  for (let i = 0; i < 5; i++) {
    const result = await handle.run(KICK_CMD);
    if (result.exitCode === 0) {
      const status = result.stdout.trim();
      if (status === '200') {
        kicked = true;
        break;
      }
      if (status !== '503') {
        throw new Error(`/api/leader-restart returned unexpected status ${status}`);
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!kicked) {
    throw new Error('Failed to kick leader after 5 retries (sandbox may not be healthy)');
  }

  const refreshed = await pollForRefreshedStatus(handle, baselineUpdatedAt, {
    timeoutMs: opts.pollTimeoutMs ?? 60_000,
    intervalMs: opts.pollIntervalMs ?? 500,
  });

  // Tray rebuilt iff we had a baseline AND the new trayId is different.
  // (No baseline → can't tell, default to false so we don't spuriously
  // warn on a freshly-created sandbox where the registry was wiped.)
  const trayRebuilt = Boolean(
    baselineTrayId && refreshed.trayId && baselineTrayId !== refreshed.trayId
  );
  const versionMismatch =
    refreshed.sliccVersion && refreshed.sliccVersion !== opts.localSliccVersion
      ? { running: refreshed.sliccVersion, local: opts.localSliccVersion }
      : undefined;

  // Write the new baseline back — same fields runStart populated.
  await reg.update(entry.sandboxId, {
    joinUrl: refreshed.joinUrl,
    lastSeen: new Date().toISOString(),
    state: 'running',
    trayId: refreshed.trayId,
    lastJoinUpdatedAt: refreshed.updatedAt,
  });

  return {
    sandboxId: entry.sandboxId,
    joinUrl: refreshed.joinUrl,
    trayRebuilt,
    ...(versionMismatch ? { versionMismatch } : {}),
  };
}

interface CloudStatus {
  joinUrl: string;
  trayId?: string;
  sliccVersion?: string;
  updatedAt?: string;
}

async function pollForRefreshedStatus(
  handle: SandboxHandle,
  baselineUpdatedAt: string | undefined,
  opts: { timeoutMs: number; intervalMs: number }
): Promise<CloudStatus> {
  const start = Date.now();
  while (Date.now() - start < opts.timeoutMs) {
    try {
      const raw = await handle.readFile('/tmp/slicc-join.json');
      const parsed = JSON.parse(raw) as CloudStatus;
      if (parsed.joinUrl) {
        // Require a STRICTLY newer updatedAt than the registry baseline.
        // If we have no baseline (first-time resume of an externally-created
        // sandbox), accept any well-formed read.
        if (!baselineUpdatedAt) return parsed;
        if (parsed.updatedAt && parsed.updatedAt !== baselineUpdatedAt) {
          return parsed;
        }
      }
    } catch {
      /* file not yet present or not yet refreshed */
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
  throw new Error(`cloud-status did not refresh within ${opts.timeoutMs}ms`);
}
```

- [ ] **Step 4: Run test to verify it passes**

```
cd packages/node-server && npx vitest run tests/cloud/resume.test.ts
```

Expected: PASS for all three cases.

- [ ] **Step 5: Commit**

```bash
git add packages/node-server/src/cloud/resume.ts packages/node-server/tests/cloud/resume.test.ts
git commit -m "feat(node-server): slicc --cloud resume (kick + version check + tray-rebuild detection)"
```

---

### Task 4.8: `slicc --cloud kill`

**Files:**

- Create: `packages/node-server/src/cloud/kill.ts`
- Create: `packages/node-server/tests/cloud/kill.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/node-server/tests/cloud/kill.test.ts`:

```typescript
import { describe, expect, it, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runKill } from '../../src/cloud/kill.js';
import { CloudSessionRegistry } from '../../src/cloud/registry.js';
import { FakeSubstrate } from './fake-substrate.js';

let dir: string;
let registryPath: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slicc-kill-'));
  registryPath = path.join(dir, 'cloud-sessions.json');
});

describe('slicc --cloud kill', () => {
  it('kills the sandbox and removes the registry entry', async () => {
    const sub = new FakeSubstrate();
    const h = await sub.create({
      template: 'slicc',
      envVars: {},
      metadata: {},
      autoPauseOnCap: true,
      name: 'task-1',
    });
    const reg = new CloudSessionRegistry(registryPath);
    await reg.append({
      substrate: 'e2b',
      sandboxId: h.sandboxId,
      name: 'task-1',
      createdAt: new Date().toISOString(),
      joinUrl: 'https://w/j',
      lastSeen: new Date().toISOString(),
      state: 'running',
    });

    await runKill({ substrate: sub, registryPath, query: 'task-1' });

    expect(await sub.list()).toHaveLength(0);
    expect(await reg.list()).toHaveLength(0);
  });

  it('removes the registry entry even when the sandbox is already dead', async () => {
    const sub = new FakeSubstrate();
    const reg = new CloudSessionRegistry(registryPath);
    await reg.append({
      substrate: 'e2b',
      sandboxId: 'gone',
      name: 'task-1',
      createdAt: new Date().toISOString(),
      joinUrl: 'https://w/j',
      lastSeen: new Date().toISOString(),
      state: 'dead',
    });

    await runKill({ substrate: sub, registryPath, query: 'task-1' });
    expect(await reg.list()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd packages/node-server && npx vitest run tests/cloud/kill.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `kill.ts`**

Create `packages/node-server/src/cloud/kill.ts`:

```typescript
import { CloudSessionRegistry } from './registry.js';
import type { SandboxSubstrate } from './substrate.js';

export interface RunKillOpts {
  substrate: SandboxSubstrate;
  registryPath: string;
  query: string;
}

export async function runKill(opts: RunKillOpts): Promise<void> {
  const reg = new CloudSessionRegistry(opts.registryPath);
  const entry = await reg.findByNameOrId(opts.query);
  if (!entry) throw new Error(`cloud session not found: ${opts.query}`);

  try {
    const handle = await opts.substrate.connect(entry.sandboxId);
    await handle.kill();
  } catch {
    // Substrate doesn't know about it — registry cleanup still proceeds.
  }
  await reg.remove(entry.sandboxId);
}
```

- [ ] **Step 4: Run test to verify it passes**

```
cd packages/node-server && npx vitest run tests/cloud/kill.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/node-server/src/cloud/kill.ts packages/node-server/tests/cloud/kill.test.ts
git commit -m "feat(node-server): slicc --cloud kill"
```

---

### Task 4.9: `--cloud` argv dispatcher in `index.ts`

**Files:**

- Modify: `packages/node-server/src/index.ts`
- Create: `packages/node-server/src/cloud/dispatch.ts`
- Create: `packages/node-server/tests/cloud/dispatch.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/node-server/tests/cloud/dispatch.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { parseCloudArgs } from '../../src/cloud/dispatch.js';

describe('parseCloudArgs', () => {
  it('parses --cloud start with name and env-file', () => {
    const r = parseCloudArgs([
      '--cloud',
      'start',
      '--name',
      'task-1',
      '--env-file',
      '/etc/slicc.env',
    ]);
    expect(r).toEqual({
      subcommand: 'start',
      args: { name: 'task-1', envFile: '/etc/slicc.env', substrate: 'e2b' },
    });
  });

  it('parses --cloud list', () => {
    const r = parseCloudArgs(['--cloud', 'list']);
    expect(r).toEqual({ subcommand: 'list', args: { substrate: 'e2b' } });
  });

  it('parses --cloud pause/resume/kill with positional query', () => {
    expect(parseCloudArgs(['--cloud', 'pause', 'task-1'])).toEqual({
      subcommand: 'pause',
      args: { query: 'task-1', substrate: 'e2b' },
    });
    expect(parseCloudArgs(['--cloud', 'resume', 'sb-abc'])).toEqual({
      subcommand: 'resume',
      args: { query: 'sb-abc', substrate: 'e2b' },
    });
    expect(parseCloudArgs(['--cloud', 'kill', 'task-1'])).toEqual({
      subcommand: 'kill',
      args: { query: 'task-1', substrate: 'e2b' },
    });
  });

  it('rejects --cloud and --hosted in the same invocation', () => {
    expect(() => parseCloudArgs(['--cloud', 'list', '--hosted'])).toThrow(/mutually exclusive/i);
    expect(() => parseCloudArgs(['--hosted', '--cloud', 'list'])).toThrow(/mutually exclusive/i);
  });

  it('rejects unknown subcommands', () => {
    expect(() => parseCloudArgs(['--cloud', 'banana'])).toThrow(/unknown subcommand/i);
  });

  it('returns null when --cloud is absent', () => {
    expect(parseCloudArgs(['--hosted', '--port', '5710'])).toBeNull();
    expect(parseCloudArgs([])).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd packages/node-server && npx vitest run tests/cloud/dispatch.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `dispatch.ts`**

Create `packages/node-server/src/cloud/dispatch.ts`:

```typescript
import type { SubstrateId } from './substrate.js';

export interface ParsedCloudArgs {
  subcommand: 'start' | 'list' | 'pause' | 'resume' | 'kill';
  args: {
    substrate: SubstrateId;
    name?: string;
    envFile?: string;
    query?: string;
  };
}

const VALID_SUBCOMMANDS = ['start', 'list', 'pause', 'resume', 'kill'] as const;
type Sub = (typeof VALID_SUBCOMMANDS)[number];

export function parseCloudArgs(argv: string[]): ParsedCloudArgs | null {
  if (argv.includes('--hosted') && argv.includes('--cloud')) {
    throw new Error('--cloud and --hosted are mutually exclusive');
  }
  const cloudIdx = argv.indexOf('--cloud');
  if (cloudIdx === -1) return null;

  const sub = argv[cloudIdx + 1];
  if (!sub || !VALID_SUBCOMMANDS.includes(sub as Sub)) {
    throw new Error(
      `unknown subcommand: ${sub ?? '(none)'} (expected one of: ${VALID_SUBCOMMANDS.join(', ')})`
    );
  }
  const rest = argv.slice(cloudIdx + 2);

  const args: ParsedCloudArgs['args'] = { substrate: 'e2b' };
  let i = 0;
  while (i < rest.length) {
    const a = rest[i];
    if (a === '--name') {
      args.name = rest[++i];
    } else if (a === '--env-file') {
      args.envFile = rest[++i];
    } else if (a === '--substrate') {
      const v = rest[++i];
      if (v !== 'e2b') throw new Error(`unsupported substrate: ${v} (MVP only supports 'e2b')`);
      args.substrate = v;
    } else if (
      !a.startsWith('--') &&
      !args.query &&
      (sub === 'pause' || sub === 'resume' || sub === 'kill')
    ) {
      args.query = a;
    } else {
      throw new Error(`unrecognized arg: ${a}`);
    }
    i++;
  }

  return { subcommand: sub as Sub, args };
}
```

- [ ] **Step 4: Run test to verify it passes**

```
cd packages/node-server && npx vitest run tests/cloud/dispatch.test.ts
```

Expected: PASS.

- [ ] **Step 5: Wire dispatcher into `index.ts`**

Edit `packages/node-server/src/index.ts` near the top of the boot flow, before any server boot (Chrome launch, port resolution, CDP wait, Express app boot — all of these must NOT run for `--cloud` invocations).

The dispatch block uses top-level `await`. Verify before merging: `packages/node-server/package.json` has `"type": "module"` (confirmed — yes), and the compiled `dist/node-server/index.js` is consumed as an ES module so top-level `await` is valid. Also ensure the runtime-flag parser already used at the top of `index.ts` does NOT consume `--cloud` or its subargs — `parseCloudArgs` looks for `--cloud` directly in `process.argv.slice(2)` and is independent of the existing flag parser. If `parseRuntimeFlags` (or whichever helper is used at boot) errors on unknown flags, exclude `--cloud …` args from it before parsing.

```typescript
import { parseCloudArgs } from './cloud/dispatch.js';
import { createSubstrate } from './cloud/substrate.js';
import { CloudSessionRegistry } from './cloud/registry.js';
import { runStart } from './cloud/start.js';
import { runList } from './cloud/list.js';
import { runPause } from './cloud/pause.js';
import { runResume } from './cloud/resume.js';
import { runKill } from './cloud/kill.js';

const parsed = parseCloudArgs(process.argv.slice(2));
if (parsed) {
  await runCloudSubcommand(parsed);
  process.exit(0);
}

async function runCloudSubcommand(parsed: ParsedCloudArgs): Promise<void> {
  const apiKey = process.env['E2B_API_KEY'] ?? readSecretsEnv('E2B_API_KEY');
  if (!apiKey) {
    console.error(
      'E2B_API_KEY not set. Add it to ~/.slicc/secrets.env (with E2B_API_KEY_DOMAINS=e2b.dev) ' +
        'or export it.'
    );
    process.exit(2);
  }
  const substrate = createSubstrate(parsed.args.substrate, { apiKey });
  const registryPath = CloudSessionRegistry.defaultPath();
  const localSliccVersion = readPackageVersion();

  switch (parsed.subcommand) {
    case 'start': {
      const result = await runStart({
        substrate,
        envFilePath: parsed.args.envFile ?? defaultSecretsPath(),
        registryPath,
        workerBaseUrl: process.env['SLICC_TRAY_WORKER_BASE_URL']?.trim() || 'https://www.sliccy.ai',
        sliccVersion: localSliccVersion,
        name: parsed.args.name,
      });
      console.log(`Sandbox ${result.sandboxId} ready.`);
      console.log(`Open: ${result.joinUrl}`);
      console.log('Attach from iOS, desktop SLICC, or any browser tab.');
      break;
    }
    case 'list': {
      const entries = await runList({ substrate, registryPath });
      for (const e of entries) {
        console.log(`${e.substrate}\t${e.sandboxId}\t${e.name ?? '-'}\t${e.state}\t${e.joinUrl}`);
      }
      break;
    }
    case 'pause':
      await runPause({ substrate, registryPath, query: parsed.args.query! });
      console.log(`Paused.`);
      break;
    case 'resume': {
      const result = await runResume({
        substrate,
        registryPath,
        query: parsed.args.query!,
        localSliccVersion,
      });
      if (result.versionMismatch) {
        console.warn(
          `Warning: running sandbox is sliccVersion=${result.versionMismatch.running}, ` +
            `local CLI is ${result.versionMismatch.local}. Proceeding anyway.`
        );
      }
      if (result.trayRebuilt) {
        console.warn('Tray was rebuilt; existing followers must re-attach to the new join URL.');
      }
      console.log(`Resumed. Open: ${result.joinUrl}`);
      break;
    }
    case 'kill':
      await runKill({ substrate, registryPath, query: parsed.args.query! });
      console.log(`Killed.`);
      break;
  }
}

// Helper stubs — implement using existing patterns:
function readSecretsEnv(name: string): string | undefined {
  // Pre-dispatch the CLI needs to read one specific key (E2B_API_KEY) before
  // any substrate or registry is constructed. The existing EnvSecretStore at
  // `packages/node-server/src/secrets/env-secret-store.ts` exposes get(name)
  // but only after construction with a path (and it gates on _DOMAINS). For
  // the pre-dispatch use case, the simplest path is a 5-line file parser:
  try {
    const path = require('node:path');
    const fs = require('node:fs');
    const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '.';
    const file = process.env['SLICC_SECRETS_FILE'] ?? path.join(home, '.slicc', 'secrets.env');
    const contents = fs.readFileSync(file, 'utf-8') as string;
    for (const line of contents.split('\n')) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (m && m[1] === name) return m[2].trim();
    }
  } catch {
    /* file missing → return undefined */
  }
  return undefined;
}
function defaultSecretsPath(): string {
  return path.join(process.env['HOME'] ?? '.', '.slicc', 'secrets.env');
}
function readPackageVersion(): string {
  // Read the root package.json's version (or use a build-time constant).
  // Match whatever the existing node-server build uses.
}
```

- [ ] **Step 6: Smoke-test the dispatcher end to end via the FakeSubstrate**

```
cd packages/node-server && npx vitest run tests/cloud
```

Expected: all cloud tests still pass.

- [ ] **Step 7: Commit**

```bash
git add packages/node-server/src/cloud/dispatch.ts \
        packages/node-server/src/index.ts \
        packages/node-server/tests/cloud/dispatch.test.ts
git commit -m "feat(node-server): --cloud subcommand dispatcher (start/list/pause/resume/kill)"
```

---

## Phase 5 — Release pipeline + docs

### Task 5.1: Live e2b harness (opt-in, gated by `SLICC_TEST_E2B_API_KEY`)

**Files:**

- Create: `packages/node-server/tests/cloud-live.test.ts`

- [ ] **Step 1: Add the gated live test**

Create `packages/node-server/tests/cloud-live.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { createSubstrate } from '../src/cloud/substrate.js';
import { runStart } from '../src/cloud/start.js';
import { runPause } from '../src/cloud/pause.js';
import { runResume } from '../src/cloud/resume.js';
import { runKill } from '../src/cloud/kill.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const apiKey = process.env['SLICC_TEST_E2B_API_KEY'];
const describeFn = apiKey ? describe : describe.skip;

describeFn('cloud live e2e (requires SLICC_TEST_E2B_API_KEY)', () => {
  it(
    'runs the full create → status → pause → resume → kill cycle',
    async () => {
      const substrate = createSubstrate('e2b', { apiKey: apiKey! });
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slicc-live-'));
      const envFile = path.join(dir, 'secrets.env');
      await fs.writeFile(
        envFile,
        'ANTHROPIC_API_KEY=sk-fake\nANTHROPIC_API_KEY_DOMAINS=api.anthropic.com\n'
      );
      const registryPath = path.join(dir, 'cloud-sessions.json');

      const startResult = await runStart({
        substrate,
        envFilePath: envFile,
        registryPath,
        sliccVersion: 'live-test',
        workerBaseUrl: 'https://www.sliccy.ai',
        name: `live-${Date.now()}`,
        pollTimeoutMs: 120_000,
      });
      expect(startResult.joinUrl).toMatch(/^https:\/\//);

      await runPause({ substrate, registryPath, query: startResult.sandboxId });

      const resumeResult = await runResume({
        substrate,
        registryPath,
        query: startResult.sandboxId,
        localSliccVersion: 'live-test',
        pollTimeoutMs: 120_000,
      });
      expect(resumeResult.joinUrl).toMatch(/^https:\/\//);

      await runKill({ substrate, registryPath, query: startResult.sandboxId });
    },
    /* timeout */ 5 * 60 * 1000
  );
});
```

- [ ] **Step 2: Add a `test:live:cloud` script to `packages/node-server/package.json`**

```json
{
  "scripts": {
    "test:live:cloud": "vitest run tests/cloud-live.test.ts"
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/node-server/tests/cloud-live.test.ts packages/node-server/package.json
git commit -m "test(node-server): opt-in live e2b cloud harness"
```

---

### Task 5.2: Worker tests — Phase 1 regression sweep

- [ ] **Step 1: Run the full worker test suite and verify**

```
cd packages/cloudflare-worker && npx vitest run
```

Expected: all pass.

- [ ] **Step 2: Run the full repo verification gate**

```
npx prettier --check .
npm run typecheck
npm run test
npm run build
npm run build -w @slicc/chrome-extension
```

If any fail, fix and re-commit before moving on.

- [ ] **Step 3: If everything is green, no commit needed (just a checkpoint)**

---

### Task 5.3: README, docs/architecture, docs/shell-reference, root CLAUDE.md

**Files:**

- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/shell-reference.md`
- Modify: `CLAUDE.md` (root)
- Modify: `packages/node-server/CLAUDE.md`

- [ ] **Step 1: Update root `README.md`**

Append a new section to `README.md`:

````markdown
## Cloud (`slicc --cloud`)

Run a SLICC leader inside an e2b.dev sandbox so it survives your laptop going to sleep.

**Prerequisites:** an e2b account; `E2B_API_KEY` in `~/.slicc/secrets.env` (with `E2B_API_KEY_DOMAINS=e2b.dev`) or in `process.env`.

```bash
slicc --cloud start [--name task-1] [--env-file ~/.slicc/secrets.env]
slicc --cloud list
slicc --cloud pause <sandboxId|name>
slicc --cloud resume <sandboxId|name>
slicc --cloud kill <sandboxId|name>
```
````

`start` prints a tray join URL; open it on iOS SliccFollower, desktop SLICC, or any browser tab.

**Known limitations:**

- OAuth-based providers (Anthropic OAuth, GitHub OAuth, Adobe IMS) are not supported; use static keys / PATs in `secrets.env`.
- Local FS-Access mounts don't work in headless cloud Chromium. S3 / S3-compatible / DA mounts via `secrets.env` credentials work.
- Pause beyond 30 days exceeds the worker's hosted-tray reclaim TTL; a new tray will be minted on resume with a new join URL.
- Sandbox crash (distinct from auto-pause-on-cap) loses state.
- Anyone with access to your e2b team account can attach to a paused sandbox and read its filesystem (including `/slicc/secrets.env`). Treat the team account as a credential boundary.
- `E2B_API_KEY` (and `E2B_API_KEY_DOMAINS`) are stripped from `secrets.env` before upload, so the cloud agent cannot spawn additional sandboxes against your account. Any OTHER local-only secret in `~/.slicc/secrets.env` is uploaded wholesale; if you have dev creds you don't want in the cloud, remove them from the file or use `--env-file` to point at a curated copy.
- No SIGINT handling during `--cloud start`. If you Ctrl-C while the sandbox is starting, it may end up running with no registry entry. Find it via `--cloud list` (which queries e2b directly) and `--cloud kill` it.
- No credential rotation flow. Updating `~/.slicc/secrets.env` after `--cloud start` does not propagate to a running sandbox. Workaround: `--cloud pause`, then upload the new file via the e2b SDK or dashboard, then `--cloud resume`.

````

- [ ] **Step 2: Update `docs/architecture.md`**

Add a section describing the hosted-leader float:

```markdown
### Hosted-leader float

A cloud-runtime variant: node-server `--hosted` + headless Chromium + the webapp boot in a remote e2b sandbox, started by `slicc --cloud start`. The webapp inside the sandbox is the cone + tray leader, identical to standalone CLI but with:

- `runtime=hosted-leader` URL query → `slicc-hosted-leader` tray attach runtime
- `kind: 'hosted'` in `POST /tray` body (worker reclaim TTL → 30 days)
- Unconditional leader auto-start in `main.ts` (does not depend on stored localStorage)
- `onLeaderReady` callback POSTs join info to localhost `/api/cloud-status`
- `/api/leader-restart` recovers a stuck leader via CDP `Page.reload()`
- `SLICC_TRAY_WORKER_BASE_URL` env drives `/api/runtime-config`

Substrate abstraction: `packages/node-server/src/cloud/substrate.ts` defines `SandboxSubstrate`; MVP impl at `cloud/substrates/e2b.ts`.

Template: `packages/dev-tools/e2b-template/` (Dockerfile + e2b.toml + start.sh + build/verify scripts).
````

- [ ] **Step 3: Update `docs/shell-reference.md`**

Append `--cloud` documentation matching the README.

- [ ] **Step 4: Update root `CLAUDE.md`**

Under "Floats" in the Ice Cream Vocabulary section, add hosted-leader:

```markdown
- **Floats**: CLI (`packages/node-server/src/`), Extension (`packages/chrome-extension/src/`), Electron (`packages/node-server/src/electron-main.ts`), Sliccstart (`packages/swift-launcher/`), **hosted-leader (cloud)** (`packages/node-server/src/cloud/` orchestrates an e2b sandbox running `node-server --hosted`).
```

Also add an entry to "Module Map" under "Other Top-Level Directories" if `packages/dev-tools/e2b-template/` should be visible there. Or add to dev-tools sub-CLAUDE.md.

- [ ] **Step 5: Update `packages/node-server/CLAUDE.md`**

Add a "Cloud mode" section under "Runtime Modes":

```markdown
- **Hosted mode (`--hosted`)**: bundled with the e2b template at `packages/dev-tools/e2b-template/`. node-server boots headless Chromium against `?runtime=hosted-leader`, persists `--user-data-dir=/data/profile`, exposes `/api/cloud-status` and `/api/leader-restart`, reads `SLICC_TRAY_WORKER_BASE_URL`.
- **Cloud subcommands (`--cloud start/list/pause/resume/kill`)**: laptop-side orchestration over an e2b sandbox. Code in `src/cloud/`. Goes through the `SandboxSubstrate` interface; e2b SDK is imported only by `cloud/substrates/e2b.ts`. Mutually exclusive with `--hosted`.
```

- [ ] **Step 6: Run prettier and commit**

```bash
npx prettier --write README.md docs/architecture.md docs/shell-reference.md CLAUDE.md packages/node-server/CLAUDE.md
git add README.md docs/architecture.md docs/shell-reference.md CLAUDE.md packages/node-server/CLAUDE.md
git commit -m "docs: hosted-leader float documentation"
```

---

### Task 5.4: Full repo verification + branch readiness

**Cross-phase deployment ordering.** Phase 1 (the worker `kind` + 30-day TTL) must be **deployed to production** before Phase 4's pause-for-days dogfooding works against `www.sliccy.ai`. CI auto-deploys the worker from `main`, so merging this branch deploys Phase 1 as part of the same merge — but a partial-rollback that reverts the worker change while leaving the CLI alone would silently degrade hosted-tray reclaim back to 1h. Note this in the PR description (test-plan checkbox) so reviewers see the dependency.

- [ ] **Step 1: Run all CI gates**

```
npx prettier --check .
npm run typecheck
npm run test
npm run test:coverage
npm run build
npm run build -w @slicc/chrome-extension
```

Expected: all green.

- [ ] **Step 2: (Optional, opt-in) Run the live e2b harness**

```
SLICC_TEST_E2B_API_KEY=<your-key> npm run test:live:cloud -w @slicc/node-server
```

Expected: full create → pause → resume → kill cycle completes.

- [ ] **Step 3: (Optional) Build and publish the e2b template against a test team**

```
npm run build
packages/dev-tools/e2b-template/scripts/build-template.sh
packages/dev-tools/e2b-template/scripts/verify-template.sh
```

Expected: template published; verify produces a joinUrl.

- [ ] **Step 4: Final commit, push, open PR**

```bash
git status
git log --oneline origin/main..HEAD
git push -u origin feat/hosted-slicc-e2b
gh pr create --title "feat: hosted-leader float (slicc --cloud, e2b)" --body "$(cat <<'EOF'
## Summary
- Adds a hosted-leader float that runs the webapp + node-server + Chromium inside an e2b.dev sandbox.
- New `slicc --cloud start/list/pause/resume/kill` CLI surface.
- Gated worker change: `TrayRecord.kind = 'desktop' | 'hosted'`, 30-day reclaim TTL for hosted.
- Webapp adds `'hosted-leader'` runtime mode with unconditional leader auto-start and `onLeaderReady`.
- New e2b template at `packages/dev-tools/e2b-template/`.
- `SandboxSubstrate` interface so the substrate is swappable.

## Test plan
- [ ] `npm run test` passes (incl. all new `tests/cloud/*` and worker tests)
- [ ] `npm run typecheck` and `npm run build` pass
- [ ] `npx prettier --check .` passes
- [ ] `SLICC_TEST_E2B_API_KEY=… npm run test:live:cloud -w @slicc/node-server` (manual)
- [ ] Worker deployed to production (Phase 1 `kind` + 30-day TTL must land before pause-for-days dogfooding works)
- [ ] e2b template built and published (`packages/dev-tools/e2b-template/scripts/build-template.sh`)
- [ ] Manual smoke: `slicc --cloud start --name test1`, attach iOS follower, send a turn, `slicc --cloud pause`, `slicc --cloud resume`, verify follower reattaches, `slicc --cloud kill`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

### Spec coverage check

Mapping each spec section to tasks:

- **Hosted leader boot contract** → Tasks 2.1, 2.2, 2.3, 2.4, 2.5, 2.6
- **CLI surface** → Tasks 4.1–4.9 (substrate + each subcommand + dispatch)
- **node-server `--hosted` mode** → Tasks 3.2, 3.3, 3.4
- **`/api/leader-restart` page-target identification + retry** → Task 3.4
- **e2b template** → Tasks 3.5, 3.6
- **Pause/resume flow** → Tasks 4.6, 4.7
- **`kind` plumbing + 30-day TTL** → Tasks 1.1, 1.2, 1.3, 1.4
- **Substrate seam** → Tasks 4.1, 4.2
- **Live harness** → Task 5.1
- **Documentation (README, architecture, shell-reference, CLAUDE.mds)** → Task 5.3
- **Argv mutual exclusion `--cloud` vs `--hosted`** → Task 4.9
- **Container Chrome flags** → Task 3.1
- **`SLICC_TRAY_WORKER_BASE_URL` env wiring** → Task 3.2
- **Stale `storedJoinUrl` precedence fix** → Task 2.6

### Open execution-time concerns

- **e2b SDK shape.** `Task 4.2` uses `Sandbox.list()`, `Sandbox.create(template, {autoPause, envs, metadata})`, `Sandbox.connect(id)`, `sbx.pause()`, `sbx.kill()`, `sbx.getInfo()`, `sbx.files.read/write`, `sbx.commands.run`. If the published SDK names differ at implementation time, patch `cloud/substrates/e2b.ts` to match — keep the `SandboxSubstrate` interface intact.
- **`/api/runtime-config` field name.** Existing returns `trayWorkerBaseUrl`. Task 2.6 assumes the webapp reads that field via its existing runtime-config plumbing; verify the existing path before adding new code.
- **`readSecretsEnv` helper in `dispatch.ts`.** Reuse the existing `EnvSecretStore` parsing path if it can be invoked statically; otherwise implement a minimal `${name}=value` parser inline. Don't fork the parsing logic.
- **Resume baseline fields are load-bearing.** `runStart` (Task 4.4) MUST populate `trayId` and `lastJoinUpdatedAt` on the registry entry from the initial `/tmp/slicc-join.json` read. `runPause` (Task 4.6) MUST preserve them across pause (do not overwrite with wall-clock `lastSeen`). `runResume` (Task 4.7) reads them as the poll baseline; without a baseline the kick can return success against a stale pre-kick file read. The registry tests cover the field round-trip; the resume tests assert the baseline-driven polling behavior.
- **Task 3.4 + Task 3.4b ordering.** Task 3.4 ships the `CdpLike` interface + fake-based tests. Task 3.4b ships the real `ws` transport with a roundtrip test against a fake CDP server. Both must complete before Phase 4 dogfood — `slicc --cloud resume`'s kick path drives the real `/api/leader-restart`, which only works once 3.4b lands.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-22-hosted-slicc-e2b.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
