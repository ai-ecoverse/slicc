# Plan C — Workers + e2b SDK compatibility spike

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify the e2b SDK works in the Cloudflare Workers runtime before committing Plan D to the worker-resident architecture. Output is a go/no-go verdict + the minimal worker route that exercises the SDK end-to-end. If the spike fails on any criterion, Plan D switches to a dedicated Node-service architecture without rewriting handlers.

**Architecture:** Add a temporary `/spike/*` route surface to `packages/cloudflare-worker/` that exercises `Sandbox.create`, `files.write`, `commands.run`, `pause`, `resume`, `kill`. Deploy to staging, time the calls, measure bundle size, verify the E2B_API_KEY isn't browser-reachable. Write a verdict doc summarising results.

**Tech Stack:** Cloudflare Workers (Wrangler), e2b SDK v2.

**Spec:** `docs/superpowers/specs/2026-05-26-cloud-cones-on-sliccy-ai-design.md` § "Phase 0 — Workers + e2b SDK spike".

**Time box:** 2 days. If any pass-criterion fails AND you've spent 2 days, write up the Node-service fallback verdict instead of trying to make it work.

**Depends on:** Plan A complete — specifically Task A5b ("Make the e2b adapter worker-safe"). The spike imports `createSubstrate` from `@slicc/cloud-core`, NOT raw `e2b`, so we validate the exact same code path Plan D uses. Spiking against raw e2b would miss adapter-level issues (process.env mutation, missing apiKey on connect/list) that would only surface after Plan D ships.

---

## Exit criteria (from spec)

| #   | Criterion                                                                                            | Pass                                              | Fail action                                                                              |
| --- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| C-1 | `Sandbox.create` + `files.write` + `commands.run` + `pause`/`resume`/`kill` run in a Workers runtime | works                                             | Pivot Plan D to Node-service architecture (separate plan if needed)                      |
| C-2 | Worker bundle stays under CF size limit with e2b SDK included                                        | bundle ≤ 10 MiB compressed (per CF docs)          | Same pivot                                                                               |
| C-3 | `Sandbox.create` with readyCmd completes within 60s                                                  | round-trip ≤ 60s on Adobe team account            | Switch Plan D `/start` to async pattern (immediate sandboxId, dashboard polls `/status`) |
| C-4 | `E2B_API_KEY` is unreachable from the browser                                                        | confirmed via bundle source + response inspection | Hard blocker — design must change before continuing                                      |

---

### Task C1: Add e2b dependency to cloudflare-worker

**Files:**

- Modify: `packages/cloudflare-worker/package.json`
- Modify: `packages/cloudflare-worker/wrangler.jsonc` — confirm `compatibility_date` ≥ 2024-09-23 (date when Workers gained Node.js compat for full e2b SDK use; check wrangler docs at spike time)
- Modify: `packages/cloudflare-worker/wrangler.jsonc` — enable `node_compat` / `compatibility_flags: ["nodejs_compat"]` if e2b SDK needs Node built-ins

- [ ] **Step 1: Add e2b to worker deps**

```bash
npm install --workspace @slicc/cloudflare-worker e2b
```

This adds e2b to the worker's package.json deps.

- [ ] **Step 2: Check Workers compatibility flag**

Read `packages/cloudflare-worker/wrangler.jsonc`. Look for `compatibility_flags`. If `nodejs_compat` isn't present, add it:

```jsonc
{
  // ... existing config ...
  "compatibility_date": "2026-01-01",
  "compatibility_flags": ["nodejs_compat"],
}
```

(Check current Cloudflare Workers docs for the canonical flag name. As of the spec date, it's `nodejs_compat`.)

- [ ] **Step 3: Verify the worker still builds**

```bash
npm run build -w @slicc/cloudflare-worker
```

Expected: build succeeds (the e2b dep is present but unused so far).

- [ ] **Step 4: Measure bundle baseline**

```bash
ls -la packages/cloudflare-worker/dist/
```

Note the size of the largest file. This is the baseline before any spike code.

- [ ] **Step 5: Commit**

```bash
git add packages/cloudflare-worker/package.json packages/cloudflare-worker/wrangler.jsonc package-lock.json
git commit -m "spike(worker): add e2b SDK dependency (Plan C)"
```

---

### Task C2: Write the minimal spike route

**Files:**

- Create: `packages/cloudflare-worker/src/spike/cloud-spike.ts`
- Modify: `packages/cloudflare-worker/src/index.ts` — register the spike routes (gated by env flag)

- [ ] **Step 1: Create the spike module**

```ts
// packages/cloudflare-worker/src/spike/cloud-spike.ts
//
// TEMPORARY: this file exists only for Plan C (Workers + e2b compat spike).
// Removed when Plan D ships. Do not import from here in real handlers.

import { createSubstrate, type SandboxSubstrate } from '@slicc/cloud-core';

interface SpikeEnv {
  E2B_API_KEY: string;
  SPIKE_ENABLED: string;
}

/**
 * Spike via @slicc/cloud-core's `createSubstrate` — same code path Plan D's
 * handlers use. If the adapter has Workers-incompatible bits (process.env
 * mutation, missing apiKey on connect/list), this spike surfaces them.
 */
export async function handleSpike(request: Request, env: SpikeEnv): Promise<Response> {
  const url = new URL(request.url);
  if (env.SPIKE_ENABLED !== '1') return new Response('spike disabled', { status: 404 });
  if (!env.E2B_API_KEY) return new Response('E2B_API_KEY missing', { status: 500 });

  const substrate = createSubstrate('e2b', { apiKey: env.E2B_API_KEY });
  const op = url.pathname.replace('/spike/', '');
  switch (op) {
    case 'create':
      return runCreate(substrate);
    case 'pause':
      return runPause(substrate, request);
    case 'resume':
      return runResume(substrate, request);
    case 'kill':
      return runKill(substrate, request);
    case 'list':
      return runList(substrate);
    default:
      return new Response(`unknown spike op: ${op}`, { status: 404 });
  }
}

async function runCreate(substrate: SandboxSubstrate): Promise<Response> {
  const t0 = Date.now();
  const handle = await substrate.create({
    template: 'slicc',
    autoPauseOnCap: false,
    metadata: { source: 'plan-c-spike' },
    envVars: { ADOBE_IMS_TOKEN: 'spike-fake-token' },
  });
  const createdMs = Date.now() - t0;
  await handle.writeFile('/tmp/spike.txt', 'hello from worker via cloud-core');
  const result = await handle.run('cat /tmp/spike.txt');
  return Response.json({
    sandboxId: handle.sandboxId,
    createdMs,
    fileRoundtripStdout: result.stdout,
    exitCode: result.exitCode,
  });
}

async function runPause(substrate: SandboxSubstrate, request: Request): Promise<Response> {
  const { sandboxId } = (await request.json()) as { sandboxId: string };
  const handle = await substrate.connect(sandboxId);
  const t0 = Date.now();
  await handle.pause();
  return Response.json({ ok: true, pausedMs: Date.now() - t0 });
}

async function runResume(substrate: SandboxSubstrate, request: Request): Promise<Response> {
  const { sandboxId } = (await request.json()) as { sandboxId: string };
  const t0 = Date.now();
  const handle = await substrate.connect(sandboxId);
  const result = await handle.run('echo resumed');
  return Response.json({ ok: true, resumedMs: Date.now() - t0, stdout: result.stdout });
}

async function runKill(substrate: SandboxSubstrate, request: Request): Promise<Response> {
  const { sandboxId } = (await request.json()) as { sandboxId: string };
  const handle = await substrate.connect(sandboxId);
  await handle.kill();
  return Response.json({ ok: true });
}

async function runList(substrate: SandboxSubstrate): Promise<Response> {
  const items = await substrate.list();
  return Response.json({ count: items.length, items });
}
```

This validates: substrate.create + writeFile + run via cloud-core (C-1), the cloud-core adapter under Workers' Node-compat (C-2 implicit), wall-clock for create (C-3), and the fact that apiKey is passed through cloud-core's substrate WITHOUT process.env mutation (C-4 + the key never reaches the browser).

- [ ] **Step 2: Wire the route**

In `packages/cloudflare-worker/src/index.ts`, find the request dispatcher and add at the top:

```ts
import { handleSpike } from './spike/cloud-spike.js';

// inside the main fetch handler, BEFORE the existing route table:
if (url.pathname.startsWith('/spike/')) {
  return handleSpike(request, env);
}
```

- [ ] **Step 3: Update worker-configuration.d.ts**

Make sure `SPIKE_ENABLED` and `E2B_API_KEY` are typed on `Env`. They get set as Wrangler secrets later; the type declaration just needs them present.

```ts
// in packages/cloudflare-worker/worker-configuration.d.ts (extend Env)
interface Env {
  // ... existing fields ...
  E2B_API_KEY: string;
  SPIKE_ENABLED: string;
}
```

- [ ] **Step 4: Typecheck + build**

```bash
npm run typecheck
npm run build -w @slicc/cloudflare-worker
```

Expected: clean.

- [ ] **Step 5: Measure spike-bundle size**

```bash
ls -la packages/cloudflare-worker/dist/
```

Record the delta vs the baseline from Task C1 Step 4. The e2b SDK is ~6MB unminified — bundle should still fit under Workers' 10MiB compressed limit. **If bundle is too big, this is C-2 failure** — stop and write the verdict (Task C5) with fail.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "spike(worker): /spike/{create,pause,resume,kill} routes for Plan C verification"
```

---

### Task C3: Test spike locally with wrangler dev

**Files:** none (validation)

- [ ] **Step 1: Set spike secrets**

```bash
cd packages/cloudflare-worker
npx wrangler secret put E2B_API_KEY
# (paste your Adobe team E2B_API_KEY when prompted)
npx wrangler secret put SPIKE_ENABLED
# (enter "1" when prompted)
```

Or for `wrangler dev` mode, set in `.dev.vars`:

```
echo 'E2B_API_KEY=<value>' >> packages/cloudflare-worker/.dev.vars
echo 'SPIKE_ENABLED=1' >> packages/cloudflare-worker/.dev.vars
echo packages/cloudflare-worker/.dev.vars >> .gitignore  # ensure not committed
```

- [ ] **Step 2: Run wrangler dev**

```bash
npx wrangler dev --config packages/cloudflare-worker/wrangler.jsonc
```

In another terminal:

```bash
curl -s http://localhost:8787/spike/create
```

Expected: JSON response with `sandboxId`, `createdMs`, `fileRoundtripStdout: 'hello from worker'`. The `createdMs` value answers criterion C-3 (≤ 60s pass).

- [ ] **Step 3: Test pause/resume/kill**

```bash
SBX=<sandboxId from previous response>

curl -s -X POST http://localhost:8787/spike/pause \
  -H 'content-type: application/json' \
  -d "{\"sandboxId\": \"$SBX\"}"
# { ok: true, pausedMs: ... }

curl -s -X POST http://localhost:8787/spike/resume \
  -H 'content-type: application/json' \
  -d "{\"sandboxId\": \"$SBX\"}"
# { ok: true, resumedMs: ..., stdout: "resumed" }

curl -s -X POST http://localhost:8787/spike/kill \
  -H 'content-type: application/json' \
  -d "{\"sandboxId\": \"$SBX\"}"
# { ok: true }
```

Record each round-trip time. If `createdMs` > 30s but ≤ 60s, that's a yellow flag for criterion C-3 — note it in the verdict.

- [ ] **Step 4: Verify E2B_API_KEY not in response or bundle**

```bash
grep -r "$E2B_API_KEY" packages/cloudflare-worker/dist/ || echo "OK — key not in bundle"
```

Inspect the response body / headers of `/spike/create` — confirm the api key isn't echoed.

If the api key leaks anywhere visible to the browser, that's **C-4 failure** — record verdict.

- [ ] **Step 5: No commit** — validation only

---

### Task C4: Deploy to staging and re-verify

**Files:** none (deployment validation)

- [ ] **Step 1: Set staging secrets**

```bash
cd packages/cloudflare-worker
npx wrangler secret put E2B_API_KEY --env staging
npx wrangler secret put SPIKE_ENABLED --env staging
```

- [ ] **Step 2: Deploy**

```bash
npx wrangler deploy --env staging --config packages/cloudflare-worker/wrangler.jsonc
```

Note the deployed URL.

- [ ] **Step 3: Hit the spike routes against staging**

```bash
STAGING=<deployed-staging-url>

curl -s "$STAGING/spike/create"
# capture sandboxId + createdMs
```

The staging path runs under real Workers CPU + wall budgets. If `createdMs` > 30s, Workers might have killed the request — check `wrangler tail --env staging` for timeout errors.

- [ ] **Step 4: Test the full cycle against staging**

Mirror Task C3 Step 3 against the staging URL. Record timings.

- [ ] **Step 5: Disable spike on staging**

```bash
# Set SPIKE_ENABLED to 0 to lock the route off when not actively testing.
# Or remove the secret:
npx wrangler secret delete SPIKE_ENABLED --env staging
```

- [ ] **Step 6: No commit** — validation only

---

### Task C5: Write the verdict document

**Files:**

- Create: `docs/superpowers/specs/2026-05-26-cloud-cones-spike-verdict.md`

- [ ] **Step 1: Write the verdict**

Template (fill in real numbers):

```markdown
# Plan C verdict — Workers + e2b SDK compatibility

**Date:** YYYY-MM-DD
**Spike duration:** N hours over M days
**Decision:** PASS / PASS-WITH-CAVEATS / FAIL

## Results by criterion

| #   | Criterion                                                                  | Result                   | Notes                                                 |
| --- | -------------------------------------------------------------------------- | ------------------------ | ----------------------------------------------------- |
| C-1 | Sandbox.create + files.write + commands.run + pause/resume/kill in Workers | PASS / FAIL              | <one line>                                            |
| C-2 | Worker bundle ≤ 10 MiB compressed with e2b SDK                             | <N MiB>                  | <delta vs baseline>                                   |
| C-3 | Sandbox.create round-trip ≤ 60s                                            | <max observed createdMs> | <e.g. mostly 25-35s; one outlier 55s>                 |
| C-4 | E2B_API_KEY unreachable from browser                                       | PASS / FAIL              | <evidence — bundle grep result + response inspection> |

## Timings observed (local + staging)

| Operation | Local (wrangler dev) | Staging (deployed) |
| --------- | -------------------- | ------------------ |
| create    | <ms>                 | <ms>               |
| pause     | <ms>                 | <ms>               |
| resume    | <ms>                 | <ms>               |
| kill      | <ms>                 | <ms>               |

## Decision

PASS path: Plan D proceeds against Workers + e2b SDK. The synchronous /start handler pattern (block until joinUrl ready) is viable.

PASS-WITH-CAVEATS path: viable but with adjustments noted below. Examples:

- create takes >30s typically → /start moves to async pattern (return sandboxId immediately, dashboard polls /status).
- Bundle near size limit → strip dynamic imports, mark e2b sub-deps external where possible.

FAIL path: Plan D pivots to a dedicated Node service (Cloud Run / Adobe-internal host). Worker becomes a reverse proxy. Specifics of the fallback:

- Service language: Node 22 (reuse @slicc/cloud-core directly without Workers-compat concerns).
- Auth: IMS JWT validation moves to the service (mirrors the worker's auth.ts shape).
- Per-user state: same DurableObject pattern doesn't apply — switch to per-service-instance routing OR move state to a real DB (Postgres / KV). Pick at design time.
- Sliccy.ai/cloud dashboard still served by the worker; /api/cloud/\* proxied to the service.
- Estimated additional plan size: ~10 tasks on top of Plan D.

## Spike cleanup

- [ ] Spike routes left in `packages/cloudflare-worker/src/spike/` for reference until Plan D's /api/cloud/\* handlers ship. Removed in Plan D's final cleanup task.
- [ ] SPIKE_ENABLED secret unset in production. Local .dev.vars gitignored.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-05-26-cloud-cones-spike-verdict.md
git commit -m "docs(spike): record Plan C verdict for Workers + e2b SDK compatibility"
```

---

### Task C6: Decide — proceed to Plan D or pivot

**Files:** none (decision)

- [ ] **Step 1: Read your own verdict**

Open the verdict doc you just wrote. Be honest about which criteria passed.

- [ ] **Step 2: If PASS / PASS-WITH-CAVEATS**

Proceed to Plan D. If criterion C-3 was caveat'd ("create takes 35s+"), adjust Plan D Task D9 to use the async `/start` pattern instead of synchronous. Other caveats get one-line adjustments to the relevant Plan D task.

- [ ] **Step 3: If FAIL**

Plan D as written is invalid. Two options:

- A. Write a separate plan (`2026-05-26-plan-D-node-service.md`) sketching the Node service architecture. Mostly a substitution for D's handlers + DO sections; the auth pipeline / cloud-core consumers / dashboard SPA stay the same.
- B. Accept fail and document the project as blocked pending an architectural redesign.

Pick A unless the team explicitly decides B.

- [ ] **Step 4: Commit cleanup if any**

(No code commit; the decision is recorded in the verdict doc.)

---

## Plan C done

End state: a verdict document plus a working `/spike/*` surface in the cloudflare-worker. The verdict is the gating artifact — Plan D execution starts (or pivots) based on it.

**Cleanup**: the `/spike/*` surface stays in the codebase as a `wrangler.jsonc`-gated artifact until Plan D's final task removes it. Don't ship `SPIKE_ENABLED=1` to production at any time.
