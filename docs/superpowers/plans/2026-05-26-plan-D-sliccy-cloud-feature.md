# Plan D — sliccy.ai/cloud feature

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the user-facing web feature: dashboard at `sliccy.ai/cloud`, IMS sign-in, REST API for cone lifecycle, per-user DurableObject, reconciliation, CI integration. Adobe-only v1; per-user caps; denylist abuse mitigation.

**Architecture:** Worker extends with `/api/cloud/*` handlers + `/cloud` static dashboard + `/auth/cloud-callback`. Per-user state AND lifecycle mutations live in `CloudSessionsDurableObject` — the handler authenticates, applies rate-limit, then forwards to a DO endpoint that runs the full lifecycle (reconcile → cap → substrate call → registry write) inside a single `blockConcurrencyWhile` block. This is the only way to make cap checks atomic with `Sandbox.create`. Handlers are thin auth-and-forward shims. Dashboard assets are built into `dist/ui/cloud/` (existing ASSETS binding, no new static dir).

**Tech Stack:** Cloudflare Workers (Wrangler), e2b SDK v2, jose (JWT), DurableObjects, vanilla TS for the dashboard.

**Spec:** `docs/superpowers/specs/2026-05-26-cloud-cones-on-sliccy-ai-design.md`

**Depends on:** Plan A complete (cloud-core), Plan B complete (template env-var bootstrap), Plan C verdict PASS.

---

## File map

```
packages/cloudflare-worker/
├── wrangler.jsonc                          ← MODIFY: env vars, DO binding, secrets
├── src/
│   ├── index.ts                            ← MODIFY: register routes, DO class export
│   ├── cloud/                              ← NEW directory
│   │   ├── auth.ts                         ← JWT pipeline (jwks, allowlist, denylist, ownerOrg)
│   │   ├── auth-cache.ts                   ← Token → AuthResult cache; TTL = min(10min, tokenExp)
│   │   ├── auth-middleware.ts              ← authenticateRequest wrapper (threads tokenExp)
│   │   ├── caps.ts                         ← cap-math pure function (called inside DO)
│   │   ├── rate-limit.ts                   ← per-user soft rate-limit (worker-level)
│   │   ├── error-envelope.ts               ← uniform JSON error response shape
│   │   ├── handlers.ts                     ← THIN SHIMS: auth → rate-limit → forward to DO
│   │   ├── handler-signout.ts              ← /api/cloud/sign-out
│   │   ├── handler-admin.ts                ← /api/cloud/admin/stats
│   │   ├── cloud-sessions-do.ts            ← DO with lifecycle endpoints + local-storage Registry
│   │   └── local-registry.ts               ← Registry impl backed by DO's own state.storage
│   ├── auth/
│   │   ├── cloud-callback.ts               ← /auth/cloud-callback HTML shell
│   │   └── cloud-callback.js               ← external script for the popup (no inline JS)
│   └── (dashboard assets in dist/ui/cloud/ — built alongside the webapp, not a separate dir)
└── tests/
    ├── cloud-auth.test.ts                  ← JWT validation, allowlist/denylist
    ├── cloud-auth-cache.test.ts            ← cache TTL behaviour
    ├── cloud-handlers.test.ts              ← /api/cloud/* with FakeSubstrate + mock DO
    ├── cloud-handlers-helpers.ts           ← mock DO namespace + helpers
    ├── cloud-csp.test.ts                   ← CSP header smoke
    ├── caps.test.ts                        ← cap math
    ├── rate-limit.test.ts                  ← rate-limit triggers
    ├── cloud-live.test.ts                  ← opt-in e2b round-trip (env-gated)
    ├── index.test.ts                       ← MODIFY: new routes in routes list
    └── deployed.test.ts                    ← MODIFY: /cloud + auth-401 smoke
```

---

## Phase D-1 — Worker auth pipeline

### Task D1: Add worker env vars and DO binding

**Files:**

- Modify: `packages/cloudflare-worker/wrangler.jsonc`
- Modify: `packages/cloudflare-worker/worker-configuration.d.ts`

- [ ] **Step 1: Update wrangler.jsonc**

Add to the existing config (preserve everything that's there):

```jsonc
{
  "vars": {
    "IMS_ENVIRONMENT": "prod",
    "IMS_CLIENT_ID": "darkalley",
    "ALLOWED_EMAIL_DOMAIN": "adobe.com",
    "BLOCKED_EMAILS": "",
    "REQUIRE_OWNER_ORG": "false",
    "ADMIN_USER_IDS": "",
    "CONE_CAP_RUNNING": "1",
    "CONE_CAP_PAUSED": "5",
  },
  "durable_objects": {
    "bindings": [
      {
        "name": "CLOUD_SESSIONS",
        "class_name": "CloudSessionsDurableObject",
      },
    ],
  },
  "migrations": [
    {
      "tag": "v2-cloud-sessions",
      "new_classes": ["CloudSessionsDurableObject"],
    },
  ],
}
```

(`IMS_CLIENT_ID` value: placeholder. Replace with the real sliccy-cloud IMS app client_id when registered. `E2B_API_KEY` is a Wrangler secret, set via `wrangler secret put`, NOT in vars.)

- [ ] **Step 2: Extend Env type**

In `packages/cloudflare-worker/worker-configuration.d.ts`:

```ts
interface Env {
  CLOUD_SESSIONS: DurableObjectNamespace;
  E2B_API_KEY: string;
  IMS_ENVIRONMENT: string;
  IMS_CLIENT_ID: string;
  ALLOWED_EMAIL_DOMAIN: string;
  BLOCKED_EMAILS: string;
  REQUIRE_OWNER_ORG: string;
  ADMIN_USER_IDS: string;
  CONE_CAP_RUNNING: string;
  CONE_CAP_PAUSED: string;
}
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck -w @slicc/cloudflare-worker
```

- [ ] **Step 4: Commit**

```bash
git add packages/cloudflare-worker/wrangler.jsonc packages/cloudflare-worker/worker-configuration.d.ts
git commit -m "feat(worker): add cloud-sessions DO binding + IMS/cap env vars"
```

---

### Task D2: jwks fetcher + validateBearer

**Files:**

- Create: `packages/cloudflare-worker/src/cloud/auth.ts`

- [ ] **Step 1: Add jose dependency**

```bash
npm install --workspace @slicc/cloudflare-worker jose
```

- [ ] **Step 2: Create auth.ts**

```ts
// packages/cloudflare-worker/src/cloud/auth.ts
import { createRemoteJWKSet, jwtVerify } from 'jose';

const JWKS_URLS: Record<string, string> = {
  prod: 'https://ims-na1.adobelogin.com/ims/keys',
  stg1: 'https://ims-na1-stg1.adobelogin.com/ims/keys',
};

const IMS_HOSTS: Record<string, string> = {
  prod: 'https://ims-na1.adobelogin.com',
  stg1: 'https://ims-na1-stg1.adobelogin.com',
};

const jwksSets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export function getJWKS(environment: string): ReturnType<typeof createRemoteJWKSet> {
  const env = environment || 'prod';
  let jwks = jwksSets.get(env);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(JWKS_URLS[env] || JWKS_URLS.prod));
    jwksSets.set(env, jwks);
  }
  return jwks;
}

export function getImsHost(environment: string): string {
  return IMS_HOSTS[environment] || IMS_HOSTS.prod;
}

export interface AuthResult {
  userId: string;
  email: string;
  userName: string;
  ownerOrg?: string;
  /** Token exp claim (Unix seconds). Used by the auth cache to cap TTL at
   * min(10min, tokenExp - now). Surfaced from JWT validation. */
  tokenExp?: number;
}

export class AuthError extends Error {
  constructor(
    public readonly code: 'MISSING_TOKEN' | 'INVALID_TOKEN' | 'NOT_ALLOWED',
    message: string
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

interface IMSProfile {
  email?: string;
  displayName?: string;
  name?: string;
  ownerOrg?: string;
}

async function fetchImsProfile(token: string, environment: string): Promise<IMSProfile> {
  const res = await fetch(`${getImsHost(environment)}/ims/profile/v1`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new AuthError('INVALID_TOKEN', `IMS profile fetch failed: ${res.status}`);
  return (await res.json()) as IMSProfile;
}

export function extractBearer(request: Request): string {
  const header = request.headers.get('Authorization');
  if (!header?.startsWith('Bearer ')) {
    throw new AuthError('MISSING_TOKEN', 'expected Authorization: Bearer <ims-access-token>');
  }
  return header.slice(7);
}

interface JWTPayload {
  iss?: string;
  sub?: string;
  user_id?: string;
  client_id?: string;
  type?: string;
  email?: string;
  ownerOrg?: string;
  given_name?: string;
  family_name?: string;
  exp?: number;
}

export interface ValidateBearerEnv {
  IMS_ENVIRONMENT: string;
  IMS_CLIENT_ID: string;
  ALLOWED_EMAIL_DOMAIN: string;
  BLOCKED_EMAILS: string;
  REQUIRE_OWNER_ORG: string;
}

export async function validateBearer(token: string, env: ValidateBearerEnv): Promise<AuthResult> {
  const environment = env.IMS_ENVIRONMENT || 'prod';
  const expectedIssuer = getImsHost(environment);
  const jwks = getJWKS(environment);

  let payload: JWTPayload;
  try {
    const { payload: p } = await jwtVerify(token, jwks);
    payload = p as JWTPayload;
  } catch (err) {
    throw new AuthError(
      'INVALID_TOKEN',
      `JWT verification failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (payload.iss && payload.iss !== expectedIssuer) {
    throw new AuthError('INVALID_TOKEN', `issuer mismatch: ${payload.iss}`);
  }
  if (payload.client_id !== env.IMS_CLIENT_ID) {
    throw new AuthError('INVALID_TOKEN', `client_id mismatch: ${payload.client_id}`);
  }
  if (payload.type !== 'access_token') {
    throw new AuthError('INVALID_TOKEN', `token type is not access_token: ${payload.type}`);
  }

  let email = payload.email;
  let ownerOrg = payload.ownerOrg;
  let userName = '';
  if (!email || (env.REQUIRE_OWNER_ORG === 'true' && !ownerOrg)) {
    const profile = await fetchImsProfile(token, environment);
    email = email || profile.email;
    ownerOrg = ownerOrg || profile.ownerOrg;
    userName = profile.displayName || profile.name || '';
  }
  if (!email) throw new AuthError('INVALID_TOKEN', 'no email in token or profile');
  if (env.REQUIRE_OWNER_ORG === 'true' && !ownerOrg) {
    throw new AuthError('NOT_ALLOWED', `no ownerOrg for ${email}`);
  }

  const allowedDomains = (env.ALLOWED_EMAIL_DOMAIN || 'adobe.com').split(',').map((d) => d.trim());
  if (!allowedDomains.includes('*')) {
    const emailDomain = email.split('@')[1]?.toLowerCase();
    if (!emailDomain || !allowedDomains.includes(emailDomain)) {
      throw new AuthError('NOT_ALLOWED', `email domain not allowed: ${email}`);
    }
  }

  const blocked = (env.BLOCKED_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (blocked.includes(email.toLowerCase())) {
    throw new AuthError('NOT_ALLOWED', `email access denied: ${email}`);
  }

  if (!userName) {
    const given = payload.given_name ?? '';
    const family = payload.family_name ?? '';
    userName = [given, family].filter(Boolean).join(' ') || email;
  }

  return {
    userId: (payload.sub ?? payload.user_id ?? email) as string,
    email,
    userName,
    ownerOrg,
    tokenExp: payload.exp,
  };
}
```

- [ ] **Step 3: Test (`tests/cloud-auth.test.ts`)**

Create test that mocks `https://ims-na1.adobelogin.com/ims/keys` via undici's `MockAgent` and signs test JWTs with a locally generated RS256 keypair. Cover:

- Accepts well-formed Adobe token (sub claim → userId)
- Rejects non-adobe.com email
- Rejects denylisted email
- Requires ownerOrg when REQUIRE_OWNER_ORG=true

See `packages/cloudflare-worker/tests/cloud-auth.test.ts` skeleton (full code identical to the structure from the earlier draft but kept here as exec-time deliverable since the test setup is fiddly — copy from the spec's "Testing → validateBearer" excerpt during execution).

- [ ] **Step 4: Verify**

```bash
npx vitest run --project cloudflare-worker packages/cloudflare-worker/tests/cloud-auth.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(worker/cloud): IMS JWT validation pipeline with allowlist/denylist/ownerOrg"
```

---

### Task D3: Auth cache

**Files:**

- Create: `packages/cloudflare-worker/src/cloud/auth-cache.ts`
- Create: `packages/cloudflare-worker/tests/cloud-auth-cache.test.ts`

- [ ] **Step 1: Implement cache**

```ts
// packages/cloudflare-worker/src/cloud/auth-cache.ts
import type { AuthResult } from './auth.js';

const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { result: AuthResult; expiresAt: number }>();

async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function getCached(token: string): Promise<AuthResult | null> {
  const key = await hashToken(token);
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.result;
}

export async function setCached(
  token: string,
  result: AuthResult,
  tokenExpSec?: number
): Promise<void> {
  const key = await hashToken(token);
  const tokenTtlMs = tokenExpSec ? tokenExpSec * 1000 - Date.now() : TTL_MS;
  const ttl = Math.max(0, Math.min(TTL_MS, tokenTtlMs));
  cache.set(key, { result, expiresAt: Date.now() + ttl });
}

export async function invalidate(token: string): Promise<void> {
  cache.delete(await hashToken(token));
}

export function clearAll(): void {
  cache.clear();
}
```

- [ ] **Step 2: Test**

```ts
// packages/cloudflare-worker/tests/cloud-auth-cache.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { getCached, setCached, invalidate, clearAll } from '../src/cloud/auth-cache.js';

beforeEach(() => clearAll());

describe('auth cache', () => {
  it('round-trips a result', async () => {
    const r = { userId: 'u', email: 'a@adobe.com', userName: 'A' };
    await setCached('tok', r);
    expect(await getCached('tok')).toEqual(r);
  });
  it('returns null for unknown token', async () => {
    expect(await getCached('absent')).toBeNull();
  });
  it('invalidate clears the entry', async () => {
    await setCached('tok', { userId: 'u', email: 'a@adobe.com', userName: 'A' });
    await invalidate('tok');
    expect(await getCached('tok')).toBeNull();
  });
});
```

- [ ] **Step 3: Verify + commit**

```bash
npx vitest run --project cloudflare-worker packages/cloudflare-worker/tests/cloud-auth-cache.test.ts
git add -A
git commit -m "feat(worker/cloud): SHA-256-keyed auth cache with TTL"
```

---

### Task D4: Error envelope + auth middleware

**Files:**

- Create: `packages/cloudflare-worker/src/cloud/error-envelope.ts`
- Create: `packages/cloudflare-worker/src/cloud/auth-middleware.ts`

- [ ] **Step 1: error-envelope.ts**

```ts
// packages/cloudflare-worker/src/cloud/error-envelope.ts
export function errorResponse(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>
): Response {
  return Response.json({ error: code, message, ...(details ? { details } : {}) }, { status });
}

export function okResponse(payload: Record<string, unknown> = { ok: true }): Response {
  return Response.json(payload, { status: 200 });
}
```

- [ ] **Step 2: auth-middleware.ts**

```ts
// packages/cloudflare-worker/src/cloud/auth-middleware.ts
import {
  extractBearer,
  validateBearer,
  AuthError,
  type AuthResult,
  type ValidateBearerEnv,
} from './auth.js';
import { getCached, setCached } from './auth-cache.js';
import { errorResponse } from './error-envelope.js';

export async function authenticateRequest(
  request: Request,
  env: ValidateBearerEnv
): Promise<AuthResult | Response> {
  let token: string;
  try {
    token = extractBearer(request);
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(401, err.code, err.message);
    return errorResponse(401, 'INVALID_TOKEN', 'auth failed');
  }
  const cached = await getCached(token);
  if (cached) return cached;
  try {
    const result = await validateBearer(token, env);
    // Cap cache TTL at min(10min, tokenExp − now) per spec — never cache past
    // the token's own expiry.
    await setCached(token, result, result.tokenExp);
    return result;
  } catch (err) {
    if (err instanceof AuthError) {
      const status = err.code === 'NOT_ALLOWED' ? 403 : 401;
      return errorResponse(status, err.code, err.message);
    }
    return errorResponse(500, 'INTERNAL', err instanceof Error ? err.message : String(err));
  }
}
```

- [ ] **Step 3: Verify + commit**

```bash
npm run typecheck -w @slicc/cloudflare-worker
git add -A
git commit -m "feat(worker/cloud): authenticateRequest middleware + error envelope"
```

---

## Phase D-2 — DurableObject (lifecycle resides here)

**Architecture note:** the DO holds BOTH state AND the lifecycle business logic. Each lifecycle endpoint (`/start-cone`, `/resume-cone`, `/pause-cone`, `/kill-cone`, `/list-cones`) wraps the call in `state.blockConcurrencyWhile(...)` so reconciliation + cap check + e2b call + registry mutation all run as one atomic per-user step. The handler layer (Phase D-4) is reduced to authenticate + rate-limit + forward.

The cloud-core `Registry` interface is still used inside the DO — backed by `state.storage` directly via a tiny adapter (`local-registry.ts`). That keeps cloud-core's operations testable with a FakeSubstrate and an in-memory Registry, while the DO provides the real serialization at runtime.

### Task D5: CloudSessionsDurableObject (lifecycle endpoints)

**Files:**

- Create: `packages/cloudflare-worker/src/cloud/cloud-sessions-do.ts`
- Modify: `packages/cloudflare-worker/src/index.ts` — export the DO class

- [ ] **Step 1: Create LocalRegistry (DO-storage-backed Registry impl)**

`packages/cloudflare-worker/src/cloud/local-registry.ts`:

```ts
import type { ConeEntry, Registry } from '@slicc/cloud-core';
import type { DurableObjectState } from '@cloudflare/workers-types';

interface PersistedState {
  // Matches FileRegistry's schema for forensic consistency.
  sessions: ConeEntry[];
}

export class LocalRegistry implements Registry {
  constructor(private readonly storage: DurableObjectState['storage']) {}

  private async readAll(): Promise<ConeEntry[]> {
    return (await this.storage.get<PersistedState>('state'))?.sessions ?? [];
  }
  private async writeAll(sessions: ConeEntry[]): Promise<void> {
    await this.storage.put('state', { sessions });
  }

  async list(): Promise<ConeEntry[]> {
    return this.readAll();
  }
  async findByNameOrId(query: string): Promise<ConeEntry | null> {
    const all = await this.readAll();
    return all.find((c) => c.sandboxId === query || c.name === query) ?? null;
  }
  async append(entry: ConeEntry): Promise<void> {
    const all = await this.readAll();
    const i = all.findIndex((c) => c.sandboxId === entry.sandboxId);
    if (i >= 0) all[i] = { ...all[i]!, ...entry };
    else all.push(entry);
    await this.writeAll(all);
  }
  async update(sandboxId: string, patch: Partial<ConeEntry>): Promise<void> {
    const all = await this.readAll();
    const i = all.findIndex((c) => c.sandboxId === sandboxId);
    if (i < 0) throw new Error(`entry not found: ${sandboxId}`);
    all[i] = { ...all[i]!, ...patch };
    await this.writeAll(all);
  }
  async remove(sandboxId: string): Promise<void> {
    const all = await this.readAll();
    await this.writeAll(all.filter((c) => c.sandboxId !== sandboxId));
  }
}
```

- [ ] **Step 2: Create the DO with lifecycle endpoints**

`packages/cloudflare-worker/src/cloud/cloud-sessions-do.ts`:

```ts
import type { DurableObject, DurableObjectState } from '@cloudflare/workers-types';
import {
  createSubstrate,
  isCloudError,
  startCone,
  listCones,
  pauseCone,
  resumeCone,
  killCone,
  type SandboxSubstrate,
} from '@slicc/cloud-core';
import { checkCapsForRun } from './caps.js';
import { errorResponse, okResponse } from './error-envelope.js';
import { LocalRegistry } from './local-registry.js';

interface DoEnv {
  E2B_API_KEY: string;
  CONE_CAP_RUNNING: string;
  CONE_CAP_PAUSED: string;
  /** Test-only hatch: inject a substrate factory in place of e2b.
   * Never set in production Wrangler env. */
  __SUBSTRATE_FACTORY__?: () => SandboxSubstrate;
}

const ADOBE_TOKEN_DOMAINS = 'adobe-llm-proxy.paolo-moz.workers.dev';

interface StartConeBody {
  bearer: string;
  name?: string;
  userId: string;
  email: string;
  workerOrigin: string;
}
interface ResumeConeBody {
  bearer: string;
  sandboxId: string;
  localSliccVersion: string;
  userId: string;
}
interface SimpleSandboxBody {
  sandboxId: string;
}
interface ListConesBody {
  userId: string;
}

export class CloudSessionsDurableObject implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: DoEnv
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // Every lifecycle op runs inside blockConcurrencyWhile so reconciliation +
    // cap check + substrate call + registry write are atomic per user.
    return this.state.blockConcurrencyWhile(() => this.dispatch(url.pathname, request));
  }

  private substrate(): SandboxSubstrate {
    if (this.env.__SUBSTRATE_FACTORY__) return this.env.__SUBSTRATE_FACTORY__();
    return createSubstrate('e2b', { apiKey: this.env.E2B_API_KEY });
  }
  private registry(): LocalRegistry {
    return new LocalRegistry(this.state.storage);
  }

  private async dispatch(op: string, request: Request): Promise<Response> {
    try {
      switch (op) {
        case '/start-cone':
          return await this.startConeOp((await request.json()) as StartConeBody);
        case '/resume-cone':
          return await this.resumeConeOp((await request.json()) as ResumeConeBody);
        case '/pause-cone':
          return await this.pauseConeOp((await request.json()) as SimpleSandboxBody);
        case '/kill-cone':
          return await this.killConeOp((await request.json()) as SimpleSandboxBody);
        case '/list-cones':
          return await this.listConesOp((await request.json()) as ListConesBody);
        default:
          return new Response(`unknown DO op: ${op}`, { status: 404 });
      }
    } catch (err) {
      if (isCloudError(err)) {
        return errorResponse(errCodeToStatus(err.code), err.code, err.message, err.details);
      }
      return errorResponse(500, 'INTERNAL', err instanceof Error ? err.message : String(err));
    }
  }

  // ── Lifecycle ops (each runs inside blockConcurrencyWhile via fetch) ──

  private async startConeOp(body: StartConeBody): Promise<Response> {
    const substrate = this.substrate();
    const registry = this.registry();
    // 1. Reconcile DO state against substrate (drops dead entries, picks up orphans).
    const reconciled = await listCones(
      { substrate, registry },
      { metadata: { userId: body.userId } }
    );
    // 2. Enforce per-user soft-name uniqueness across non-dead cones.
    const requestedName = body.name?.trim();
    if (requestedName && reconciled.some((c) => c.state !== 'dead' && c.name === requestedName)) {
      return errorResponse(
        409,
        'NAME_TAKEN',
        `cloud session name already exists: ${requestedName}`
      );
    }

    // 3. Cap check against reconciled state.
    const cap = checkCapsForRun(reconciled, this.env);
    if (!cap.ok) {
      return errorResponse(403, 'CAP_EXCEEDED', `at ${cap.reason} cap`, {
        running: cap.running,
        paused: cap.paused,
        cap: { running: cap.runningCap, paused: cap.pausedCap },
      });
    }
    // 4. Run startCone — atomic with the checks above.
    const result = await startCone(
      { substrate, registry },
      {
        envContents: [
          `ADOBE_IMS_TOKEN=${body.bearer}`,
          `ADOBE_IMS_TOKEN_DOMAINS=${ADOBE_TOKEN_DOMAINS}`,
        ].join('\n'),
        envs: {
          ADOBE_IMS_TOKEN: body.bearer,
          ADOBE_IMS_TOKEN_DOMAINS: ADOBE_TOKEN_DOMAINS,
        },
        workerBaseUrl: body.workerOrigin,
        sliccVersion: 'web-' + new Date().toISOString().slice(0, 10),
        name: requestedName,
        metadata: { userId: body.userId, email: body.email },
      }
    );
    return okResponse({
      sandboxId: result.sandboxId,
      name: result.name,
      joinUrl: result.joinUrl,
      trayId: result.trayId,
    });
  }

  private async resumeConeOp(body: ResumeConeBody): Promise<Response> {
    const substrate = this.substrate();
    const registry = this.registry();
    const all = await listCones({ substrate, registry }, { metadata: { userId: body.userId } });
    const others = all.filter((c) => c.sandboxId !== body.sandboxId);
    const cap = checkCapsForRun(others, this.env);
    if (!cap.ok) {
      return errorResponse(403, 'CAP_EXCEEDED', 'resuming would exceed running cap', {
        running: cap.running,
        cap: { running: cap.runningCap, paused: cap.pausedCap },
      });
    }
    const result = await resumeCone(
      { substrate, registry },
      {
        query: body.sandboxId,
        localSliccVersion: body.localSliccVersion,
        refreshSecretsContents: [
          `ADOBE_IMS_TOKEN=${body.bearer}`,
          `ADOBE_IMS_TOKEN_DOMAINS=${ADOBE_TOKEN_DOMAINS}`,
        ].join('\n'),
      }
    );
    return okResponse({
      sandboxId: result.sandboxId,
      joinUrl: result.joinUrl,
      trayRebuilt: result.trayRebuilt,
    });
  }

  private async pauseConeOp(body: SimpleSandboxBody): Promise<Response> {
    await pauseCone({ substrate: this.substrate(), registry: this.registry() }, body.sandboxId);
    return okResponse();
  }

  private async killConeOp(body: SimpleSandboxBody): Promise<Response> {
    try {
      await killCone({ substrate: this.substrate(), registry: this.registry() }, body.sandboxId);
    } catch (err) {
      if (isCloudError(err) && err.code === 'NOT_FOUND') {
        // Kill is idempotent.
        return okResponse();
      }
      throw err;
    }
    return okResponse();
  }

  private async listConesOp(body: ListConesBody): Promise<Response> {
    const cones = await listCones(
      { substrate: this.substrate(), registry: this.registry() },
      { metadata: { userId: body.userId } }
    );
    return okResponse({ cones });
  }
}

function errCodeToStatus(code: string): number {
  const map: Record<string, number> = {
    CAP_EXCEEDED: 403,
    NOT_FOUND: 404,
    NAME_TAKEN: 409,
    ALREADY_PAUSED: 409,
    ALREADY_RUNNING: 409,
    LEADER_NOT_READY: 503,
    SANDBOX_NOT_READY: 503,
    CDP_NOT_READY: 503,
    CDP_ERROR: 500,
    INTERNAL: 500,
  };
  return map[code] ?? 500;
}
```

- [ ] **Step 3: Export from worker index.ts**

```ts
// in packages/cloudflare-worker/src/index.ts (top-level):
export { CloudSessionsDurableObject } from './cloud/cloud-sessions-do.js';
```

(Wrangler's migration entry references the class; without the export it fails to bind.)

- [ ] **Step 4: Typecheck + commit**

```bash
npm run typecheck
git add -A
git commit -m "feat(worker/cloud): CloudSessionsDurableObject"
```

---

### Task D6: (intentionally dropped — no DoRegistry needed)

In the earlier draft of Plan D, a `DoRegistry` adapter wrapped the DO stub for use by worker-side handlers calling cloud-core ops. That architecture had a fatal flaw: each cloud-core op makes multiple DO calls (list, append, update); the worker-side sequence wasn't atomic, so two concurrent `/start` calls could both pass the cap check.

The corrected architecture (Task D5) runs cloud-core ops INSIDE the DO with `state.blockConcurrencyWhile`, using `LocalRegistry` to talk to the DO's own storage. Handlers (Task D9 onwards) become thin shims that forward to DO endpoints; there is no `DoRegistry` and no worker-side Registry wrapping. Nothing to do for D6.

---

## Phase D-3 — Caps + rate-limit

### Task D7: Cap check

**Files:**

- Create: `packages/cloudflare-worker/src/cloud/caps.ts`
- Create: `packages/cloudflare-worker/tests/caps.test.ts`

- [ ] **Step 1: caps.ts**

```ts
// packages/cloudflare-worker/src/cloud/caps.ts
import type { ConeEntry } from '@slicc/cloud-core';

export interface CapEnv {
  CONE_CAP_RUNNING: string;
  CONE_CAP_PAUSED: string;
}

export interface CapResult {
  ok: boolean;
  running: number;
  paused: number;
  runningCap: number;
  pausedCap: number;
  reason?: 'RUNNING_CAP' | 'PAUSED_CAP';
}

/**
 * Allow if a new running cone fits within the running cap AND total paused
 * fits within paused cap. Pass `cones` = all non-target cones for resume
 * (i.e. excluding the one transitioning).
 */
export function checkCapsForRun(cones: ConeEntry[], env: CapEnv): CapResult {
  const running = cones.filter((c) => c.state === 'running').length;
  const paused = cones.filter((c) => c.state === 'paused').length;
  const runningCap = Number.parseInt(env.CONE_CAP_RUNNING, 10);
  const pausedCap = Number.parseInt(env.CONE_CAP_PAUSED, 10);
  if (running >= runningCap) {
    return { ok: false, running, paused, runningCap, pausedCap, reason: 'RUNNING_CAP' };
  }
  if (paused >= pausedCap) {
    return { ok: false, running, paused, runningCap, pausedCap, reason: 'PAUSED_CAP' };
  }
  return { ok: true, running, paused, runningCap, pausedCap };
}
```

- [ ] **Step 2: caps.test.ts**

```ts
import { describe, it, expect } from 'vitest';
import { checkCapsForRun } from '../src/cloud/caps.js';

const env = { CONE_CAP_RUNNING: '1', CONE_CAP_PAUSED: '5' };

describe('checkCapsForRun', () => {
  it('passes when nothing is running', () => {
    expect(checkCapsForRun([], env).ok).toBe(true);
  });
  it('rejects RUNNING_CAP when at running cap', () => {
    const result = checkCapsForRun(
      [{ sandboxId: 's1', createdAt: '', lastSeen: '', state: 'running' }],
      env
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('RUNNING_CAP');
  });
  it('rejects PAUSED_CAP when at paused cap', () => {
    const cones = Array.from({ length: 5 }, (_, i) => ({
      sandboxId: `s${i}`,
      createdAt: '',
      lastSeen: '',
      state: 'paused' as const,
    }));
    expect(checkCapsForRun(cones, env).reason).toBe('PAUSED_CAP');
  });
});
```

- [ ] **Step 3: Verify + commit**

```bash
npx vitest run --project cloudflare-worker packages/cloudflare-worker/tests/caps.test.ts
git add -A
git commit -m "feat(worker/cloud): cap check for start and resume"
```

---

### Task D8: Rate limit

**Files:**

- Create: `packages/cloudflare-worker/src/cloud/rate-limit.ts`
- Create: `packages/cloudflare-worker/tests/rate-limit.test.ts`

- [ ] **Step 1: rate-limit.ts** (token-bucket)

```ts
// packages/cloudflare-worker/src/cloud/rate-limit.ts
interface Bucket {
  tokens: number;
  lastRefill: number;
}

interface Limit {
  refillPerSec: number;
  capacity: number;
}

const LIMITS: Record<string, Limit> = {
  start: { refillPerSec: 30 / 3600, capacity: 30 },
  list: { refillPerSec: 60 / 60, capacity: 60 },
  pause: { refillPerSec: 60 / 60, capacity: 60 },
  resume: { refillPerSec: 30 / 3600, capacity: 30 },
  kill: { refillPerSec: 60 / 60, capacity: 60 },
};

const buckets = new Map<string, Bucket>();

export function checkRateLimit(
  userId: string,
  op: string
): { ok: true } | { ok: false; retryAfterSec: number } {
  const limit = LIMITS[op];
  if (!limit) return { ok: true };
  const key = `${userId}:${op}`;
  const now = Date.now() / 1000;
  let b = buckets.get(key);
  if (!b) {
    b = { tokens: limit.capacity, lastRefill: now };
    buckets.set(key, b);
  }
  const elapsed = now - b.lastRefill;
  b.tokens = Math.min(limit.capacity, b.tokens + elapsed * limit.refillPerSec);
  b.lastRefill = now;
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return { ok: true };
  }
  return { ok: false, retryAfterSec: Math.ceil((1 - b.tokens) / limit.refillPerSec) };
}

export function clearAll(): void {
  buckets.clear();
}
```

- [ ] **Step 2: rate-limit.test.ts**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { checkRateLimit, clearAll } from '../src/cloud/rate-limit.js';

beforeEach(() => clearAll());

describe('rate-limit', () => {
  it('allows under capacity', () => {
    for (let i = 0; i < 30; i++) {
      expect(checkRateLimit('u1', 'start')).toEqual({ ok: true });
    }
  });
  it('rejects over capacity with retryAfter', () => {
    for (let i = 0; i < 30; i++) checkRateLimit('u1', 'start');
    const r = checkRateLimit('u1', 'start');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retryAfterSec).toBeGreaterThan(0);
  });
  it('isolates users', () => {
    for (let i = 0; i < 30; i++) checkRateLimit('u1', 'start');
    expect(checkRateLimit('u2', 'start')).toEqual({ ok: true });
  });
});
```

- [ ] **Step 3: Verify + commit**

```bash
npx vitest run --project cloudflare-worker packages/cloudflare-worker/tests/rate-limit.test.ts
git add -A
git commit -m "feat(worker/cloud): per-user rate-limit middleware"
```

---

## Phase D-4 — Handlers

### Task D9: handlers.ts — /start

**Files:**

- Create: `packages/cloudflare-worker/src/cloud/handlers.ts`
- Create: `packages/cloudflare-worker/tests/cloud-handlers-helpers.ts`
- Create: `packages/cloudflare-worker/tests/cloud-handlers.test.ts`

- [ ] **Step 1: Implement handlers.ts (thin shims forwarding to DO)**

```ts
// packages/cloudflare-worker/src/cloud/handlers.ts
import { authenticateRequest } from './auth-middleware.js';
import { errorResponse } from './error-envelope.js';
import { checkRateLimit } from './rate-limit.js';

export interface CloudEnv {
  CLOUD_SESSIONS: DurableObjectNamespace;
  E2B_API_KEY: string;
  IMS_ENVIRONMENT: string;
  IMS_CLIENT_ID: string;
  ALLOWED_EMAIL_DOMAIN: string;
  BLOCKED_EMAILS: string;
  REQUIRE_OWNER_ORG: string;
  CONE_CAP_RUNNING: string;
  CONE_CAP_PAUSED: string;
}

function getDoStub(env: CloudEnv, userId: string): DurableObjectStub {
  const id = env.CLOUD_SESSIONS.idFromName(userId);
  return env.CLOUD_SESSIONS.get(id);
}

async function forwardToDo(
  stub: DurableObjectStub,
  endpoint: string,
  body: Record<string, unknown>
): Promise<Response> {
  return await stub.fetch(`https://do${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function handleStart(request: Request, env: CloudEnv): Promise<Response> {
  const auth = await authenticateRequest(request, env);
  if (auth instanceof Response) return auth;
  const rate = checkRateLimit(auth.userId, 'start');
  if (!rate.ok) {
    return errorResponse(429, 'RATE_LIMITED', 'too many start requests', {
      retryAfterSec: rate.retryAfterSec,
    });
  }
  const bearer = request.headers.get('Authorization')!.slice(7);
  const body = (await request.json().catch(() => ({}))) as { name?: string };
  const stub = getDoStub(env, auth.userId);
  return forwardToDo(stub, '/start-cone', {
    bearer,
    name: body.name,
    userId: auth.userId,
    email: auth.email,
    workerOrigin: new URL(request.url).origin,
  });
}

export async function handleList(request: Request, env: CloudEnv): Promise<Response> {
  const auth = await authenticateRequest(request, env);
  if (auth instanceof Response) return auth;
  const rate = checkRateLimit(auth.userId, 'list');
  if (!rate.ok) {
    return errorResponse(429, 'RATE_LIMITED', 'too many list requests', {
      retryAfterSec: rate.retryAfterSec,
    });
  }
  const stub = getDoStub(env, auth.userId);
  return forwardToDo(stub, '/list-cones', { userId: auth.userId });
}

export async function handlePause(request: Request, env: CloudEnv): Promise<Response> {
  const auth = await authenticateRequest(request, env);
  if (auth instanceof Response) return auth;
  const rate = checkRateLimit(auth.userId, 'pause');
  if (!rate.ok) {
    return errorResponse(429, 'RATE_LIMITED', 'too many pause requests', {
      retryAfterSec: rate.retryAfterSec,
    });
  }
  const body = (await request.json()) as { sandboxId: string };
  const stub = getDoStub(env, auth.userId);
  return forwardToDo(stub, '/pause-cone', { sandboxId: body.sandboxId });
}

export async function handleResume(request: Request, env: CloudEnv): Promise<Response> {
  const auth = await authenticateRequest(request, env);
  if (auth instanceof Response) return auth;
  const rate = checkRateLimit(auth.userId, 'resume');
  if (!rate.ok) {
    return errorResponse(429, 'RATE_LIMITED', 'too many resume requests', {
      retryAfterSec: rate.retryAfterSec,
    });
  }
  const bearer = request.headers.get('Authorization')!.slice(7);
  const body = (await request.json()) as { sandboxId: string };
  const stub = getDoStub(env, auth.userId);
  return forwardToDo(stub, '/resume-cone', {
    bearer,
    sandboxId: body.sandboxId,
    localSliccVersion: 'web-' + new Date().toISOString().slice(0, 10),
    userId: auth.userId,
  });
}

export async function handleKill(request: Request, env: CloudEnv): Promise<Response> {
  const auth = await authenticateRequest(request, env);
  if (auth instanceof Response) return auth;
  const rate = checkRateLimit(auth.userId, 'kill');
  if (!rate.ok) {
    return errorResponse(429, 'RATE_LIMITED', 'too many kill requests', {
      retryAfterSec: rate.retryAfterSec,
    });
  }
  const body = (await request.json()) as { sandboxId: string };
  const stub = getDoStub(env, auth.userId);
  return forwardToDo(stub, '/kill-cone', { sandboxId: body.sandboxId });
}
```

The handler is now ~10 lines per endpoint: auth, rate-limit, forward to DO. All business logic (reconciliation, cap check, substrate calls, registry writes) is in the DO endpoints (Task D5) running under `blockConcurrencyWhile`.

- [ ] **Step 2: cloud-handlers-helpers.ts** — mock DO namespace

```ts
// packages/cloudflare-worker/tests/cloud-handlers-helpers.ts
import type { ConeEntry } from '@slicc/cloud-core';

const states = new Map<string, { cones: ConeEntry[] }>();

export function resetMockNamespace(): void {
  states.clear();
}

export function makeMockNamespace(): DurableObjectNamespace {
  return {
    idFromName: (name: string) => ({ toString: () => name }) as DurableObjectId,
    idFromString: (s: string) => ({ toString: () => s }) as DurableObjectId,
    newUniqueId: () => ({ toString: () => crypto.randomUUID() }) as DurableObjectId,
    get: (id: DurableObjectId) => {
      const key = id.toString();
      const stub = {
        async fetch(req: Request | string): Promise<Response> {
          const r = typeof req === 'string' ? new Request(req) : req;
          const url = new URL(r.url);
          const state = states.get(key) ?? { cones: [] };
          states.set(key, state);
          switch (url.pathname) {
            case '/list':
              return Response.json(state.cones);
            case '/findByNameOrId': {
              const { query } = (await r.json()) as { query: string };
              return Response.json(
                state.cones.find((c) => c.sandboxId === query || c.name === query) ?? null
              );
            }
            case '/append': {
              const { entry } = (await r.json()) as { entry: ConeEntry };
              state.cones.push(entry);
              return Response.json({ ok: true });
            }
            case '/update': {
              const { sandboxId, patch } = (await r.json()) as {
                sandboxId: string;
                patch: Partial<ConeEntry>;
              };
              const i = state.cones.findIndex((c) => c.sandboxId === sandboxId);
              if (i < 0) return new Response('not found', { status: 404 });
              state.cones[i] = { ...state.cones[i]!, ...patch };
              return Response.json({ ok: true });
            }
            case '/remove': {
              const { sandboxId } = (await r.json()) as { sandboxId: string };
              state.cones = state.cones.filter((c) => c.sandboxId !== sandboxId);
              return Response.json({ ok: true });
            }
            default:
              return new Response('not found', { status: 404 });
          }
        },
      };
      return stub as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
}

export function makeCloudEnv(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    CLOUD_SESSIONS: makeMockNamespace(),
    E2B_API_KEY: 'test-e2b-key',
    IMS_ENVIRONMENT: 'prod',
    IMS_CLIENT_ID: 'test-client',
    ALLOWED_EMAIL_DOMAIN: 'adobe.com',
    BLOCKED_EMAILS: '',
    REQUIRE_OWNER_ORG: 'false',
    CONE_CAP_RUNNING: '1',
    CONE_CAP_PAUSED: '5',
    ...overrides,
  } as Parameters<typeof import('../src/cloud/handlers.js').handleStart>[1];
}
```

- [ ] **Step 3: cloud-handlers.test.ts** — start test (TDD)

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { handleStart } from '../src/cloud/handlers.js';
import { setCached, clearAll as clearAuthCache } from '../src/cloud/auth-cache.js';
import { clearAll as clearRateLimit } from '../src/cloud/rate-limit.js';
import { makeCloudEnv, resetMockNamespace } from './cloud-handlers-helpers.js';
import { FakeSubstrate } from '@slicc/cloud-core/tests/fake-substrate';

beforeEach(() => {
  clearAuthCache();
  clearRateLimit();
  resetMockNamespace();
});

describe('handleStart', () => {
  it('creates a cone under cap', async () => {
    await setCached('test-bearer', {
      userId: 'u1',
      email: 'kpauls@adobe.com',
      userName: 'Karl',
    });
    const env = makeCloudEnv();
    const substrate = new FakeSubstrate();
    const req = new Request('https://w/api/cloud/start', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-bearer' },
      body: JSON.stringify({ name: 'smoke' }),
    });
    const res = await handleStart(req, env, { substrate });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; sandboxId: string; joinUrl: string };
    expect(body.name).toBe('smoke');
    expect(body.joinUrl).toMatch(/^https:\/\//);
  });

  it('rejects when at running cap', async () => {
    await setCached('test-bearer', { userId: 'u1', email: 'k@adobe.com', userName: 'K' });
    const env = makeCloudEnv();
    const substrate = new FakeSubstrate();
    // Pre-seed one running cone via the mock DO.
    const stub = env.CLOUD_SESSIONS.get(env.CLOUD_SESSIONS.idFromName('u1'));
    await stub.fetch('https://do/append', {
      method: 'POST',
      body: JSON.stringify({
        entry: {
          sandboxId: 'existing',
          createdAt: '',
          lastSeen: '',
          state: 'running',
        },
      }),
    });
    const req = new Request('https://w/api/cloud/start', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-bearer' },
      body: JSON.stringify({}),
    });
    const res = await handleStart(req, env, { substrate });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('CAP_EXCEEDED');
  });

  it('rejects unauthenticated requests with 401', async () => {
    const env = makeCloudEnv();
    const req = new Request('https://w/api/cloud/start', { method: 'POST' });
    const res = await handleStart(req, env);
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 4: Verify**

```bash
npx vitest run --project cloudflare-worker packages/cloudflare-worker/tests/cloud-handlers.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(worker/cloud): /api/cloud/start with cap + rate-limit"
```

---

### Task D10: Handler-level tests (auth + forward shape)

**Files:**

- Modify: `packages/cloudflare-worker/tests/cloud-handlers.test.ts`
- Modify: `packages/cloudflare-worker/tests/cloud-handlers-helpers.ts` — replace CRUD-mock with lifecycle-mock

Handlers in the new architecture (D9) are thin: their job is to authenticate, rate-limit, and forward to a DO endpoint with a well-shaped body. These tests verify exactly that, without trying to simulate the DO's lifecycle. The DO's actual behavior is tested separately in Task D11.

- [ ] **Step 1: Update the mock helper to record forwarded requests**

Replace `tests/cloud-handlers-helpers.ts`:

```ts
import type { ConeEntry } from '@slicc/cloud-core';

interface RecordedCall {
  path: string;
  body: unknown;
}

const recorded = new Map<string, RecordedCall[]>();
const responses = new Map<string, Response>();

export function resetMockNamespace(): void {
  recorded.clear();
  responses.clear();
}

/**
 * Pre-seed what the mock DO will return for a given key+endpoint pair.
 * Calls .clone() internally — same canned response can be served to multiple calls.
 */
export function setMockResponse(userId: string, endpoint: string, response: Response): void {
  responses.set(`${userId}:${endpoint}`, response);
}

export function getRecordedCalls(userId: string): RecordedCall[] {
  return recorded.get(userId) ?? [];
}

export function makeMockNamespace(): DurableObjectNamespace {
  return {
    idFromName: (name: string) => ({ toString: () => name }) as DurableObjectId,
    idFromString: (s: string) => ({ toString: () => s }) as DurableObjectId,
    newUniqueId: () => ({ toString: () => crypto.randomUUID() }) as DurableObjectId,
    get: (id: DurableObjectId) => {
      const userId = id.toString();
      return {
        async fetch(req: Request | string): Promise<Response> {
          const r = typeof req === 'string' ? new Request(req) : req;
          const url = new URL(r.url);
          const body = await r.json().catch(() => ({}));
          const calls = recorded.get(userId) ?? [];
          calls.push({ path: url.pathname, body });
          recorded.set(userId, calls);
          const canned = responses.get(`${userId}:${url.pathname}`);
          if (canned) return canned.clone();
          return Response.json({ ok: true });
        },
      } as unknown as DurableObjectStub;
    },
  } as unknown as DurableObjectNamespace;
}

export function makeCloudEnv(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    CLOUD_SESSIONS: makeMockNamespace(),
    E2B_API_KEY: 'test-e2b-key',
    IMS_ENVIRONMENT: 'prod',
    IMS_CLIENT_ID: 'test-client',
    ALLOWED_EMAIL_DOMAIN: 'adobe.com',
    BLOCKED_EMAILS: '',
    REQUIRE_OWNER_ORG: 'false',
    CONE_CAP_RUNNING: '1',
    CONE_CAP_PAUSED: '5',
    ...overrides,
  } as unknown as import('../src/cloud/handlers.js').CloudEnv;
}
```

- [ ] **Step 2: Write handler tests**

Replace `tests/cloud-handlers.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  handleStart,
  handleList,
  handlePause,
  handleResume,
  handleKill,
} from '../src/cloud/handlers.js';
import { setCached, clearAll as clearAuthCache } from '../src/cloud/auth-cache.js';
import { clearAll as clearRateLimit } from '../src/cloud/rate-limit.js';
import {
  makeCloudEnv,
  resetMockNamespace,
  setMockResponse,
  getRecordedCalls,
} from './cloud-handlers-helpers.js';

beforeEach(() => {
  clearAuthCache();
  clearRateLimit();
  resetMockNamespace();
});

const AUTH = { userId: 'u1', email: 'k@adobe.com', userName: 'K' };

describe('thin handlers forward to DO lifecycle endpoints', () => {
  it('handleStart → POSTs /start-cone with bearer + name + userId', async () => {
    await setCached('test-bearer', AUTH);
    const env = makeCloudEnv();
    setMockResponse(
      'u1',
      '/start-cone',
      Response.json({ sandboxId: 's1', joinUrl: 'https://w/join/s1' })
    );
    const req = new Request('https://w/api/cloud/start', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-bearer' },
      body: JSON.stringify({ name: 'smoke' }),
    });
    const res = await handleStart(req, env);
    expect(res.status).toBe(200);
    const calls = getRecordedCalls('u1');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe('/start-cone');
    const body = calls[0]!.body as { bearer: string; name: string; userId: string };
    expect(body).toMatchObject({
      bearer: 'test-bearer',
      name: 'smoke',
      userId: 'u1',
      email: 'k@adobe.com',
    });
    expect(body).toHaveProperty('workerOrigin');
  });

  it('handleList → POSTs /list-cones with userId', async () => {
    await setCached('test-bearer', AUTH);
    const env = makeCloudEnv();
    setMockResponse('u1', '/list-cones', Response.json({ cones: [] }));
    const req = new Request('https://w/api/cloud/list', {
      headers: { Authorization: 'Bearer test-bearer' },
    });
    const res = await handleList(req, env);
    expect(res.status).toBe(200);
    expect(getRecordedCalls('u1')).toHaveLength(1);
    expect(getRecordedCalls('u1')[0]!.path).toBe('/list-cones');
  });

  it('handlePause → POSTs /pause-cone with sandboxId', async () => {
    await setCached('test-bearer', AUTH);
    const env = makeCloudEnv();
    const req = new Request('https://w/api/cloud/pause', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-bearer' },
      body: JSON.stringify({ sandboxId: 's1' }),
    });
    await handlePause(req, env);
    expect(getRecordedCalls('u1')[0]!.body).toMatchObject({ sandboxId: 's1' });
  });

  it('handleResume → POSTs /resume-cone with bearer + sandboxId + userId', async () => {
    await setCached('test-bearer', AUTH);
    const env = makeCloudEnv();
    const req = new Request('https://w/api/cloud/resume', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-bearer' },
      body: JSON.stringify({ sandboxId: 's1' }),
    });
    await handleResume(req, env);
    expect(getRecordedCalls('u1')[0]!.body).toMatchObject({
      bearer: 'test-bearer',
      sandboxId: 's1',
      userId: 'u1',
    });
  });

  it('handleKill → POSTs /kill-cone with sandboxId', async () => {
    await setCached('test-bearer', AUTH);
    const env = makeCloudEnv();
    const req = new Request('https://w/api/cloud/kill', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-bearer' },
      body: JSON.stringify({ sandboxId: 's1' }),
    });
    await handleKill(req, env);
    expect(getRecordedCalls('u1')[0]!.body).toMatchObject({ sandboxId: 's1' });
  });

  it('rejects unauthenticated requests with 401', async () => {
    const env = makeCloudEnv();
    const req = new Request('https://w/api/cloud/start', { method: 'POST' });
    const res = await handleStart(req, env);
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 3: Verify + commit**

```bash
npx vitest run --project cloudflare-worker packages/cloudflare-worker/tests/cloud-handlers.test.ts
git add -A
git commit -m "test(worker/cloud): handler-level tests for auth + DO-forward shape"
```

---

### Task D11: DO lifecycle tests (cap math, idempotency, reconciliation)

**Files:**

- Modify: `packages/cloudflare-worker/src/cloud/cloud-sessions-do.ts` — make the substrate factory injectable
- Create: `packages/cloudflare-worker/tests/cloud-sessions-do.test.ts`

These tests cover the parts of the lifecycle that previously lived in worker-side handlers — atomic cap check, idempotent kill, reconciliation drift. The DO is exercised directly with a FakeSubstrate.

- [ ] **Step 1: Make substrate factory injectable**

Modify `cloud-sessions-do.ts` to accept an optional substrate factory through env (or DI). Add to `DoEnv`:

```ts
interface DoEnv {
  E2B_API_KEY: string;
  CONE_CAP_RUNNING: string;
  CONE_CAP_PAUSED: string;
  /** Tests only: injects a substrate factory in place of createSubstrate('e2b', …). */
  __SUBSTRATE_FACTORY__?: () => SandboxSubstrate;
}

// in CloudSessionsDurableObject:
private substrate() {
  if (this.env.__SUBSTRATE_FACTORY__) return this.env.__SUBSTRATE_FACTORY__();
  return createSubstrate('e2b', { apiKey: this.env.E2B_API_KEY });
}
```

(The `__SUBSTRATE_FACTORY__` field is never present in production Wrangler env. It's purely a test hatch.)

- [ ] **Step 2: Test the DO directly**

```ts
// packages/cloudflare-worker/tests/cloud-sessions-do.test.ts
import { describe, it, expect } from 'vitest';
import { CloudSessionsDurableObject } from '../src/cloud/cloud-sessions-do.js';
import { FakeSubstrate } from '@slicc/cloud-core/tests/fake-substrate';

function makeFakeState() {
  const storage = new Map<string, unknown>();
  const state = {
    storage: {
      get: async (k: string) => storage.get(k),
      put: async (k: string, v: unknown) => {
        storage.set(k, v);
      },
      delete: async (k: string) => {
        storage.delete(k);
      },
    },
    blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as ConstructorParameters<typeof CloudSessionsDurableObject>[0];
  return { state, storage };
}

function makeDoEnv(substrate: FakeSubstrate) {
  return {
    E2B_API_KEY: 'test',
    CONE_CAP_RUNNING: '1',
    CONE_CAP_PAUSED: '5',
    __SUBSTRATE_FACTORY__: () => substrate,
  };
}

async function call(
  do_: CloudSessionsDurableObject,
  path: string,
  body: unknown
): Promise<Response> {
  return do_.fetch(
    new Request(`https://do${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

describe('CloudSessionsDurableObject — lifecycle endpoints', () => {
  it('start-cone returns 403 CAP_EXCEEDED when running cap is hit', async () => {
    const substrate = new FakeSubstrate();
    substrate.seedSandbox('s1', {
      metadata: { userId: 'u1', name: 'existing' },
      state: 'running',
    });
    const { state } = makeFakeState();
    const do_ = new CloudSessionsDurableObject(state, makeDoEnv(substrate));
    // First start: succeeds (substrate.list sees s1, but DO is empty → reconciliation
    // rebuilds DO with s1 as running; cap check then rejects).
    const res = await call(do_, '/start-cone', {
      bearer: 'b',
      userId: 'u1',
      email: 'k@adobe.com',
      workerOrigin: 'https://w',
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('CAP_EXCEEDED');
  });

  it('start-cone returns 409 NAME_TAKEN for a duplicate live name in the same user scope', async () => {
    const substrate = new FakeSubstrate();
    substrate.seedSandbox('s1', {
      metadata: { userId: 'u1', name: 'existing' },
      state: 'paused',
    });
    const { state } = makeFakeState();
    const do_ = new CloudSessionsDurableObject(state, makeDoEnv(substrate));
    const res = await call(do_, '/start-cone', {
      bearer: 'b',
      userId: 'u1',
      email: 'k@adobe.com',
      workerOrigin: 'https://w',
      name: ' existing ',
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('NAME_TAKEN');
  });

  it('resume-cone reconciles only the authenticated user scope before cap checks', async () => {
    const substrate = new FakeSubstrate();
    substrate.seedSandbox('foreign', {
      metadata: { userId: 'u2', name: 'foreign' },
      state: 'running',
    });
    substrate.seedSandbox('target', {
      metadata: { userId: 'u1', name: 'target' },
      state: 'paused',
    });
    const { state } = makeFakeState();
    const do_ = new CloudSessionsDurableObject(state, makeDoEnv(substrate));
    const res = await call(do_, '/resume-cone', {
      bearer: 'b',
      sandboxId: 'target',
      localSliccVersion: 'web-test',
      userId: 'u1',
    });
    expect(res.status).toBe(200);

    const list = await call(do_, '/list-cones', { userId: 'u1' });
    const body = (await list.json()) as { cones: Array<{ sandboxId: string }> };
    expect(body.cones.some((c) => c.sandboxId === 'target')).toBe(true);
    expect(body.cones.some((c) => c.sandboxId === 'foreign')).toBe(false);
  });

  it('kill-cone is idempotent', async () => {
    const substrate = new FakeSubstrate();
    const { state } = makeFakeState();
    const do_ = new CloudSessionsDurableObject(state, makeDoEnv(substrate));
    const res = await call(do_, '/kill-cone', { sandboxId: 'never-existed' });
    expect(res.status).toBe(200);
  });

  it('list-cones reconciles DO state against substrate', async () => {
    const substrate = new FakeSubstrate();
    substrate.seedSandbox('s-orphan', {
      metadata: { userId: 'u1', name: 'orphan' },
      state: 'running',
    });
    const { state } = makeFakeState();
    const do_ = new CloudSessionsDurableObject(state, makeDoEnv(substrate));
    const res = await call(do_, '/list-cones', { userId: 'u1' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cones: Array<{ sandboxId: string }> };
    // Orphan in substrate gets reconciled into the DO.
    expect(body.cones.some((c) => c.sandboxId === 's-orphan')).toBe(true);
  });
});
```

- [ ] **Step 3: Verify + commit**

```bash
npx vitest run --project cloudflare-worker packages/cloudflare-worker/tests/cloud-sessions-do.test.ts
git add -A
git commit -m "test(worker/cloud): DO lifecycle endpoints — cap, idempotent kill, reconciliation"
```

---

### Task D12: /sign-out + /admin/stats

**Files:**

- Create: `packages/cloudflare-worker/src/cloud/handler-signout.ts`
- Create: `packages/cloudflare-worker/src/cloud/handler-admin.ts`
- Modify: `packages/cloudflare-worker/tests/cloud-handlers.test.ts`

- [ ] **Step 1: handler-signout.ts**

```ts
import { extractBearer, AuthError } from './auth.js';
import { invalidate } from './auth-cache.js';
import { errorResponse, okResponse } from './error-envelope.js';

export async function handleSignOut(request: Request): Promise<Response> {
  let token: string;
  try {
    token = extractBearer(request);
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(401, err.code, err.message);
    return errorResponse(401, 'INVALID_TOKEN', 'auth failed');
  }
  await invalidate(token);
  return okResponse();
}
```

- [ ] **Step 2: handler-admin.ts**

```ts
import { authenticateRequest } from './auth-middleware.js';
import { errorResponse, okResponse } from './error-envelope.js';
import type { ValidateBearerEnv } from './auth.js';

export interface AdminEnv extends ValidateBearerEnv {
  ADMIN_USER_IDS: string;
}

export async function handleAdminStats(request: Request, env: AdminEnv): Promise<Response> {
  const auth = await authenticateRequest(request, env);
  if (auth instanceof Response) return auth;

  const admins = (env.ADMIN_USER_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!admins.includes(auth.userId)) {
    return errorResponse(403, 'NOT_ADMIN', 'admin access required');
  }

  return okResponse({
    note: 'v1: aggregate stats limited; full team view via e2b dashboard',
  });
}
```

- [ ] **Step 3: Tests**

```ts
it('sign-out invalidates auth cache', async () => {
  await setCached('drop', { userId: 'u', email: 'k@adobe.com', userName: 'K' });
  const req = new Request('https://w/api/cloud/sign-out', {
    method: 'POST',
    headers: { Authorization: 'Bearer drop' },
  });
  const res = await handleSignOut(req);
  expect(res.status).toBe(200);
  expect(await getCached('drop')).toBeNull();
});

it('admin/stats rejects non-admin with 403', async () => {
  await setCached('bearer', { userId: 'not-admin', email: 'k@adobe.com', userName: 'K' });
  const env = { ...makeCloudEnv(), ADMIN_USER_IDS: 'someone-else' };
  const req = new Request('https://w/api/cloud/admin/stats', {
    headers: { Authorization: 'Bearer bearer' },
  });
  const res = await handleAdminStats(req, env);
  expect(res.status).toBe(403);
});
```

- [ ] **Step 4: Verify + commit**

```bash
npx vitest run --project cloudflare-worker
git add -A
git commit -m "feat(worker/cloud): /sign-out and /admin/stats handlers"
```

---

## Phase D-5 — Route wiring + callback

### Task D13: Register routes in worker index.ts

**Files:**

- Modify: `packages/cloudflare-worker/src/index.ts`
- Modify: `packages/cloudflare-worker/tests/index.test.ts`
- Modify: `packages/cloudflare-worker/tests/deployed.test.ts`

- [ ] **Step 1: Wire the routes**

In the worker's `fetch()` dispatcher:

```ts
import {
  handleStart,
  handleList,
  handlePause,
  handleResume,
  handleKill,
} from './cloud/handlers.js';
import { handleSignOut } from './cloud/handler-signout.js';
import { handleAdminStats } from './cloud/handler-admin.js';

// ... inside fetch(), before existing route handling:
const url = new URL(request.url);
if (url.pathname.startsWith('/api/cloud/')) {
  const op = url.pathname.replace('/api/cloud/', '');
  switch (op) {
    case 'start':
      return handleStart(request, env);
    case 'list':
      return handleList(request, env);
    case 'pause':
      return handlePause(request, env);
    case 'resume':
      return handleResume(request, env);
    case 'kill':
      return handleKill(request, env);
    case 'sign-out':
      return handleSignOut(request);
    case 'admin/stats':
      return handleAdminStats(request, env);
    default:
      return new Response(`unknown cloud op: ${op}`, { status: 404 });
  }
}
```

- [ ] **Step 2: Update the routes-list smoke**

Find the routes array used by the default `/` response and the smoke tests. Add:

```
POST /api/cloud/start
GET  /api/cloud/list
POST /api/cloud/pause
POST /api/cloud/resume
POST /api/cloud/kill
POST /api/cloud/sign-out
GET  /api/cloud/admin/stats
```

(Exact shape: match the existing routes-list format in `packages/cloudflare-worker/src/index.ts` — look for the `routes` array near the top of the file.)

- [ ] **Step 3: Update both tests**

`tests/index.test.ts` and `tests/deployed.test.ts` both assert the routes list. Append the new entries to each.

- [ ] **Step 4: Verify**

```bash
npx vitest run --project cloudflare-worker
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(worker/cloud): wire /api/cloud/* routes in worker dispatcher"
```

---

### Task D14: /auth/cloud-callback

**Files:**

- Create: `packages/cloudflare-worker/src/auth/cloud-callback.ts`
- Modify: `packages/cloudflare-worker/src/index.ts`

- [ ] **Step 1: Create the callback HTML (no inline JS) + external script**

The popup carries an IMS bearer in `location.hash`. Per the spec's security section, the CSP must be `script-src 'self'` — no inline JS — so the token-bearing page doesn't loosen its CSP. Two files: HTML shell + external JS.

`packages/cloudflare-worker/src/auth/cloud-callback.ts`:

```ts
const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Signing in…</title></head>
<body>Signing in… you can close this tab if it doesn't close automatically.
<script src="/auth/cloud-callback.js"></script>
</body></html>`;

export function handleCloudCallback(): Response {
  return new Response(HTML, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'self'; script-src 'self'; frame-ancestors 'none';",
    },
  });
}
```

`packages/webapp/src/cloud-dashboard/auth-callback.js` (built to `dist/ui/auth/cloud-callback.js` via the same webapp build pipeline that handles the dashboard — add it as an extra rollup input):

```js
(function () {
  var hash = window.location.hash.replace(/^#/, '');
  var params = new URLSearchParams(hash);
  var token = params.get('access_token');
  var expiresIn = params.get('expires_in');
  if (!window.opener) {
    document.body.textContent = 'Sign-in completed, but no opener — close this tab.';
    return;
  }
  if (token) {
    window.opener.postMessage(
      { type: 'sliccy.cloud.imsToken', token: token, expiresIn: expiresIn },
      window.location.origin
    );
  } else {
    window.opener.postMessage(
      { type: 'sliccy.cloud.imsError', error: hash || 'no access_token in URL' },
      window.location.origin
    );
  }
  window.close();
})();
```

- [ ] **Step 2: Register both routes**

In `packages/cloudflare-worker/src/index.ts`:

```ts
import { handleCloudCallback } from './auth/cloud-callback.js';

// inside fetch() dispatcher:
if (url.pathname === '/auth/cloud-callback') {
  return handleCloudCallback();
}
if (url.pathname === '/auth/cloud-callback.js') {
  // Served by the ASSETS binding from dist/ui/auth/cloud-callback.js.
  return env.ASSETS.fetch(new Request(new URL('/auth/cloud-callback.js', request.url), request));
}
```

Add `'GET /auth/cloud-callback'` to the routes array and update tests.

- [ ] **Step 3: Verify + commit**

```bash
npx vitest run --project cloudflare-worker
git add -A
git commit -m "feat(worker/cloud): /auth/cloud-callback for IMS implicit-grant popup"
```

---

## Phase D-6 — Dashboard SPA

### Task D15: Dashboard HTML + CSS

**Files:**

- Create: `packages/webapp/src/cloud-dashboard/index.html`
- Create: `packages/webapp/src/cloud-dashboard/styles.css`
- Modify: `packages/webapp/vite.config.ts` (or equivalent) — emit dashboard files to `dist/ui/cloud/`
- Modify: `packages/cloudflare-worker/src/index.ts` — serve `/cloud` from existing ASSETS binding

**Why this location:** the worker already binds `assets.directory` to `../../dist/ui/` for the existing webapp SPA + tray join/controller pages. Creating a new `static/` directory would conflict with that binding. Instead, the dashboard is built alongside the webapp into `dist/ui/cloud/` — same build pipeline, same ASSETS binding, no wrangler.jsonc changes.

- [ ] **Step 1: index.html** (lives at `packages/webapp/src/cloud-dashboard/index.html`; built to `dist/ui/cloud/index.html`)

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>SLICC cloud cones</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <header>
      <h1>Cloud cones</h1>
      <div id="user-box" class="hidden">
        <span id="user-label"></span>
        <button id="sign-out-btn">Sign out</button>
      </div>
    </header>

    <main id="signed-out" class="hidden">
      <button id="sign-in-btn">Sign in with Adobe</button>
    </main>

    <main id="signed-in" class="hidden">
      <section class="create-row">
        <input id="cone-name" placeholder="name (optional)" autocomplete="off" />
        <button id="create-btn">+ New cone</button>
        <span id="create-status" class="status"></span>
      </section>
      <section class="list">
        <ul id="cone-list"></ul>
        <div id="cap-info" class="cap-info"></div>
      </section>
    </main>

    <div id="toast" class="toast hidden" role="status" aria-live="polite"></div>
    <script type="module" src="./app.js"></script>
  </body>
</html>
```

- [ ] **Step 2: styles.css**

```css
body {
  font:
    14px/1.4 system-ui,
    sans-serif;
  margin: 24px auto;
  max-width: 720px;
  color: #1a1a1a;
}
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid #ccc;
  padding-bottom: 12px;
}
.hidden {
  display: none !important;
}
.create-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin: 16px 0;
}
#cone-list {
  list-style: none;
  padding: 0;
  margin: 12px 0;
}
.cone {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px;
  border: 1px solid #ddd;
  border-radius: 6px;
  margin-bottom: 8px;
}
.state-dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  margin-right: 8px;
}
.cone.running .state-dot {
  background: #2ec27e;
}
.cone.paused .state-dot {
  background: #b8b8b8;
}
.cone.dead .state-dot {
  background: #e02020;
}
.cone-actions {
  display: flex;
  gap: 6px;
}
.status {
  color: #666;
}
.toast {
  position: fixed;
  top: 16px;
  right: 16px;
  padding: 12px 16px;
  background: #1a1a1a;
  color: #fff;
  border-radius: 6px;
  max-width: 320px;
}
.cap-info {
  font-size: 12px;
  color: #666;
  text-align: right;
}
```

- [ ] **Step 3: Add the dashboard as a webapp build input**

The worker's existing `ASSETS` binding already points at `../../dist/ui/`. Do NOT change it. Instead, add the dashboard as a separate Rollup input in the webapp's Vite config so its `index.html` lands at `dist/ui/cloud/index.html`.

Edit `packages/webapp/vite.config.ts`. Find the `build.rollupOptions.input` block (or create one) and add the dashboard entry:

```ts
build: {
  rollupOptions: {
    input: {
      main: resolve(__dirname, 'index.html'),                       // existing
      cloud: resolve(__dirname, 'src/cloud-dashboard/index.html'),  // NEW
      // also wire the OAuth callback's external JS so it lands at /auth/cloud-callback.js:
      authCloudCallback: resolve(__dirname, 'src/cloud-dashboard/auth-callback.js'),
    },
  },
},
```

(Adapt to whatever the current vite config shape is. The goal: dashboard assets emit to `dist/ui/cloud/`, callback JS emits to `dist/ui/auth/cloud-callback.js`. Both served by the existing ASSETS binding.)

Verify:

```bash
npm run build -w @slicc/webapp
ls dist/ui/cloud/                    # expect: index.html, hashed app.js, styles.css
ls dist/ui/auth/cloud-callback.js    # expect: the callback script
```

- [ ] **Step 4: Serve /cloud with CSP via existing ASSETS binding**

In `packages/cloudflare-worker/src/index.ts`:

```ts
if (url.pathname === '/cloud' || url.pathname.startsWith('/cloud/')) {
  const path = url.pathname === '/cloud' ? '/cloud/index.html' : url.pathname;
  const res = await env.ASSETS.fetch(new Request(new URL(path, request.url), request));
  if (!res.body) return res;
  const headers = new Headers(res.headers);
  headers.set(
    'content-security-policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "connect-src 'self' https://ims-na1.adobelogin.com",
      "img-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "frame-ancestors 'none'",
    ].join('; ')
  );
  return new Response(res.body, { status: res.status, headers });
}
```

- [ ] **Step 5: Verify**

```bash
npm run build -w @slicc/cloudflare-worker
npx wrangler dev --config packages/cloudflare-worker/wrangler.jsonc
# in another terminal:
curl -sI http://localhost:8787/cloud
```

Expected: 200, `content-type: text/html`, `content-security-policy` header present.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(worker/cloud): dashboard HTML+CSS skeleton at /cloud with CSP"
```

---

### Task D16: Dashboard JS — sign-in flow

**Files:**

- Create: `packages/webapp/src/cloud-dashboard/app.js`

- [ ] **Step 1: Create app.js (sign-in only; list/actions in next tasks)**

```js
const TOKEN_KEY = 'cloud-ims-token';
const TOKEN_EXP_KEY = 'cloud-ims-token-exp';
const IMS_AUTHORIZE_URL = 'https://ims-na1.adobelogin.com/ims/authorize/v2';
const REDIRECT_URI = `${window.location.origin}/auth/cloud-callback`;
const SCOPE = 'openid,profile,email,session,ab.manage';
// Set to match wrangler.jsonc IMS_CLIENT_ID. If wired from /api/runtime-config later, replace.
const IMS_CLIENT_ID = 'darkalley';

function getToken() {
  const token = localStorage.getItem(TOKEN_KEY);
  const exp = parseInt(localStorage.getItem(TOKEN_EXP_KEY) || '0', 10);
  if (!token || exp < Date.now()) return null;
  return token;
}

function setToken(token, expiresInSec) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(
    TOKEN_EXP_KEY,
    String(Date.now() + (parseInt(expiresInSec, 10) || 0) * 1000)
  );
}

function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(TOKEN_EXP_KEY);
}

function showToast(message) {
  const el = document.getElementById('toast');
  el.textContent = message; // safe: textContent prevents XSS
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

function setSignedIn() {
  document.getElementById('signed-out').classList.add('hidden');
  document.getElementById('signed-in').classList.remove('hidden');
  document.getElementById('user-box').classList.remove('hidden');
  document.getElementById('user-label').textContent = 'signed in';
}

function setSignedOut() {
  document.getElementById('signed-out').classList.remove('hidden');
  document.getElementById('signed-in').classList.add('hidden');
  document.getElementById('user-box').classList.add('hidden');
}

function startImsPopup() {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      client_id: IMS_CLIENT_ID,
      scope: SCOPE,
      response_type: 'token',
      redirect_uri: REDIRECT_URI,
      state: crypto.randomUUID(),
    });
    const popup = window.open(
      `${IMS_AUTHORIZE_URL}?${params}`,
      'sliccy-cloud-ims',
      'width=480,height=640'
    );
    if (!popup) return reject(new Error('popup blocked'));

    function onMessage(ev) {
      if (ev.origin !== window.location.origin) return;
      if (ev.data?.type === 'sliccy.cloud.imsToken') {
        window.removeEventListener('message', onMessage);
        setToken(ev.data.token, ev.data.expiresIn);
        resolve();
      } else if (ev.data?.type === 'sliccy.cloud.imsError') {
        window.removeEventListener('message', onMessage);
        reject(new Error(ev.data.error));
      }
    }
    window.addEventListener('message', onMessage);
  });
}

document.getElementById('sign-in-btn').addEventListener('click', async () => {
  try {
    await startImsPopup();
    setSignedIn();
    await refreshList();
  } catch (err) {
    showToast('Sign-in failed: ' + err.message);
  }
});

document.getElementById('sign-out-btn').addEventListener('click', async () => {
  const token = getToken();
  if (token) {
    try {
      await fetch('/api/cloud/sign-out', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      /* best-effort */
    }
  }
  clearToken();
  setSignedOut();
});

// Initial state.
if (getToken()) {
  setSignedIn();
  refreshList();
} else {
  setSignedOut();
}

// refreshList implemented in Task D17.
async function refreshList() {}
```

- [ ] **Step 2: Manual smoke**

```bash
npx wrangler dev --config packages/cloudflare-worker/wrangler.jsonc
# browser → http://localhost:8787/cloud → click Sign in → IMS popup → token captured.
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(dashboard): IMS implicit-grant sign-in flow"
```

---

### Task D17: Dashboard JS — list rendering + polling

**Files:**

- Modify: `packages/webapp/src/cloud-dashboard/app.js`

- [ ] **Step 1: Replace the `refreshList()` stub and add safe-DOM rendering**

Append to / replace the bottom of `app.js`:

```js
async function api(path, options = {}) {
  const token = getToken();
  if (!token) throw new Error('not authenticated');
  const res = await fetch(path, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
    },
  });
  if (res.status === 401) {
    clearToken();
    setSignedOut();
    showToast('Session expired — please sign in again.');
    throw new Error('unauthorized');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'unknown', message: res.statusText }));
    throw Object.assign(new Error(body.message || 'error'), { code: body.error });
  }
  return res.json();
}

function timeAgo(iso) {
  const d = new Date(iso);
  const sec = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (sec < 60) return `${Math.floor(sec)}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)} min ago`;
  return `${Math.floor(sec / 3600)} hr ago`;
}

// Safe DOM building — every value goes through textContent or attribute setters.
// No innerHTML anywhere; no template-literal HTML.
function renderCones(cones) {
  const list = document.getElementById('cone-list');
  list.replaceChildren();

  for (const c of cones) {
    const li = document.createElement('li');
    li.className = `cone ${c.state}`;

    const left = document.createElement('div');
    const dot = document.createElement('span');
    dot.className = 'state-dot';
    left.appendChild(dot);
    const name = document.createElement('strong');
    name.textContent = c.name || c.sandboxId;
    left.appendChild(name);
    left.appendChild(document.createTextNode(' '));
    const status = document.createElement('span');
    status.className = 'status';
    status.textContent = `${c.state} · ${timeAgo(c.lastSeen)}`;
    left.appendChild(status);
    li.appendChild(left);

    const actions = document.createElement('div');
    actions.className = 'cone-actions';

    if (c.state === 'running' && c.joinUrl) {
      const open = document.createElement('a');
      open.href = c.joinUrl;
      open.target = '_blank';
      open.rel = 'noopener noreferrer';
      open.title =
        'This link grants follower access — only share with people you trust to see this cone.';
      open.textContent = 'Open ⤴';
      actions.appendChild(open);
    }
    if (c.state === 'running') {
      const btn = document.createElement('button');
      btn.textContent = 'Pause';
      btn.addEventListener('click', () => pauseCone(c.sandboxId));
      actions.appendChild(btn);
    }
    if (c.state === 'paused') {
      const btn = document.createElement('button');
      btn.textContent = 'Resume';
      btn.addEventListener('click', () => resumeCone(c.sandboxId));
      actions.appendChild(btn);
    }
    const killBtn = document.createElement('button');
    killBtn.textContent = 'Kill';
    killBtn.addEventListener('click', () => killConeAction(c.sandboxId));
    actions.appendChild(killBtn);

    li.appendChild(actions);
    list.appendChild(li);
  }

  const running = cones.filter((c) => c.state === 'running').length;
  const paused = cones.filter((c) => c.state === 'paused').length;
  document.getElementById('cap-info').textContent =
    `${running} running · ${paused} paused (cap: 1/5)`;

  const createBtn = document.getElementById('create-btn');
  createBtn.disabled = running >= 1;
  createBtn.title = createBtn.disabled
    ? `Cap reached (${running}/1 running). Pause or kill another first.`
    : '';
}

async function refreshList() {
  try {
    const data = await api('/api/cloud/list');
    renderCones(data.cones || []);
  } catch (e) {
    if (e.message !== 'unauthorized') showToast('List failed: ' + e.message);
  }
}

window.addEventListener('focus', () => {
  if (getToken()) refreshList();
});

// Stubs filled in Task D18.
async function pauseCone() {}
async function resumeCone() {}
async function killConeAction() {}
```

(Note: action functions use safe-DOM construction throughout — no innerHTML, no HTML template literals. Every user-controllable value passes through `textContent` or `setAttribute`.)

- [ ] **Step 2: Manual smoke**

Sign in via wrangler dev. List should render empty without console errors.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(dashboard): list rendering with safe DOM construction + focus-poll"
```

---

### Task D18: Dashboard JS — create / pause / resume / kill

**Files:**

- Modify: `packages/webapp/src/cloud-dashboard/app.js`

- [ ] **Step 1: Replace the stubs**

```js
async function pauseCone(sandboxId) {
  try {
    await api('/api/cloud/pause', { method: 'POST', body: JSON.stringify({ sandboxId }) });
    await refreshList();
  } catch (e) {
    showToast('Pause failed: ' + e.message);
  }
}

async function resumeCone(sandboxId) {
  try {
    await api('/api/cloud/resume', { method: 'POST', body: JSON.stringify({ sandboxId }) });
    await refreshList();
  } catch (e) {
    showToast('Resume failed: ' + e.message);
  }
}

async function killConeAction(sandboxId) {
  if (!confirm('Kill this cone? This cannot be undone.')) return;
  try {
    await api('/api/cloud/kill', { method: 'POST', body: JSON.stringify({ sandboxId }) });
    await refreshList();
  } catch (e) {
    showToast('Kill failed: ' + e.message);
  }
}

let createController = null;

const createBtn = document.getElementById('create-btn');
createBtn.addEventListener('click', async () => {
  // If a create is in flight, this click cancels.
  if (createController) {
    createController.abort();
    createController = null;
    return;
  }
  const nameInput = document.getElementById('cone-name');
  const status = document.getElementById('create-status');
  const name = nameInput.value.trim() || undefined;
  const originalLabel = createBtn.textContent;
  createBtn.textContent = 'Cancel';
  status.textContent = 'starting…';
  createController = new AbortController();
  try {
    const result = await api('/api/cloud/start', {
      method: 'POST',
      body: JSON.stringify({ name }),
      signal: createController.signal,
    });
    status.textContent = 'ready';
    nameInput.value = '';
    await refreshList();
    if (result.joinUrl) {
      window.open(result.joinUrl, '_blank', 'noopener,noreferrer');
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      status.textContent = 'cancelled';
    } else {
      showToast('Create failed: ' + e.message);
      status.textContent = '';
    }
  } finally {
    createBtn.textContent = originalLabel;
    createController = null;
    setTimeout(() => (status.textContent = ''), 3000);
  }
});
```

- [ ] **Step 2: Manual smoke**

```bash
# wrangler dev running
# in browser: sign in → click + New cone → spinner ~25s → joinUrl tab opens
# pause → state flips → resume → spinner → flips back → kill → entry removed
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(dashboard): create with cancel + pause/resume/kill + auto-open joinUrl"
```

---

### Task D19: CSP enforcement test

**Files:**

- Create: `packages/cloudflare-worker/tests/cloud-csp.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect } from 'vitest';
import { unstable_dev } from 'wrangler';

describe('CSP', () => {
  it('serves /cloud with a content-security-policy header', async () => {
    const worker = await unstable_dev('packages/cloudflare-worker/src/index.ts', {
      experimental: { disableExperimentalWarning: true },
    });
    try {
      const res = await worker.fetch('/cloud');
      const csp = res.headers.get('content-security-policy');
      expect(csp).toBeTruthy();
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain('https://ims-na1.adobelogin.com');
    } finally {
      await worker.stop();
    }
  });
});
```

- [ ] **Step 2: Verify + commit**

```bash
npx vitest run --project cloudflare-worker packages/cloudflare-worker/tests/cloud-csp.test.ts
git add -A
git commit -m "test(worker/cloud): CSP header smoke on /cloud responses"
```

---

## Phase D-7 — Live test + deployed smoke

### Task D20: Live opt-in test

**Files:**

- Create: `packages/cloudflare-worker/tests/cloud-live.test.ts`

- [ ] **Step 1: Write the test**

```ts
// packages/cloudflare-worker/tests/cloud-live.test.ts
import { describe, it, expect } from 'vitest';
import { createSubstrate, startCone, killCone } from '@slicc/cloud-core';
import type { ConeEntry, Registry } from '@slicc/cloud-core';

const apiKey = process.env['SLICC_TEST_E2B_API_KEY'];
const describeFn = apiKey ? describe : describe.skip;

class MemRegistry implements Registry {
  private entries: ConeEntry[] = [];
  async list() {
    return [...this.entries];
  }
  async findByNameOrId(q: string) {
    return this.entries.find((e) => e.sandboxId === q || e.name === q) ?? null;
  }
  async append(e: ConeEntry) {
    this.entries.push(e);
  }
  async update(id: string, patch: Partial<ConeEntry>) {
    const i = this.entries.findIndex((e) => e.sandboxId === id);
    if (i >= 0) this.entries[i] = { ...this.entries[i]!, ...patch };
  }
  async remove(id: string) {
    this.entries = this.entries.filter((e) => e.sandboxId !== id);
  }
}

describeFn('worker substrate live (requires SLICC_TEST_E2B_API_KEY)', () => {
  it(
    'creates and kills a sandbox via cloud-core ops',
    async () => {
      const substrate = createSubstrate('e2b', { apiKey: apiKey! });
      const registry = new MemRegistry();
      const result = await startCone(
        { substrate, registry },
        {
          envContents: 'ANTHROPIC_API_KEY=sk-fake\nANTHROPIC_API_KEY_DOMAINS=api.anthropic.com',
          envs: {
            ADOBE_IMS_TOKEN: 'fake-bearer',
            ADOBE_IMS_TOKEN_DOMAINS: 'adobe-llm-proxy.example',
          },
          workerBaseUrl: 'https://www.sliccy.ai',
          sliccVersion: 'live-worker-test',
          name: `live-worker-${Date.now()}`,
          pollTimeoutMs: 120_000,
        }
      );
      expect(result.joinUrl).toMatch(/^https:\/\//);
      await killCone({ substrate, registry }, result.sandboxId);
    },
    5 * 60 * 1000
  );
});
```

- [ ] **Step 2: Run**

```bash
SLICC_TEST_E2B_API_KEY="$E2B_API_KEY" \
  npx vitest run --project cloudflare-worker packages/cloudflare-worker/tests/cloud-live.test.ts
```

Expected: 1 passed (~12s).

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "test(worker/cloud): live opt-in test against real e2b"
```

---

### Task D21: Deployed smoke

**Files:**

- Modify: `packages/cloudflare-worker/tests/deployed.test.ts`

- [ ] **Step 1: Append cloud smoke**

```ts
describe('cloud routes smoke', () => {
  it('rejects unauthenticated /api/cloud/list with 401', async () => {
    const res = await fetch(`${WORKER_BASE_URL}/api/cloud/list`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/MISSING_TOKEN|INVALID_TOKEN/);
  });

  it('serves /cloud dashboard with CSP', async () => {
    const res = await fetch(`${WORKER_BASE_URL}/cloud`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(res.headers.get('content-security-policy')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Verify**

```bash
WORKER_BASE_URL=<staging-url> \
  cd packages/cloudflare-worker && npm test -- tests/deployed.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "test(worker/cloud): deployed smoke for /api/cloud auth-401 + /cloud CSP"
```

---

## Phase D-8 — CI + docs + cleanup

### Task D22: Extend worker.yml to build the e2b template

**Files:**

- Modify: `.github/workflows/worker.yml`

- [ ] **Step 1: Add template build + verify steps**

Append after the existing `wrangler deploy` step:

```yaml
- name: Build and push e2b template
  run: bash packages/dev-tools/e2b-template/scripts/build-template.sh
  env:
    E2B_API_KEY: ${{ secrets.E2B_API_KEY }}

- name: Verify template boots
  run: bash packages/dev-tools/e2b-template/scripts/verify-template.sh
  env:
    SLICC_TEST_E2B_API_KEY: ${{ secrets.E2B_API_KEY }}
```

(Confirm the trigger block `on:` matches release-tag cadence per spec; adjust if currently main-push.)

- [ ] **Step 2: Add `E2B_API_KEY` to repo secrets**

Document in `packages/cloudflare-worker/CLAUDE.md` (Task D23) that this secret needs to be set on the GitHub repo, scoped to the Adobe team e2b workspace.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "ci(worker): rebuild + verify e2b template on release"
```

---

### Task D23: Update worker CLAUDE.md

**Files:**

- Modify: `packages/cloudflare-worker/CLAUDE.md`

- [ ] **Step 1: Append cloud-cones section**

Append to the end of the existing CLAUDE.md:

````markdown
## Cloud cones (sliccy.ai/cloud)

Web feature shipped via Plan D. See spec at
`docs/superpowers/specs/2026-05-26-cloud-cones-on-sliccy-ai-design.md`.

### Routes

- `GET  /cloud` — dashboard SPA (CSP-enforced)
- `GET  /auth/cloud-callback` — IMS popup callback
- `POST /api/cloud/start | /pause | /resume | /kill | /sign-out` — lifecycle
- `GET  /api/cloud/list` — per-user cone list (reconciled with e2b per call)
- `GET  /api/cloud/admin/stats` — admin-gated by ADMIN_USER_IDS

All `/api/cloud/*` require `Authorization: Bearer <ims-access-token>` and
route to `env.CLOUD_SESSIONS.idFromName(userId)` for per-user state.

### Wrangler config

Vars (in `wrangler.jsonc`):

- `ALLOWED_EMAIL_DOMAIN` — CSV, default `adobe.com`, `*` to disable
- `BLOCKED_EMAILS` — CSV denylist
- `REQUIRE_OWNER_ORG` — `true` for v2 expansion to any ownerOrg-holder
- `IMS_CLIENT_ID`, `IMS_ENVIRONMENT` — IMS app identity
- `CONE_CAP_RUNNING`, `CONE_CAP_PAUSED` — per-user caps
- `ADMIN_USER_IDS` — CSV of IMS userIds with admin access

Secrets (`wrangler secret put`):

- `E2B_API_KEY` — Adobe team e2b key. Worker-only; never reachable from browser.

GitHub Actions secrets (for CI worker deploy + template build):

- `E2B_API_KEY` — same value; scoped to the Adobe team workspace.

### v1 → v2 expansion

```bash
npx wrangler secret put REQUIRE_OWNER_ORG  # value: true
# update ALLOWED_EMAIL_DOMAIN in wrangler.jsonc to "*"
npx wrangler deploy
```
````

### Stable API contract (worker ↔ sandbox)

Worker depends on these surfaces inside paused-cone images. **Breaking
changes require a deprecation cycle** because paused cones from older
templates can't be patched:

- `POST /api/leader-restart` (loopback in sandbox)
- `GET  /api/hosted-bootstrap` (loopback in sandbox)
- `POST /api/cloud-status` (loopback in sandbox)
- `/slicc/secrets.env` — sandbox file the worker writes
- `/tmp/slicc-join.json` — sandbox file the worker reads via SDK
- `ADOBE_IMS_TOKEN`, `ADOBE_IMS_TOKEN_DOMAINS`, `SLICC_TRAY_WORKER_BASE_URL` —
  envs consumed by `start.sh`

### Routes mirror rule (existing)

Update routes in all three places when adding to `/api/cloud/*`:

- `src/index.ts` routes array (the default `GET /` body)
- `tests/index.test.ts` routes-list assertion
- `tests/deployed.test.ts` routes-list assertion

````

- [ ] **Step 2: Commit**

```bash
git add packages/cloudflare-worker/CLAUDE.md
git commit -m "docs(worker): cloud-cones routes, config, and stable-API contract"
````

---

### Task D24: Spike cleanup + final verification

**Files:**

- Delete: `packages/cloudflare-worker/src/spike/`
- Modify: `packages/cloudflare-worker/src/index.ts` — remove spike route

- [ ] **Step 1: Drop spike code (if present from Plan C)**

```bash
rm -rf packages/cloudflare-worker/src/spike
```

Remove the `if (url.pathname.startsWith('/spike/'))` branch from `src/index.ts`.

- [ ] **Step 2: Unset SPIKE_ENABLED**

```bash
cd packages/cloudflare-worker
npx wrangler secret delete SPIKE_ENABLED --env production 2>/dev/null || true
npx wrangler secret delete SPIKE_ENABLED --env staging 2>/dev/null || true
```

- [ ] **Step 3: Run all the gates**

```bash
npx prettier --write packages/cloudflare-worker packages/cloud-core/src
npm run typecheck
npm run test
npm run build -w @slicc/cloudflare-worker
```

Expected: all green.

- [ ] **Step 4: Deploy to staging + manual smoke**

```bash
npx wrangler deploy --env staging --config packages/cloudflare-worker/wrangler.jsonc
```

Open `https://<staging-url>/cloud` in a browser. Confirm full flow:

- Sign in with Adobe IMS → consent screen → dashboard renders with your name
- Create a cone → spinner → joinUrl tab opens → chat UI loads
- Send a message → Adobe LLM responds
- Pause → state flips, joinUrl link disappears
- Resume → spinner → fresh joinUrl → chat continues
- Kill → entry removed, e2b sandbox cleaned up

- [ ] **Step 5: Commit cleanup**

```bash
git add -A
git commit -m "chore(worker): remove Plan C spike artifacts; Plan D ready for promotion"
```

---

## Plan D done

End state:

- `sliccy.ai/cloud` is a fully functional dashboard backed by IMS auth, per-user DurableObjects, worker-resident e2b orchestration via `@slicc/cloud-core`.
- `/api/cloud/*` REST surface covers full lifecycle with caps + rate-limits + reconciliation.
- CI rebuilds the e2b template on release; verify-template smoke runs after.
- Worker CLAUDE.md documents the routes, config matrix, stable API contract.
- Unit + live opt-in + deployed smoke all green.

Promotion path (post-merge):

1. PR review, merge to main.
2. Cut a release tag; CI deploys staging worker + rebuilds template.
3. Watch staging for ~1 day; manual flow tests with the wider team.
4. Promote to production worker (`wrangler deploy --env production`).
5. Announce internally; populate `ADMIN_USER_IDS` for whoever ops the feature.
