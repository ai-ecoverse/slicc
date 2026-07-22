# Remove SLICC Cone-Count Caps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove SLICC's per-user running and paused cone-count limits so E2B is the sole sandbox-capacity authority.

**Architecture:** Keep Durable Object reservations as short-lived concurrency records, but remove all cap parsing, counting, configuration, errors, and UI gating. Starts and resumes for different cones remain parallel; duplicate names and duplicate operations remain serialized. Preserve the existing per-user request-rate token buckets unchanged.

**Tech Stack:** TypeScript, JavaScript ES modules, Cloudflare Workers and Durable Objects, E2B SDK, Vitest, JSDOM, Wrangler.

## Global Constraints

- The E2B project/team for live verification is `Adobe Experience Manager` (`c5b04852-7176-48d8-8d37-cd103a7c7545`).
- Keep Start and Resume rate limits at a burst of 30 and refill of 30/hour.
- Keep List, Pause, and Kill rate limits at a burst of 60 and refill of 60/minute.
- Do not change E2B project, quota, timeout, CPU, memory, or template settings.
- Do not add E2B-specific quota error classification.
- Remove obsolete behavior outright; do not add unlimited sentinels or compatibility aliases.
- Preserve `reserved` as the registry state for an in-flight start or resume.
- Preserve duplicate-name, duplicate-operation, stale-reservation, and failure-cleanup behavior.
- Use tests before implementation and keep all lint, typecheck, test, coverage, build, and complexity outputs warning-free.

---

## File Map

### Cloud core

- `packages/cloud-core/src/operations/start.ts`: rename the atomic start reservation API and remove cap inputs/checks.
- `packages/cloud-core/src/operations/list.ts`: update the reservation reference in reconciliation documentation.
- `packages/cloud-core/src/index.ts`: export the renamed reservation type and function.
- `packages/cloud-core/src/errors.ts`: remove the obsolete `CAP_EXCEEDED` code after worker usages are gone.
- `packages/cloud-core/tests/start.test.ts`: prove reservations are count-independent while preserving name and cleanup behavior.
- `packages/cloud-core/CLAUDE.md`: document the renamed reservation operation and its concurrency purpose.

### Cloudflare Worker lifecycle

- `packages/cloudflare-worker/src/cloud/cloud-sessions-do.ts`: remove start/resume cap enforcement while retaining atomic reservations.
- `packages/cloudflare-worker/src/cloud/caps.ts`: delete the cap subsystem.
- `packages/cloudflare-worker/tests/caps.test.ts`: delete obsolete cap tests.
- `packages/cloudflare-worker/tests/cloud-sessions-do.test.ts`: prove distinct concurrent starts/resumes succeed and same-cone duplication remains blocked.
- `packages/cloudflare-worker/tests/cloud-handlers.test.ts`: replace the obsolete `CAP_EXCEEDED` pass-through case with a still-valid cloud error.

### Configuration and dashboard

- `packages/cloudflare-worker/src/cloud/handler-config.ts`: remove cap env parsing and response fields.
- `packages/cloudflare-worker/src/cloud/handlers.ts`: remove cap fields from `CloudEnv`.
- `packages/cloudflare-worker/src/index.ts`: remove cap fields from `WorkerEnv`.
- `packages/cloudflare-worker/wrangler.jsonc`: remove production and staging cap variables.
- `packages/cloudflare-worker/tests/cloud-config.test.ts`: assert that cloud config has no cap fields.
- `packages/cloudflare-worker/tests/cloud-handlers-helpers.ts`: remove cap values from fake environments.
- `packages/webapp/cloud/app.js`: render counts without cap gating.
- `packages/webapp/cloud/index.html`: rename the count element away from cap terminology.
- `packages/webapp/cloud/styles.css`: rename the matching CSS class.
- packages/webapp/tests/cloud/cloud-dashboard.test.ts (new): exercise dashboard behavior at the former 1/5 boundary.
- `packages/cloudflare-worker/CLAUDE.md`: state that E2B owns capacity and remove cap configuration documentation.

---

### Task 1: Make Cloud-Core Start Reservations Count-Independent

**Files:**

- Modify: `packages/cloud-core/tests/start.test.ts:1-92,367-505`
- Modify: `packages/cloud-core/src/operations/start.ts:9-160`
- Modify: `packages/cloud-core/src/operations/list.ts:79`
- Modify: `packages/cloud-core/src/index.ts:19-20`
- Modify: `packages/cloudflare-worker/src/cloud/cloud-sessions-do.ts:1-151`

**Interfaces:**

- Consumes: `StartConeDeps`, `ConeEntry[]`, and the existing `Registry` contract.
- Produces: `ReserveConeStartOpts` and `reserveConeStart(deps, opts): Promise<{ reservationId: string }>`.
- Preserves: `startCone(..., { reservationId })` and the `pending-<uuid>` reservation identifier.

- [ ] **Step 1: Replace the cap rejection test with a failing count-independent reservation test**

In `packages/cloud-core/tests/start.test.ts`, import the new name and replace the first `reserveSlot` describe block with:

```ts
import { reserveConeStart, startCone } from '../src/operations/start.js';

describe('reserveConeStart', () => {
  it('allows a reservation when running and paused cones already exist', async () => {
    const registry = new MemRegistry();
    const existing = [
      {
        sandboxId: 'running-1',
        substrate: 'e2b' as const,
        createdAt: '',
        lastSeen: '',
        state: 'running' as const,
        joinUrl: 'https://w/join/running-1',
      },
      {
        sandboxId: 'paused-1',
        substrate: 'e2b' as const,
        createdAt: '',
        lastSeen: '',
        state: 'paused' as const,
        joinUrl: 'https://w/join/paused-1',
      },
    ];
    for (const entry of existing) await registry.append(entry);

    const result = await reserveConeStart(
      { substrate: makeFakeSubstrate({ listResult: [] }), registry },
      {
        name: 'next-lab',
        metadata: { userId: 'u1' },
        reconciledCones: existing,
      }
    );

    expect(result.reservationId).toMatch(/^pending-/);
    expect(await registry.list()).toContainEqual(
      expect.objectContaining({
        sandboxId: result.reservationId,
        name: 'next-lab',
        state: 'reserved',
      })
    );
  });
});
```

- [ ] **Step 2: Run the focused test and confirm the renamed API is missing**

Run:

```bash
npm run test -w @slicc/cloud-core -- tests/start.test.ts
```

Expected: FAIL because `reserveConeStart` is not exported.

- [ ] **Step 3: Replace the cap-aware reservation interface and implementation**

In `packages/cloud-core/src/operations/start.ts`, replace `ReserveSlotOpts`, `parseCapLimit`, and `reserveSlot` with:

```ts
export interface ReserveConeStartOpts {
  /** User ID for filtering (worker use) or undefined (CLI use). */
  userId?: string;
  /** Optional name; checked for conflicts. */
  name?: string;
  /** Metadata to store on the reservation entry. */
  metadata?: Record<string, string>;
  /** Pre-reconciled cone list (from listCones). If provided, skips the slow
   * reconciliation call inside reserveConeStart, making it fast enough to fit
   * under blockConcurrencyWhile. Worker callers MUST pass this to avoid
   * holding the DO lock through substrate.list(). */
  reconciledCones?: ConeEntry[];
}

/**
 * Reserve an in-flight start in the registry atomically under a DO lock before
 * substrate.create. Throws CloudError('NAME_TAKEN') on a live-name conflict.
 *
 * Callers MUST wrap this in blockConcurrencyWhile so concurrent calls observe
 * each other's reservations.
 */
export async function reserveConeStart(
  deps: StartConeDeps,
  opts: ReserveConeStartOpts
): Promise<{ reservationId: string }> {
  const reservationId = `pending-${crypto.randomUUID()}`;
  const createdAt = new Date().toISOString();

  let existing: ConeEntry[];
  if (opts.reconciledCones) {
    existing = opts.reconciledCones;
  } else {
    const { listCones } = await import('./list.js');
    existing = await listCones(deps, opts.userId ? { metadata: { userId: opts.userId } } : {});
  }

  const requestedName = opts.name?.trim();
  if (requestedName && existing.some((e) => e.state !== 'dead' && e.name === requestedName)) {
    throw new CloudError('NAME_TAKEN', `cloud session name already exists: ${requestedName}`);
  }

  const reservation: ConeEntry = {
    substrate: deps.substrate.id,
    sandboxId: reservationId,
    name: requestedName,
    createdAt,
    lastSeen: createdAt,
    state: 'reserved',
    reservedAt: createdAt,
    joinUrl: '',
    metadata: opts.metadata,
  };
  await deps.registry.append(reservation);

  return { reservationId };
}
```

Also update the `StartConeOpts.reservationId` doc comment to refer to `reserveConeStart`.

- [ ] **Step 4: Update exports, references, and existing tests to the new API**

In `packages/cloud-core/src/index.ts`, use:

```ts
export type { ReserveConeStartOpts, StartConeDeps, StartConeOpts } from './operations/start.js';
export { reserveConeStart, startCone } from './operations/start.js';
```

In `packages/cloud-core/src/operations/list.ts`, change the reservation comment to refer to `reserveConeStart`.

In `packages/cloudflare-worker/src/cloud/cloud-sessions-do.ts`:

```ts
import {
  createSubstrate,
  isCloudError,
  killCone,
  listCones,
  pauseCone,
  reserveConeStart,
  resumeCone,
  type SandboxSubstrate,
  startCone,
} from '@slicc/cloud-core';
```

Change the call to:

```ts
...(await reserveConeStart(
  { substrate, registry },
  {
    userId: body.userId,
    name: body.name?.trim(),
    metadata: { userId: body.userId },
    reconciledCones: filtered,
  }
)),
```

Across `packages/cloud-core/tests/start.test.ts`, rename every `reserveSlot` call and description to `reserveConeStart`, remove every `env` argument, and remove the unused reservation-only `sliccVersion` arguments. Replace the old “second reservation hits cap” assertion with:

```ts
const second = await reserveConeStart(
  { substrate, registry },
  {
    userId: 'u1',
    name: 'second',
    metadata: { userId: 'u1' },
    reconciledCones: await registry.list(),
  }
);
expect(second.reservationId).toMatch(/^pending-/);
expect(await registry.list()).toHaveLength(2);
```

- [ ] **Step 5: Run cloud-core tests and both affected typechecks**

Run:

```bash
npm run test -w @slicc/cloud-core -- tests/start.test.ts
npm run build -w @slicc/cloud-core
npm run typecheck -w @slicc/cloudflare-worker
```

Expected: all commands PASS with no warnings.

- [ ] **Step 6: Commit the count-independent reservation change**

```bash
git add packages/cloud-core/src/operations/start.ts \
  packages/cloud-core/src/operations/list.ts \
  packages/cloud-core/src/index.ts \
  packages/cloud-core/tests/start.test.ts \
  packages/cloudflare-worker/src/cloud/cloud-sessions-do.ts
git commit -m "refactor(cloud): remove start reservation caps"
```

---

### Task 2: Remove Worker Lifecycle Cap Enforcement

**Files:**

- Delete: `packages/cloudflare-worker/src/cloud/caps.ts`
- Delete: `packages/cloudflare-worker/tests/caps.test.ts`
- Modify: `packages/cloudflare-worker/src/cloud/cloud-sessions-do.ts:1-415`
- Modify: `packages/cloudflare-worker/tests/cloud-sessions-do.test.ts:160-365`
- Modify: `packages/cloudflare-worker/tests/cloud-handlers.test.ts:69-79`
- Modify: `packages/cloud-core/src/errors.ts:1-20`

**Interfaces:**

- Consumes: `reserveConeStart`, `listCones`, `startCone`, and `resumeCone` from Task 1.
- Produces: start/resume lifecycle endpoints with no SLICC count-based rejection.
- Preserves: `NAME_TAKEN`, `ALREADY_RUNNING`, registry rollback, and rate-limit responses.

- [ ] **Step 1: Rewrite lifecycle tests for uncapped parallel behavior**

In `packages/cloudflare-worker/tests/cloud-sessions-do.test.ts`, remove cap fields from `makeDoEnv`:

```ts
function makeDoEnv(substrate: FakeSubstrate) {
  return {
    E2B_API_KEY: 'test',
    __SUBSTRATE_FACTORY__: () => substrate as SandboxSubstrate,
  };
}
```

Replace the existing-running cap test with:

```ts
it('start-cone succeeds when another cone is already running', async () => {
  const substrate = new FakeSubstrate();
  substrate.seedSandbox('s1', {
    metadata: { userId: 'u1', name: 'existing' },
    state: 'running',
  });
  const { state } = makeFakeState();
  const do_ = new CloudSessionsDurableObject(state as any, makeDoEnv(substrate));

  const res = await call(do_, '/start-cone', {
    bearer: 'b',
    userId: 'u1',
    workerOrigin: 'https://w',
    name: 'next',
  });

  expect(res.status).toBe(200);
  expect(substrate.sandboxes.size).toBe(2);
});
```

Replace the concurrent start test with:

```ts
it('allows two distinct concurrent start-cone calls', async () => {
  const substrate = new FakeSubstrate();
  const { state } = makeFakeState();
  const do_ = new CloudSessionsDurableObject(state as any, makeDoEnv(substrate));

  const responses = await Promise.all([
    call(do_, '/start-cone', {
      bearer: 'b1',
      userId: 'u1',
      workerOrigin: 'https://w',
      name: 'first',
    }),
    call(do_, '/start-cone', {
      bearer: 'b2',
      userId: 'u1',
      workerOrigin: 'https://w',
      name: 'second',
    }),
  ]);

  expect(responses.map((response) => response.status)).toEqual([200, 200]);
  expect(
    Array.from(substrate.sandboxes.values())
      .map((sandbox) => sandbox.name)
      .sort()
  ).toEqual(['first', 'second']);
});
```

Replace the concurrent resume test with:

```ts
it('allows two different paused cones to resume concurrently', async () => {
  const substrate = new FakeSubstrate();
  substrate.seedSandbox('s1', { metadata: { userId: 'u1', name: 'a' }, state: 'paused' });
  substrate.seedSandbox('s2', { metadata: { userId: 'u1', name: 'b' }, state: 'paused' });
  const { state } = makeFakeState();
  const do_ = new CloudSessionsDurableObject(state as any, makeDoEnv(substrate));
  await call(do_, '/list-cones', { userId: 'u1' });

  const responses = await Promise.all([
    call(do_, '/resume-cone', {
      bearer: 'b',
      sandboxId: 's1',
      localSliccVersion: 'v',
      userId: 'u1',
    }),
    call(do_, '/resume-cone', {
      bearer: 'b',
      sandboxId: 's2',
      localSliccVersion: 'v',
      userId: 'u1',
    }),
  ]);

  expect(responses.map((response) => response.status)).toEqual([200, 200]);
  expect(substrate.sandboxes.get('s1')?.state).toBe('running');
  expect(substrate.sandboxes.get('s2')?.state).toBe('running');
});
```

Add same-target regression coverage:

```ts
it('rejects a duplicate concurrent resume of the same cone', async () => {
  const substrate = new FakeSubstrate();
  substrate.seedSandbox('s1', { metadata: { userId: 'u1', name: 'a' }, state: 'paused' });
  const { state } = makeFakeState();
  const do_ = new CloudSessionsDurableObject(state as any, makeDoEnv(substrate));
  await call(do_, '/list-cones', { userId: 'u1' });

  const responses = await Promise.all([
    call(do_, '/resume-cone', {
      bearer: 'b',
      sandboxId: 's1',
      localSliccVersion: 'v',
      userId: 'u1',
    }),
    call(do_, '/resume-cone', {
      bearer: 'b',
      sandboxId: 's1',
      localSliccVersion: 'v',
      userId: 'u1',
    }),
  ]);

  expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
});
```

- [ ] **Step 2: Run lifecycle tests and confirm cap behavior still fails them**

Run:

```bash
npm run test -w @slicc/cloudflare-worker -- tests/cloud-sessions-do.test.ts
```

Expected: FAIL because current start/resume paths still return `CAP_EXCEEDED`, and `DoEnv` still requires cap fields.

- [ ] **Step 3: Remove cap enforcement from the Durable Object**

In `packages/cloudflare-worker/src/cloud/cloud-sessions-do.ts`:

- Delete the `checkCapsForRun` import.
- Remove `CONE_CAP_RUNNING` and `CONE_CAP_PAUSED` from `DoEnv`.
- Change the start atomic-phase comment to “registry-only name check and reservation.”
- Change the slow-phase comment to “The reservation records the in-flight start.”
- Delete the `others`, `cap`, and `CAP_EXCEEDED` block from `resumeConeOp`.
- Keep the target lookup, `ALREADY_RUNNING` check, original-state capture, and `reserved` update.
- Change “Reserve the slot” to “Mark this resume in flight.”
- Remove `CAP_EXCEEDED: 403` from `errCodeToStatus`.

The resume precheck after removal must read:

```ts
let originalState: 'paused' | 'dead' | undefined;
const precheck = await this.state.blockConcurrencyWhile(async () => {
  const all = await registry.list();
  const target = all.find((c) => c.sandboxId === body.sandboxId);
  if (!target) {
    return {
      error: errorResponse(404, 'NOT_FOUND', `cloud session not found: ${body.sandboxId}`),
    };
  }
  if (target.state === 'running' || target.state === 'reserved') {
    return {
      error: errorResponse(
        409,
        'ALREADY_RUNNING',
        `cloud session is already running: ${body.sandboxId}`
      ),
    };
  }

  originalState = target.state;
  await registry.update(body.sandboxId, {
    state: 'reserved',
    reservedAt: new Date().toISOString(),
  });
  return { error: null };
});
```

Delete `packages/cloudflare-worker/src/cloud/caps.ts` and `packages/cloudflare-worker/tests/caps.test.ts` with `trash`, not `rm`:

```bash
trash packages/cloudflare-worker/src/cloud/caps.ts
trash packages/cloudflare-worker/tests/caps.test.ts
```

- [ ] **Step 4: Remove the obsolete error code and update handler pass-through coverage**

Delete `'CAP_EXCEEDED'` from `CloudErrorCode` in `packages/cloud-core/src/errors.ts`.

In `packages/cloudflare-worker/tests/cloud-handlers.test.ts`, replace the cap case with:

```ts
it('passes through DO 409 NAME_TAKEN', async () => {
  const env = makeCloudEnv();
  setMockResponse(() =>
    Response.json(
      { error: 'NAME_TAKEN', message: 'cloud session name already exists' },
      { status: 409 }
    )
  );
  const req = await authedRequest('https://w/start', {});
  const res = await handleStart(req, env);
  expect(res.status).toBe(409);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe('NAME_TAKEN');
});
```

- [ ] **Step 5: Run lifecycle, handler, cloud-core, and type checks**

Run:

```bash
npm run test -w @slicc/cloudflare-worker -- \
  tests/cloud-sessions-do.test.ts tests/cloud-handlers.test.ts tests/rate-limit.test.ts
npm run test -w @slicc/cloud-core
npm run typecheck -w @slicc/cloudflare-worker
```

Expected: all commands PASS, including the unchanged rate-limit suite.

- [ ] **Step 6: Commit worker lifecycle cap removal**

```bash
git add packages/cloud-core/src/errors.ts \
  packages/cloudflare-worker/src/cloud/cloud-sessions-do.ts \
  packages/cloudflare-worker/src/cloud/caps.ts \
  packages/cloudflare-worker/tests/caps.test.ts \
  packages/cloudflare-worker/tests/cloud-sessions-do.test.ts \
  packages/cloudflare-worker/tests/cloud-handlers.test.ts
git commit -m "feat(cloud): remove cone count enforcement"
```

---

### Task 3: Remove Cap Configuration and Dashboard Gating

**Files:**

- Modify: `packages/cloudflare-worker/src/cloud/handler-config.ts:1-84`
- Modify: `packages/cloudflare-worker/src/cloud/handlers.ts:6-16`
- Modify: `packages/cloudflare-worker/src/index.ts:49-72`
- Modify: `packages/cloudflare-worker/wrangler.jsonc:17-34,75-92`
- Modify: `packages/cloudflare-worker/tests/cloud-config.test.ts:182-218`
- Modify: `packages/cloudflare-worker/tests/cloud-handlers-helpers.ts:48-63`
- Modify: `packages/webapp/cloud/app.js:173-254`
- Modify: `packages/webapp/cloud/index.html:65-70`
- Modify: `packages/webapp/cloud/styles.css:450-456`
- Create: packages/webapp/tests/cloud/cloud-dashboard.test.ts
- Modify: `packages/cloud-core/CLAUDE.md:61`
- Modify: `packages/cloudflare-worker/CLAUDE.md:29,224`

**Interfaces:**

- Consumes: `/api/cloud/config` IMS/proxy fields and `/api/cloud/list` cone data.
- Produces: a config response without `capRunning`/`capPaused` and a dashboard count label with no count-based control gating.
- Preserves: create-button in-flight disabling, provider/model gating, authentication, and rate limiting.

- [ ] **Step 1: Make cloud-config and dashboard regression tests fail**

Replace the two cap tests at the end of `packages/cloudflare-worker/tests/cloud-config.test.ts` with:

```ts
it('omits retired cone cap fields', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/v1/config')) {
      return new Response(JSON.stringify({ clientId: 'x', scopes: 'y', imsEnvironment: 'prod' }), {
        status: 200,
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  const res = await handleCloudConfig(new Request('https://w/api/cloud/config'), {});
  const body = (await res.json()) as Record<string, unknown>;

  expect(body).not.toHaveProperty('capRunning');
  expect(body).not.toHaveProperty('capPaused');
});
```

Create packages/webapp/tests/cloud/cloud-dashboard.test.ts:

```ts
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

let dom: JSDOM | undefined;

afterEach(() => {
  dom?.window.close();
  dom = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('cloud dashboard cone counts', () => {
  it('shows counts without disabling create at the former cap', async () => {
    const html = await readFile(new URL('../../cloud/index.html', import.meta.url), 'utf8');
    dom = new JSDOM(html, { url: 'https://www.sliccy.ai/cloud' });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('localStorage', dom.window.localStorage);

    dom.window.localStorage.setItem('cloud-ims-token', 'token');
    dom.window.localStorage.setItem('cloud-ims-token-exp', String(Date.now() + 60_000));

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith('/api/cloud/config')) {
          return Response.json({
            imsRelayUrl: 'https://www.sliccy.ai/auth/callback',
            imsReceivePath: '/auth/cloud-callback',
            adobeModels: [],
          });
        }
        if (url.endsWith('/api/cloud/list')) {
          return Response.json({
            cones: [
              {
                sandboxId: 'running-1',
                state: 'running',
                lastSeen: new Date().toISOString(),
                joinUrl: 'https://www.sliccy.ai/join/running-1',
              },
              ...Array.from({ length: 5 }, (_, index) => ({
                sandboxId: `paused-${index + 1}`,
                state: 'paused',
                lastSeen: new Date().toISOString(),
                joinUrl: '',
              })),
            ],
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );

    // @ts-expect-error plain-JS cloud dashboard module ships no types
    await import('../../cloud/app.js');

    await vi.waitFor(() => {
      expect(document.getElementById('cone-counts')?.textContent).toBe('1 running · 5 paused');
    });
    const createButton = document.getElementById('create-btn') as HTMLButtonElement;
    expect(createButton.disabled).toBe(false);
    expect(createButton.title).toBe('');
  });
});
```

- [ ] **Step 2: Run both focused suites and confirm the old cap response/UI fails**

Run:

```bash
npm run test -w @slicc/cloudflare-worker -- tests/cloud-config.test.ts
npx vitest run --project webapp packages/webapp/tests/cloud/cloud-dashboard.test.ts
```

Expected: the config test FAILS because cap fields are returned; the dashboard test FAILS because `cone-counts` does not exist and the Start button is disabled at 1/5.

- [ ] **Step 3: Remove cap parsing from cloud config and environment types**

In `packages/cloudflare-worker/src/cloud/handler-config.ts`, reduce `ConfigEnv` to:

```ts
export interface ConfigEnv {
  ADOBE_PROXY_ENDPOINT?: string;
  IMS_RELAY_URL?: string;
}
```

Delete `parseCapLimit` and the worker-cap validation block. Keep proxy error handling unchanged. The successful response must be:

```ts
return Response.json({
  imsClientId: proxy.clientId,
  imsEnvironment: proxy.imsEnvironment,
  imsAuthorizeUrl: IMS_AUTHORIZE_URLS[proxy.imsEnvironment] || IMS_AUTHORIZE_URLS.prod!,
  imsScope: proxy.scopes,
  imsRelayUrl: relayUrl,
  imsReceivePath: RECEIVE_PATH,
  adobeModels: (proxy.models ?? []).map((m) => ({ id: m.id, name: m.name })),
});
```

Delete `CONE_CAP_RUNNING` and `CONE_CAP_PAUSED` from `CloudEnv` in `packages/cloudflare-worker/src/cloud/handlers.ts`, from `WorkerEnv` in `packages/cloudflare-worker/src/index.ts`, and from `makeCloudEnv` in `packages/cloudflare-worker/tests/cloud-handlers-helpers.ts`.

Delete both cap variables and their “Cloud cone concurrency caps” comments from production and staging `vars` in `packages/cloudflare-worker/wrangler.jsonc`.

- [ ] **Step 4: Remove dashboard cap terminology and control gating**

In `packages/webapp/cloud/index.html`, replace the count element with:

```html
<div id="cone-counts" class="cone-counts"></div>
```

In `packages/webapp/cloud/styles.css`, rename `.cap-info` to `.cone-counts` without changing its declarations.

At the end of `renderCones` in `packages/webapp/cloud/app.js`, replace all cap logic with:

```js
const running = cones.filter((c) => c.state === 'running' || c.state === 'reserved').length;
const paused = cones.filter((c) => c.state === 'paused').length;
document.getElementById('cone-counts').textContent = `${running} running · ${paused} paused`;
```

Do not change the separate click-handler logic that disables `createBtn` only while a start request is in flight.

- [ ] **Step 5: Update package documentation**

In `packages/cloud-core/CLAUDE.md`, describe `src/operations/start.ts` as:

```md
| `src/operations/start.ts` | `startCone` + `reserveConeStart` (worker atomically records an in-flight named start under `blockConcurrencyWhile`, then performs slow sandbox creation outside the lock) |
```

In `packages/cloudflare-worker/CLAUDE.md`:

- Delete the `src/cloud/caps.ts` module-map row.
- Delete the `CONE_CAP_RUNNING`, `CONE_CAP_PAUSED` environment-variable entry.
- Add this sentence to the cloud lifecycle description:

```md
E2B is the sandbox-capacity authority; the worker does not impose separate running or paused cone-count limits. Per-user endpoint token buckets in `src/cloud/rate-limit.ts` remain the abuse-protection boundary.
```

- [ ] **Step 6: Run focused tests, lint checks, and a cap-reference scan**

Run:

```bash
npm run test -w @slicc/cloudflare-worker -- \
  tests/cloud-config.test.ts tests/cloud-handlers.test.ts tests/cloud-sessions-do.test.ts \
  tests/rate-limit.test.ts
npx vitest run --project webapp packages/webapp/tests/cloud/cloud-dashboard.test.ts
npm run lint:docs
git grep -nE 'CONE_CAP_RUNNING|CONE_CAP_PAUSED|CAP_EXCEEDED|capRunning|capPaused|reserveSlot|cap-info' -- \
  packages ':!packages/node-server/tests' || true
```

Expected: tests and docs lint PASS. The grep emits no matches; `autoPauseOnCap` is intentionally outside the searched terms because it controls E2B timeout lifecycle rather than cone counts.

- [ ] **Step 7: Commit configuration, dashboard, tests, and docs**

```bash
git add packages/cloudflare-worker/src/cloud/handler-config.ts \
  packages/cloudflare-worker/src/cloud/handlers.ts \
  packages/cloudflare-worker/src/index.ts \
  packages/cloudflare-worker/wrangler.jsonc \
  packages/cloudflare-worker/tests/cloud-config.test.ts \
  packages/cloudflare-worker/tests/cloud-handlers-helpers.ts \
  packages/webapp/cloud/app.js \
  packages/webapp/cloud/index.html \
  packages/webapp/cloud/styles.css \
  packages/webapp/tests/cloud/cloud-dashboard.test.ts \
  packages/cloud-core/CLAUDE.md \
  packages/cloudflare-worker/CLAUDE.md
git commit -m "feat(cloud): rely on E2B sandbox capacity"
```

---

### Task 4: Run Full Verification

**Files:**

- Verify all files changed in Tasks 1-3.
- Modify only files changed automatically by the repository formatter, and include those formatting changes in a dedicated commit if needed.

**Interfaces:**

- Consumes: the completed uncapped cloud lifecycle and dashboard.
- Produces: warning-free evidence for lint, types, tests, coverage, builds, and complexity.

- [ ] **Step 1: Confirm the intended diff and absence of retired symbols**

Run:

```bash
git status --short
git diff main...HEAD --stat
git grep -nE 'CONE_CAP_RUNNING|CONE_CAP_PAUSED|CAP_EXCEEDED|capRunning|capPaused|reserveSlot|cap-info' -- \
  packages ':!packages/node-server/tests' || true
```

Expected: only planned files are changed, and the retired-symbol grep prints nothing.

- [ ] **Step 2: Run lint first and review formatter changes**

Run:

```bash
npm run lint
git status --short
git diff --check
```

Expected: lint and whitespace checks PASS with no warnings. If lint formats planned files, inspect and commit only those deterministic formatting changes:

```bash
git add packages/cloud-core packages/cloudflare-worker packages/webapp
git commit -m "style: format cloud cap removal"
```

Skip that commit when `git status --short` is clean.

- [ ] **Step 3: Run typechecks and focused package tests**

Run:

```bash
npm run typecheck
npm run test -w @slicc/cloud-core
npm run test -w @slicc/cloudflare-worker
npx vitest run --project webapp packages/webapp/tests/cloud
```

Expected: all commands PASS with no warnings.

- [ ] **Step 4: Run coverage gates**

Run:

```bash
npm run test:coverage:cloud-core
npm run test:coverage:cloudflare-worker
npm run test:coverage:webapp
```

Expected: every package remains above its committed coverage floor.

- [ ] **Step 5: Run the complete test and build pass**

Run:

```bash
npm run test
npm run build
npm run build -w @slicc/chrome-extension
npm run build -w @slicc/cloudflare-worker
```

Expected: all tests and builds PASS. Wrangler's worker dry-run reports a valid bundle.

- [ ] **Step 6: Run the touched-file complexity gate and diagnostics**

Run:

```bash
node packages/dev-tools/tools/check-touched-exemptions.mjs
git diff --check
git status --short --branch
```

Then run `lens_diagnostics` with `mode=all` for all edited files.

Expected: complexity, whitespace, and diagnostics are clean; the branch contains only the planned commits and has no uncommitted changes.
