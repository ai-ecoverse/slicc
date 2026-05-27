# Cloud cones on sliccy.ai — design

> **Supersedes**: the "Web UI on sliccy.ai" non-goal in `docs/superpowers/specs/2026-05-22-hosted-slicc-e2b-design.md`. The hosted-leader feature lands on the web here.

## Goal

Move the hosted-leader feature from "laptop-CLI-only" to "web-accessible at sliccy.ai/cloud" so Adobe employees can spawn, list, pause/resume, and kill their own cloud cones from any browser without needing the CLI installed. The CLI path (`slicc --cloud …`) stays in place for power users; this adds a parallel web entry point.

## Audience and scope

- **Audience**: Adobe employees, gated via IMS sign-in. v2 expands to any IMS identity with an `ownerOrg` claim (i.e., users of Adobe-org Adobe products). No public/anonymous access.
- **In scope (v1)**: dashboard at `sliccy.ai/cloud` with sign-in, create, list, pause, resume, kill. Per-user caps enforced server-side. Adobe team e2b account pays the bill.
- **Out of scope**: see "Explicit non-goals" at the end.

## Architecture overview

```
sliccy.ai (existing CF worker)
  ├── /cloud                          ← dashboard SPA (HTML/JS, static assets)
  ├── /api/cloud/*                    ← REST API, IMS-Bearer-auth, routes to per-user DO
  ├── /auth/cloud-callback            ← IMS implicit-grant callback (reuses in-app pattern)
  ├── CloudSessionsDurableObject      ← NEW. one per IMS userId. holds cone list.
  └── SessionTrayDurableObject        ← UNCHANGED. one per tray.

       ↓ (worker → e2b SDK)

e2b sandbox (existing 'slicc' template, slightly modified)
  ├── node-server in --hosted mode    ← UNCHANGED
  ├── start.sh                        ← writes /slicc/secrets.env from env vars before exec
  ├── /api/hosted-bootstrap           ← UNCHANGED, exposes injected ADOBE_IMS_TOKEN
  └── /api/leader-restart             ← UNCHANGED, kicked by worker on resume
```

The orchestration logic is **factored into a new shared package** (`packages/cloud-core/`, exact placement decided during plan) consumed by BOTH the laptop CLI (existing `packages/node-server/src/cloud/`) AND the cloudflare-worker (new). The worker is a thin handler layer; the operations themselves live in `cloud-core`. See the next section for details — this is a v1 architectural commitment to prevent the dual-codebase drift that the alternative ("worker reimplements against e2b SDK") would inevitably produce.

## Shared orchestration module

`packages/cloud-core/` is a new package depending only on `@slicc/shared-ts` (and a peer-dep `e2b` for the substrate types). Browser-and-Node-safe; no `node:fs` at module load.

**Exports**:

```typescript
// substrate.ts — interface + factory; same shape as packages/node-server/src/cloud/substrate.ts
export interface SandboxSubstrate { … }
export interface SandboxHandle    { … }
export type SubstrateId = 'e2b';
export function createSubstrate(id, config): SandboxSubstrate;

// operations.ts — pure functions, no I/O of their own. Take a substrate +
// a "registry" abstraction (read/write/findByNameOrId/list) + opts.
export async function startCone(deps, opts): Promise<StartResult>;
export async function listCones(deps): Promise<Cone[]>;
export async function pauseCone(deps, query): Promise<void>;
export async function resumeCone(deps, opts): Promise<ResumeResult>;
export async function killCone(deps, query): Promise<void>;

// registry.ts — Registry interface (NOT implementation). Two implementations
// live in their consumers:
//   - packages/node-server: file-backed (~/.slicc/cloud-sessions.json) — existing
//   - packages/cloudflare-worker: DO-backed (CloudSessionsDurableObject)
export interface Registry {
  list(): Promise<ConeEntry[]>;
  findByNameOrId(query): Promise<ConeEntry | null>;
  append(entry): Promise<void>;
  update(id, patch): Promise<void>;
  remove(id): Promise<void>;
}

// errors.ts — shared error codes (CAP_EXCEEDED, NOT_FOUND, LEADER_NOT_READY,
// SANDBOX_NOT_READY, ALREADY_PAUSED, ALREADY_RUNNING, CDP_NOT_READY).

// secrets-filter.ts — filterSecretsEnv (strip E2B_API_KEY*). Existing fn moves
// from packages/node-server/src/cloud/start.ts to here.

// polling.ts — pollCloudStatus, pollForRefreshedStatus. Move from
// packages/node-server/src/cloud/{start,resume}.ts. The "stale file vs missing
// file" diagnostic improvements from commit ca8d34ae come along.

// types.ts — ConeEntry, CloudStatus, ResumeResult, StartResult shapes.
```

**Migration approach** (locked in for v1):

- Move existing files from `packages/node-server/src/cloud/{substrate.ts,operations,start,list,pause,resume,kill}.ts` into `packages/cloud-core/`.
- node-server's `packages/node-server/src/cloud/` shrinks to: `dispatch.ts` (CLI parser), `Registry` impl (file-backed), and a thin shim wiring `cloud-core` operations to the CLI command output formatter.
- cloudflare-worker imports `cloud-core` directly. Its `Registry` impl is DO-backed. Its handler files are thin route shims that call `cloud-core` operations.
- The `FakeSubstrate` testing helper moves with it; both consumers test against the same fake.

**Operation-by-operation responsibility split**:

| Layer                                    | Consumer    | What lives here                                                                                      |
| ---------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------- |
| `cloud-core/operations`                  | shared      | start/list/pause/resume/kill business logic — polling, baseline preservation, kick retry, validation |
| `cloud-core/substrate`                   | shared      | substrate interface + e2b adapter                                                                    |
| `node-server/cloud/dispatch.ts`          | CLI-only    | argv parsing, JSON-vs-pretty output formatting                                                       |
| `node-server/cloud/registry-file.ts`     | CLI-only    | file-backed registry (`~/.slicc/cloud-sessions.json`)                                                |
| `cloudflare-worker/cloud/handlers.ts`    | Worker-only | HTTP shim — extract userId, build deps, call ops                                                     |
| `cloudflare-worker/cloud/registry-do.ts` | Worker-only | DurableObject-backed registry                                                                        |
| `cloudflare-worker/cloud/auth.ts`        | Worker-only | JWT pipeline, allowlist/denylist, ownerOrg gate                                                      |

## Auth flow

The dashboard reuses the existing in-app IMS OAuth flow (implicit grant, `response_type=token`), with browser-held tokens sent as `Authorization: Bearer` on every API call.

```
User → sliccy.ai/cloud
  ↓ (no token in localStorage)
Dashboard JS → opens IMS authorize popup, response_type=token
  ↓ (consent / SSO)
IMS → /auth/cloud-callback#access_token=…&expires_in=…
Callback page → postMessage to opener, closes
Dashboard → localStorage['cloud-ims-token'] = token, renders list
  ↓
Every API call → Authorization: Bearer <token>
  ↓
Worker validates JWT (see Validation pipeline below)
       → routes to env.CLOUD_SESSIONS.idFromName(userId)
```

**Validation pipeline (in order)**:

1. JWT signature verification via `jose.jwtVerify` against cached IMS jwks (RS256).
2. `payload.iss === expectedIssuer` and `payload.client_id === env.IMS_CLIENT_ID`.
3. `payload.type === 'access_token'`.
4. Extract `email` and `ownerOrg` from JWT claims; fall back to `GET /ims/profile/v1` with Bearer if either is missing.
5. Email-domain allowlist: `env.ALLOWED_EMAIL_DOMAIN` (CSV, default `adobe.com`, `*` to disable).
6. Email denylist: `env.BLOCKED_EMAILS` (CSV, lowercased, trimmed). Denial wins over allow.
7. Optional org gate: if `env.REQUIRE_OWNER_ORG === 'true'`, reject when `ownerOrg` is empty.

Cache the validated `AuthResult` keyed by `SHA-256(token)` with TTL = `min(10min, tokenExp − now)`. Same library + cache shape as proven authentication patterns elsewhere in the codebase.

**"No refresh" tradeoff**: implicit grant doesn't return refresh tokens. When a token expires (Adobe IMS access tokens typically 24h), the dashboard catches the next 401, re-launches the IMS popup, transparently re-fires the request. With SSO this is zero-click; with fresh sessions it's the standard consent screen. Acceptable for internal tool.

**v1.1 note**: if Adobe IMS policy ever blocks new clients from using implicit grant, the dashboard migrates to authorization-code + PKCE with a small BFF in the worker. Same callback surface, different exchange. Not v1 work.

## API surface

All endpoints are under `/api/cloud/*`, all require `Authorization: Bearer <ims-access-token>`, all return JSON.

```
POST /api/cloud/start    body: { name?: string }
   200 { sandboxId, name, joinUrl, trayId, createdAt }
   403 CAP_EXCEEDED       (running >= 1 or paused >= 5)
   503 SANDBOX_NOT_READY  (e2b boot timed out)

GET  /api/cloud/list
   200 { cones: [{ sandboxId, name, state, joinUrl, createdAt, lastSeen }] }

POST /api/cloud/pause    body: { sandboxId }
   200 { ok: true }
   404 NOT_FOUND
   409 ALREADY_PAUSED

POST /api/cloud/resume   body: { sandboxId }
   200 { sandboxId, joinUrl, trayRebuilt }
   403 CAP_EXCEEDED       (resume would push running over CONE_CAP_RUNNING)
   404 NOT_FOUND
   409 ALREADY_RUNNING
   503 LEADER_NOT_READY   (post-resume Page.reload kick failed)

POST /api/cloud/kill     body: { sandboxId }
   200 { ok: true }                 (idempotent: returns 200 if already gone)
   404 NOT_FOUND
```

**Error response envelope** (uniform across all endpoints):

```json
{
  "error": "CAP_EXCEEDED",
  "message": "1/1 running cones; pause or kill another first.",
  "details": { "running": 1, "paused": 2, "cap": { "running": 1, "paused": 5 } }
}
```

`error` is a stable machine code (dashboard switches on it). `message` is human-readable. `details` is optional, endpoint-specific.

Middleware order on every request:

```
authBearer    — verify JWT against IMS jwks; extract userId from sub claim
loadUserDO    — env.CLOUD_SESSIONS.idFromName(userId) → stub
checkCap      — on /start AND /resume; rejects if the transition would
                exceed CONE_CAP_RUNNING (counts cones currently running plus
                the one about to transition). Pause/kill never check.
rateLimit     — soft per-user limit: 30 starts/hour, 60 list/min. Returns 429
                with retry-after. Defense against bug-loops; not a security
                feature.
```

## State storage

One `CloudSessionsDurableObject` instance per IMS user, keyed by `userId` (IMS `sub` claim, the unique stable IMS user-id like `E376851E585957EB0A495CC4@adobe.com`).

```typescript
interface CloudSessionsState {
  cones: Array<{
    sandboxId: string;
    name: string;
    state: 'running' | 'paused';
    joinUrl: string;
    trayId: string;
    createdAt: string;
    lastSeen: string;
  }>;
  // No auth state stored — browser holds the Bearer, worker uses whatever
  // arrives on each request. Implicit-grant means no refresh tokens to store.
}
```

**Properties this gives for free**:

- **Per-user isolation**: User A's `/list` cannot return User B's cones. Different DO instance.
- **Cross-device consistency**: Same userId → same DO globally → laptop and phone see the same list.
- **Concurrent-write safety**: DO is single-threaded; rapid-fire actions serialize cleanly.
- **Defense in depth**: each e2b sandbox is also tagged with `metadata.userId` at create; if DO state is ever lost, the user's cone list can be reconstructed by listing e2b sandboxes filtered by metadata.

## Concurrency and idempotency

DO is single-threaded but `Sandbox.create` is a network call that yields. Without care, a double-click "Create" could (a) pass the cap check twice and (b) start two sandboxes.

**Resolution**: cap check + e2b create + registry append happen inside one `blockConcurrencyWhile` block in the DO. The DO holds a sequential lock for the user's entire mutation; the second click waits for the first to finish, sees the updated cap, and gets `CAP_EXCEEDED`.

**Name uniqueness**: per-user, soft. `POST /start { name: "x" }` while another running/paused cone named "x" exists → reject with `409 NAME_TAKEN` (added to the API surface). Cross-user collisions are fine (different DO).

**Idempotency**:

- `POST /kill` returns 200 whether the cone existed or not.
- `POST /pause` on already-paused: 409 `ALREADY_PAUSED` (NOT idempotent — the client should refresh and retry; auto-treating as success masks bugs).
- `POST /resume` on already-running: 409 `ALREADY_RUNNING`.
- `POST /start` is NOT idempotent — each call is a new create.

## State reconciliation

The DO is the cache; e2b is the source of truth. Drift happens (worker crash mid-operation, manual e2b sandbox deletion from the dashboard, paused cones expired past their reclaim TTL).

**On every `GET /list`** (cheap):

1. Read DO entries.
2. Call `substrate.list({ metadata: { userId } })` against e2b — this is filtered by `metadata.userId` so it's small.
3. For each DO entry: if e2b doesn't return it → mark `state: 'dead'`, surface to UI ("This cone has expired and can no longer be resumed; please kill it"). The DO entry stays until the user clicks Kill (which now just removes the registry entry).
4. For each e2b entry NOT in DO: rebuild the entry from `metadata` (name, createdAt) and add. Defense-in-depth recovery.
5. For each DO entry whose `state` disagrees with e2b's state: e2b wins; update DO.

The reconciliation runs in the DO handler, before returning. Adds ~one e2b API call per list — fine for typical list rates.

**On `POST /start` and `POST /resume`**: same reconciliation runs first (to ensure cap math is correct against real state, not stale DO state). Adds latency to mutations but eliminates "I have 1/1 running per DO but actually 0 in e2b" bugs.

**joinUrl freshness**: the leader's tray can be rebuilt on reconnect (per the `IndexedDbLeaderTraySessionStore` clear in `40fb4eaf` — every hosted-leader page boot creates a fresh tray). When this happens, the leader POSTs a new joinUrl to `/api/cloud-status` inside the sandbox; the worker doesn't automatically know. The dashboard's polling `/list` is the only mechanism that surfaces a stale joinUrl in v1 — and currently `/list` doesn't talk to the sandbox to refresh joinUrl. Two options:

- **v1**: accept that the dashboard's joinUrl can go stale silently between reloads. User notices when their follower disconnects, clicks "Open" again, gets the (possibly stale) URL. Document this.
- **v1.x**: on `/list`, for each running cone, the worker uses `sbx.commands.run('cat /tmp/slicc-join.json')` to read the current canonical joinUrl, updates DO if changed. Adds latency proportional to running-cone-count. Trade off when stale-joinUrl complaints become real.

v1 ships with the first; the spec calls this out as a known sharp edge.

## Sandbox lifecycle integration

**Boot ordering** (the timing race that matters): the existing in-sandbox bootstrap (main.ts hosted-leader branch) fetches `/api/hosted-bootstrap` ~5s after `startPageLeaderTray`. If `secrets.env` doesn't exist at that moment, the page sees no token and the Adobe provider stays unconfigured. The CLI's current `runStart` actually has the same race — it calls `Sandbox.create` first, THEN `sbx.files.write` for secrets.env. The 5s page-side delay (commit `78ff315d`) papers over it; CLI gets lucky because file upload typically completes in well under 5s. The worker can't depend on this because `Sandbox.create({ readyCmd: waitForFile(...) })` blocks until AFTER the page has run and (possibly) already missed the bootstrap window.

**Fix in the template** (eliminates the race for BOTH CLI and worker): pass the IMS token as a sandbox env var at `Sandbox.create` time; `start.sh` writes `secrets.env` from those envs BEFORE `exec`'ing node-server:

```sh
# packages/dev-tools/e2b-template/start.sh
if [ -n "$ADOBE_IMS_TOKEN" ]; then
  cat > /slicc/secrets.env <<EOF
ADOBE_IMS_TOKEN=$ADOBE_IMS_TOKEN
ADOBE_IMS_TOKEN_DOMAINS=$ADOBE_IMS_TOKEN_DOMAINS
EOF
fi
exec node /opt/slicc/node-server/index.js --hosted --port 5710 --no-open …
```

Worker calls `Sandbox.create('slicc', { envs: { ADOBE_IMS_TOKEN, ADOBE_IMS_TOKEN_DOMAINS }, metadata: { userId, name }, readyCmd: waitForFile('/tmp/slicc-join.json') })`. By the time `create` returns, the sandbox has secrets in place AND the leader has registered with the tray.

**CLI backport** (small, same change): laptop CLI's `runStart` migrates to passing the token via `envs` instead of `files.write`. Single shared substrate adapter, single boot story. Captured as part of the cloud-core extraction work.

**Resume token freshness** (NEW behavior in v1 — CLI's `runResume` today does NOT refresh secrets, only kicks leader-restart): on `/api/cloud/resume`, worker reads the current Bearer (which the dashboard refreshed via the IMS popup if needed), writes a new `/slicc/secrets.env` via `sbx.files.write`, then `sbx.commands.run` curls `/api/leader-restart`. The 5s page-side bootstrap delay re-fires after Page.reload and picks up the fresh token. CLI gets the same treatment as part of the cloud-core extraction — long-paused cones with expired tokens are an existing CLI bug this work fixes incidentally.

**API contract between worker and sandbox** (stable surfaces — changing these breaks paused cones from older templates):

```
sandbox HTTP surface:
  POST /api/leader-restart      (loopback-only inside sandbox)
  GET  /api/hosted-bootstrap    (loopback-only inside sandbox)
  POST /api/cloud-status        (loopback-only, sandbox-internal)

sandbox file surface:
  /slicc/secrets.env            (worker writes here)
  /tmp/slicc-join.json          (sandbox writes; worker reads via SDK)

sandbox env vars (consumed by start.sh):
  ADOBE_IMS_TOKEN
  ADOBE_IMS_TOKEN_DOMAINS
  SLICC_TRAY_WORKER_BASE_URL    (existing)
```

The worker code that depends on these gets an inline comment marking each call site as "STABLE API — paused cones from older templates depend on this shape; deprecation cycle required."

## Template versioning and paused-cone semantics

The `slicc` template alias is mutable (`Template.build` republishes under the same name). New `Sandbox.create('slicc', …)` always gets the latest build.

**Paused cone behavior**: e2b snapshots the entire sandbox VM at pause. When a user resumes a cone paused 5 days ago, they get back THAT image — the dist/ baked into the template at pause time. Their cone keeps the code it was paused with. Pros: work preserved exactly. Cons: long-paused cones may have known bugs that have been fixed.

This is the implicit deal with paused cones, and it requires the stable API contract above. Document inline; mention in `packages/dev-tools/e2b-template/README.md`.

**No rollback story in v1**: e2b alias doesn't support "previous build". If a release breaks the template, roll forward (revert the commit, rerun CI). v1.1 could add immutable tags alongside the alias (`slicc:v3.2.3`) for explicit rollback support.

## Deployment and CI

**Phase 0 — Workers + e2b SDK spike** (FIRST task in the plan, before any handler code).

Time-boxed to ~2 days. Exit criteria:

| Criterion                                                                                                                                         | Pass  | Fail action                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `Sandbox.create` + `files.write` + `commands.run` + `pause`/`resume`/`kill` run in a Workers runtime                                              | works | Migrate to dedicated Node service (Cloud Run / Adobe-internal host). Worker becomes a reverse proxy.                                    |
| Worker bundle stays under CF size limit with e2b SDK included                                                                                     | yes   | Same as above                                                                                                                           |
| `Sandbox.create` with readyCmd completes within 60s CPU/wall budget (network-blocked time doesn't count toward CPU, so this is mostly about wall) | yes   | Switch to async pattern: `POST /start` returns `{ sandboxId, status: 'starting' }` immediately; dashboard polls `/api/cloud/status/:id` |
| `E2B_API_KEY` stays in worker secrets only — never reachable from browser                                                                         | yes   | Hard blocker; design must change                                                                                                        |

The spike writes the smallest possible test: `wrangler dev` worker that exposes `POST /spike/start` → creates a sandbox → returns sandboxId. If it works locally, deploy to staging and confirm under real Workers limits. If any criterion fails, the plan branches to the Node-service fallback before any handler code is written.

Cadence: **on release tag** (semantic-release driven; not on every main-merge).

Extended `.github/workflows/worker.yml` runs in order:

```
1. npm run build                              # dist/ui + dist/node-server
2. npx wrangler deploy …                      # ships worker + serves dist/ui
3. bash packages/dev-tools/e2b-template/scripts/build-template.sh
                                              # rebuilds 'slicc' alias
4. bash packages/dev-tools/e2b-template/scripts/verify-template.sh
                                              # spawn-then-kill smoke
5. existing tests/deployed.test.ts            # worker route smoke
6. NEW (optional in v1): cloud E2E smoke through the live /api/cloud/*
        — only if a CI-friendly IMS auth path exists (technical-account
        token or a worker-side test bypass). If not available at impl
        time, this gets deferred — the live substrate test in step 3
        already covers the e2b round-trip; step 4 covers the template;
        steps 5 covers the worker routes. The marginal coverage is "the
        auth-middleware doesn't choke on real headers."
```

GitHub Actions secret: `E2B_API_KEY` scoped to the Adobe team. Adds ~5-10min to release (chromium apt-install layer is cached; only dist/ layers rebuild).

The local `bash packages/dev-tools/e2b-template/scripts/build-template.sh` keeps working for iterating on template Dockerfile/start.sh changes outside the release cycle.

## Local development

Four modes by fidelity, for different inner-loop needs:

| Mode                                | Worker                 | IMS                                   | e2b                                             | Sandbox-to-tray plane                                  | What it's for                                                                         |
| ----------------------------------- | ---------------------- | ------------------------------------- | ----------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| 1. Unit                             | vitest                 | mocked jwks + signed test JWT         | `FakeSubstrate`                                 | n/a                                                    | Handler logic, DO mutations, cap math, auth pipeline. ~95% of inner loop.             |
| 2. wrangler dev + fake e2b          | local                  | real (popup against `adobelogin.com`) | `FakeSubstrate` (gated by `SUBSTRATE=fake` env) | n/a                                                    | UI iteration, API shapes, real auth flow. Fake cones appear in the list.              |
| 3. wrangler dev + real e2b + tunnel | local                  | real                                  | real (Adobe team key)                           | local via `cloudflared tunnel` exposing localhost:8787 | Full E2E from a real sandbox through the dev worker. Costs e2b credits (cents/spawn). |
| 4. Staging                          | `--env staging` deploy | real (stg1 if configured)             | real                                            | staging worker URL                                     | Pre-prod verification; runs the deployed-smoke tests.                                 |

**One IMS-side setup**: the IMS app registration allows both prod (`https://www.sliccy.ai/auth/cloud-callback`) and dev (`http://localhost:8787/auth/cloud-callback`) redirect URIs.

**Mode 3 wrinkle**: the sandbox is on the public internet (e2b's infra) and can't reach `localhost`. The tunnel approach exposes the dev worker via a public HTTPS URL; the worker sets `SLICC_TRAY_WORKER_BASE_URL=<tunnel-url>` in `Sandbox.create`'s envs. Alternative: split-brain — dashboard local, tray plane at `https://www.sliccy.ai` (or staging). Tests less of the worker path but doesn't need a tunnel.

## Security considerations

**Token in localStorage**: any XSS on `sliccy.ai/cloud` could exfiltrate the IMS Bearer. Mitigations:

- Strict CSP on `/cloud` and `/auth/cloud-callback`: `default-src 'self'; script-src 'self'; connect-src 'self' https://ims-na1.adobelogin.com`. No inline scripts. No third-party origins beyond IMS.
- Subresource Integrity on any external assets (none planned for v1; the dashboard is fully self-hosted).
- The dashboard is single-purpose static HTML/JS served by the worker; no user-generated content, no markdown rendering, no postMessage from unknown origins (the IMS callback's `postMessage` is origin-checked).
- Incident response: revoke a compromised token by adding the user's email to `BLOCKED_EMAILS` and waiting up to 10min for the worker auth cache to expire. Forced flush via `clearAuthCache()`-equivalent admin endpoint (v1.1 if needed).

**Token in e2b sandbox env**: `ADOBE_IMS_TOKEN` is passed via `Sandbox.create({ envs })`. e2b stores these and they MAY appear in their dashboard, support dumps, or audit logs. Accept this as trusted-vendor risk; e2b is on Adobe's vendor list. Document in worker code: "ADOBE_IMS_TOKEN is exposed to e2b infrastructure by design; rotation TTL is bounded by IMS access-token lifetime (~24h)."

**E2B_API_KEY in Wrangler secrets**: a single shared key bills the Adobe team account. Mitigations:

- Worker secret, never reachable from browser (verified by the Phase 0 spike).
- Per-user rate limits (above) prevent any single compromised user from runaway-spawning.
- Worker alerts on sandbox count >100 in 10min (anomaly signal).
- Key rotation: standard Wrangler secret rotation process; document in worker CLAUDE.md.

**joinUrl is bearer-grade**: anyone with the URL can attach as a follower. Listed as a v1 non-goal for per-recipient sharing, but the risk needs to be visible to users:

- Dashboard's "Open" affordance has a tooltip: "This link grants follower access — only share with people you trust to see this cone's screen and chat."
- Copy-link UX shows the same warning once.
- Worker doesn't expose joinUrl in any log or metric output.

**Admin endpoint hardening**: `GET /api/cloud/admin/stats` (note: renamed from `_admin/stats` to avoid the underscore-path convention question) runs through the same JWT pipeline as user endpoints, then additionally requires `payload.sub ∈ ADMIN_USER_IDS` (env var, CSV). No IDOR: the response is aggregate counts only, never per-user PII beyond admin's own identity. Logged separately for audit.

**JWT cache invalidation**: cache by `SHA-256(token)`. Invalidate on explicit sign-out (dashboard hits a `POST /api/cloud/sign-out` that takes the token-hash off the cache; even though there's no server session, this lets us cap a compromised token to <10min remaining lifetime). Also invalidate on any 401 from the `/ims/profile/v1` fallback (token was revoked at IMS).

## Dashboard UI

Vanilla SPA served from the worker. No framework. Budget ~800-1000 LoC (IMS popup choreography, polling, cap UI, error mapping, cancel-during-create).

```
┌─ sliccy.ai/cloud ─────────────────────────────────────────┐
│  Cloud cones                            [Karl] [Sign out] │
│                                                            │
│  + New cone   [────────name (optional)───────] [Create]   │
│                                                            │
│  ┌────────────────────────────────────────────────────┐   │
│  │ ● smoke-3        running     2 min ago      Open ⤴ │   │
│  │                                       Pause  Kill  │   │
│  ├────────────────────────────────────────────────────┤   │
│  │ ○ analysis       paused      18 hr ago    Resume   │   │
│  │                                              Kill   │   │
│  └────────────────────────────────────────────────────┘   │
│                          1 running · 1 paused (cap: 1/5)   │
└────────────────────────────────────────────────────────────┘
```

**User journeys**:

- _First visit_: no token → "Sign in with Adobe" → popup → token → empty list → Create → spinner ~25s → cone with state=running → Open → new tab to joinUrl → existing follower flow.
- _Returning_: token in localStorage → validated → list rendered → click Resume → spinner ~30s → state flips, fresh joinUrl → Open.
- _Cap hit_: Create button greyed when at running cap; tooltip explains. Worker returns 403 if the client misses the gate.
- _Token expired_: 401 caught by dashboard JS → re-launches IMS popup → on success, re-fires the original request. Visible as a brief popup flash.

**Live state**: poll `/api/cloud/list` on page load, window focus, and 5s after each mutation. No SSE/WS in v1.

**Open behavior**: cone joinUrl opens in a new tab (`target="_blank"`). Follower tab is independent of the dashboard tab.

**Create cancellation**: during the ~25s create spinner the Create button becomes a Cancel button. Clicking Cancel sends `POST /api/cloud/kill { sandboxId }` against whatever sandboxId the worker has already returned (or just no-op if create hasn't reached e2b yet — the DO holds a flag). Kill of a half-spawned sandbox is safe and cheap.

**Sign-out**: clears `localStorage['cloud-ims-token']` AND hits `POST /api/cloud/sign-out` so the worker's token cache forgets the entry. The DO state stays — the user's cones persist; only the dashboard session ends.

**Errors**: top-right toast with the API-returned code (CAP_EXCEEDED, NOT_FOUND, LEADER_NOT_READY) and a one-line explanation. Full error stashed in console for debug.

## Caps and quotas

Worker-enforced hard caps stored in `env`:

```
CONE_CAP_RUNNING = 1     (max concurrent running cones per user)
CONE_CAP_PAUSED  = 5     (max paused cones per user)
```

Check happens in the `checkCap` middleware on `/api/cloud/start`. Pause/resume/kill don't check (they only move existing cones between buckets). Dashboard mirrors the cap in the UI so users see the limit before hitting it.

No "total runtime per month" cap in v1. E2B's `auto-pause-on-cap` (which we already set in the substrate) covers idle sandboxes that exceed e2b's per-sandbox runtime budget.

## Testing

| Layer          | Scope                                                                                                                                                  | Where                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Unit           | Worker handlers + DO state mutations + cap enforcement + JWT verification + reconciliation logic — mock e2b SDK at the substrate boundary              | `packages/cloudflare-worker/tests/cloud.test.ts` (new)      |
| Shared core    | `cloud-core` operations (startCone, listCones, etc.) with `FakeSubstrate` + in-memory `Registry`. Same fake used by CLI tests and worker tests.        | `packages/cloud-core/tests/`                                |
| Live opt-in    | Real e2b sandbox lifecycle via the worker substrate code — env-var-gated, same pattern as the existing `packages/node-server/tests/cloud-live.test.ts` | `packages/cloudflare-worker/tests/cloud-live.test.ts` (new) |
| Deployed smoke | One end-to-end against staging post-deploy: spawn via real API, get joinUrl, kill                                                                      | extends `tests/deployed.test.ts`                            |
| Template smoke | Confirm just-published `slicc` template boots                                                                                                          | existing `verify-template.sh` in CI                         |

**Specific test cases worth calling out** (not exhaustive, but the ones the gaps in the previous spec missed):

- **DO concurrency**: two parallel `POST /start` requests when at running cap — exactly one succeeds, the other gets `CAP_EXCEEDED`. Verifies `blockConcurrencyWhile` is correctly scoped.
- **Reconciliation drift**: DO has cone X, e2b returns X plus untracked Y, missing Z → list returns X (state from e2b), Y (rebuilt), Z (marked dead).
- **Resume without fresh token**: caller's Bearer is expired during dashboard → 401, dashboard re-auths, retries. Verifies the re-auth loop end-to-end.
- **Cap on resume**: user has 1 running + 1 paused (caps 1/5) → resume the paused one → `CAP_EXCEEDED` until they pause the running one.
- **CSP enforcement**: dashboard fetches non-allowed origin → blocked. Smoke test for the CSP header shape.
- **JWT cache invalidation**: token in cache, `/sign-out` hits → next request with same token → re-validates (cache miss).

The `FakeSubstrate` from `packages/node-server/tests/cloud/fake-substrate.ts` moves with the rest of `cloud/` into `packages/cloud-core/tests/`. Both CLI and worker tests consume the same fake.

IMS tests: mock the jwks endpoint, sign a test JWT with a known key. `jose` library standard.

## Rollout

Configuration via Wrangler env vars (changeable without redeploying code):

| Var                    | v1 launch                     | v2 expansion                  |
| ---------------------- | ----------------------------- | ----------------------------- |
| `ALLOWED_EMAIL_DOMAIN` | `adobe.com`                   | `*`                           |
| `BLOCKED_EMAILS`       | `""`                          | same — denylist always active |
| `REQUIRE_OWNER_ORG`    | `false`                       | `true`                        |
| `IMS_CLIENT_ID`        | `<sliccy-cloud-app-id>`       | same                          |
| `IMS_ENVIRONMENT`      | `prod` (or `stg1` on staging) | same                          |
| `CONE_CAP_RUNNING`     | `1`                           | same                          |
| `CONE_CAP_PAUSED`      | `5`                           | same                          |

**v1 launch**: Adobe employees only (`ALLOWED_EMAIL_DOMAIN=adobe.com`, `REQUIRE_OWNER_ORG=false`). Denylist available for abuse mitigation from day one.

**v2 expansion**: flip `REQUIRE_OWNER_ORG=true`, set `ALLOWED_EMAIL_DOMAIN=*`. Anyone whose IMS identity carries an `ownerOrg` claim (i.e., the user's IMS principal belongs to at least one Adobe-customer organization, internal or external) gets access. Denylist still wins.

Phase transition is a Wrangler env-var change + redeploy — no code change, no schema migration. Document in worker CLAUDE.md.

**Why denylist over allowlist**: with IMS issuing tokens only to legitimate Adobe-org users, the per-user allowlist creates ongoing maintenance for no security benefit. Denylist is the rare bad-actor escape valve.

**Monitoring**:

- Cloudflare Workers Analytics (built-in) — latency, error rate per endpoint.
- E2B dashboard — sandbox count, hours used, spend per team.
- `GET /api/cloud/_admin/stats` — admin-only endpoint gated by an additional `ADMIN_USER_IDS` env list. Returns aggregate counts (total cones, cap utilization, recent errors). No PII beyond aggregates.
- `wrangler tail --env production` for live incident debugging.

## Explicit non-goals (v1)

- **Sharing**: joinUrls remain bearer-grade (anyone with the URL can attach). No per-recipient invite or revocation UI. Users can copy-paste at their own discretion.
- **Scheduled actions**: no auto-pause at clock times, no kill-after-idle. E2B's auto-pause-on-cap is the only automation.
- **Cone cloning / forking**: snapshot-and-copy is out.
- **Per-user cost visibility**: no $ display in dashboard. Aggregate visible via e2b dashboard for admins only.
- **Real-time updates**: dashboard polls. No SSE / WS push.
- **Multiple templates**: only `slicc`. No thin/fat/GPU variants.
- **Mobile UI**: desktop-only. The follower view (existing webapp) works on mobile already; the cone-management dashboard is desktop-first.
- **Persistent audit log**: no per-user "who created what when" trail beyond ephemeral Workers logs.
- **Backend-service fallback** is NOT a v1 non-goal — it's a Phase 0 spike outcome. If the spike says Workers+e2b is incompatible, the worker becomes a reverse proxy to a dedicated Node service and the rest of the design adjusts (DO moves to the Node service or stays as session lookup; static dashboard still served by worker). Captured in the deployment section, not here.
- **Periodic janitor for orphan sandboxes**: reconciliation on every `/list` and `/start` handles most drift. A standalone "kill orphans tagged with my userId" cron is v1.1 if telemetry shows orphans accumulating.
