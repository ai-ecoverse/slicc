# Cloud Cone Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users configure a cloud cone's model, secrets, and provider logins (API-key + interactive OAuth) at create time and edit/renew them on resume, via the `/cloud` dashboard.

**Architecture:** A single logical `ConeConfig` bundle (`{ model, accounts[], secrets[] }`) is produced in the dashboard's real browser (reusing the webapp's provider-login UI via a slim `?connect=1` mode) and sent through the worker, which lands it in two sandbox files — `/slicc/secrets.env` (flat secrets, read by `EnvSecretStore`) and `/slicc/cone-config.json` (`{model,accounts}`, served to the webapp via `/api/hosted-bootstrap`). Preboot injection is two base64 env vars decoded by `start.sh` then unset. Resume sends a delta the worker read-modify-writes into both files, then fires an ordered reload hook (`secretProxy.reload()` then leader-restart `Page.reload`). A names-only index in the `CloudSessionsDurableObject` lets the dashboard show provisioned keys while the cone is paused.

**Tech Stack:** TypeScript across `@slicc/cloud-core` (Node + Cloudflare-worker shared), `@slicc/cloudflare-worker` (Workers runtime), `@slicc/node-server` (Express), `@slicc/webapp` (vanilla TS browser). Tests: Vitest (`packages/*/tests/`, `globals: true`, `environment: node`). Spec: `docs/superpowers/specs/2026-05-29-cloud-cone-config-design.md`.

**Conventions for every task:** Run Prettier on changed files before committing (`npx prettier --write <files>`). Per-package tests: `npx vitest run --project <pkg> <testfile>`. Commit messages use Conventional Commits.

---

## Phase A — Shared contract

### Task 1: `cone-config` types + pure helpers in `@slicc/cloud-core`

A side-effect-free module (no `e2b`/Node imports) usable by the worker, node-server, and the browser webapp.

**Files:**
- Create: `packages/cloud-core/src/cone-config/index.ts`
- Test: `packages/cloud-core/tests/cone-config/cone-config.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/cloud-core/tests/cone-config/cone-config.test.ts
import { describe, it, expect } from 'vitest';
import {
  validateConeConfig,
  mergeConeConfig,
  serializeSecretsEnv,
  bundleToFiles,
  bundleIndex,
  encodeBundleEnv,
  decodeBundleEnv,
  MAX_CONE_CONFIG_BYTES,
  type ConeConfig,
} from '../../src/cone-config/index.js';

const base: ConeConfig = {
  model: 'anthropic:claude-opus-4-6',
  accounts: [
    { providerId: 'adobe', kind: 'oauth', accessToken: 'a', tokenExpiresAt: 0 },
    { providerId: 'anthropic', kind: 'apikey', apiKey: 'k' },
  ],
  secrets: [{ name: 'GITHUB_TOKEN', value: 'gt', domains: ['api.github.com', 'github.com'] }],
};

describe('validateConeConfig', () => {
  it('accepts a well-formed bundle', () => {
    expect(validateConeConfig(base)).toEqual(base);
  });
  it('rejects an oauth account missing accessToken', () => {
    expect(() =>
      validateConeConfig({ ...base, accounts: [{ providerId: 'x', kind: 'oauth' }] })
    ).toThrow(/accessToken/);
  });
  it('rejects an apikey account missing apiKey', () => {
    expect(() =>
      validateConeConfig({ ...base, accounts: [{ providerId: 'x', kind: 'apikey' }] })
    ).toThrow(/apiKey/);
  });
  it('rejects a secret whose domains is not string[]', () => {
    expect(() =>
      validateConeConfig({ ...base, secrets: [{ name: 'X', value: 'v', domains: 'a,b' }] })
    ).toThrow(/domains/);
  });
});

describe('mergeConeConfig', () => {
  it('upserts accounts by providerId and secrets by name, and deletes', () => {
    const merged = mergeConeConfig(base, {
      upsert: {
        accounts: [{ providerId: 'anthropic', kind: 'apikey', apiKey: 'k2' }],
        secrets: [{ name: 'NEW', value: 'n', domains: ['x.com'] }],
      },
      delete: { providerIds: ['adobe'], secretNames: ['GITHUB_TOKEN'] },
    });
    expect(merged.accounts).toEqual([{ providerId: 'anthropic', kind: 'apikey', apiKey: 'k2' }]);
    expect(merged.secrets).toEqual([{ name: 'NEW', value: 'n', domains: ['x.com'] }]);
    expect(merged.model).toBe('anthropic:claude-opus-4-6');
  });
  it('replaces model only when the delta provides one', () => {
    expect(mergeConeConfig(base, { model: 'openai:gpt-x' }).model).toBe('openai:gpt-x');
    expect(mergeConeConfig(base, {}).model).toBe('anthropic:claude-opus-4-6');
  });
});

describe('serializeSecretsEnv + bundleToFiles', () => {
  it('emits NAME and NAME_DOMAINS lines', () => {
    expect(serializeSecretsEnv(base.secrets)).toBe(
      'GITHUB_TOKEN=gt\nGITHUB_TOKEN_DOMAINS=api.github.com,github.com\n'
    );
  });
  it('emits empty string for no secrets', () => {
    expect(serializeSecretsEnv([])).toBe('');
  });
  it('splits a bundle into cone-config.json + secrets.env', () => {
    const { coneConfigJson, secretsEnv } = bundleToFiles(base);
    expect(JSON.parse(coneConfigJson)).toEqual({ model: base.model, accounts: base.accounts });
    expect(secretsEnv).toContain('GITHUB_TOKEN=gt');
  });
});

describe('bundleIndex', () => {
  it('produces a names-only index with no values', () => {
    const idx = bundleIndex(base);
    expect(idx).toEqual({
      model: 'anthropic:claude-opus-4-6',
      accountProviderIds: ['adobe', 'anthropic'],
      accountMeta: [
        { providerId: 'adobe', kind: 'oauth', tokenExpiresAt: 0 },
        { providerId: 'anthropic', kind: 'apikey', tokenExpiresAt: undefined },
      ],
      secretNames: ['GITHUB_TOKEN'],
    });
    expect(JSON.stringify(idx)).not.toContain('gt'); // no secret values leak
  });
});

describe('base64 env round-trip', () => {
  it('round-trips UTF-8 JSON', () => {
    const json = JSON.stringify({ s: 'héllo — 🍦' });
    expect(decodeBundleEnv(encodeBundleEnv(json))).toBe(json);
  });
  it('exposes a positive size cap', () => {
    expect(MAX_CONE_CONFIG_BYTES).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project cloud-core packages/cloud-core/tests/cone-config/cone-config.test.ts`
Expected: FAIL — cannot resolve `../../src/cone-config/index.js`.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/cloud-core/src/cone-config/index.ts
// Side-effect-free shared contract for cloud-cone configuration.
// MUST NOT import e2b, node:*, or any runtime substrate — it is imported
// by the browser webapp via the @slicc/cloud-core/cone-config subpath.

export interface OAuthAccount {
  providerId: string;
  kind: 'oauth';
  accessToken: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
  userName?: string;
  baseUrl?: string;
}
export interface ApiKeyAccount {
  providerId: string;
  kind: 'apikey';
  apiKey: string;
  baseUrl?: string;
  deployment?: string;
  apiVersion?: string;
}
export type Account = OAuthAccount | ApiKeyAccount;

export interface SecretEntry {
  name: string;
  value: string;
  domains: string[];
}

export interface ConeConfig {
  model: string;
  accounts: Account[];
  secrets: SecretEntry[];
}

export interface ConeConfigDelta {
  model?: string;
  upsert?: { accounts?: Account[]; secrets?: SecretEntry[] };
  delete?: { providerIds?: string[]; secretNames?: string[] };
}

export interface ConeConfigIndex {
  model: string;
  accountProviderIds: string[];
  accountMeta: Array<{ providerId: string; kind: Account['kind']; tokenExpiresAt?: number }>;
  secretNames: string[];
}

/** Max serialized bundle size (bytes) accepted as a preboot env payload. */
export const MAX_CONE_CONFIG_BYTES = 256 * 1024;

function isStr(v: unknown): v is string {
  return typeof v === 'string';
}

export function validateConeConfig(input: unknown): ConeConfig {
  if (!input || typeof input !== 'object') throw new Error('cone-config: not an object');
  const cfg = input as Record<string, unknown>;
  if (!isStr(cfg.model)) throw new Error('cone-config: model must be a string');
  if (!Array.isArray(cfg.accounts)) throw new Error('cone-config: accounts must be an array');
  if (!Array.isArray(cfg.secrets)) throw new Error('cone-config: secrets must be an array');
  const accounts = cfg.accounts.map((a) => validateAccount(a));
  const secrets = cfg.secrets.map((s) => validateSecret(s));
  return { model: cfg.model, accounts, secrets };
}

function validateAccount(a: unknown): Account {
  if (!a || typeof a !== 'object') throw new Error('cone-config: account not an object');
  const acc = a as Record<string, unknown>;
  if (!isStr(acc.providerId)) throw new Error('cone-config: account.providerId required');
  if (acc.kind === 'oauth') {
    if (!isStr(acc.accessToken)) throw new Error('cone-config: oauth account requires accessToken');
    return {
      providerId: acc.providerId,
      kind: 'oauth',
      accessToken: acc.accessToken,
      ...(isStr(acc.refreshToken) ? { refreshToken: acc.refreshToken } : {}),
      ...(typeof acc.tokenExpiresAt === 'number' ? { tokenExpiresAt: acc.tokenExpiresAt } : {}),
      ...(isStr(acc.userName) ? { userName: acc.userName } : {}),
      ...(isStr(acc.baseUrl) ? { baseUrl: acc.baseUrl } : {}),
    };
  }
  if (acc.kind === 'apikey') {
    if (!isStr(acc.apiKey)) throw new Error('cone-config: apikey account requires apiKey');
    return {
      providerId: acc.providerId,
      kind: 'apikey',
      apiKey: acc.apiKey,
      ...(isStr(acc.baseUrl) ? { baseUrl: acc.baseUrl } : {}),
      ...(isStr(acc.deployment) ? { deployment: acc.deployment } : {}),
      ...(isStr(acc.apiVersion) ? { apiVersion: acc.apiVersion } : {}),
    };
  }
  throw new Error(`cone-config: account.kind must be 'oauth' | 'apikey'`);
}

function validateSecret(s: unknown): SecretEntry {
  if (!s || typeof s !== 'object') throw new Error('cone-config: secret not an object');
  const sec = s as Record<string, unknown>;
  if (!isStr(sec.name)) throw new Error('cone-config: secret.name required');
  if (!isStr(sec.value)) throw new Error('cone-config: secret.value required');
  if (!Array.isArray(sec.domains) || !sec.domains.every(isStr)) {
    throw new Error('cone-config: secret.domains must be string[]');
  }
  return { name: sec.name, value: sec.value, domains: sec.domains as string[] };
}

export function mergeConeConfig(base: ConeConfig, delta: ConeConfigDelta): ConeConfig {
  const accounts = new Map(base.accounts.map((a) => [a.providerId, a]));
  for (const a of delta.upsert?.accounts ?? []) accounts.set(a.providerId, a);
  for (const id of delta.delete?.providerIds ?? []) accounts.delete(id);
  const secrets = new Map(base.secrets.map((s) => [s.name, s]));
  for (const s of delta.upsert?.secrets ?? []) secrets.set(s.name, s);
  for (const n of delta.delete?.secretNames ?? []) secrets.delete(n);
  return {
    model: delta.model ?? base.model,
    accounts: [...accounts.values()],
    secrets: [...secrets.values()],
  };
}

export function serializeSecretsEnv(secrets: SecretEntry[]): string {
  const lines: string[] = [];
  for (const s of secrets) {
    lines.push(`${s.name}=${s.value}`);
    lines.push(`${s.name}_DOMAINS=${s.domains.join(',')}`);
  }
  return lines.length ? lines.join('\n') + '\n' : '';
}

export function bundleToFiles(cfg: ConeConfig): { coneConfigJson: string; secretsEnv: string } {
  return {
    coneConfigJson: JSON.stringify({ model: cfg.model, accounts: cfg.accounts }),
    secretsEnv: serializeSecretsEnv(cfg.secrets),
  };
}

export function bundleIndex(cfg: ConeConfig): ConeConfigIndex {
  return {
    model: cfg.model,
    accountProviderIds: cfg.accounts.map((a) => a.providerId),
    accountMeta: cfg.accounts.map((a) => ({
      providerId: a.providerId,
      kind: a.kind,
      tokenExpiresAt: a.kind === 'oauth' ? a.tokenExpiresAt : undefined,
    })),
    secretNames: cfg.secrets.map((s) => s.name),
  };
}

/** Portable base64 of a UTF-8 string (worker/browser/node all have btoa+TextEncoder). */
export function encodeBundleEnv(json: string): string {
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
export function decodeBundleEnv(b64: string): string {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project cloud-core packages/cloud-core/tests/cone-config/cone-config.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Format + commit**

```bash
npx prettier --write packages/cloud-core/src/cone-config/index.ts packages/cloud-core/tests/cone-config/cone-config.test.ts
git add packages/cloud-core/src/cone-config/index.ts packages/cloud-core/tests/cone-config/cone-config.test.ts
git commit -m "feat(cloud-core): add cone-config contract types + helpers"
```

---

### Task 2: Expose the `@slicc/cloud-core/cone-config` subpath

**Files:**
- Modify: `packages/cloud-core/package.json` (the `exports` map)

- [ ] **Step 1: Add the subpath export**

In `packages/cloud-core/package.json`, change the `exports` map to add the `./cone-config` entry:

```json
  "exports": {
    ".": {
      "types": "./dist/src/index.d.ts",
      "default": "./dist/src/index.js"
    },
    "./cone-config": {
      "types": "./dist/src/cone-config/index.d.ts",
      "default": "./dist/src/cone-config/index.js"
    },
    "./tests/fake-substrate": {
      "types": "./dist/tests/fixtures/fake-substrate.d.ts",
      "default": "./dist/tests/fixtures/fake-substrate.js"
    }
  },
```

- [ ] **Step 2: Build cloud-core and verify the subpath emits**

Run: `npm run build -w @slicc/cloud-core`
Expected: succeeds; `packages/cloud-core/dist/src/cone-config/index.js` and `.d.ts` exist.

Run: `ls packages/cloud-core/dist/src/cone-config/`
Expected: lists `index.js` and `index.d.ts`.

- [ ] **Step 3: Commit**

```bash
npx prettier --write packages/cloud-core/package.json
git add packages/cloud-core/package.json
git commit -m "build(cloud-core): export side-effect-free ./cone-config subpath"
```

---

## Phase B — node-server consumption

### Task 3: `POST /api/secrets/reload` loopback endpoint

Lets the worker tell a running node-server to rebuild the fetch-proxy masking after secrets change — no process restart.

**Files:**
- Modify: `packages/node-server/src/index.ts` (near the other `/api/secrets/*` endpoints, ~line 1185)
- Test: `packages/node-server/tests/secrets-reload-endpoint.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/node-server/tests/secrets-reload-endpoint.test.ts
import { describe, it, expect, vi } from 'vitest';
import { registerSecretsReloadEndpoint } from '../src/secrets-reload-endpoint.js';

describe('POST /api/secrets/reload', () => {
  it('registers a loopback route that calls secretProxy.reload() and returns {ok:true}', async () => {
    const reload = vi.fn().mockResolvedValue(undefined);
    // Capture the handler registered via app.post(path, requireLoopback, handler).
    let handler: ((req: unknown, res: { json: (b: unknown) => void }) => Promise<void>) | undefined;
    const app = {
      post: (path: string, _mw: unknown, h: typeof handler) => {
        if (path === '/api/secrets/reload') handler = h;
      },
    };
    registerSecretsReloadEndpoint(app as never, { secretProxy: { reload } });
    expect(handler).toBeTypeOf('function');
    const json = vi.fn();
    await handler!({}, { json });
    expect(reload).toHaveBeenCalledOnce();
    expect(json).toHaveBeenCalledWith({ ok: true });
  });
});
```

> This stubs `app.post` to capture the third argument (the handler — `requireLoopback` is the middleware in slot two) and invokes it directly with a mock req/res, so the test needs neither a real socket nor the loopback guard.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project node-server packages/node-server/tests/secrets-reload-endpoint.test.ts`
Expected: FAIL — cannot resolve `../src/secrets-reload-endpoint.js`.

- [ ] **Step 3: Write the implementation (extracted, testable)**

```typescript
// packages/node-server/src/secrets-reload-endpoint.ts
import type { Express } from 'express';
import { requireLoopback } from './leader-restart.js';

export interface SecretsReloadDeps {
  secretProxy: { reload(): Promise<void> };
}

export function registerSecretsReloadEndpoint(app: Express, deps: SecretsReloadDeps): void {
  app.post('/api/secrets/reload', requireLoopback, async (_req, res) => {
    await deps.secretProxy.reload();
    res.json({ ok: true });
  });
}
```

> If `requireLoopback` is not exported from `leader-restart.ts`, export it there (it is already used by `/api/leader-restart`, `/api/hosted-bootstrap`, and `/api/cloud-status`). Add `export` to its declaration.

- [ ] **Step 4: Wire it into the hosted boot in `index.ts`**

In `packages/node-server/src/index.ts`, in the `if (RUNTIME_FLAGS.hosted) { … }` block that registers `registerCloudStatusEndpoint` and `registerHostedBootstrapEndpoint` (~line 1202), add:

```typescript
    registerSecretsReloadEndpoint(app, { secretProxy });
```

and add the import near the other secret imports:

```typescript
import { registerSecretsReloadEndpoint } from './secrets-reload-endpoint.js';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run --project node-server packages/node-server/tests/secrets-reload-endpoint.test.ts`
Expected: PASS.

- [ ] **Step 6: Format + commit**

```bash
npx prettier --write packages/node-server/src/secrets-reload-endpoint.ts packages/node-server/src/index.ts packages/node-server/src/leader-restart.ts packages/node-server/tests/secrets-reload-endpoint.test.ts
git add packages/node-server/src/secrets-reload-endpoint.ts packages/node-server/src/index.ts packages/node-server/src/leader-restart.ts packages/node-server/tests/secrets-reload-endpoint.test.ts
git commit -m "feat(node-server): add /api/secrets/reload loopback endpoint"
```

---

### Task 4: Extend `/api/hosted-bootstrap` to `{ model, accounts }`

**Files:**
- Modify: `packages/node-server/src/hosted-bootstrap.ts`
- Test: `packages/node-server/tests/hosted-bootstrap.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/node-server/tests/hosted-bootstrap.test.ts
import { describe, it, expect } from 'vitest';
import { buildHostedBootstrapPayload } from '../src/hosted-bootstrap.js';

describe('buildHostedBootstrapPayload', () => {
  it('returns model + accounts from cone-config.json when present', () => {
    const readConeConfig = () =>
      JSON.stringify({
        model: 'anthropic:claude-opus-4-6',
        accounts: [{ providerId: 'anthropic', kind: 'apikey', apiKey: 'k' }],
      });
    const payload = buildHostedBootstrapPayload({
      readConeConfig,
      getLegacyAdobeToken: () => undefined,
    });
    expect(payload.model).toBe('anthropic:claude-opus-4-6');
    expect(payload.accounts).toEqual([{ providerId: 'anthropic', kind: 'apikey', apiKey: 'k' }]);
  });

  it('falls back to a legacy Adobe token when cone-config.json is absent', () => {
    const payload = buildHostedBootstrapPayload({
      readConeConfig: () => null,
      getLegacyAdobeToken: () => 'legacy-token',
    });
    expect(payload.model).toBe('adobe:claude-opus-4-6');
    expect(payload.accounts).toEqual([
      { providerId: 'adobe', kind: 'oauth', accessToken: 'legacy-token' },
    ]);
    expect(payload.adobeImsToken).toBe('legacy-token'); // back-compat field retained
  });

  it('returns an empty payload when nothing is provisioned', () => {
    const payload = buildHostedBootstrapPayload({
      readConeConfig: () => null,
      getLegacyAdobeToken: () => undefined,
    });
    expect(payload).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project node-server packages/node-server/tests/hosted-bootstrap.test.ts`
Expected: FAIL — `buildHostedBootstrapPayload` not exported.

- [ ] **Step 3: Rewrite `hosted-bootstrap.ts`**

```typescript
// packages/node-server/src/hosted-bootstrap.ts
import { readFileSync } from 'node:fs';
import type { Express } from 'express';
import { requireLoopback } from './leader-restart.js';
import type { SecretStore } from './secrets/types.js';
import type { Account } from '@slicc/cloud-core/cone-config';

const CONE_CONFIG_PATH = '/slicc/cone-config.json';
const DEFAULT_MODEL = 'adobe:claude-opus-4-6';

export interface HostedBootstrapPayload {
  model?: string;
  accounts?: Account[];
  /** Back-compat: retained so older webapp builds still read the IMS token. */
  adobeImsToken?: string;
}

export interface BootstrapSources {
  readConeConfig: () => string | null;
  getLegacyAdobeToken: () => string | undefined;
}

export function buildHostedBootstrapPayload(sources: BootstrapSources): HostedBootstrapPayload {
  const raw = sources.readConeConfig();
  if (raw) {
    const parsed = JSON.parse(raw) as { model?: string; accounts?: Account[] };
    return { model: parsed.model, accounts: parsed.accounts ?? [] };
  }
  const legacy = sources.getLegacyAdobeToken();
  if (legacy) {
    return {
      model: DEFAULT_MODEL,
      accounts: [{ providerId: 'adobe', kind: 'oauth', accessToken: legacy }],
      adobeImsToken: legacy,
    };
  }
  return {};
}

export function registerHostedBootstrapEndpoint(
  app: Express,
  options: { secretStore: SecretStore }
): void {
  app.get('/api/hosted-bootstrap', requireLoopback, (_req, res) => {
    const payload = buildHostedBootstrapPayload({
      readConeConfig: () => {
        try {
          return readFileSync(CONE_CONFIG_PATH, 'utf-8');
        } catch {
          return null;
        }
      },
      getLegacyAdobeToken: () => options.secretStore.get('ADOBE_IMS_TOKEN')?.value,
    });
    res.json(payload);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project node-server packages/node-server/tests/hosted-bootstrap.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck node-server (cone-config import resolves)**

Run: `npm run build -w @slicc/cloud-core && tsc --noEmit -p tsconfig.cli.json`
Expected: no errors (the `@slicc/cloud-core/cone-config` subpath resolves because Task 2 built it).

- [ ] **Step 6: Format + commit**

```bash
npx prettier --write packages/node-server/src/hosted-bootstrap.ts packages/node-server/tests/hosted-bootstrap.test.ts
git add packages/node-server/src/hosted-bootstrap.ts packages/node-server/tests/hosted-bootstrap.test.ts
git commit -m "feat(node-server): hosted-bootstrap returns {model, accounts} from cone-config.json"
```

---

## Phase C — Preboot template

### Task 5: `start.sh` decodes two base64 envs into files, then unsets them

The substrate `create()` only carries env vars, so the bundle must arrive as env and be materialized to files before node-server boots.

**Files:**
- Modify: `packages/dev-tools/e2b-template/start.sh`

- [ ] **Step 1: Read the current preboot block**

Run: `sed -n '1,46p' packages/dev-tools/e2b-template/start.sh`
Expected: shows the existing `if [ -n "$ADOBE_IMS_TOKEN" ] && [ ! -f /slicc/secrets.env ]` heredoc bootstrap.

- [ ] **Step 2: Replace the bootstrap block**

Replace the existing `ADOBE_IMS_TOKEN` heredoc bootstrap with the generalized base64 decode (keep the `ADOBE_IMS_TOKEN` heredoc as a fallback for old worker images). The new block, placed before the `node-server --hosted` launch:

```bash
# --- Cone config preboot (race-free: write files before node-server boots) ---
mkdir -p /slicc
if [ -n "$SLICC_SECRETS_ENV_B64" ]; then
  printf '%s' "$SLICC_SECRETS_ENV_B64" | base64 -d > /slicc/secrets.env
  unset SLICC_SECRETS_ENV_B64
elif [ -n "$ADOBE_IMS_TOKEN" ] && [ ! -f /slicc/secrets.env ]; then
  # Back-compat: older worker images only pass ADOBE_IMS_TOKEN.
  {
    printf 'ADOBE_IMS_TOKEN=%s\n' "$ADOBE_IMS_TOKEN"
    printf 'ADOBE_IMS_TOKEN_DOMAINS=%s\n' "$ADOBE_IMS_TOKEN_DOMAINS"
  } > /slicc/secrets.env
fi

if [ -n "$SLICC_CONE_CONFIG_B64" ]; then
  printf '%s' "$SLICC_CONE_CONFIG_B64" | base64 -d > /slicc/cone-config.json
  unset SLICC_CONE_CONFIG_B64
fi
```

- [ ] **Step 3: Lint the script**

Run: `shellcheck packages/dev-tools/e2b-template/start.sh` (if available) or `bash -n packages/dev-tools/e2b-template/start.sh`
Expected: no syntax errors.

- [ ] **Step 4: Manually verify the decode locally**

Run:
```bash
SLICC_CONE_CONFIG_B64=$(printf '{"model":"m","accounts":[]}' | base64) bash -c '
  printf "%s" "$SLICC_CONE_CONFIG_B64" | base64 -d'
```
Expected output: `{"model":"m","accounts":[]}`

- [ ] **Step 5: Commit**

```bash
git add packages/dev-tools/e2b-template/start.sh
git commit -m "feat(e2b-template): decode cone-config + secrets base64 envs preboot, then unset"
```

---

## Phase D — Producer: cloud-core operations

### Task 6: `startCone` accepts cone-config + secrets and writes both files

**Files:**
- Modify: `packages/cloud-core/src/operations/start.ts`
- Test: `packages/cloud-core/tests/operations/start-cone-config.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/cloud-core/tests/operations/start-cone-config.test.ts
import { describe, it, expect } from 'vitest';
import { startCone } from '../../src/operations/start.js';
import { FakeSubstrate } from '../fixtures/fake-substrate.js';
import { InMemoryRegistry } from '../fixtures/in-memory-registry.js'; // use existing test registry helper

describe('startCone with coneConfig env injection', () => {
  it('passes SLICC_CONE_CONFIG_B64 + SLICC_SECRETS_ENV_B64 and writes both files', async () => {
    const substrate = new FakeSubstrate();
    const registry = new InMemoryRegistry();
    await startCone(
      { substrate, registry },
      {
        envContents: 'GITHUB_TOKEN=gt\nGITHUB_TOKEN_DOMAINS=github.com\n',
        coneConfigJson: '{"model":"anthropic:claude-opus-4-6","accounts":[]}',
        workerBaseUrl: 'https://w',
        sliccVersion: 'web-test',
      }
    );
    const created = substrate.lastCreateOpts!;
    expect(created.envVars.SLICC_SECRETS_ENV_B64).toBeTruthy();
    expect(created.envVars.SLICC_CONE_CONFIG_B64).toBeTruthy();
    const handle = substrate.lastHandle!;
    expect(handle.writes['/slicc/secrets.env']).toContain('GITHUB_TOKEN=gt');
    expect(JSON.parse(handle.writes['/slicc/cone-config.json']).model).toBe(
      'anthropic:claude-opus-4-6'
    );
  });
});
```

> Use the existing `FakeSubstrate` (`packages/cloud-core/tests/fixtures/fake-substrate.ts`). If it does not already record `lastCreateOpts`, `lastHandle`, and per-handle `writes`, extend the fixture in this task to capture them (add `writes: Record<string,string>` populated by `writeFile`). If no `InMemoryRegistry` fixture exists, use the registry fixture the existing `start.ts` tests use.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project cloud-core packages/cloud-core/tests/operations/start-cone-config.test.ts`
Expected: FAIL — `coneConfigJson` not accepted / files not written.

- [ ] **Step 3: Modify `start.ts`**

Add `coneConfigJson` to `StartConeOpts`:

```typescript
export interface StartConeOpts {
  envContents: string;
  coneConfigJson?: string; // serialized { model, accounts } for /slicc/cone-config.json
  workerBaseUrl: string;
  template?: string;
  name?: string;
  sliccVersion: string;
  metadata?: Record<string, string>;
  envs?: Record<string, string>;
  pollTimeoutMs?: number;
  pollIntervalMs?: number;
  autoPauseOnCap?: boolean;
  reservationId?: string;
}
```

Add the import at the top:

```typescript
import { encodeBundleEnv } from '../cone-config/index.js';
```

In the `substrate.create({ … })` call, extend `envVars` with the base64 payloads (alongside the existing `SLICC_TRAY_WORKER_BASE_URL` and `...opts.envs`):

```typescript
    envVars: {
      SLICC_TRAY_WORKER_BASE_URL: opts.workerBaseUrl,
      SLICC_SECRETS_ENV_B64: encodeBundleEnv(safeSecrets),
      ...(opts.coneConfigJson
        ? { SLICC_CONE_CONFIG_B64: encodeBundleEnv(opts.coneConfigJson) }
        : {}),
      ...(opts.envs ?? {}),
    },
```

After the existing `await handle.writeFile('/slicc/secrets.env', safeSecrets);` (line 241), add the authoritative cone-config write:

```typescript
    if (opts.coneConfigJson) {
      await handle.writeFile('/slicc/cone-config.json', opts.coneConfigJson);
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project cloud-core packages/cloud-core/tests/operations/start-cone-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Format + commit**

```bash
npx prettier --write packages/cloud-core/src/operations/start.ts packages/cloud-core/tests/operations/start-cone-config.test.ts packages/cloud-core/tests/fixtures/fake-substrate.ts
git add packages/cloud-core/src/operations/start.ts packages/cloud-core/tests/operations/start-cone-config.test.ts packages/cloud-core/tests/fixtures/fake-substrate.ts
git commit -m "feat(cloud-core): startCone injects cone-config + secrets (env preboot + file write)"
```

---

### Task 7: `resumeCone` merges a delta into both files + ordered reload hook

**Files:**
- Modify: `packages/cloud-core/src/operations/resume.ts`
- Test: `packages/cloud-core/tests/operations/resume-cone-config.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/cloud-core/tests/operations/resume-cone-config.test.ts
import { describe, it, expect } from 'vitest';
import { applyConeConfigDelta } from '../../src/operations/resume.js';

describe('applyConeConfigDelta (read-modify-write of both files)', () => {
  it('merges upserts/deletes, returns new file contents + names index', () => {
    const existingConeConfig = JSON.stringify({
      model: 'adobe:claude-opus-4-6',
      accounts: [{ providerId: 'adobe', kind: 'oauth', accessToken: 'old' }],
    });
    const existingSecretsEnv = 'GITHUB_TOKEN=gt\nGITHUB_TOKEN_DOMAINS=github.com\n';
    const out = applyConeConfigDelta(existingConeConfig, existingSecretsEnv, {
      upsert: {
        accounts: [{ providerId: 'adobe', kind: 'oauth', accessToken: 'fresh' }],
        secrets: [{ name: 'NEW', value: 'n', domains: ['x.com'] }],
      },
      delete: { secretNames: ['GITHUB_TOKEN'] },
    });
    expect(JSON.parse(out.coneConfigJson).accounts[0].accessToken).toBe('fresh');
    expect(out.secretsEnv).toContain('NEW=n');
    expect(out.secretsEnv).not.toContain('GITHUB_TOKEN=gt');
    expect(out.index.secretNames).toEqual(['NEW']);
  });

  it('synthesizes from secrets.env when cone-config.json is missing (pre-feature cone)', () => {
    const out = applyConeConfigDelta(
      null,
      'ADOBE_IMS_TOKEN=abc\nADOBE_IMS_TOKEN_DOMAINS=adobe-llm-proxy.example\n',
      { upsert: { accounts: [{ providerId: 'adobe', kind: 'oauth', accessToken: 'abc' }] } }
    );
    expect(JSON.parse(out.coneConfigJson).model).toBe('adobe:claude-opus-4-6');
    expect(JSON.parse(out.coneConfigJson).accounts[0].providerId).toBe('adobe');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project cloud-core packages/cloud-core/tests/operations/resume-cone-config.test.ts`
Expected: FAIL — `applyConeConfigDelta` not exported.

- [ ] **Step 3: Implement `applyConeConfigDelta` + wire it into `resumeCone`**

Add to `packages/cloud-core/src/operations/resume.ts`:

```typescript
import {
  mergeConeConfig,
  serializeSecretsEnv,
  bundleToFiles,
  bundleIndex,
  validateConeConfig,
  type ConeConfig,
  type ConeConfigDelta,
  type ConeConfigIndex,
  type SecretEntry,
} from '../cone-config/index.js';

const DEFAULT_MODEL = 'adobe:claude-opus-4-6';

function parseSecretsEnv(text: string): SecretEntry[] {
  const lines = text.split('\n').filter((l) => l.includes('=') && !l.endsWith('_DOMAINS'));
  // Build a name->domains map first.
  const domains = new Map<string, string[]>();
  for (const l of text.split('\n')) {
    const eq = l.indexOf('=');
    if (eq < 0) continue;
    const key = l.slice(0, eq);
    if (key.endsWith('_DOMAINS')) {
      domains.set(key.slice(0, -'_DOMAINS'.length), l.slice(eq + 1).split(',').filter(Boolean));
    }
  }
  const out: SecretEntry[] = [];
  for (const l of lines) {
    const eq = l.indexOf('=');
    const name = l.slice(0, eq);
    if (name.endsWith('_DOMAINS')) continue;
    out.push({ name, value: l.slice(eq + 1), domains: domains.get(name) ?? [] });
  }
  return out;
}

/**
 * Read-modify-write helper: merges `delta` over the existing files and returns
 * the new file contents plus the names-only index. When `coneConfigJson` is
 * null (a pre-feature cone), synthesizes a degenerate base from secrets.env.
 */
export function applyConeConfigDelta(
  coneConfigJson: string | null,
  secretsEnv: string,
  delta: ConeConfigDelta
): { coneConfigJson: string; secretsEnv: string; index: ConeConfigIndex } {
  let base: ConeConfig;
  if (coneConfigJson) {
    const parsed = JSON.parse(coneConfigJson) as { model?: string; accounts?: unknown[] };
    base = validateConeConfig({
      model: parsed.model ?? DEFAULT_MODEL,
      accounts: parsed.accounts ?? [],
      secrets: parseSecretsEnv(secretsEnv),
    });
  } else {
    base = { model: DEFAULT_MODEL, accounts: [], secrets: parseSecretsEnv(secretsEnv) };
  }
  const merged = mergeConeConfig(base, delta);
  const files = bundleToFiles(merged);
  return { ...files, index: bundleIndex(merged) };
}
```

Add `coneConfigDelta` to `ResumeConeOpts`:

```typescript
export interface ResumeConeOpts {
  query: string;
  localSliccVersion: string;
  refreshSecretsContents?: string;
  coneConfigDelta?: ConeConfigDelta;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  skipStateCheck?: boolean;
}
```

In `resumeCone`, after `connect` and BEFORE the leader-restart kick loop, replace the existing `if (opts.refreshSecretsContents !== undefined) { … }` block with a delta-aware merge that writes BOTH files and triggers the secret-proxy reload before the page reload:

```typescript
  if (opts.coneConfigDelta) {
    let existingConeConfig: string | null = null;
    try {
      existingConeConfig = await handle.readFile('/slicc/cone-config.json');
    } catch {
      existingConeConfig = null;
    }
    let existingSecretsEnv = '';
    try {
      existingSecretsEnv = await handle.readFile('/slicc/secrets.env');
    } catch {
      existingSecretsEnv = '';
    }
    const out = applyConeConfigDelta(existingConeConfig, existingSecretsEnv, opts.coneConfigDelta);
    await handle.writeFile('/slicc/secrets.env', out.secretsEnv);
    await handle.writeFile('/slicc/cone-config.json', out.coneConfigJson);
    // Ordered reload: secret proxy first, then page reload (masks must match).
    await handle.run(
      'curl -sS -X POST http://localhost:5710/api/secrets/reload -o /dev/null -w "%{http_code}"'
    );
    // Surface the merged index to the caller so the DO can update its index.
    resumeIndex = out.index;
  } else if (opts.refreshSecretsContents !== undefined) {
    await handle.writeFile('/slicc/secrets.env', opts.refreshSecretsContents);
  }
```

Declare `let resumeIndex: ConeConfigIndex | undefined;` near the top of `resumeCone`, and add `coneConfigIndex: resumeIndex` to the object `resumeCone` returns (extend its return type accordingly). The existing `kickLeaderUntilReady`/`KICK_CMD` leader-restart `Page.reload` runs after this block, completing the ordered hook.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project cloud-core packages/cloud-core/tests/operations/resume-cone-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full cloud-core suite (no regressions)**

Run: `npx vitest run --project cloud-core`
Expected: all pass.

- [ ] **Step 6: Format + commit**

```bash
npx prettier --write packages/cloud-core/src/operations/resume.ts packages/cloud-core/tests/operations/resume-cone-config.test.ts
git add packages/cloud-core/src/operations/resume.ts packages/cloud-core/tests/operations/resume-cone-config.test.ts
git commit -m "feat(cloud-core): resume merges cone-config delta into both files + reload hook"
```

---

## Phase E — Producer: worker

### Task 8: DurableObject — names-only index, start with `coneConfig`, resume delta, migration

**Files:**
- Modify: `packages/cloudflare-worker/src/cloud/cloud-sessions-do.ts`
- Test: `packages/cloudflare-worker/tests/cloud-sessions-cone-config.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/cloudflare-worker/tests/cloud-sessions-cone-config.test.ts
import { describe, it, expect } from 'vitest';
import { buildStartConeArgs, coneConfigToBundle } from '../src/cloud/cone-config-bridge.js';

describe('coneConfigToBundle (worker-side default + validation)', () => {
  it('uses the supplied bundle when present', () => {
    const bundle = coneConfigToBundle(
      { model: 'anthropic:claude-opus-4-6', accounts: [{ providerId: 'anthropic', kind: 'apikey', apiKey: 'k' }], secrets: [] },
      'bearer-x'
    );
    expect(bundle.model).toBe('anthropic:claude-opus-4-6');
  });
  it('synthesizes the Adobe default when no coneConfig is supplied', () => {
    const bundle = coneConfigToBundle(undefined, 'bearer-x');
    expect(bundle.model).toBe('adobe:claude-opus-4-6');
    expect(bundle.accounts).toEqual([
      { providerId: 'adobe', kind: 'oauth', accessToken: 'bearer-x' },
    ]);
  });
  it('rejects a bundle whose model provider has no account (narrow F6)', () => {
    expect(() =>
      coneConfigToBundle(
        { model: 'openai:gpt-x', accounts: [{ providerId: 'anthropic', kind: 'apikey', apiKey: 'k' }], secrets: [] },
        'bearer-x'
      )
    ).toThrow(/provider 'openai' has no account/);
  });
});

describe('buildStartConeArgs', () => {
  it('produces envContents (secrets.env) + coneConfigJson ({model,accounts})', () => {
    const args = buildStartConeArgs(
      { model: 'm', accounts: [{ providerId: 'adobe', kind: 'oauth', accessToken: 't' }], secrets: [{ name: 'S', value: 'v', domains: ['x.com'] }] },
      'bearer'
    );
    expect(args.envContents).toContain('S=v');
    expect(JSON.parse(args.coneConfigJson).accounts[0].providerId).toBe('adobe');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project cloudflare-worker packages/cloudflare-worker/tests/cloud-sessions-cone-config.test.ts`
Expected: FAIL — `../src/cloud/cone-config-bridge.js` not found.

- [ ] **Step 3: Create the worker-side bridge**

```typescript
// packages/cloudflare-worker/src/cloud/cone-config-bridge.ts
import {
  bundleToFiles,
  validateConeConfig,
  type ConeConfig,
} from '@slicc/cloud-core/cone-config';

const ADOBE_TOKEN_DOMAINS = 'adobe-llm-proxy.paolo-moz.workers.dev'; // mirror existing constant
const DEFAULT_MODEL = 'adobe:claude-opus-4-6';
const AUTH_OPTIONAL_PROVIDERS = new Set<string>(['local']);

/** Narrow F6 re-validation: the model's provider must have an account (unless auth-optional). */
export function assertModelHasAccount(bundle: ConeConfig): void {
  const provider = bundle.model.split(':')[0];
  if (AUTH_OPTIONAL_PROVIDERS.has(provider)) return;
  if (!bundle.accounts.some((a) => a.providerId === provider)) {
    throw new Error(`model provider '${provider}' has no account in the bundle`);
  }
}

/** Validate a client bundle, or synthesize the Adobe default from the cloud bearer. */
export function coneConfigToBundle(input: unknown, bearer: string): ConeConfig {
  if (input === undefined || input === null) {
    return {
      model: DEFAULT_MODEL,
      accounts: [{ providerId: 'adobe', kind: 'oauth', accessToken: bearer }],
      secrets: [
        { name: 'ADOBE_IMS_TOKEN', value: bearer, domains: [ADOBE_TOKEN_DOMAINS] },
        { name: 'ADOBE_IMS_TOKEN_DOMAINS', value: ADOBE_TOKEN_DOMAINS, domains: [ADOBE_TOKEN_DOMAINS] },
      ],
    };
  }
  const bundle = validateConeConfig(input);
  assertModelHasAccount(bundle);
  return bundle;
}

export function buildStartConeArgs(
  bundle: ConeConfig,
  _bearer: string
): { envContents: string; coneConfigJson: string } {
  const { coneConfigJson, secretsEnv } = bundleToFiles(bundle);
  return { envContents: secretsEnv, coneConfigJson };
}
```

> Note: source `ADOBE_TOKEN_DOMAINS` from the existing constant in `cloud-sessions-do.ts` rather than re-declaring if it is exported; otherwise keep this local copy in sync.

- [ ] **Step 4: Wire the bridge into `cloud-sessions-do.ts`**

Extend `StartConeBody` and `ResumeConeBody`:

```typescript
interface StartConeBody {
  bearer: string;
  name?: string;
  userId: string;
  workerOrigin: string;
  coneConfig?: unknown; // validated by coneConfigToBundle
}
interface ResumeConeBody {
  bearer: string;
  sandboxId: string;
  localSliccVersion: string;
  userId: string;
  coneConfigDelta?: unknown;
}
```

In `startConeOp`, replace the inline `envContents`/`envs` construction with the bridge:

```typescript
import { coneConfigToBundle, buildStartConeArgs } from './cone-config-bridge.js';
import { bundleIndex } from '@slicc/cloud-core/cone-config';
// …
const bundle = coneConfigToBundle(body.coneConfig, body.bearer);
const { envContents, coneConfigJson } = buildStartConeArgs(bundle, body.bearer);
const result = await startCone(
  { substrate, registry },
  {
    reservationId: reservation.reservationId,
    envContents,
    coneConfigJson,
    workerBaseUrl: body.workerOrigin,
    sliccVersion: 'web-' + new Date().toISOString().slice(0, 10),
    name: body.name?.trim(),
    metadata: { userId: body.userId },
  }
);
```

After `startCone` resolves, persist the names-only index on the cone's registry/DO record:

```typescript
// in the registry entry update where state flips to 'running':
entry.coneConfigIndex = bundleIndex(bundle);
```

Add `coneConfigIndex?: ConeConfigIndex` to the DO's per-cone record type (import `ConeConfigIndex` from `@slicc/cloud-core/cone-config`). **Never** store account/secret values — only the index.

In `resumeConeOp`, pass the delta through and update the index from `resumeCone`'s returned `coneConfigIndex`:

```typescript
const result = await resumeCone(
  { substrate, registry },
  {
    query: body.sandboxId,
    localSliccVersion: body.localSliccVersion,
    coneConfigDelta: body.coneConfigDelta as ConeConfigDelta | undefined,
    skipStateCheck: true,
  }
);
if (result.coneConfigIndex) entry.coneConfigIndex = result.coneConfigIndex;
```

Add a method to read the index for the dashboard:

```typescript
getConeConfigIndex(sandboxId: string): ConeConfigIndex | null {
  const entry = this.registry.get(sandboxId); // adapt to the DO's actual registry accessor
  return entry?.coneConfigIndex ?? null;
}
```

- [ ] **Step 5: Run test + full worker suite**

Run: `npx vitest run --project cloudflare-worker packages/cloudflare-worker/tests/cloud-sessions-cone-config.test.ts`
Expected: PASS.
Run: `npx vitest run --project cloudflare-worker`
Expected: all pass.

- [ ] **Step 6: Format + commit**

```bash
npx prettier --write packages/cloudflare-worker/src/cloud/cone-config-bridge.ts packages/cloudflare-worker/src/cloud/cloud-sessions-do.ts packages/cloudflare-worker/tests/cloud-sessions-cone-config.test.ts
git add packages/cloudflare-worker/src/cloud/cone-config-bridge.ts packages/cloudflare-worker/src/cloud/cloud-sessions-do.ts packages/cloudflare-worker/tests/cloud-sessions-cone-config.test.ts
git commit -m "feat(worker): cone-config bridge + names-only DO index + default/migration"
```

---

### Task 9: Worker routes/handlers — `coneConfig` on start/resume, auth'd `GET /api/cloud/cone-config`, validation + size cap

**Files:**
- Modify: `packages/cloudflare-worker/src/cloud/handlers.ts`
- Modify: `packages/cloudflare-worker/src/index.ts` (route switch + routes list)
- Test: `packages/cloudflare-worker/tests/index.test.ts`, `packages/cloudflare-worker/tests/deployed.test.ts` (routes list)

- [ ] **Step 1: Add the route to all three required locations (routes-mirror rule)**

In `packages/cloudflare-worker/src/index.ts` route switch (the `/api/cloud/` block), add a case BEFORE `default`:

```typescript
    case 'cone-config':
      return handleConeConfig(request, cloudEnv);
```

Add to the routes-list array in `index.ts`:

```typescript
  'GET /api/cloud/cone-config',
```

Update the routes-list assertions in `packages/cloudflare-worker/tests/index.test.ts` AND `packages/cloudflare-worker/tests/deployed.test.ts` to include `'GET /api/cloud/cone-config'` (per the routes-mirror rule in `packages/cloudflare-worker/CLAUDE.md`).

- [ ] **Step 2: Write the failing handler test**

```typescript
// packages/cloudflare-worker/tests/cone-config-handler.test.ts
import { describe, it, expect } from 'vitest';
import { validateStartBody } from '../src/cloud/handlers.js';

describe('validateStartBody (size cap + shape)', () => {
  it('rejects an oversized coneConfig', () => {
    const huge = { coneConfig: { model: 'm', accounts: [], secrets: [{ name: 'X', value: 'v'.repeat(300_000), domains: [] }] } };
    expect(() => validateStartBody(huge)).toThrow(/too large/i);
  });
  it('accepts a normal body', () => {
    expect(() => validateStartBody({ name: 'x', coneConfig: { model: 'm', accounts: [], secrets: [] } })).not.toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run --project cloudflare-worker packages/cloudflare-worker/tests/cone-config-handler.test.ts`
Expected: FAIL — `validateStartBody` not exported.

- [ ] **Step 4: Implement handler changes in `handlers.ts`**

Add the size-cap validator and the new handler; thread `coneConfig` through start/resume:

```typescript
import { MAX_CONE_CONFIG_BYTES, type ConeConfigIndex } from '@slicc/cloud-core/cone-config';

export function validateStartBody(body: { name?: string; coneConfig?: unknown }): void {
  if (body.coneConfig !== undefined) {
    const size = new TextEncoder().encode(JSON.stringify(body.coneConfig)).length;
    if (size > MAX_CONE_CONFIG_BYTES) {
      throw new Error(`coneConfig too large: ${size} > ${MAX_CONE_CONFIG_BYTES}`);
    }
  }
}

export async function handleConeConfig(request: Request, env: CloudEnv): Promise<Response> {
  const auth = await authenticateRequest(request, env);
  if (auth instanceof Response) return auth;
  const sandboxId = new URL(request.url).searchParams.get('sandboxId');
  if (!sandboxId) return errorResponse(400, 'BAD_REQUEST', 'sandboxId is required');
  const stub = getDoStub(env, auth.userId);
  return forwardToDo(stub, '/cone-config-index', { sandboxId, userId: auth.userId });
}
```

In `handleStart`, after parsing the body, call the validator and forward `coneConfig`:

```typescript
  const body = (await request.json().catch(() => ({}))) as { name?: string; coneConfig?: unknown };
  try {
    validateStartBody(body);
  } catch (e) {
    return errorResponse(400, 'BAD_REQUEST', (e as Error).message); // message is shape-only, not values
  }
  // …
  return forwardToDo(stub, '/start-cone', {
    bearer,
    name: body.name,
    userId: auth.userId,
    workerOrigin: new URL(request.url).origin,
    coneConfig: body.coneConfig,
  });
```

In `handleResume`, forward the delta:

```typescript
  const body = (await request.json().catch(() => ({}))) as { sandboxId?: string; coneConfigDelta?: unknown };
  // … existing sandboxId check …
  return forwardToDo(stub, '/resume-cone', {
    bearer,
    sandboxId: body.sandboxId,
    localSliccVersion: 'web-' + new Date().toISOString().slice(0, 10),
    userId: auth.userId,
    coneConfigDelta: body.coneConfigDelta,
  });
```

Add a `/cone-config-index` route to the DO's `fetch()` dispatch that returns `getConeConfigIndex(sandboxId)` as JSON (404 if null).

> Validation errors must be **redacted** — they describe shape/size only, never echo secret values. The `validateStartBody` message above only contains sizes; keep it that way.

- [ ] **Step 5: Run tests**

Run: `npx vitest run --project cloudflare-worker`
Expected: all pass (incl. updated routes-list assertions).

- [ ] **Step 6: Worker dry-run gate (asset/build sanity)**

Run: `npm run build -w @slicc/webapp && npm run build -w @slicc/cloudflare-worker`
Expected: `wrangler deploy --dry-run` succeeds.

- [ ] **Step 7: Format + commit**

```bash
npx prettier --write packages/cloudflare-worker/src/cloud/handlers.ts packages/cloudflare-worker/src/index.ts packages/cloudflare-worker/tests/*.test.ts
git add packages/cloudflare-worker/src/cloud/handlers.ts packages/cloudflare-worker/src/index.ts packages/cloudflare-worker/tests/
git commit -m "feat(worker): cone-config on start/resume + auth'd GET /api/cloud/cone-config"
```

---

## Phase F — Consumer: webapp boot

### Task 10: Hosted-leader boot consumes `{ model, accounts }` and reconciles (managed-only)

**Files:**
- Create: `packages/webapp/src/ui/hosted-config-apply.ts`
- Modify: `packages/webapp/src/ui/main.ts` (hosted-leader block ~2807-2841)
- Test: `packages/webapp/tests/ui/hosted-config-apply.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/webapp/tests/ui/hosted-config-apply.test.ts
import { describe, it, expect, vi } from 'vitest';
import { applyHostedAccounts } from '../../src/ui/hosted-config-apply.js';
import type { Account } from '@slicc/cloud-core/cone-config';

describe('applyHostedAccounts (managed-only reconcile)', () => {
  it('saves oauth via saveOAuthAccount, apikey via addAccount, removes managed-absent', async () => {
    const calls: string[] = [];
    const deps = {
      saveOAuthAccount: vi.fn(async (o: { providerId: string }) => {
        calls.push('save:' + o.providerId);
      }),
      addAccount: vi.fn((id: string) => {
        calls.push('add:' + id);
      }),
      removeAccount: vi.fn(async (id: string) => {
        calls.push('remove:' + id);
      }),
      currentProviderIds: () => ['adobe', 'openai', 'manual-local'],
      previouslyManaged: () => ['adobe', 'openai'], // openai was cloud-managed, now absent
    };
    const accounts: Account[] = [
      { providerId: 'adobe', kind: 'oauth', accessToken: 't' },
      { providerId: 'anthropic', kind: 'apikey', apiKey: 'k' },
    ];
    await applyHostedAccounts(accounts, deps);
    expect(calls).toContain('save:adobe');
    expect(calls).toContain('add:anthropic');
    expect(calls).toContain('remove:openai'); // managed + absent → removed
    expect(calls).not.toContain('remove:manual-local'); // not managed → preserved
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project webapp packages/webapp/tests/ui/hosted-config-apply.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the reconcile helper**

```typescript
// packages/webapp/src/ui/hosted-config-apply.ts
import type { Account } from '@slicc/cloud-core/cone-config';

export interface ApplyAccountsDeps {
  saveOAuthAccount: (o: {
    providerId: string;
    accessToken: string;
    refreshToken?: string;
    tokenExpiresAt?: number;
    userName?: string;
    baseUrl?: string;
  }) => Promise<void>;
  addAccount: (
    providerId: string,
    apiKey: string,
    baseUrl?: string,
    deployment?: string,
    apiVersion?: string
  ) => void;
  removeAccount: (providerId: string) => Promise<void>;
  /** providerIds currently in slicc_accounts. */
  currentProviderIds: () => string[];
  /** providerIds this cone previously cloud-managed (from the prior bundle). */
  previouslyManaged: () => string[];
}

/** Reconcile localStorage accounts to the bundle; only remove cloud-managed ones. */
export async function applyHostedAccounts(
  accounts: Account[],
  deps: ApplyAccountsDeps
): Promise<void> {
  const desired = new Set(accounts.map((a) => a.providerId));
  for (const a of accounts) {
    if (a.kind === 'oauth') {
      await deps.saveOAuthAccount({
        providerId: a.providerId,
        accessToken: a.accessToken,
        refreshToken: a.refreshToken,
        tokenExpiresAt: a.tokenExpiresAt,
        userName: a.userName,
        baseUrl: a.baseUrl,
      });
    } else {
      deps.addAccount(a.providerId, a.apiKey, a.baseUrl, a.deployment, a.apiVersion);
    }
  }
  // Managed-only deletion: remove accounts that were cloud-managed but are now absent.
  const managed = new Set(deps.previouslyManaged());
  for (const id of deps.currentProviderIds()) {
    if (managed.has(id) && !desired.has(id)) {
      await deps.removeAccount(id);
    }
  }
}
```

- [ ] **Step 4: Wire it into `main.ts`**

Replace the hosted-leader bootstrap block (`main.ts:2807-2841`) so it consumes the extended payload, seeds the model, applies accounts via `applyHostedAccounts`, and records the managed set in `localStorage['slicc_cloud_managed']`:

```typescript
void (async () => {
  await new Promise((r) => setTimeout(r, 5000));
  try {
    const res = await fetch('/api/hosted-bootstrap');
    if (!res.ok) return;
    const boot = (await res.json()) as {
      model?: string;
      accounts?: import('@slicc/cloud-core/cone-config').Account[];
      adobeImsToken?: string; // legacy
    };

    const accounts =
      boot.accounts ??
      (boot.adobeImsToken
        ? [{ providerId: 'adobe', kind: 'oauth' as const, accessToken: boot.adobeImsToken }]
        : []);
    if (boot.model) localStorage.setItem('selected-model', boot.model);
    else if (!localStorage.getItem('selected-model'))
      localStorage.setItem('selected-model', 'adobe:claude-opus-4-6');

    const { applyHostedAccounts } = await import('./hosted-config-apply.js');
    const prevManaged = JSON.parse(localStorage.getItem('slicc_cloud_managed') ?? '[]') as string[];
    await applyHostedAccounts(accounts, {
      saveOAuthAccount,
      addAccount,
      removeAccount,
      currentProviderIds: () => getAccounts().map((a) => a.providerId),
      previouslyManaged: () => prevManaged,
    });
    localStorage.setItem('slicc_cloud_managed', JSON.stringify(accounts.map((a) => a.providerId)));
    log.info('hosted-leader: cone config applied', { count: accounts.length });
  } catch (err) {
    log.warn('hosted-leader: bootstrap fetch failed; provider needs manual login', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
})();
```

Ensure `addAccount`, `removeAccount`, and `getAccounts` are imported alongside the existing `saveOAuthAccount` import in `main.ts` (all from `./provider-settings.js`).

- [ ] **Step 5: Run test + typecheck**

Run: `npx vitest run --project webapp packages/webapp/tests/ui/hosted-config-apply.test.ts`
Expected: PASS.
Run: `tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 6: Format + commit**

```bash
npx prettier --write packages/webapp/src/ui/hosted-config-apply.ts packages/webapp/src/ui/main.ts packages/webapp/tests/ui/hosted-config-apply.test.ts
git add packages/webapp/src/ui/hosted-config-apply.ts packages/webapp/src/ui/main.ts packages/webapp/tests/ui/hosted-config-apply.test.ts
git commit -m "feat(webapp): hosted-leader applies cone-config (model + managed-only account reconcile)"
```

---

### Task 11: `?connect=1` runtime mode + slim boot + suppress replica sync

**Files:**
- Modify: `packages/webapp/src/ui/runtime-mode.ts`
- Modify: `packages/webapp/src/ui/main.ts` (boot dispatch)
- Modify: `packages/webapp/src/ui/provider-settings.ts` (replica-sync guard)
- Test: `packages/webapp/tests/ui/runtime-mode.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/webapp/tests/ui/runtime-mode.test.ts (add cases)
import { describe, it, expect } from 'vitest';
import { resolveUiRuntimeMode } from '../../src/ui/runtime-mode.js';

describe('resolveUiRuntimeMode connect mode', () => {
  it('detects ?connect=1 (non-extension)', () => {
    expect(resolveUiRuntimeMode('https://www.sliccy.ai/?connect=1', false)).toBe('connect');
  });
  it('does not treat ?connect=1 as connect in extension contexts', () => {
    expect(resolveUiRuntimeMode('https://x/?connect=1', true)).toBe('extension');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project webapp packages/webapp/tests/ui/runtime-mode.test.ts`
Expected: FAIL — returns `'standalone'`, not `'connect'`.

- [ ] **Step 3: Add the mode**

In `runtime-mode.ts`, add `'connect'` to the union and a branch in `resolveUiRuntimeMode` (non-extension path, before the hosted-leader/standalone resolution):

```typescript
export type UiRuntimeMode =
  | 'standalone'
  | 'extension'
  | 'electron-overlay'
  | 'extension-detached'
  | 'hosted-leader'
  | 'connect';
```

```typescript
  // inside the non-extension branch of resolveUiRuntimeMode, before standalone fallback:
    if (url.searchParams.get('connect') === '1') {
      return 'connect';
    }
```

- [ ] **Step 4: Add the slim boot + replica guard**

In `main.ts`, where `resolveUiRuntimeMode` drives the boot path, add a `connect` branch that boots only the provider-settings/accounts/model-picker UI (no kernel/orchestrator). Reuse the existing accounts/provider settings rendering entrypoint; do NOT start the orchestrator or kernel worker. Set a module flag so `provider-settings.ts` can detect connect mode:

```typescript
  if (mode === 'connect') {
    (globalThis as Record<string, unknown>).__slicc_connect_mode = true;
    const { mountConnectSurface } = await import('./connect-surface.js');
    await mountConnectSurface(document.getElementById('app')!);
    return;
  }
```

Create `packages/webapp/src/ui/connect-surface.ts` that mounts the existing provider-settings + accounts UI + model picker components into the given root (reusing the same functions the settings panel uses; no new OAuth code).

In `provider-settings.ts`, guard the non-extension replica POST (`saveOAuthAccount`, ~line 842) so it is skipped in connect mode:

```typescript
  } else if (!(globalThis as Record<string, unknown>).__slicc_connect_mode) {
    const r = await fetch('/api/secrets/oauth-update', { /* …existing… */ });
    // …existing handling…
  }
```

- [ ] **Step 5: Run test + typecheck**

Run: `npx vitest run --project webapp packages/webapp/tests/ui/runtime-mode.test.ts`
Expected: PASS.
Run: `tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 6: Format + commit**

```bash
npx prettier --write packages/webapp/src/ui/runtime-mode.ts packages/webapp/src/ui/main.ts packages/webapp/src/ui/connect-surface.ts packages/webapp/src/ui/provider-settings.ts packages/webapp/tests/ui/runtime-mode.test.ts
git add packages/webapp/src/ui/runtime-mode.ts packages/webapp/src/ui/main.ts packages/webapp/src/ui/connect-surface.ts packages/webapp/src/ui/provider-settings.ts packages/webapp/tests/ui/runtime-mode.test.ts
git commit -m "feat(webapp): ?connect=1 slim login mode; suppress replica sync in connect mode"
```

---

## Phase G — Dashboard

### Task 12: Dashboard create flow — assemble + validate the bundle

**Files:**
- Create: `packages/webapp/cloud/cone-config-client.js` (pure helpers; importable by tests)
- Modify: `packages/webapp/cloud/app.js` (create handler ~317-346)
- Modify: `packages/webapp/cloud/index.html` (model picker + secret rows + "Connect" button)
- Test: `packages/webapp/tests/cloud/cone-config-client.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/webapp/tests/cloud/cone-config-client.test.ts
import { describe, it, expect } from 'vitest';
import { assembleBundle, validateModelHasAccount } from '../../cloud/cone-config-client.js';

describe('assembleBundle', () => {
  it('builds {model, accounts, secrets} from selected localStorage accounts + secret rows', () => {
    const accounts = [
      { providerId: 'anthropic', apiKey: 'k', accessToken: '' },
      { providerId: 'adobe', apiKey: '', accessToken: 't', tokenExpiresAt: 5 },
    ];
    const bundle = assembleBundle({
      model: 'anthropic:claude-opus-4-6',
      selectedProviderIds: ['anthropic'],
      allAccounts: accounts,
      secretRows: [{ name: 'GITHUB_TOKEN', value: 'g', domains: 'github.com' }],
    });
    expect(bundle.accounts).toEqual([{ providerId: 'anthropic', kind: 'apikey', apiKey: 'k' }]);
    expect(bundle.secrets).toEqual([{ name: 'GITHUB_TOKEN', value: 'g', domains: ['github.com'] }]);
  });
});

describe('validateModelHasAccount (F6 strict)', () => {
  it('passes when the model provider has a selected account', () => {
    expect(validateModelHasAccount('anthropic:x', ['anthropic'], [])).toBe(true);
  });
  it('fails when the model provider has no selected account', () => {
    expect(validateModelHasAccount('openai:x', ['anthropic'], [])).toBe(false);
  });
  it('passes for auth-optional providers', () => {
    expect(validateModelHasAccount('local:x', [], ['local'])).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project webapp packages/webapp/tests/cloud/cone-config-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the client helpers**

```javascript
// packages/webapp/cloud/cone-config-client.js
// Pure bundle-assembly helpers for the /cloud dashboard. No DOM access here.

export function assembleBundle({ model, selectedProviderIds, allAccounts, secretRows }) {
  const selected = new Set(selectedProviderIds);
  const accounts = allAccounts
    .filter((a) => selected.has(a.providerId))
    .map((a) =>
      a.accessToken
        ? {
            providerId: a.providerId,
            kind: 'oauth',
            accessToken: a.accessToken,
            ...(a.refreshToken ? { refreshToken: a.refreshToken } : {}),
            ...(a.tokenExpiresAt ? { tokenExpiresAt: a.tokenExpiresAt } : {}),
            ...(a.userName ? { userName: a.userName } : {}),
          }
        : { providerId: a.providerId, kind: 'apikey', apiKey: a.apiKey }
    );
  const secrets = secretRows
    .filter((r) => r.name && r.value)
    .map((r) => ({
      name: r.name,
      value: r.value,
      domains: r.domains.split(',').map((d) => d.trim()).filter(Boolean),
    }));
  return { model, accounts, secrets };
}

export function validateModelHasAccount(model, selectedProviderIds, authOptionalProviders) {
  const provider = model.split(':')[0];
  if (authOptionalProviders.includes(provider)) return true;
  return selectedProviderIds.includes(provider);
}
```

- [ ] **Step 4: Wire into `app.js` create handler + `index.html`**

In `index.html`, add to the create form: a model `<select id="cone-model">`, a container `<div id="secret-rows">` with an "Add secret" button, a "Connect a provider / set model" button (`id="connect-btn"`), and a list of selectable accounts (`id="account-list"`).

In `app.js`:
- On dashboard load, read `slicc_accounts` from `localStorage` (same-origin) and render them as checkboxes in `#account-list`; populate `#cone-model` from a static model list (or from the selected accounts' providers).
- `#connect-btn` opens `window.open('/?connect=1', 'slicc-connect', 'width=520,height=720')`; on focus/return, re-read `slicc_accounts` and re-render.
- In the existing create handler (`app.js:317-346`), build the bundle and validate before POST:

```javascript
import { assembleBundle, validateModelHasAccount } from './cone-config-client.js';
// inside createBtn click handler, replacing `body: JSON.stringify({ name })`:
const model = document.getElementById('cone-model').value;
const selectedProviderIds = [...document.querySelectorAll('#account-list input:checked')].map(
  (el) => el.value
);
const allAccounts = JSON.parse(localStorage.getItem('slicc_accounts') || '[]');
const secretRows = [...document.querySelectorAll('#secret-rows .secret-row')].map((row) => ({
  name: row.querySelector('.s-name').value.trim(),
  value: row.querySelector('.s-value').value,
  domains: row.querySelector('.s-domains').value.trim(),
}));
if (!validateModelHasAccount(model, selectedProviderIds, ['local'])) {
  showToast('Selected model needs a connected account for its provider.');
  return;
}
const coneConfig = assembleBundle({ model, selectedProviderIds, allAccounts, secretRows });
const result = await api('/api/cloud/start', {
  method: 'POST',
  body: JSON.stringify({ name, coneConfig }),
});
```

- [ ] **Step 5: Run test**

Run: `npx vitest run --project webapp packages/webapp/tests/cloud/cone-config-client.test.ts`
Expected: PASS.

- [ ] **Step 6: Format + commit**

```bash
npx prettier --write packages/webapp/cloud/cone-config-client.js packages/webapp/cloud/app.js packages/webapp/cloud/index.html packages/webapp/tests/cloud/cone-config-client.test.ts
git add packages/webapp/cloud/cone-config-client.js packages/webapp/cloud/app.js packages/webapp/cloud/index.html packages/webapp/tests/cloud/cone-config-client.test.ts
git commit -m "feat(dashboard): create flow assembles+validates cone-config bundle"
```

---

### Task 13: Dashboard resume manager — show keys, add/delete/reauth, send delta

**Files:**
- Modify: `packages/webapp/cloud/cone-config-client.js` (add `assembleDelta`)
- Modify: `packages/webapp/cloud/app.js` (resume action + a "Manage" panel)
- Test: `packages/webapp/tests/cloud/cone-config-client.test.ts` (add cases)

- [ ] **Step 1: Write the failing test (append)**

```typescript
// append to packages/webapp/tests/cloud/cone-config-client.test.ts
import { assembleDelta } from '../../cloud/cone-config-client.js';

describe('assembleDelta', () => {
  it('produces upserts for new/changed and deletes for removed keys', () => {
    const delta = assembleDelta({
      model: 'openai:x',
      upsertAccounts: [{ providerId: 'openai', apiKey: 'k', accessToken: '' }],
      upsertSecretRows: [{ name: 'NEW', value: 'n', domains: 'x.com' }],
      deleteProviderIds: ['adobe'],
      deleteSecretNames: ['OLD'],
    });
    expect(delta).toEqual({
      model: 'openai:x',
      upsert: {
        accounts: [{ providerId: 'openai', kind: 'apikey', apiKey: 'k' }],
        secrets: [{ name: 'NEW', value: 'n', domains: ['x.com'] }],
      },
      delete: { providerIds: ['adobe'], secretNames: ['OLD'] },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project webapp packages/webapp/tests/cloud/cone-config-client.test.ts`
Expected: FAIL — `assembleDelta` not exported.

- [ ] **Step 3: Implement `assembleDelta`**

```javascript
// append to packages/webapp/cloud/cone-config-client.js
export function assembleDelta({
  model,
  upsertAccounts,
  upsertSecretRows,
  deleteProviderIds,
  deleteSecretNames,
}) {
  const { accounts, secrets } = assembleBundle({
    model: model ?? '',
    selectedProviderIds: upsertAccounts.map((a) => a.providerId),
    allAccounts: upsertAccounts,
    secretRows: upsertSecretRows,
  });
  const delta = {};
  if (model) delta.model = model;
  const upsert = {};
  if (accounts.length) upsert.accounts = accounts;
  if (secrets.length) upsert.secrets = secrets;
  if (Object.keys(upsert).length) delta.upsert = upsert;
  const del = {};
  if (deleteProviderIds.length) del.providerIds = deleteProviderIds;
  if (deleteSecretNames.length) del.secretNames = deleteSecretNames;
  if (Object.keys(del).length) delta.delete = del;
  return delta;
}
```

- [ ] **Step 4: Wire the Manage panel into `app.js`**

Add a "Manage" button per cone row that:
- `GET`s the names-only index: `await api('/api/cloud/cone-config?sandboxId=' + encodeURIComponent(sandboxId), { method: 'GET' })`.
- Renders the provisioned keys (account providerIds + secret names) with delete checkboxes, an "Add secret" form, and a "Reconnect / set model" button (opens `/?connect=1`).
- On "Apply on resume", builds the delta with `assembleDelta` and calls resume with it:

```javascript
await api('/api/cloud/resume', {
  method: 'POST',
  body: JSON.stringify({ sandboxId, coneConfigDelta }),
});
```

(For deletes/changes the cone must be running, so "Apply" triggers resume with the delta; the existing `runConeAction('resume', …)` becomes a no-delta resume, and "Apply on resume" is the delta-carrying variant.)

- [ ] **Step 5: Run test**

Run: `npx vitest run --project webapp packages/webapp/tests/cloud/cone-config-client.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Format + commit**

```bash
npx prettier --write packages/webapp/cloud/cone-config-client.js packages/webapp/cloud/app.js packages/webapp/tests/cloud/cone-config-client.test.ts
git add packages/webapp/cloud/cone-config-client.js packages/webapp/cloud/app.js packages/webapp/tests/cloud/cone-config-client.test.ts
git commit -m "feat(dashboard): resume manager (show keys, add/delete/reauth → delta)"
```

---

## Phase H — Verification, docs

### Task 14: Full verification + docs

**Files:**
- Modify: `packages/cloudflare-worker/CLAUDE.md`, `packages/webapp/CLAUDE.md`, `docs/shell-reference.md` (if cone config surfaces any command), `README.md` (cloud cones section if user-facing)

- [ ] **Step 1: Full gates**

```bash
npx prettier --check .
npm run typecheck
npm run test
npm run build
npm run build -w @slicc/chrome-extension
```
Expected: all pass. Fix any failures before continuing.

- [ ] **Step 2: Coverage gates for touched packages**

```bash
npm run test:coverage:cloud-core
npm run test:coverage:node-server
npm run test:coverage:cloudflare-worker
npm run test:coverage:webapp
```
Expected: all at or above each package's floor.

- [ ] **Step 3: Manual QA (real cone)**

Follow the spec's "Testing → Manual QA": create a cone with a non-Adobe model + one API-key provider + one OAuth provider; verify the model is selected and agent calls succeed; pause; on resume view provisioned keys, delete one secret + one login and add a new secret; verify deletions take effect (no kill) after reload and the new secret works; expire a token, reconnect, resume → calls restored.

- [ ] **Step 4: Update docs**

- `packages/cloudflare-worker/CLAUDE.md`: document `POST /api/cloud/start` `coneConfig`, `GET /api/cloud/cone-config?sandboxId`, `POST /api/cloud/resume` `coneConfigDelta`, the names-only DO index, and add the three routes-mirror locations note for the new route.
- `packages/webapp/CLAUDE.md`: document the `?connect=1` slim mode, the hosted-leader cone-config apply (`hosted-config-apply.ts`), and the `slicc_cloud_managed` localStorage key.
- Add a short "Configuring cloud cones" note to the cloud cones section of `README.md` if user-facing.

- [ ] **Step 5: Commit docs**

```bash
npx prettier --write packages/cloudflare-worker/CLAUDE.md packages/webapp/CLAUDE.md README.md docs/shell-reference.md
git add packages/cloudflare-worker/CLAUDE.md packages/webapp/CLAUDE.md README.md docs/shell-reference.md
git commit -m "docs: cloud cone configuration (model, secrets, provider logins)"
```

---

## Notes for the executor

- **Routes-mirror rule:** any worker route change must appear in `src/index.ts` routes array, `tests/index.test.ts`, and `tests/deployed.test.ts`, or the staging smoke test fails (`packages/cloudflare-worker/CLAUDE.md`).
- **Secret hygiene:** never log or persist bundle values; the DO stores only the names-only index. Validation errors are shape/size only.
- **`@slicc/cloud-core/cone-config` is browser-safe** — never import the cloud-core root (`e2b`) from webapp code; only the subpath.
- **Build order:** `@slicc/cloud-core` must be built before node-server/worker/webapp typecheck resolves the subpath (`npm run build -w @slicc/cloud-core`).
