# Secret-aware fetch proxy in CLI and extension — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close three gaps in the secret-aware fetch proxy — HTTP Basic auth, extension-mode coverage, and the `oauth-token` real-token leak — so the public security claim ("API keys, OAuth tokens, and other sensitive values… are not placed into the LLM's context window") becomes uniformly true.

**Architecture:** Introduce a new `@slicc/shared` workspace package containing platform-agnostic secret primitives. Move `secret-masking.ts` into it; add a new `secrets-pipeline.ts` (stateful unmask/scrub class). Both `node-server` (via `SecretProxyManager`) and the chrome-extension SW (via a new Port-based `fetch-proxy.fetch` handler) delegate to `SecretsPipeline`. Add Basic-auth-aware + URL-credential-aware unmask; make body unmask byte-safe. Replicate OAuth tokens into a writable in-memory store on node-server / swift-server (and `chrome.storage.local` in extension) so the proxy can unmask masked OAuth Bearers. Page-side `createProxiedFetch()` (the existing `SecureFetch` factory) gets a Port-backed extension branch and replaces direct fetch in `git-http.ts`. Persist sessionId per-runtime so cached masks survive restart.

**Tech Stack:** TypeScript (webapp, node-server, chrome-extension, new `@slicc/shared`) + Vitest. Swift (swift-server) + XCTest. Web Crypto (`crypto.subtle`, `TextEncoder`) for HMAC-SHA256 masking. `chrome.runtime.connect` Ports for SW streaming. Hummingbird for swift-server HTTP. `isomorphic-git` consumer of the response stream.

**Spec:** `docs/superpowers/specs/2026-05-08-secret-aware-fetch-proxy-design.md` — refer to it for full context on each phase. Section names below match the spec.

---

## Existing-surface contract (must preserve)

The plan **preserves the public surface of `SecretProxyManager`** so existing callers (`packages/node-server/src/index.ts`) compile and run unchanged. Drift from these will break the build:

- `new SecretProxyManager(store?: EnvSecretStore, sessionId?: string)` — positional, no options object.
- `unmask(text: string, hostname): { text: string; forbidden?: { secretName: string; hostname: string } }`
- `unmaskBody(text: string, hostname): { text: string }` — string in, string out, no forbidden.
- `unmaskHeaders(headers: Record<string, string>, hostname): { forbidden?: { secretName: string; hostname: string } }` — **mutates the headers parameter in place**.
- `scrubResponse(text: string): string`
- `scrubHeaders(headers: Headers): Record<string, string>`
- `getMaskedEntries(): Array<{ name: string; maskedValue: string; domains: string[] }>`
- `getByMaskedValue(maskedValue: string): MaskedSecret | undefined`
- `reload(): Promise<void>`
- `SecretPair` interface from `secret-masking.ts` = `{ realValue: string; maskedValue: string }` (not `{ real, masked }`).
- `forbidden` shape is always `{ secretName: string; hostname: string }` (not `{ name, reason }`).

The new `SecretsPipeline` mirrors these signatures so `SecretProxyManager` becomes a thin delegating wrapper. Tasks below show explicit signatures — if you deviate to "cleaner" naming, you'll spend Phase 5 chasing call-site regressions.

`SecureFetch` is a **type** from `just-bash` (see `packages/webapp/src/shell/proxied-fetch.ts:21`). The canonical factory is `createProxiedFetch()` in `packages/webapp/src/shell/proxied-fetch.ts:110`, which today routes CLI through `/api/fetch-proxy` and extension through bare `fetch()`. The plan **modifies the extension branch of `createProxiedFetch()`** rather than introducing a new `secureFetch` symbol.

---

## Conventions

- **Before every commit:** run `npx prettier --write <touched-files>`. CI's `prettier --check` is the most common failure.
- **After every commit** in a TS phase: run `npm run typecheck` and the targeted vitest subset. The broader `npm run test` runs at phase end.
- **Phase end gates:** `npm run typecheck`, `npm run test`, `npm run build`, `npm run build -w @slicc/chrome-extension`. Phase 1's gates also include `npm run test:coverage`.
- **TDD discipline:** every behavior task is failing-test-first → red → green → commit. No skipping the "watch it fail" step.
- **Phase 7 (Swift):** Swift files commit-and-push to let CI's `swift-server` job validate. The local TS-only gates above still need to pass on every commit.
- **Naming:** Existing pipeline-method names (`scrubResponse`, `scrubHeaders`, `unmaskBody`, `unmaskHeaders`) are **stable** — do not rename them. New helpers add to the surface; existing names preserve.

---

## Phase 1: Extract `secrets-pipeline` into `@slicc/shared`

Spec: §"Phase 1: Extract `secrets-pipeline` (shared core)" and §"Mask consistency".

Goal: a new `@slicc/shared` workspace package holding `secret-masking.ts` (moved from webapp) and `secrets-pipeline.ts` (new). `SecretProxyManager` becomes a thin wrapper around `SecretsPipeline`. The chrome-extension SW (Phase 3) and swift-server (Phase 7 — Swift-only, separate code path) will reuse the same primitive contracts. SessionId persists across node-server restart.

---

### Task 1.1: Scaffold the `@slicc/shared` workspace package

**Files:**

- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/index.ts` (empty placeholder for now)
- Modify: root `package.json` `workspaces` array
- Modify: root `package.json` `build` script (add `@slicc/shared` first in the chain)
- Modify: root `tsconfig.json` `include` (so the webapp typecheck sees the new package)

The package keeps the flat `dist/node-server/index.js` layout intact by being self-contained (its own `dist/`). `dist/node-server/` paths in `main` / `bin` / `start` / `package:release` / `publish:chrome` are unchanged.

- [ ] **Step 1: Create the package skeleton**

`packages/shared/package.json`:

```json
{
  "name": "@slicc/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "default": "./dist/index.js"
    },
    "./src/*": "./src/*"
  },
  "files": ["dist", "src"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  }
}
```

`packages/shared/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "rootDir": "src",
    "outDir": "dist",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"]
}
```

`packages/shared/src/index.ts`:

```ts
// Re-exports added in Task 1.2 (secret-masking) and Task 1.3 (secrets-pipeline).
export {};
```

(The `DOM` lib is needed because `crypto.subtle`, `TextEncoder`, `Headers` are global in browser AND in Node 22+ — `DOM` widens the type surface that compiles cleanly in both targets.)

- [ ] **Step 2: Register the workspace**

Edit root `package.json`. Add `"packages/shared"` to the `workspaces` array (place it first so npm install resolves it before consumers). Update the root `build` script so `@slicc/shared` builds before `@slicc/node-server` (since node-server's runtime code consumes the compiled `dist/`):

```diff
   "workspaces": [
+    "packages/shared",
     "packages/webapp",
     "packages/node-server",
     ...
   ],
   ...
-    "build": "npm run build -w @slicc/webapp && npm run build -w @slicc/node-server && ..."
+    "build": "npm run build -w @slicc/shared && npm run build -w @slicc/webapp && npm run build -w @slicc/node-server && ..."
```

- [ ] **Step 3: Update root tsconfig.json include**

Edit root `tsconfig.json`:

```diff
-  "include": ["packages/webapp/src/**/*.ts", "packages/chrome-extension/src/**/*.ts"],
+  "include": ["packages/shared/src/**/*.ts", "packages/webapp/src/**/*.ts", "packages/chrome-extension/src/**/*.ts"],
   "exclude": ["packages/node-server/src/**/*.ts"]
```

- [ ] **Step 4: Install + build the empty package**

```bash
npm install
npm run build -w @slicc/shared
```

Expected: `packages/shared/dist/index.js` and `packages/shared/dist/index.d.ts` exist. Empty exports are OK.

- [ ] **Step 5: Verify root build still works** (catches a misordered `workspaces` field or build chain)

```bash
npm run build
```

Expected: clean. `dist/node-server/index.js` (etc.) still at the same paths as before.

- [ ] **Step 6: Commit**

```bash
npx prettier --write packages/shared/package.json packages/shared/tsconfig.json packages/shared/src/index.ts package.json tsconfig.json
git add packages/shared/ package.json tsconfig.json package-lock.json
git commit -m "chore(shared): scaffold @slicc/shared workspace package"
```

---

### Task 1.2: Move `secret-masking.ts` into `@slicc/shared`

**Files:**

- Move: `packages/webapp/src/core/secret-masking.ts` → `packages/shared/src/secret-masking.ts`
- Move: `packages/webapp/tests/core/secret-masking.test.ts` → `packages/shared/tests/secret-masking.test.ts`
- Modify: `packages/shared/src/index.ts` to re-export
- Modify: every importer of `secret-masking.ts`

- [ ] **Step 1: Identify all importers** (static AND dynamic)

Run both forms — the dynamic `await import(...)` won't show up in the static-import grep:

```bash
grep -rn "from.*secret-masking" packages/ --include='*.ts' | grep -v test.ts
grep -rn "await import.*secret-masking\|import('.*secret-masking" packages/ --include='*.ts'
```

Confirmed importers today (verified):

- `packages/webapp/tests/core/secret-masking.test.ts` — the test file itself, moved alongside the source.
- `packages/webapp/src/shell/supplemental-commands/secret-command.ts:266` — **dynamic import** `await import('../../core/secret-masking.js')` for `isAllowedDomain`. The relative path breaks after `git mv`; this importer MUST be updated to `@slicc/shared` (no shim) before the move can land green.
- `packages/node-server/src/secrets/masking.ts` — only a comment reference (deleted in Task 1.6).

Phase 2/3/4 work adds more importers; they all point at `@slicc/shared` directly.

- [ ] **Step 2: Add `@slicc/shared` to `@slicc/webapp` dependencies**

Edit `packages/webapp/package.json` — append `@slicc/shared` to `dependencies`:

```diff
   "dependencies": {
     "@adobe/helix-rum-js": "^2.14.2",
     ...
+    "@slicc/shared": "*"
   },
```

Run `npm install` to refresh the `node_modules/@slicc/shared` symlink for the webapp workspace. (Vite + vitest will resolve `@slicc/shared` from the symlink; for production webapp builds, Vite bundles the shared source directly via the workspace `exports.types` mapping to `./src/index.ts`.)

- [ ] **Step 3: Update the dynamic importer in `secret-command.ts`**

Edit `packages/webapp/src/shell/supplemental-commands/secret-command.ts` line 266:

```diff
-          const { isAllowedDomain } = await import('../../core/secret-masking.js');
+          const { isAllowedDomain } = await import('@slicc/shared');
```

- [ ] **Step 4: Move the source file**

```bash
mkdir -p packages/shared/tests
git mv packages/webapp/src/core/secret-masking.ts packages/shared/src/secret-masking.ts
git mv packages/webapp/tests/core/secret-masking.test.ts packages/shared/tests/secret-masking.test.ts
```

If `packages/webapp/src/core/` is now empty, leave it in place — other files (`proxy-error.ts`, `tool-adapter.ts`, etc.) live there.

- [ ] **Step 5: Update the test's import path**

Edit `packages/shared/tests/secret-masking.test.ts` line ~7:

```diff
-} from '../../src/core/secret-masking.js';
+} from '../src/secret-masking.js';
```

- [ ] **Step 6: Re-export from the package barrel + add `matchesDomains` alias**

Edit `packages/shared/src/index.ts`:

```ts
export * from './secret-masking.js';
```

The existing `secret-masking.ts` exports `domainMatches(pattern, hostname)` (single pattern) and `isAllowedDomain(patterns, hostname)`. Node-server callers use a third name `matchesDomains(hostname, patterns)` — different argument order. To keep node-server call sites compiling after Task 1.6's consolidation, append an alias **at the bottom of `packages/shared/src/secret-masking.ts`**:

```ts
/**
 * Compatibility alias for node-server's historical name + arg order.
 * Prefer `isAllowedDomain(patterns, hostname)` in new code.
 */
export function matchesDomains(hostname: string, patterns: string[]): boolean {
  return isAllowedDomain(patterns, hostname);
}
```

- [ ] **Step 7: Run the moved test**

Run: `npx vitest run packages/shared/tests/secret-masking.test.ts`
Expected: PASS — same tests, new location.

- [ ] **Step 8: Build the package**

Run: `npm run build -w @slicc/shared`
Expected: `packages/shared/dist/secret-masking.js`, `.d.ts` produced.

- [ ] **Step 9: Verify nothing else broke**

Run: `npm run typecheck && npm run test`
Expected: clean. Two webapp-side concerns for the move are handled: the test relocated into `packages/shared/tests/` with a relative import (Step 5), and `secret-command.ts:266` rewritten to `await import('@slicc/shared')` (Step 3). If a typecheck error mentions `'@slicc/shared'` resolution, the webapp dep from Step 2 didn't take — re-run `npm install`.

- [ ] **Step 10: Commit**

```bash
npx prettier --write packages/shared/src/secret-masking.ts packages/shared/tests/secret-masking.test.ts packages/shared/src/index.ts packages/webapp/package.json packages/webapp/src/shell/supplemental-commands/secret-command.ts
git add packages/shared/ packages/webapp/src/core packages/webapp/tests/core packages/webapp/package.json packages/webapp/src/shell/supplemental-commands/secret-command.ts package-lock.json
git commit -m "refactor(shared): move secret-masking.ts into @slicc/shared"
```

---

### Task 1.3: Create `secrets-pipeline.ts` in `@slicc/shared`

**Files:**

- Create: `packages/shared/src/secrets-pipeline.ts`
- Modify: `packages/shared/src/index.ts` (export it)
- Test: `packages/shared/tests/secrets-pipeline.test.ts`

**Contract**: `SecretsPipeline` mirrors `SecretProxyManager`'s existing surface exactly — in-place header mutation, `string`-only body unmask, `{ secretName, hostname }` forbidden shape, `{ name, maskedValue, domains }` masked-entries shape.

- [ ] **Step 1: Write the failing test**

`packages/shared/tests/secrets-pipeline.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { SecretsPipeline, type FetchProxySecretSource } from '../src/secrets-pipeline.js';

function source(
  entries: { name: string; value: string; domains: string[] }[]
): FetchProxySecretSource {
  return {
    get: async (name) => entries.find((e) => e.name === name)?.value,
    listAll: async () => entries.map((e) => ({ ...e })),
  };
}

describe('SecretsPipeline (skeleton)', () => {
  let pipeline: SecretsPipeline;

  beforeEach(async () => {
    pipeline = new SecretsPipeline({
      sessionId: 'session-fixed',
      source: source([
        { name: 'GITHUB_TOKEN', value: 'ghp_realToken123', domains: ['api.github.com'] },
      ]),
    });
    await pipeline.reload();
  });

  it('mask is deterministic for the same (sessionId, name, value)', async () => {
    const a = await pipeline.maskOne('GITHUB_TOKEN', 'ghp_realToken123');
    const b = await pipeline.maskOne('GITHUB_TOKEN', 'ghp_realToken123');
    expect(a).toBe(b);
  });

  it('getMaskedEntries returns {name, maskedValue, domains}[]', () => {
    const entries = pipeline.getMaskedEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      name: 'GITHUB_TOKEN',
      maskedValue: expect.stringMatching(/^[a-f0-9]+$/),
      domains: ['api.github.com'],
    });
  });

  it('unmaskHeaders mutates the headers param in place and returns {forbidden?} only', async () => {
    const masked = await pipeline.maskOne('GITHUB_TOKEN', 'ghp_realToken123');
    const headers: Record<string, string> = { authorization: `Bearer ${masked}` };
    const result = pipeline.unmaskHeaders(headers, 'api.github.com');
    expect(result.forbidden).toBeUndefined();
    expect(headers.authorization).toBe('Bearer ghp_realToken123'); // mutated
  });

  it('unmaskHeaders returns {forbidden: {secretName, hostname}} for non-allowed domain', async () => {
    const masked = await pipeline.maskOne('GITHUB_TOKEN', 'ghp_realToken123');
    const headers: Record<string, string> = { authorization: `Bearer ${masked}` };
    const result = pipeline.unmaskHeaders(headers, 'evil.example.com');
    expect(result.forbidden).toEqual({ secretName: 'GITHUB_TOKEN', hostname: 'evil.example.com' });
  });

  it('unmaskBody(text, hostname) returns {text} with masked→real where domain allowed', async () => {
    const masked = await pipeline.maskOne('GITHUB_TOKEN', 'ghp_realToken123');
    const result = pipeline.unmaskBody(`payload ${masked}`, 'api.github.com');
    expect(result.text).toBe('payload ghp_realToken123');
  });

  it('unmaskBody leaves masked-value untouched on domain mismatch (no forbidden)', async () => {
    const masked = await pipeline.maskOne('GITHUB_TOKEN', 'ghp_realToken123');
    const result = pipeline.unmaskBody(`payload ${masked}`, 'evil.example.com');
    expect(result.text).toBe(`payload ${masked}`);
  });

  it('scrubResponse replaces real → masked', async () => {
    const masked = await pipeline.maskOne('GITHUB_TOKEN', 'ghp_realToken123');
    const out = pipeline.scrubResponse('hello ghp_realToken123 world');
    expect(out).toBe(`hello ${masked} world`);
  });
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `npx vitest run packages/shared/tests/secrets-pipeline.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

`packages/shared/src/secrets-pipeline.ts`:

```ts
import {
  mask as cryptoMask,
  buildScrubber,
  matchesDomains,
  type SecretPair,
} from './secret-masking.js';

export interface FetchProxySecretSource {
  get(name: string): Promise<string | undefined>;
  listAll(): Promise<{ name: string; value: string; domains: string[] }[]>;
}

export interface MaskedSecret {
  name: string;
  realValue: string;
  maskedValue: string;
  domains: string[];
}

export interface ForbiddenInfo {
  secretName: string;
  hostname: string;
}

export interface UnmaskResult {
  text: string;
  forbidden?: ForbiddenInfo;
}

export interface UnmaskHeadersResult {
  forbidden?: ForbiddenInfo;
}

export interface SecretsPipelineOpts {
  sessionId: string;
  source: FetchProxySecretSource;
}

export class SecretsPipeline {
  public readonly sessionId: string;
  private readonly source: FetchProxySecretSource;
  private maskedToSecret = new Map<string, MaskedSecret>();
  private scrubber: (text: string) => string = (t) => t;

  constructor(opts: SecretsPipelineOpts) {
    this.sessionId = opts.sessionId;
    this.source = opts.source;
  }

  async reload(): Promise<void> {
    const all = await this.source.listAll();
    const next = new Map<string, MaskedSecret>();
    for (const s of all) {
      const maskedValue = await cryptoMask(this.sessionId, s.name, s.value);
      next.set(maskedValue, {
        name: s.name,
        realValue: s.value,
        maskedValue,
        domains: s.domains,
      });
    }
    this.maskedToSecret = next;
    const pairs: SecretPair[] = Array.from(next.values()).map((ms) => ({
      realValue: ms.realValue,
      maskedValue: ms.maskedValue,
    }));
    this.scrubber = buildScrubber(pairs);
  }

  async maskOne(name: string, value: string): Promise<string> {
    return cryptoMask(this.sessionId, name, value);
  }

  hasSecrets(): boolean {
    return this.maskedToSecret.size > 0;
  }

  getMaskedEntries(): Array<{ name: string; maskedValue: string; domains: string[] }> {
    return Array.from(this.maskedToSecret.values()).map((ms) => ({
      name: ms.name,
      maskedValue: ms.maskedValue,
      domains: ms.domains,
    }));
  }

  getByMaskedValue(maskedValue: string): MaskedSecret | undefined {
    return this.maskedToSecret.get(maskedValue);
  }

  /**
   * Unmask a single string. Domain mismatch on a matched secret → forbidden.
   * Returns { text } on success, { text: original, forbidden } on block.
   */
  unmask(text: string, hostname: string): UnmaskResult {
    let result = text;
    for (const [maskedValue, ms] of this.maskedToSecret) {
      if (!result.includes(maskedValue)) continue;
      if (!matchesDomains(hostname, ms.domains)) {
        return { text, forbidden: { secretName: ms.name, hostname } };
      }
      result = result.split(maskedValue).join(ms.realValue);
    }
    return { text: result };
  }

  /**
   * Unmask body text. Domain mismatch on a matched secret leaves it untouched
   * (NO forbidden — masked values in conversation context are harmless).
   */
  unmaskBody(text: string, hostname: string): { text: string } {
    let result = text;
    for (const [maskedValue, ms] of this.maskedToSecret) {
      if (!result.includes(maskedValue)) continue;
      if (!matchesDomains(hostname, ms.domains)) continue;
      result = result.split(maskedValue).join(ms.realValue);
    }
    return { text: result };
  }

  /**
   * Unmask headers IN PLACE. Mutates the headers parameter; returns only { forbidden? }.
   * Match SecretProxyManager's existing semantics so call sites compile unchanged.
   */
  unmaskHeaders(headers: Record<string, string>, hostname: string): UnmaskHeadersResult {
    for (const [key, val] of Object.entries(headers)) {
      const { text, forbidden } = this.unmask(val, hostname);
      if (forbidden) return { forbidden };
      headers[key] = text;
    }
    return {};
  }

  scrubResponse(text: string): string {
    return this.scrubber(text);
  }

  scrubHeaders(headers: Headers): Record<string, string> {
    const out: Record<string, string> = {};
    headers.forEach((v, k) => {
      out[k] = this.scrubber(v);
    });
    return out;
  }
}
```

The webapp/SW Basic-auth and URL-creds helpers come in Phase 2 — this task lands the parity skeleton only.

- [ ] **Step 4: Update the package barrel**

Edit `packages/shared/src/index.ts`:

```ts
export * from './secret-masking.js';
export * from './secrets-pipeline.js';
```

- [ ] **Step 5: Run — verify it passes**

Run: `npx vitest run packages/shared/tests/secrets-pipeline.test.ts`
Expected: PASS, 7 tests green.

- [ ] **Step 6: Build the package**

Run: `npm run build -w @slicc/shared`
Expected: clean emit.

- [ ] **Step 7: Commit**

```bash
npx prettier --write packages/shared/src/secrets-pipeline.ts packages/shared/tests/secrets-pipeline.test.ts packages/shared/src/index.ts
git add packages/shared/src/secrets-pipeline.ts packages/shared/tests/secrets-pipeline.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): SecretsPipeline mirrors SecretProxyManager surface"
```

---

### Task 1.4: Refactor `SecretProxyManager` to wrap `SecretsPipeline`

**Files:**

- Modify: `packages/node-server/src/secrets/proxy-manager.ts`
- Read first end-to-end: existing `packages/node-server/tests/secrets/proxy-manager.test.ts` — these are the contract.

The wrapper preserves the **exact** existing public surface (positional constructor, in-place header mutation, forbidden shape, method names) so `packages/node-server/src/index.ts` and all existing tests compile and pass unchanged.

- [ ] **Step 1: Verify baseline tests pass**

Run: `npx vitest run packages/node-server/tests/secrets/proxy-manager.test.ts`
Expected: PASS (baseline).

- [ ] **Step 2: Refactor the wrapper**

Replace the contents of `packages/node-server/src/secrets/proxy-manager.ts`. Keep the positional constructor signature, the field name `sessionId`, and every method name + signature unchanged. Delegate to `SecretsPipeline`:

```ts
import { randomUUID } from 'node:crypto';
import { SecretsPipeline, type FetchProxySecretSource, type MaskedSecret } from '@slicc/shared';
import { EnvSecretStore } from './env-secret-store.js';

function envStoreAsSource(store: EnvSecretStore | undefined): FetchProxySecretSource {
  return {
    get: async (name) => store?.get(name) ?? undefined,
    listAll: async () =>
      store ? store.list().map((e) => ({ name: e.name, value: e.value, domains: e.domains })) : [],
  };
}

export class SecretProxyManager {
  private readonly pipeline: SecretsPipeline;
  private readonly _sessionId: string;

  // Preserve existing positional signature exactly.
  constructor(store?: EnvSecretStore, sessionId?: string) {
    this._sessionId = sessionId ?? randomUUID();
    this.pipeline = new SecretsPipeline({
      sessionId: this._sessionId,
      source: envStoreAsSource(store),
    });
  }

  get sessionId(): string {
    return this._sessionId;
  }

  async reload(): Promise<void> {
    await this.pipeline.reload();
  }

  hasSecrets(): boolean {
    return this.pipeline.hasSecrets();
  }

  unmask(text: string, hostname: string) {
    return this.pipeline.unmask(text, hostname);
  }

  unmaskBody(text: string, hostname: string) {
    return this.pipeline.unmaskBody(text, hostname);
  }

  unmaskHeaders(headers: Record<string, string>, hostname: string) {
    return this.pipeline.unmaskHeaders(headers, hostname);
  }

  scrubResponse(text: string): string {
    return this.pipeline.scrubResponse(text);
  }

  scrubHeaders(headers: Headers): Record<string, string> {
    return this.pipeline.scrubHeaders(headers);
  }

  getByMaskedValue(maskedValue: string): MaskedSecret | undefined {
    return this.pipeline.getByMaskedValue(maskedValue);
  }

  getMaskedEntries() {
    return this.pipeline.getMaskedEntries();
  }
}
```

If the existing class had a private `MaskedSecret` interface declared inline, delete that — use the one re-exported from `@slicc/shared`.

If `packages/node-server/src/secrets/types.ts` re-exports anything that overlaps (e.g. `MaskedSecret`, `SecretGetter`), make those re-exports point at `@slicc/shared` to avoid double-definitions.

- [ ] **Step 3: Update `@slicc/node-server`'s `package.json`** (workspace dep)

Add `@slicc/shared` to `dependencies`:

```diff
   "devDependencies": { ... },
+  "dependencies": {
+    "@slicc/shared": "*"
+  }
```

(`*` resolves via npm workspaces to `packages/shared`.)

- [ ] **Step 4: `npm install`**

Run: `npm install`
Expected: `node_modules/@slicc/shared` symlink to `packages/shared`.

- [ ] **Step 5: Run the existing tests**

Run: `npx vitest run packages/node-server/tests/secrets/`
Expected: PASS, no regressions. If a test fails: the wrapper drifted from the original surface. Fix the wrapper, not the test.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
npx prettier --write packages/node-server/src/secrets/proxy-manager.ts packages/node-server/package.json
git add packages/node-server/src/secrets/proxy-manager.ts packages/node-server/package.json package-lock.json
git commit -m "refactor(node-server/secrets): proxy-manager wraps shared SecretsPipeline"
```

---

### Task 1.5: SessionId persistence (node-server)

**Files:**

- Create: `packages/node-server/src/secrets/session-id-file.ts`
- Modify: `packages/node-server/src/index.ts` (resolve session-id BEFORE constructing `SecretProxyManager`)
- Test: `packages/node-server/tests/secrets/session-persistence.test.ts`

Spec quote: "**node-server**: read/write to `~/.slicc/session-id` (or `<env-file-dir>/session-id` if `--env-file` is in play). On startup: if file exists and is non-empty, reuse it; otherwise generate a fresh UUID and write it (mode 0600)."

Key design point: the `SecretProxyManager` constructor signature **stays positional** `(store?, sessionId?)`. We resolve session-id earlier (in `index.ts`) and pass it positionally. No constructor change, no options object.

- [ ] **Step 1: Write the failing test**

`packages/node-server/tests/secrets/session-persistence.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOrCreateSessionId } from '../../src/secrets/session-id-file.js';

describe('session-id-file', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slicc-session-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('generates a UUID when no file exists and writes it with mode 0600', () => {
    const id = readOrCreateSessionId(dir);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const path = join(dir, 'session-id');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf-8').trim()).toBe(id);
    if (process.platform !== 'win32') {
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('reuses the existing UUID across calls', () => {
    const a = readOrCreateSessionId(dir);
    const b = readOrCreateSessionId(dir);
    expect(a).toBe(b);
  });

  it('overwrites empty or non-UUID corrupt files with a fresh UUID', () => {
    const path = join(dir, 'session-id');
    writeFileSync(path, '   \n');
    const id = readOrCreateSessionId(dir);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(readFileSync(path, 'utf-8').trim()).toBe(id);
  });
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `npx vitest run packages/node-server/tests/secrets/session-persistence.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

`packages/node-server/src/secrets/session-id-file.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read the session-id from `<dir>/session-id`; if missing/empty/corrupt, generate
 * a fresh UUID, write it (mode 0600), and return that. Idempotent on subsequent calls.
 */
export function readOrCreateSessionId(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'session-id');
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf-8').trim();
    if (UUID_RE.test(raw)) return raw;
  }
  const fresh = randomUUID();
  writeFileSync(path, fresh + '\n', { encoding: 'utf-8' });
  try {
    chmodSync(path, 0o600);
  } catch {
    // best effort on Windows
  }
  return fresh;
}
```

- [ ] **Step 4: Run — verify it passes**

Run: `npx vitest run packages/node-server/tests/secrets/session-persistence.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into `index.ts`**

In `packages/node-server/src/index.ts`, find the `new SecretProxyManager()` construction. Compute the session directory FIRST, resolve session-id, then pass it positionally:

```ts
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readOrCreateSessionId } from './secrets/session-id-file.js';

// ... where envFile is the resolved --env-file path (or undefined):
const sessionDir = envFile ? dirname(envFile) : join(homedir(), '.slicc');
const sessionId = readOrCreateSessionId(sessionDir);
const proxyManager = new SecretProxyManager(envStore, sessionId);
```

Adjust to the actual variable names in `index.ts`.

- [ ] **Step 6: Add the round-trip tripwire test**

Append to `session-persistence.test.ts`:

```ts
import { SecretProxyManager } from '../../src/secrets/proxy-manager.js';
import { EnvSecretStore } from '../../src/secrets/env-secret-store.js';

describe('mask round-trip across SecretProxyManager re-instantiations', () => {
  it('two managers using the same on-disk session-id produce identical masks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slicc-tripwire-'));
    try {
      const envPath = join(dir, 'secrets.env');
      writeFileSync(envPath, 'GITHUB_TOKEN=ghp_real\nGITHUB_TOKEN_DOMAINS=api.github.com\n');
      const sessionId1 = readOrCreateSessionId(dir);
      const sessionId2 = readOrCreateSessionId(dir);
      expect(sessionId1).toBe(sessionId2);

      const a = new SecretProxyManager(new EnvSecretStore(envPath), sessionId1);
      await a.reload();
      const b = new SecretProxyManager(new EnvSecretStore(envPath), sessionId2);
      await b.reload();
      const aEntry = a.getMaskedEntries().find((e) => e.name === 'GITHUB_TOKEN');
      const bEntry = b.getMaskedEntries().find((e) => e.name === 'GITHUB_TOKEN');
      expect(aEntry?.maskedValue).toBe(bEntry?.maskedValue);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

Note: uses `new EnvSecretStore(envPath)` (not `EnvSecretStore.load(...)` — there is no static `load`). The env file is written with the production-side `<NAME>=<value>` + `<NAME>_DOMAINS=<csv>` lines.

- [ ] **Step 7: Verify the tripwire passes**

Run: `npx vitest run packages/node-server/tests/secrets/session-persistence.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 8: Commit**

```bash
npx prettier --write packages/node-server/src/secrets/session-id-file.ts packages/node-server/src/index.ts packages/node-server/tests/secrets/session-persistence.test.ts
git add packages/node-server/src/secrets/session-id-file.ts packages/node-server/src/index.ts packages/node-server/tests/secrets/session-persistence.test.ts
git commit -m "feat(node-server/secrets): persist sessionId across restart"
```

---

### Task 1.6: Delete node-server's duplicate `masking.ts` and `domain-match.ts`

**Files:**

- Delete: `packages/node-server/src/secrets/masking.ts`
- Delete: `packages/node-server/src/secrets/domain-match.ts`
- Delete: `packages/node-server/tests/secrets/domain-match.test.ts` (port unique cases into `packages/shared/tests/secret-masking.test.ts` if any)
- Modify: every node-server file that imports the two deleted modules — re-point at `@slicc/shared`.

- [ ] **Step 1: Identify importers**

Run: `grep -rn "from.*secrets/masking\|from.*secrets/domain-match" packages/node-server/`
Note the list.

- [ ] **Step 2: Migrate any unique domain-match test cases**

Diff `packages/node-server/tests/secrets/domain-match.test.ts` against `packages/shared/tests/secret-masking.test.ts`. Port any unique test vector into the shared test file. If everything is already duplicated, just delete the node-server test.

- [ ] **Step 3: Re-point each importer**

For each file in Step 1's list, replace:

- `from './masking.js'` (or any relative path to it) → `from '@slicc/shared'`
- `from './domain-match.js'` → `from '@slicc/shared'`

Renames you must make at call sites:

- The shared module now exports `domainMatches(pattern, hostname)`, `isAllowedDomain(patterns, hostname)`, AND the new `matchesDomains(hostname, patterns)` alias added in Task 1.2 Step 4. Node-server's existing call sites of `matchesDomains` therefore compile unchanged once the import points at `@slicc/shared`. No rename needed.

- [ ] **Step 4: Delete the duplicates**

```bash
git rm packages/node-server/src/secrets/masking.ts packages/node-server/src/secrets/domain-match.ts packages/node-server/tests/secrets/domain-match.test.ts
```

- [ ] **Step 5: Run all node-server tests + typecheck**

```bash
npm run typecheck
npx vitest run packages/node-server/
```

Expected: green. If something explodes on an import path, that's a Step 3 miss.

- [ ] **Step 6: Commit**

```bash
npx prettier --write $(git diff --name-only --cached packages/node-server packages/shared)
git add -A packages/node-server/src/secrets packages/node-server/tests/secrets packages/shared
git commit -m "refactor(node-server/secrets): consolidate to @slicc/shared"
```

---

### Task 1.7: Phase 1 gate

- [ ] **Step 1: Full repo gate**

```bash
npm run typecheck
npm run test
npm run test:coverage
npm run build
npm run build -w @slicc/chrome-extension
```

Expected: all green. The dist layout under `dist/node-server/` is unchanged from main (verify with `ls dist/node-server/index.js`).

- [ ] **Step 2: Commit any coverage-driven test additions** (only if needed)

```bash
npx prettier --write <files>
git add <files>
git commit -m "test(shared): cover SecretsPipeline branches for coverage floor"
```

---

## Phase 2: CLI Basic-auth + URL-embedded credential + byte-safe body unmask

Spec: §"Phase 2".

Adds three new methods to `SecretsPipeline` and wires them into `/api/fetch-proxy`. The existing `unmaskBody(text, hostname)` stays string-only; a new `unmaskBodyBytes(bytes, hostname)` adds byte-safe support for Phase 3's SW request bodies (binary git packfiles).

---

### Task 2.1: `unmaskAuthorizationBasic` in `SecretsPipeline`

**Files:**

- Modify: `packages/shared/src/secrets-pipeline.ts`
- Test: `packages/shared/tests/secrets-pipeline.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `secrets-pipeline.test.ts`:

```ts
describe('unmaskAuthorizationBasic', () => {
  let pipeline: SecretsPipeline;
  let masked: string;

  beforeEach(async () => {
    pipeline = new SecretsPipeline({
      sessionId: 'session-fixed',
      source: source([
        {
          name: 'GITHUB_TOKEN',
          value: 'ghp_realToken123',
          domains: ['github.com', '*.github.com'],
        },
      ]),
    });
    await pipeline.reload();
    masked = await pipeline.maskOne('GITHUB_TOKEN', 'ghp_realToken123');
  });

  it('decodes Basic, unmasks password, re-encodes when domain allowed', async () => {
    const b64 = Buffer.from(`x-access-token:${masked}`, 'utf-8').toString('base64');
    const result = pipeline.unmaskAuthorizationBasic(`Basic ${b64}`, 'github.com');
    expect(typeof result).toBe('object');
    expect((result as { value: string }).value).toMatch(/^Basic /);
    const decoded = Buffer.from(
      (result as { value: string }).value.replace(/^Basic /, ''),
      'base64'
    ).toString('utf-8');
    expect(decoded).toBe('x-access-token:ghp_realToken123');
  });

  it('forbids when domain not allowed', async () => {
    const b64 = Buffer.from(`u:${masked}`, 'utf-8').toString('base64');
    const result = pipeline.unmaskAuthorizationBasic(`Basic ${b64}`, 'evil.example.com');
    expect((result as { forbidden: ForbiddenInfo }).forbidden).toEqual({
      secretName: 'GITHUB_TOKEN',
      hostname: 'evil.example.com',
    });
  });

  it('leaves unchanged on invalid base64 / no colon / no mask', async () => {
    expect(pipeline.unmaskAuthorizationBasic('Basic %%%not-b64%%%', 'github.com')).toEqual({
      value: 'Basic %%%not-b64%%%',
    });
    expect(
      pipeline.unmaskAuthorizationBasic(
        `Basic ${Buffer.from('nocolon').toString('base64')}`,
        'github.com'
      )
    ).toEqual({ value: `Basic ${Buffer.from('nocolon').toString('base64')}` });
    expect(
      pipeline.unmaskAuthorizationBasic(
        `Basic ${Buffer.from('u:plain').toString('base64')}`,
        'github.com'
      )
    ).toEqual({ value: `Basic ${Buffer.from('u:plain').toString('base64')}` });
  });
});
```

The shape `{ value }` vs `{ forbidden }` matches the existing `unmask()` return shape (sans the `text` field for headers).

- [ ] **Step 2: Run — verify it fails**

Run: `npx vitest run packages/shared/tests/secrets-pipeline.test.ts -t 'unmaskAuthorizationBasic'`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `secrets-pipeline.ts`:

```ts
export interface BasicResult {
  value: string;
  forbidden?: ForbiddenInfo;
}

unmaskAuthorizationBasic(headerValue: string, hostname: string): BasicResult {
  const match = /^Basic\s+(.+)$/.exec(headerValue);
  if (!match) return { value: headerValue };
  let decoded: string;
  try {
    decoded = atob(match[1].trim());
  } catch {
    return { value: headerValue };
  }
  const colon = decoded.indexOf(':');
  if (colon < 0) return { value: headerValue };
  let user = decoded.slice(0, colon);
  let pass = decoded.slice(colon + 1);
  let touched = false;
  for (const [maskedValue, ms] of this.maskedToSecret) {
    if (user.includes(maskedValue) || pass.includes(maskedValue)) {
      if (!matchesDomains(hostname, ms.domains)) {
        return { value: headerValue, forbidden: { secretName: ms.name, hostname } };
      }
      if (user.includes(maskedValue)) user = user.split(maskedValue).join(ms.realValue);
      if (pass.includes(maskedValue)) pass = pass.split(maskedValue).join(ms.realValue);
      touched = true;
    }
  }
  if (!touched) return { value: headerValue };
  return { value: `Basic ${btoa(`${user}:${pass}`)}` };
}
```

And wire it into `unmaskHeaders`: when the header key is `authorization` (case-insensitive) and the value starts with `Basic `, call this helper first and short-circuit the literal-substring loop for that header. Existing Bearer/X-API-Key paths flow through the standard `unmask` loop unchanged.

```ts
unmaskHeaders(headers: Record<string, string>, hostname: string): UnmaskHeadersResult {
  for (const [key, val] of Object.entries(headers)) {
    if (key.toLowerCase() === 'authorization' && /^Basic\s/i.test(val)) {
      const basic = this.unmaskAuthorizationBasic(val, hostname);
      if (basic.forbidden) return { forbidden: basic.forbidden };
      headers[key] = basic.value;
      continue;
    }
    const { text, forbidden } = this.unmask(val, hostname);
    if (forbidden) return { forbidden };
    headers[key] = text;
  }
  return {};
}
```

- [ ] **Step 4: Run — verify it passes**

Run: `npx vitest run packages/shared/tests/secrets-pipeline.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/shared/src/secrets-pipeline.ts packages/shared/tests/secrets-pipeline.test.ts
git add packages/shared/src/secrets-pipeline.ts packages/shared/tests/secrets-pipeline.test.ts
git commit -m "feat(shared): Basic-auth-aware unmask in SecretsPipeline"
```

---

### Task 2.2: `extractAndUnmaskUrlCredentials`

**Files:**

- Modify: `packages/shared/src/secrets-pipeline.ts`
- Test: `packages/shared/tests/secrets-pipeline.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe('extractAndUnmaskUrlCredentials', () => {
  let pipeline: SecretsPipeline;
  let masked: string;

  beforeEach(async () => {
    pipeline = new SecretsPipeline({
      sessionId: 'session-fixed',
      source: source([
        { name: 'GITHUB_TOKEN', value: 'ghp_realToken123', domains: ['github.com'] },
      ]),
    });
    await pipeline.reload();
    masked = await pipeline.maskOne('GITHUB_TOKEN', 'ghp_realToken123');
  });

  it('strips userinfo and synthesizes Authorization when password is masked', () => {
    const url = `https://x-access-token:${masked}@github.com/owner/repo.git`;
    const result = pipeline.extractAndUnmaskUrlCredentials(url);
    expect(result.url).toBe('https://github.com/owner/repo.git');
    expect(result.syntheticAuthorization).toBeDefined();
    const decoded = atob(result.syntheticAuthorization!.replace(/^Basic /, ''));
    expect(decoded).toBe('x-access-token:ghp_realToken123');
  });

  it('forbids when URL host is not allowed for the secret', () => {
    const result = pipeline.extractAndUnmaskUrlCredentials(`https://u:${masked}@evil.example.com/`);
    expect(result.forbidden).toEqual({ secretName: 'GITHUB_TOKEN', hostname: 'evil.example.com' });
  });

  it('strips userinfo even when no mask matches (browsers reject userinfo URLs)', () => {
    const result = pipeline.extractAndUnmaskUrlCredentials('https://u:plain@github.com/');
    expect(result.url).toBe('https://github.com/');
    expect(result.syntheticAuthorization).toBeUndefined();
  });

  it('returns url unchanged when no userinfo present', () => {
    const result = pipeline.extractAndUnmaskUrlCredentials('https://github.com/foo');
    expect(result.url).toBe('https://github.com/foo');
    expect(result.syntheticAuthorization).toBeUndefined();
  });

  it('returns url unchanged on malformed URL', () => {
    const result = pipeline.extractAndUnmaskUrlCredentials('not a url');
    expect(result.url).toBe('not a url');
  });
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `npx vitest run packages/shared/tests/secrets-pipeline.test.ts -t 'extractAndUnmaskUrlCredentials'`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
export interface ExtractedUrlCreds {
  url: string;
  syntheticAuthorization?: string;
  forbidden?: ForbiddenInfo;
}

extractAndUnmaskUrlCredentials(rawUrl: string): ExtractedUrlCreds {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { url: rawUrl };
  }
  if (!parsed.username && !parsed.password) return { url: rawUrl };

  let user = decodeURIComponent(parsed.username);
  let pass = decodeURIComponent(parsed.password);
  const host = parsed.host;
  let touched = false;
  for (const [maskedValue, ms] of this.maskedToSecret) {
    if (user.includes(maskedValue) || pass.includes(maskedValue)) {
      if (!matchesDomains(host, ms.domains)) {
        return { url: rawUrl, forbidden: { secretName: ms.name, hostname: host } };
      }
      if (user.includes(maskedValue)) { user = user.split(maskedValue).join(ms.realValue); touched = true; }
      if (pass.includes(maskedValue)) { pass = pass.split(maskedValue).join(ms.realValue); touched = true; }
    }
  }
  const synthetic = touched && (user || pass) ? `Basic ${btoa(`${user}:${pass}`)}` : undefined;
  parsed.username = '';
  parsed.password = '';
  return { url: parsed.toString(), syntheticAuthorization: synthetic };
}
```

- [ ] **Step 4: Run — verify it passes**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/shared/src/secrets-pipeline.ts packages/shared/tests/secrets-pipeline.test.ts
git add packages/shared/src/secrets-pipeline.ts packages/shared/tests/secrets-pipeline.test.ts
git commit -m "feat(shared): URL-embedded credential unmask + userinfo strip"
```

---

### Task 2.3: Byte-safe `unmaskBodyBytes` (additive)

**Files:**

- Modify: `packages/shared/src/secrets-pipeline.ts`
- Test: `packages/shared/tests/secrets-pipeline.test.ts`

Adds a **new** `unmaskBodyBytes(bytes: Uint8Array, hostname): { bytes: Uint8Array }` method. The existing `unmaskBody(text: string, hostname)` is left unchanged — string consumers (node-server's `/api/fetch-proxy` body unmask for text payloads) keep working. The SW handler (Phase 3) will call the bytes variant for binary request bodies.

- [ ] **Step 1: Write the failing tests**

```ts
describe('unmaskBodyBytes — byte-safe', () => {
  let pipeline: SecretsPipeline;
  let masked: string;

  beforeEach(async () => {
    pipeline = new SecretsPipeline({
      sessionId: 'session-fixed',
      source: source([
        { name: 'GITHUB_TOKEN', value: 'ghp_realToken123', domains: ['github.com'] },
      ]),
    });
    await pipeline.reload();
    masked = await pipeline.maskOne('GITHUB_TOKEN', 'ghp_realToken123');
  });

  it('replaces masked → real in a UTF-8 body', () => {
    const body = new TextEncoder().encode(`hello ${masked} world`);
    const { bytes } = pipeline.unmaskBodyBytes(body, 'github.com');
    expect(new TextDecoder().decode(bytes)).toBe('hello ghp_realToken123 world');
  });

  it('does not corrupt surrounding bytes when no match', () => {
    const before = new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0xc3, 0x28, 0xa0, 0x80]);
    const { bytes } = pipeline.unmaskBodyBytes(before, 'github.com');
    expect(Array.from(bytes)).toEqual(Array.from(before));
  });

  it('replaces only at byte-aligned masked-value occurrences', () => {
    const maskedBytes = new TextEncoder().encode(masked);
    const prefix = new Uint8Array([0xff, 0xfe, 0x00]);
    const suffix = new Uint8Array([0x01, 0xff]);
    const input = new Uint8Array(prefix.length + maskedBytes.length + suffix.length);
    input.set(prefix, 0);
    input.set(maskedBytes, prefix.length);
    input.set(suffix, prefix.length + maskedBytes.length);
    const { bytes } = pipeline.unmaskBodyBytes(input, 'github.com');
    const realBytes = new TextEncoder().encode('ghp_realToken123');
    const expected = new Uint8Array(prefix.length + realBytes.length + suffix.length);
    expected.set(prefix, 0);
    expected.set(realBytes, prefix.length);
    expected.set(suffix, prefix.length + realBytes.length);
    expect(Array.from(bytes)).toEqual(Array.from(expected));
  });

  it('leaves bytes untouched on domain mismatch', () => {
    const body = new TextEncoder().encode(`hello ${masked} world`);
    const { bytes } = pipeline.unmaskBodyBytes(body, 'evil.example.com');
    expect(new TextDecoder().decode(bytes)).toBe(`hello ${masked} world`);
  });
});
```

- [ ] **Step 2: Run — verify it fails**

Expected: FAIL.

- [ ] **Step 3: Implement**

Top-of-file helpers (module-private):

```ts
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function replaceAllBytes(
  haystack: Uint8Array,
  needle: Uint8Array,
  replacement: Uint8Array
): Uint8Array {
  if (indexOfBytes(haystack, needle) < 0) return haystack;
  const out: number[] = [];
  let i = 0;
  while (i < haystack.length) {
    const idx = indexOfBytes(haystack, needle, i);
    if (idx < 0) {
      for (let k = i; k < haystack.length; k++) out.push(haystack[k]);
      break;
    }
    for (let k = i; k < idx; k++) out.push(haystack[k]);
    for (let k = 0; k < replacement.length; k++) out.push(replacement[k]);
    i = idx + needle.length;
  }
  return new Uint8Array(out);
}
```

Method:

```ts
unmaskBodyBytes(body: Uint8Array, hostname: string): { bytes: Uint8Array } {
  let out = body;
  const enc = new TextEncoder();
  for (const [maskedValue, ms] of this.maskedToSecret) {
    if (!matchesDomains(hostname, ms.domains)) continue;
    const needle = enc.encode(maskedValue);
    const replacement = enc.encode(ms.realValue);
    out = replaceAllBytes(out, needle, replacement);
  }
  return { bytes: out };
}
```

(Note: `unmaskBody(text: string, ...)` stays unchanged — node-server's `index.ts` calls it with strings; preserving the signature avoids churn there.)

- [ ] **Step 4: Add `scrubResponseBytes` (symmetric byte-safe scrub for SW chunks)**

`scrubResponse(text: string)` stays for text consumers. Add a bytes-in/bytes-out variant the SW will call on raw response chunks. This avoids the TextDecoder/TextEncoder round-trip that corrupts binary (git packfiles, images, ZIPs).

Test (append to `secrets-pipeline.test.ts`):

```ts
describe('scrubResponseBytes', () => {
  let pipeline: SecretsPipeline;

  beforeEach(async () => {
    pipeline = new SecretsPipeline({
      sessionId: 'session-fixed',
      source: source([
        { name: 'GITHUB_TOKEN', value: 'ghp_realToken123', domains: ['github.com'] },
      ]),
    });
    await pipeline.reload();
  });

  it('replaces real → masked at byte boundaries in a UTF-8 chunk', async () => {
    const masked = await pipeline.maskOne('GITHUB_TOKEN', 'ghp_realToken123');
    const input = new TextEncoder().encode('hello ghp_realToken123 world');
    const out = pipeline.scrubResponseBytes(input);
    expect(new TextDecoder().decode(out)).toBe(`hello ${masked} world`);
  });

  it('leaves arbitrary non-UTF-8 bytes untouched', () => {
    const before = new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0xc3, 0x28, 0xa0, 0x80]);
    const out = pipeline.scrubResponseBytes(before);
    expect(Array.from(out)).toEqual(Array.from(before));
  });
});
```

Implementation:

```ts
scrubResponseBytes(bytes: Uint8Array): Uint8Array {
  let out = bytes;
  const enc = new TextEncoder();
  for (const [maskedValue, ms] of this.maskedToSecret) {
    const needle = enc.encode(ms.realValue);
    const replacement = enc.encode(maskedValue);
    out = replaceAllBytes(out, needle, replacement);
  }
  return out;
}
```

- [ ] **Step 5: Run — verify it passes**

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npx prettier --write packages/shared/src/secrets-pipeline.ts packages/shared/tests/secrets-pipeline.test.ts
git add packages/shared/src/secrets-pipeline.ts packages/shared/tests/secrets-pipeline.test.ts
git commit -m "feat(shared): byte-safe unmaskBodyBytes + scrubResponseBytes"
```

---

### Task 2.4: Wire into `/api/fetch-proxy` (node-server)

**Files:**

- Modify: `packages/node-server/src/index.ts` (route around line 1031; `targetUrl` at line 1045)
- Test: `packages/node-server/tests/secrets/fetch-proxy-basic-auth.test.ts`

The route already calls `proxyManager.unmaskHeaders(headers, hostname)` — that path now picks up Basic-auth automatically (Phase 2.1 wired it in). We add a separate `extractAndUnmaskUrlCredentials(targetUrl)` pass for the URL itself (since `x-target-url` lives in `FETCH_PROXY_SKIP_HEADERS` and is not in the headers bag).

- [ ] **Step 1: Write the failing test**

`packages/node-server/tests/secrets/fetch-proxy-basic-auth.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretProxyManager } from '../../src/secrets/proxy-manager.js';
import { EnvSecretStore } from '../../src/secrets/env-secret-store.js';
import { readOrCreateSessionId } from '../../src/secrets/session-id-file.js';

describe('fetch-proxy Basic-auth round-trip (unit)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slicc-bauth-'));
    writeFileSync(
      join(dir, 'secrets.env'),
      'GITHUB_TOKEN=ghp_realToken123\nGITHUB_TOKEN_DOMAINS=github.com,*.github.com\n'
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('decodes Basic, unmasks password, re-encodes via unmaskHeaders', async () => {
    const envFile = join(dir, 'secrets.env');
    const sessionId = readOrCreateSessionId(dir);
    const proxy = new SecretProxyManager(new EnvSecretStore(envFile), sessionId);
    await proxy.reload();
    const masked = proxy.getMaskedEntries().find((e) => e.name === 'GITHUB_TOKEN')!.maskedValue;
    const headers: Record<string, string> = {
      authorization: `Basic ${Buffer.from(`x-access-token:${masked}`).toString('base64')}`,
    };
    const result = proxy.unmaskHeaders(headers, 'github.com');
    expect(result.forbidden).toBeUndefined();
    const decoded = Buffer.from(headers.authorization.replace(/^Basic /, ''), 'base64').toString();
    expect(decoded).toBe('x-access-token:ghp_realToken123');
  });
});
```

- [ ] **Step 2: Run — should pass already** (Phase 2.1 wired Basic into unmaskHeaders)

Run: `npx vitest run packages/node-server/tests/secrets/fetch-proxy-basic-auth.test.ts`
Expected: PASS. If FAIL: revisit Task 2.1.

- [ ] **Step 3: Patch `index.ts` to add URL-creds unmask + clean URL on fetch call**

Inside the `/api/fetch-proxy` handler in `packages/node-server/src/index.ts`, after the existing `unmaskHeaders(...)` call and before the outbound `fetch(targetUrl, ...)`, add:

```ts
const credsResult = proxyManager.extractAndUnmaskUrlCredentials(targetUrl);
if (credsResult.forbidden) {
  return res.status(403).json({
    error: 'forbidden',
    secretName: credsResult.forbidden.secretName,
    hostname: credsResult.forbidden.hostname,
  });
}
const cleanedUrl = credsResult.url;
if (credsResult.syntheticAuthorization && !('authorization' in cleanedHeaders)) {
  cleanedHeaders.authorization = credsResult.syntheticAuthorization;
}
// pass cleanedUrl to fetch(...) instead of targetUrl
```

Adjust to the actual variable names in `index.ts` (`cleanedHeaders` is whatever variable holds the post-`unmaskHeaders` headers bag — likely just the same `headers` reference, since `unmaskHeaders` mutates in place).

`SecretProxyManager` already exposes `extractAndUnmaskUrlCredentials` via the wrapper (it delegates to the pipeline). If it doesn't yet, add the delegation method in `proxy-manager.ts`:

```ts
extractAndUnmaskUrlCredentials(rawUrl: string) {
  return this.pipeline.extractAndUnmaskUrlCredentials(rawUrl);
}
```

- [ ] **Step 4: Add integration test for URL-embedded creds**

Append to `fetch-proxy-basic-auth.test.ts`:

```ts
describe('URL-embedded credentials in /api/fetch-proxy', () => {
  it('strips userinfo + synthesizes Authorization for masked PAT in URL', async () => {
    // ... use proxy.extractAndUnmaskUrlCredentials(url) directly
  });
});
```

- [ ] **Step 5: Run all node-server tests**

Run: `npx vitest run packages/node-server/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npx prettier --write packages/node-server/src/index.ts packages/node-server/src/secrets/proxy-manager.ts packages/node-server/tests/secrets/fetch-proxy-basic-auth.test.ts
git add packages/node-server/src/index.ts packages/node-server/src/secrets/proxy-manager.ts packages/node-server/tests/secrets/fetch-proxy-basic-auth.test.ts
git commit -m "feat(node-server): wire Basic-auth + URL-creds unmask into /api/fetch-proxy"
```

---

### Task 2.5: Phase 2 gate

- [ ] **Step 1: Full gate**

```bash
npm run typecheck
npm run test
npm run build
npm run build -w @slicc/chrome-extension
```

Expected: all green.

---

## Phase 3: Extension SW fetch proxy (Port-based streaming)

Spec: §"Phase 3".

Goal: a new SW handler `fetch-proxy.fetch` over a `chrome.runtime.Port`. Page-side `createProxiedFetch()` extension branch opens the port per fetch; response body streams back as chunks; cancel-on-disconnect aborts upstream.

---

### Task 3.1: `listSecretsWithValues` in `secrets-storage.ts`

**Files:**

- Modify: `packages/chrome-extension/src/secrets-storage.ts`
- Test: `packages/chrome-extension/tests/secrets-storage.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listSecretsWithValues } from '../src/secrets-storage.js';

describe('listSecretsWithValues', () => {
  beforeEach(() => {
    (globalThis as any).chrome = {
      storage: {
        local: {
          get: vi.fn(async () => ({
            GITHUB_TOKEN: 'ghp_real',
            GITHUB_TOKEN_DOMAINS: 'github.com,*.github.com',
            's3.r2.access-key-id': 'AKIAEXAMPLE',
            's3.r2.access-key-id_DOMAINS': '*.r2.cloudflarestorage.com',
            unrelated: 'noise',
          })),
        },
      },
    };
  });

  it('returns {name, value, domains}[] for every <key>+<key>_DOMAINS pair', async () => {
    const entries = await listSecretsWithValues();
    expect(entries).toEqual(
      expect.arrayContaining([
        { name: 'GITHUB_TOKEN', value: 'ghp_real', domains: ['github.com', '*.github.com'] },
        {
          name: 's3.r2.access-key-id',
          value: 'AKIAEXAMPLE',
          domains: ['*.r2.cloudflarestorage.com'],
        },
      ])
    );
    expect(entries.find((e) => e.name === 'unrelated')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — verify it fails**

Expected: FAIL.

- [ ] **Step 3: Implement**

Append to `packages/chrome-extension/src/secrets-storage.ts`:

```ts
export async function listSecretsWithValues(): Promise<
  { name: string; value: string; domains: string[] }[]
> {
  const all = (await chrome.storage.local.get(null)) as Record<string, string>;
  const out: { name: string; value: string; domains: string[] }[] = [];
  for (const key of Object.keys(all)) {
    if (key.endsWith('_DOMAINS')) continue;
    const domainsKey = `${key}_DOMAINS`;
    if (typeof all[key] !== 'string' || typeof all[domainsKey] !== 'string') continue;
    const domains = all[domainsKey]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!domains.length) continue;
    out.push({ name: key, value: all[key], domains });
  }
  return out;
}
```

- [ ] **Step 4: Run — verify it passes**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/chrome-extension/src/secrets-storage.ts packages/chrome-extension/tests/secrets-storage.test.ts
git add packages/chrome-extension/src/secrets-storage.ts packages/chrome-extension/tests/secrets-storage.test.ts
git commit -m "feat(chrome-extension/secrets-storage): listSecretsWithValues"
```

---

### Task 3.2: SessionId persistence (SW)

**Files:**

- Create: `packages/chrome-extension/src/sw-session-id.ts`
- Test: `packages/chrome-extension/tests/sw-session-id.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readOrCreateSwSessionId } from '../src/sw-session-id.js';

describe('readOrCreateSwSessionId', () => {
  let storage: Record<string, string>;
  beforeEach(() => {
    storage = {};
    (globalThis as any).chrome = {
      storage: {
        local: {
          get: vi.fn(async (key: string) => (key in storage ? { [key]: storage[key] } : {})),
          set: vi.fn(async (obj: Record<string, string>) => Object.assign(storage, obj)),
        },
      },
    };
  });

  it('creates a UUID on first call and persists it', async () => {
    const id = await readOrCreateSwSessionId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(storage['_session.id']).toBe(id);
  });

  it('reuses the persisted UUID on subsequent calls', async () => {
    const a = await readOrCreateSwSessionId();
    const b = await readOrCreateSwSessionId();
    expect(a).toBe(b);
  });
});
```

- [ ] **Step 2: Run — verify it fails**

Expected: FAIL.

- [ ] **Step 3: Implement**

`packages/chrome-extension/src/sw-session-id.ts`:

```ts
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = '_session.id';

export async function readOrCreateSwSessionId(): Promise<string> {
  const got = (await chrome.storage.local.get(KEY)) as Record<string, string | undefined>;
  const existing = got[KEY];
  if (existing && UUID_RE.test(existing)) return existing;
  const fresh = crypto.randomUUID();
  await chrome.storage.local.set({ [KEY]: fresh });
  return fresh;
}
```

- [ ] **Step 4: Run — verify it passes**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/chrome-extension/src/sw-session-id.ts packages/chrome-extension/tests/sw-session-id.test.ts
git add packages/chrome-extension/src/sw-session-id.ts packages/chrome-extension/tests/sw-session-id.test.ts
git commit -m "feat(chrome-extension): persist SW sessionId in chrome.storage.local"
```

---

### Task 3.3: `fetch-proxy-shared.ts` handler (Port-based, streaming)

**Files:**

- Create: `packages/chrome-extension/src/fetch-proxy-shared.ts`
- Modify: `packages/chrome-extension/package.json` (add `@slicc/shared` dependency)
- Test: `packages/chrome-extension/tests/fetch-proxy-shared.test.ts`

- [ ] **Step 1: Add `@slicc/shared` to chrome-extension deps**

```diff
   "devDependencies": { ... },
+  "dependencies": {
+    "@slicc/shared": "*"
+  }
```

Run: `npm install`

- [ ] **Step 2: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleFetchProxyConnection,
  type PortLike,
  REQUEST_BODY_CAP,
} from '../src/fetch-proxy-shared.js';
import { SecretsPipeline } from '@slicc/shared';

function makePort(
  onPost: (msg: unknown) => void
): PortLike & { fireMessage(msg: unknown): void; fireDisconnect(): void } {
  const listeners: ((msg: unknown) => void)[] = [];
  const disconnectListeners: (() => void)[] = [];
  return {
    onMessage: { addListener: (fn: (msg: unknown) => void) => listeners.push(fn) },
    onDisconnect: { addListener: (fn: () => void) => disconnectListeners.push(fn) },
    postMessage: onPost,
    fireMessage: (m) => listeners.forEach((l) => l(m)),
    fireDisconnect: () => disconnectListeners.forEach((l) => l()),
  };
}

describe('handleFetchProxyConnection', () => {
  let pipeline: SecretsPipeline;
  let masked: string;

  beforeEach(async () => {
    pipeline = new SecretsPipeline({
      sessionId: 'session-fixed',
      source: {
        get: async () => undefined,
        listAll: async () => [
          { name: 'GITHUB_TOKEN', value: 'ghp_real', domains: ['api.github.com'] },
        ],
      },
    });
    await pipeline.reload();
    masked = await pipeline.maskOne('GITHUB_TOKEN', 'ghp_real');
  });

  it('streams a multi-chunk response back and ends with response-end', async () => {
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])];
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        chunks.forEach((ch) => c.enqueue(ch));
        c.close();
      },
    });
    (globalThis as any).fetch = vi.fn(
      async () => new Response(stream, { status: 200, statusText: 'OK' })
    );

    const posts: any[] = [];
    const port = makePort((m) => posts.push(m));
    handleFetchProxyConnection(port, pipeline);
    port.fireMessage({
      type: 'request',
      url: 'https://api.github.com/user',
      method: 'GET',
      headers: { authorization: `Bearer ${masked}` },
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(posts[0]).toMatchObject({ type: 'response-head', status: 200 });
    expect(posts.filter((p) => p.type === 'response-chunk').length).toBe(2);
    expect(posts[posts.length - 1]).toMatchObject({ type: 'response-end' });
  });

  it('aborts upstream fetch on port disconnect', async () => {
    const ac = new AbortController();
    (globalThis as any).fetch = vi.fn(async (_url: string, init: { signal?: AbortSignal }) => {
      init.signal!.addEventListener('abort', () => ac.abort());
      return new Promise(() => {});
    });
    const port = makePort(() => {});
    handleFetchProxyConnection(port, pipeline);
    port.fireMessage({
      type: 'request',
      url: 'https://api.github.com/x',
      method: 'GET',
      headers: {},
    });
    await new Promise((r) => setTimeout(r, 5));
    port.fireDisconnect();
    await new Promise((r) => setTimeout(r, 5));
    expect(ac.signal.aborted).toBe(true);
  });

  it('returns 413 + Payload Too Large when requestBodyTooLarge is set', async () => {
    const posts: any[] = [];
    const port = makePort((m) => posts.push(m));
    handleFetchProxyConnection(port, pipeline);
    port.fireMessage({
      type: 'request',
      url: 'https://api.github.com/x',
      method: 'POST',
      headers: {},
      requestBodyTooLarge: true,
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(posts[0]).toMatchObject({
      type: 'response-head',
      status: 413,
      statusText: 'Payload Too Large',
    });
    expect(posts[1]).toMatchObject({ type: 'response-end' });
  });

  it('forbidden domain returns response-error', async () => {
    (globalThis as any).fetch = vi.fn();
    const posts: any[] = [];
    const port = makePort((m) => posts.push(m));
    handleFetchProxyConnection(port, pipeline);
    port.fireMessage({
      type: 'request',
      url: 'https://evil.example.com/',
      method: 'GET',
      headers: { authorization: `Bearer ${masked}` },
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(posts.find((p) => p.type === 'response-error')).toBeDefined();
  });

  it('the real value never appears in any posted message', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('hello world'));
        c.close();
      },
    });
    (globalThis as any).fetch = vi.fn(
      async () => new Response(stream, { status: 200, statusText: 'OK' })
    );
    const posts: any[] = [];
    const port = makePort((m) => posts.push(m));
    handleFetchProxyConnection(port, pipeline);
    port.fireMessage({
      type: 'request',
      url: 'https://api.github.com/user',
      method: 'GET',
      headers: { authorization: `Bearer ${masked}` },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(JSON.stringify(posts)).not.toContain('ghp_real');
  });
});
```

- [ ] **Step 3: Run — verify it fails**

Expected: FAIL.

- [ ] **Step 4: Implement**

`packages/chrome-extension/src/fetch-proxy-shared.ts`:

```ts
import { SecretsPipeline } from '@slicc/shared';

export const REQUEST_BODY_CAP = 32 * 1024 * 1024;

export interface PortLike {
  onMessage: { addListener: (fn: (msg: unknown) => void) => void };
  onDisconnect: { addListener: (fn: () => void) => void };
  postMessage: (msg: unknown) => void;
}

interface RequestMsg {
  type: 'request';
  url: string;
  method: string;
  headers: Record<string, string>;
  bodyBase64?: string;
  requestBodyTooLarge?: boolean;
}

function decodeBase64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function encodeBase64Bytes(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function handleFetchProxyConnection(port: PortLike, pipeline: SecretsPipeline): void {
  const ac = new AbortController();
  let started = false;

  port.onDisconnect.addListener(() => ac.abort());

  port.onMessage.addListener(async (raw) => {
    if (started) return;
    started = true;
    const msg = raw as RequestMsg;
    if (msg.type !== 'request') return;

    if (msg.requestBodyTooLarge) {
      port.postMessage({
        type: 'response-head',
        status: 413,
        statusText: 'Payload Too Large',
        headers: {},
      });
      port.postMessage({ type: 'response-end' });
      return;
    }

    try {
      const credsResult = pipeline.extractAndUnmaskUrlCredentials(msg.url);
      if (credsResult.forbidden) {
        port.postMessage({
          type: 'response-error',
          error: `forbidden: ${credsResult.forbidden.secretName} on ${credsResult.forbidden.hostname}`,
        });
        return;
      }
      const cleanedUrl = credsResult.url;
      const host = new URL(cleanedUrl).host;

      const headers: Record<string, string> = { ...msg.headers };
      const headersResult = pipeline.unmaskHeaders(headers, host);
      if (headersResult.forbidden) {
        port.postMessage({
          type: 'response-error',
          error: `forbidden: ${headersResult.forbidden.secretName} on ${headersResult.forbidden.hostname}`,
        });
        return;
      }
      if (credsResult.syntheticAuthorization && !('authorization' in headers)) {
        headers.authorization = credsResult.syntheticAuthorization;
      }

      let body: Uint8Array | undefined;
      if (msg.bodyBase64) {
        const raw = decodeBase64Bytes(msg.bodyBase64);
        body = pipeline.unmaskBodyBytes(raw, host).bytes;
      }

      const upstream = await fetch(cleanedUrl, {
        method: msg.method,
        headers,
        body,
        signal: ac.signal,
      });
      const respHeaders = pipeline.scrubHeaders(upstream.headers);
      port.postMessage({
        type: 'response-head',
        status: upstream.status,
        statusText: upstream.statusText,
        headers: respHeaders,
      });

      if (upstream.body) {
        const reader = upstream.body.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          // Byte-safe scrub — no TextDecoder round-trip, so binary chunks
          // (git packfiles, ZIPs, images) survive intact. Chunk-boundary
          // scrub limitation matches CLI behavior: a coincidental real-value
          // straddling a chunk boundary leaks through. v2: carry-over window.
          const scrubbed = pipeline.scrubResponseBytes(value);
          port.postMessage({ type: 'response-chunk', dataBase64: encodeBase64Bytes(scrubbed) });
        }
      }
      port.postMessage({ type: 'response-end' });
    } catch (err) {
      port.postMessage({
        type: 'response-error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
```

- [ ] **Step 5: Run — verify it passes**

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npx prettier --write packages/chrome-extension/src/fetch-proxy-shared.ts packages/chrome-extension/package.json packages/chrome-extension/tests/fetch-proxy-shared.test.ts
git add packages/chrome-extension/src/fetch-proxy-shared.ts packages/chrome-extension/package.json packages/chrome-extension/tests/fetch-proxy-shared.test.ts package-lock.json
git commit -m "feat(chrome-extension): fetch-proxy-shared handler with Port-based streaming"
```

---

### Task 3.4: Wire SW `onConnect` registration + `secrets.list-masked-entries` + `secrets.mask-oauth-token`

**Files:**

- Modify: `packages/chrome-extension/src/service-worker.ts`
- Test: `packages/chrome-extension/tests/service-worker.test.ts`

- [ ] **Step 1: Write the failing test** (registers handler for `fetch-proxy.fetch`)

```ts
import { describe, it, expect, vi } from 'vitest';

describe('service-worker fetch-proxy.fetch connect handler', () => {
  it('registers a handler for port name "fetch-proxy.fetch"', async () => {
    const listeners: ((port: any) => void)[] = [];
    (globalThis as any).chrome = {
      ...((globalThis as any).chrome || {}),
      runtime: {
        ...((globalThis as any).chrome?.runtime || {}),
        onConnect: { addListener: (fn: (port: any) => void) => listeners.push(fn) },
      },
    };
    await import('../src/service-worker.js');
    const fakePort: any = {
      name: 'fetch-proxy.fetch',
      onMessage: { addListener: vi.fn() },
      onDisconnect: { addListener: vi.fn() },
      postMessage: vi.fn(),
    };
    expect(listeners.length).toBeGreaterThan(0);
    listeners.forEach((l) => l(fakePort));
    expect(fakePort.onMessage.addListener).toHaveBeenCalled();
  });
});
```

Also tests for the new message handlers `secrets.list-masked-entries` and `secrets.mask-oauth-token` (Phase 4 needs the latter; bundle into this task since it's the same surface):

```ts
it('secrets.list-masked-entries returns {name, maskedValue, domains}[] with SW sessionId', async () => {
  // mock chrome.storage.local with one GITHUB_TOKEN entry
  // dispatch via chrome.runtime.onMessage listener
  // assert response shape, and maskedValue matches mask(swSessionId, name, value)
});
```

- [ ] **Step 2: Run — verify it fails**

Expected: FAIL.

- [ ] **Step 3: Implement**

In `packages/chrome-extension/src/service-worker.ts`, near the existing mount handler registration, add:

```ts
import { handleFetchProxyConnection } from './fetch-proxy-shared.js';
import { listSecretsWithValues } from './secrets-storage.js';
import { readOrCreateSwSessionId } from './sw-session-id.js';
import { SecretsPipeline, type FetchProxySecretSource } from '@slicc/shared';

async function buildPipeline(): Promise<SecretsPipeline> {
  const sessionId = await readOrCreateSwSessionId();
  const source: FetchProxySecretSource = {
    get: async (name) => {
      const got = (await chrome.storage.local.get(name)) as Record<string, string | undefined>;
      return got[name];
    },
    listAll: () => listSecretsWithValues(),
  };
  return new SecretsPipeline({ sessionId, source });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'fetch-proxy.fetch') return;
  buildPipeline().then(async (pipeline) => {
    await pipeline.reload();
    handleFetchProxyConnection(port as any, pipeline);
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'secrets.list-masked-entries') {
    (async () => {
      const pipeline = await buildPipeline();
      await pipeline.reload();
      const entries = pipeline.getMaskedEntries(); // {name, maskedValue, domains}
      sendResponse({ entries });
    })();
    return true;
  }
  if (msg?.type === 'secrets.mask-oauth-token') {
    (async () => {
      const pipeline = await buildPipeline();
      await pipeline.reload();
      const name = `oauth.${msg.providerId}.token`;
      const found = pipeline.getMaskedEntries().find((e) => e.name === name);
      sendResponse({ maskedValue: found?.maskedValue });
    })();
    return true;
  }
  // ... existing handlers (do not remove)
});
```

- [ ] **Step 4: Run — verify it passes**

Expected: PASS.

- [ ] **Step 5: Build the extension** (catches IIFE bundling issues with `@slicc/shared`)

Run: `npm run build -w @slicc/chrome-extension`
Expected: clean build. If the SW IIFE can't resolve `@slicc/shared`, the vite/esbuild SW config in `packages/chrome-extension/vite.config.ts` may need to inline the dep. Verify the bundled SW contains the masking + pipeline code (grep the output for `maskedToSecret` or similar internal symbols).

- [ ] **Step 6: Commit**

```bash
npx prettier --write packages/chrome-extension/src/service-worker.ts packages/chrome-extension/tests/service-worker.test.ts
git add packages/chrome-extension/src/service-worker.ts packages/chrome-extension/tests/service-worker.test.ts
git commit -m "feat(chrome-extension/sw): fetch-proxy.fetch + secrets.list-masked-entries + mask-oauth-token"
```

---

### Task 3.5: Update `createProxiedFetch()` extension branch

**Files:**

- Modify: `packages/webapp/src/shell/proxied-fetch.ts`
- Test: `packages/webapp/tests/shell/proxied-fetch.test.ts` (extend or create)

Replace the existing extension branch (`fetch(url, ...)` with `host_permissions`) with a Port-based call. CLI branch unchanged.

- [ ] **Step 1: Read the current file end-to-end**

Run: `cat packages/webapp/src/shell/proxied-fetch.ts | head -200`. Note the exact `SecureFetch` type signature (from `just-bash`), the return shape (`{ status, statusText, headers, body, url }`), and the existing helpers (`headersToRecord`, `prepareRequestBody`, `readResponseBody`, `encodeForbiddenRequestHeaders`, `decodeForbiddenResponseHeaders`).

- [ ] **Step 2: Write the failing test**

`packages/webapp/tests/shell/proxied-fetch-extension.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

describe('createProxiedFetch — extension branch (Port-based)', () => {
  it('opens a Port named fetch-proxy.fetch and reconstructs a streamed response', async () => {
    const msgListeners: ((m: any) => void)[] = [];
    const discListeners: (() => void)[] = [];
    const port: any = {
      postMessage: vi.fn(),
      disconnect: vi.fn(),
      onMessage: { addListener: (fn: any) => msgListeners.push(fn) },
      onDisconnect: { addListener: (fn: any) => discListeners.push(fn) },
    };
    (globalThis as any).chrome = { runtime: { connect: vi.fn(() => port), id: 'test-id' } };

    const { createProxiedFetch } = await import('../../src/shell/proxied-fetch.js');
    const proxiedFetch = createProxiedFetch();

    const fetchPromise = proxiedFetch('https://api.github.com/user', {
      headers: { authorization: 'Bearer x' },
    });

    msgListeners.forEach((l) =>
      l({
        type: 'response-head',
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
      })
    );
    msgListeners.forEach((l) => l({ type: 'response-chunk', dataBase64: btoa('hello ') }));
    msgListeners.forEach((l) => l({ type: 'response-chunk', dataBase64: btoa('world') }));
    msgListeners.forEach((l) => l({ type: 'response-end' }));

    const resp = await fetchPromise;
    expect(resp.status).toBe(200);
    expect(resp.body).toBe('hello world');
    expect((globalThis as any).chrome.runtime.connect).toHaveBeenCalledWith({
      name: 'fetch-proxy.fetch',
    });
  });
});
```

- [ ] **Step 3: Run — verify it fails**

Run: `npx vitest run packages/webapp/tests/shell/proxied-fetch-extension.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement**

In `packages/webapp/src/shell/proxied-fetch.ts`, replace the extension branch (today: direct `fetch`):

```ts
import type { SecureFetch } from 'just-bash';

const REQUEST_BODY_CAP = 32 * 1024 * 1024;

async function extensionPortFetch(
  url: string,
  options?: Parameters<SecureFetch>[1]
): ReturnType<SecureFetch> {
  const port = chrome.runtime.connect({ name: 'fetch-proxy.fetch' });
  const plainHeaders = headersToRecord(options?.headers);
  const method = options?.method ?? 'GET';
  const preparedBody = options?.body ? prepareRequestBody(options.body, plainHeaders) : undefined;

  // Encode body to base64 if present
  let bodyBase64: string | undefined;
  let requestBodyTooLarge = false;
  if (preparedBody !== undefined) {
    const bodyBytes =
      preparedBody instanceof Uint8Array
        ? preparedBody
        : new Uint8Array(await new Response(preparedBody as BodyInit).arrayBuffer());
    if (bodyBytes.byteLength > REQUEST_BODY_CAP) {
      requestBodyTooLarge = true;
    } else {
      let bin = '';
      for (let i = 0; i < bodyBytes.length; i++) bin += String.fromCharCode(bodyBytes[i]);
      bodyBase64 = btoa(bin);
    }
  }

  return new Promise((resolve, reject) => {
    let headInfo: { status: number; statusText: string; headers: Record<string, string> } | null =
      null;
    const chunks: Uint8Array[] = [];

    port.onMessage.addListener((msg: any) => {
      if (msg.type === 'response-head') {
        headInfo = msg;
      } else if (msg.type === 'response-chunk') {
        const bin = atob(msg.dataBase64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        chunks.push(out);
      } else if (msg.type === 'response-end') {
        if (!headInfo) {
          reject(new Error('fetch-proxy: response-end before response-head'));
          return;
        }
        const totalLen = chunks.reduce((n, c) => n + c.length, 0);
        const merged = new Uint8Array(totalLen);
        let off = 0;
        for (const c of chunks) {
          merged.set(c, off);
          off += c.length;
        }
        // Build a synthetic Response so the existing readResponseBody helper
        // decides text vs binary (and routes binary through binary-cache.ts).
        // This preserves git-http's binary packfile path identically to today.
        const respHeaders = new Headers();
        for (const [k, v] of Object.entries(headInfo.headers)) respHeaders.set(k, String(v));
        const synth = new Response(merged, {
          status: headInfo.status,
          statusText: headInfo.statusText,
          headers: respHeaders,
        });
        readResponseBody(synth, url)
          .then((body) => {
            resolve({
              status: headInfo!.status,
              statusText: headInfo!.statusText,
              headers: headInfo!.headers,
              body,
              url,
            });
          })
          .catch(reject);
        port.disconnect();
      } else if (msg.type === 'response-error') {
        reject(new Error(msg.error));
        port.disconnect();
      }
    });
    port.onDisconnect.addListener(() => {
      if (!headInfo) reject(new Error('fetch-proxy port disconnected before response'));
    });

    port.postMessage({
      type: 'request',
      url,
      method,
      headers: plainHeaders,
      bodyBase64,
      requestBodyTooLarge,
    });
  });
}

export function createProxiedFetch(): SecureFetch {
  const isExtension = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;
  if (isExtension) {
    return extensionPortFetch;
  }
  // existing CLI branch (route through /api/fetch-proxy) — unchanged.
  return async (url, options) => {
    /* ... existing CLI code ... */
  };
}
```

This returns a string body (matching the existing `SecureFetch` contract, which is `{ body: string }`). For binary responses, the existing path through `binary-cache.ts` handles it — verify the cache still gets hit (the SW returns text-decoded bytes; binary cache lookups in `vfs-adapter.ts:102` happen before this layer, so they're orthogonal). If the binary path breaks, the SW handler needs to send the raw bytes back and `createProxiedFetch` extension branch needs to detect binary content-types and route via `binary-cache.ts`. Check `readResponseBody` in the existing file for the binary heuristic.

- [ ] **Step 5: Run — verify it passes**

Run: `npx vitest run packages/webapp/tests/shell/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npx prettier --write packages/webapp/src/shell/proxied-fetch.ts packages/webapp/tests/shell/proxied-fetch-extension.test.ts
git add packages/webapp/src/shell/proxied-fetch.ts packages/webapp/tests/shell/proxied-fetch-extension.test.ts
git commit -m "feat(webapp/shell): createProxiedFetch extension branch uses Port-based streaming"
```

---

### Task 3.6: Migrate `git-http.ts` to `createProxiedFetch()` in both branches

**Files:**

- Modify: `packages/webapp/src/git/git-http.ts` (extension branch line ~51; CLI branch line ~70)
- Test: `packages/webapp/tests/git/git-http.test.ts` (extend)

Today both branches hand-roll fetch logic. Replace with a single call to `createProxiedFetch()` and bridge its response to isomorphic-git's contract.

- [ ] **Step 1: Write the failing test**

Append a test asserting that in extension mode, `git-http`'s fetch path triggers a `chrome.runtime.connect({ name: 'fetch-proxy.fetch' })`. Use the same mock pattern as Task 3.5.

- [ ] **Step 2: Run — verify it fails**

Expected: FAIL.

- [ ] **Step 3: Refactor `git-http.ts`**

Replace both branches with:

```ts
import { createProxiedFetch } from '../shell/proxied-fetch.js';

const proxiedFetch = createProxiedFetch();
// ... in the http plugin's request handler:
const resp = await proxiedFetch(url, { method, headers, body: fetchBody });
// resp shape: { status, statusText, headers, body, url } — body is a string.
// isomorphic-git wants AsyncIterableIterator<Uint8Array>; build a single-chunk iter.
async function* singleChunk(text: string): AsyncIterableIterator<Uint8Array> {
  yield new TextEncoder().encode(text);
}
return {
  url: resp.url,
  method,
  statusCode: resp.status,
  statusMessage: resp.statusText,
  body: singleChunk(resp.body),
  headers: resp.headers,
};
```

Note: in v1 the response body is buffered as a string in `createProxiedFetch` and re-yielded as a single chunk to isomorphic-git. This is the same semantic as today's CLI branch (which also buffers via `readResponseBody`). True streaming through to isomorphic-git is a v2 follow-up. **Binary content-type handling**: `git-http` exchanges packfiles which are binary. The existing `readResponseBody` + `binary-cache.ts` path handles this. If `createProxiedFetch` extension branch can't faithfully reproduce that path, escalate: either (a) bridge into binary-cache from the new branch, or (b) reject this task's text-decoding shortcut and have the SW post raw bytes that flow through unchanged. **Verify with the failing git-push integration test BEFORE merging Phase 3.**

- [ ] **Step 4: Run — verify it passes**

Run: `npx vitest run packages/webapp/tests/git/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/webapp/src/git/git-http.ts packages/webapp/tests/git/git-http.test.ts
git add packages/webapp/src/git/git-http.ts packages/webapp/tests/git/git-http.test.ts
git commit -m "refactor(webapp/git): git-http routes through createProxiedFetch"
```

---

### Task 3.7: Bash-env population in extension via `secrets.list-masked-entries`

**Files:**

- Modify: the offscreen-side scoop init that builds the WasmShell env (find via `grep -rn "fetchSecretEnvVars\|SecretEnvVars" packages/`)
- Test: add an offscreen-side env test

The SW handler was added in Task 3.4. This task wires the offscreen-side caller.

- [ ] **Step 1: Locate the CLI bash-env population code**

Run: `grep -rn "fetchSecretEnvVars\|/api/secrets/masked\|setEnv.*SECRET" packages/webapp/src/`. Identify the function that, in CLI mode, fetches masked env vars and populates the WasmShell env at scoop init.

- [ ] **Step 2: Write the failing test**

Test: in extension mode, the equivalent scoop-init code path sends `chrome.runtime.sendMessage({ type: 'secrets.list-masked-entries' })` and populates `env[name] = maskedValue` for each entry.

- [ ] **Step 3: Run — verify it fails**

Expected: FAIL.

- [ ] **Step 4: Implement**

Add an extension branch alongside the CLI branch:

```ts
async function fetchExtensionSecretEnvVars(): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: 'secrets.list-masked-entries' },
      (resp: { entries?: { name: string; maskedValue: string }[] }) => {
        const env: Record<string, string> = {};
        for (const e of resp?.entries ?? []) env[e.name] = e.maskedValue;
        resolve(env);
      }
    );
  });
}
```

Wire it into the scoop init alongside the CLI variant.

- [ ] **Step 5: Run — verify it passes**

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npx prettier --write <touched files>
git add <touched files>
git commit -m "feat(chrome-extension): bash env populated via SW secrets.list-masked-entries"
```

---

### Task 3.8: Phase 3 gate

```bash
npm run typecheck
npm run test
npm run build
npm run build -w @slicc/chrome-extension
```

Expected: all green.

---

## Phase 4: OAuth masking + dual-storage sync

Spec: §"Phase 4: OAuth masking + dual-storage sync".

**Phase 4 depends on Phase 2** (Basic-auth-aware unmask) — the auto-write of `/workspace/.git/github-token` produces a working `git push` only because Phase 2 decodes the Basic header. Land Phase 2 first.

**Known v1 limitation (document, do not fix):** if a user restarts node-server while the SLICC tab stays open, the in-memory `OauthSecretStore` is empty until bootstrap fires (next page load). OAuth-bearing requests 403 with a clear error until reload. Extension SW is unaffected (`chrome.storage.local` persists across SW cold start). This is the spec's documented asymmetry — keep the error message clear so users know to reload; don't paper over with retries.

---

### Task 4.1: Add `oauthTokenDomains` to `ProviderConfig` + set on providers

**Files:**

- Modify: `packages/webapp/src/providers/types.ts`
- Modify: `packages/webapp/providers/github.ts`
- Modify: `packages/webapp/providers/adobe.ts`
- Test: `packages/webapp/tests/providers/oauth-config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import githubProvider from '../../providers/github.js';
import adobeProvider from '../../providers/adobe.js';

describe('OAuth provider domain config', () => {
  it('github provider has bare github.com (for git push)', () => {
    expect(githubProvider.oauthTokenDomains).toContain('github.com');
    expect(githubProvider.oauthTokenDomains).toContain('api.github.com');
    expect(githubProvider.oauthTokenDomains).toContain('*.github.com');
  });
  it('adobe provider has IMS hosts', () => {
    expect(adobeProvider.oauthTokenDomains?.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run — verify it fails**

Expected: FAIL.

- [ ] **Step 3: Implement**

In `packages/webapp/src/providers/types.ts` add `oauthTokenDomains?: string[]` to `ProviderConfig`.

In `packages/webapp/providers/github.ts` set:

```ts
oauthTokenDomains: ['github.com', '*.github.com', 'api.github.com', 'raw.githubusercontent.com', 'models.github.ai'],
```

In `packages/webapp/providers/adobe.ts` set the IMS hosts + LLM proxy host (verify against existing fetch URLs).

- [ ] **Step 4: Run — verify it passes**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/webapp/src/providers/types.ts packages/webapp/providers/github.ts packages/webapp/providers/adobe.ts packages/webapp/tests/providers/oauth-config.test.ts
git add packages/webapp/src/providers/types.ts packages/webapp/providers/github.ts packages/webapp/providers/adobe.ts packages/webapp/tests/providers/oauth-config.test.ts
git commit -m "feat(webapp/providers): oauthTokenDomains on github + adobe"
```

---

### Task 4.2: `OauthSecretStore` (node-server)

**Files:**

- Create: `packages/node-server/src/secrets/oauth-secret-store.ts`
- Test: `packages/node-server/tests/secrets/oauth-secret-store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { OauthSecretStore } from '../../src/secrets/oauth-secret-store.js';

describe('OauthSecretStore', () => {
  it('set then list returns the entry', () => {
    const store = new OauthSecretStore();
    store.set('oauth.github.token', 'ghp_real', ['github.com']);
    expect(store.list()).toEqual([
      { name: 'oauth.github.token', value: 'ghp_real', domains: ['github.com'] },
    ]);
  });
  it('delete removes the entry', () => {
    const store = new OauthSecretStore();
    store.set('A', '1', ['x.com']);
    store.delete('A');
    expect(store.list()).toEqual([]);
  });
  it('rejects empty domains', () => {
    const store = new OauthSecretStore();
    expect(() => store.set('A', '1', [])).toThrow();
  });
});
```

- [ ] **Step 2: Run — verify it fails**

Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// packages/node-server/src/secrets/oauth-secret-store.ts
export interface OauthEntry {
  name: string;
  value: string;
  domains: string[];
}

export class OauthSecretStore {
  private entries = new Map<string, OauthEntry>();
  set(name: string, value: string, domains: string[]): void {
    if (!Array.isArray(domains) || domains.length === 0) {
      throw new Error('OauthSecretStore: domains must be non-empty');
    }
    this.entries.set(name, { name, value, domains });
  }
  delete(name: string): void {
    this.entries.delete(name);
  }
  list(): OauthEntry[] {
    return Array.from(this.entries.values());
  }
  get(name: string): string | undefined {
    return this.entries.get(name)?.value;
  }
}
```

- [ ] **Step 4: Run — verify it passes**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/node-server/src/secrets/oauth-secret-store.ts packages/node-server/tests/secrets/oauth-secret-store.test.ts
git add packages/node-server/src/secrets/oauth-secret-store.ts packages/node-server/tests/secrets/oauth-secret-store.test.ts
git commit -m "feat(node-server/secrets): OauthSecretStore in-memory writable"
```

---

### Task 4.3: Chain `OauthSecretStore` into `SecretProxyManager` (constructor stays positional)

**Files:**

- Modify: `packages/node-server/src/secrets/proxy-manager.ts`
- Test: extend `packages/node-server/tests/secrets/proxy-manager.test.ts`

**Constraint:** `SecretProxyManager(store?, sessionId?)` positional signature stays unchanged. Adding the OAuth store requires either:

- (a) Adding a third positional parameter `(store?, sessionId?, oauthStore?)`
- (b) Exposing a setter / chain method post-construction

Pick (a) for explicit construction at the single `index.ts` call site. All other call sites (tests) pass it as `undefined` (positional skip).

- [ ] **Step 1: Write the failing test**

```ts
it('unmasks a token sourced from OauthSecretStore', async () => {
  const oauthStore = new OauthSecretStore();
  oauthStore.set('oauth.github.token', 'ghp_real', ['api.github.com']);
  const proxy = new SecretProxyManager(undefined, 'fixed-session', oauthStore);
  await proxy.reload();
  const entry = proxy.getMaskedEntries().find((e) => e.name === 'oauth.github.token')!;
  const headers: Record<string, string> = { authorization: `Bearer ${entry.maskedValue}` };
  const r = proxy.unmaskHeaders(headers, 'api.github.com');
  expect(r.forbidden).toBeUndefined();
  expect(headers.authorization).toBe('Bearer ghp_real');
});

it('SetOauthStore allows late binding for index.ts wiring', async () => {
  const proxy = new SecretProxyManager(undefined, 'fixed-session');
  const store = new OauthSecretStore();
  store.set('oauth.x.token', 'real_x', ['api.x.com']);
  proxy.setOauthStore(store);
  await proxy.reload();
  expect(proxy.getMaskedEntries().some((e) => e.name === 'oauth.x.token')).toBe(true);
});
```

- [ ] **Step 2: Run — verify it fails**

Expected: FAIL.

- [ ] **Step 3: Implement**

Update `SecretProxyManager`:

```ts
constructor(store?: EnvSecretStore, sessionId?: string, oauthStore?: OauthSecretStore) {
  // ...
  this._oauthStore = oauthStore;
  this.pipeline = new SecretsPipeline({ sessionId: this._sessionId, source: this.buildSource() });
}

private _oauthStore?: OauthSecretStore;

setOauthStore(store: OauthSecretStore): void {
  this._oauthStore = store;
  // Pipeline holds source by reference; rebuild not needed if source closures
  // delegate via the captured `this`. Otherwise, re-construct pipeline here.
}

private buildSource(): FetchProxySecretSource {
  const env = this._envStore;
  const oauth = () => this._oauthStore;
  return {
    get: async (name) => {
      const fromOauth = oauth()?.get(name);
      if (fromOauth !== undefined) return fromOauth;
      return env?.get(name);
    },
    listAll: async () => {
      const list: { name: string; value: string; domains: string[] }[] = [];
      // Oauth wins on name collision per spec's reserved-namespace decision
      const oauthList = oauth()?.list() ?? [];
      const oauthNames = new Set(oauthList.map((e) => e.name));
      for (const e of oauthList) list.push({ name: e.name, value: e.value, domains: e.domains });
      const envList = env?.list() ?? [];
      for (const e of envList) {
        if (oauthNames.has(e.name)) continue; // oauth wins
        list.push({ name: e.name, value: e.value, domains: e.domains });
      }
      return list;
    },
  };
}
```

The function-closure approach (`oauth()` re-evaluates) avoids needing to rebuild the pipeline when `setOauthStore` is called — the source closure picks up the new store on the next `reload()`.

- [ ] **Step 4: Run — verify it passes**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/node-server/src/secrets/proxy-manager.ts packages/node-server/tests/secrets/proxy-manager.test.ts
git add packages/node-server/src/secrets/proxy-manager.ts packages/node-server/tests/secrets/proxy-manager.test.ts
git commit -m "feat(node-server/secrets): chain OauthSecretStore into proxy-manager"
```

---

### Task 4.4: `POST /api/secrets/oauth-update` + `DELETE /api/secrets/oauth/:providerId`

**Files:**

- Modify: `packages/node-server/src/index.ts`
- Test: `packages/node-server/tests/secrets/oauth-endpoints.test.ts`

- [ ] **Step 1: Write the failing test**

Cover: POST happy path; POST rejects missing `domains`; POST rejects malformed JSON; DELETE happy path; DELETE 404 on unknown provider.

- [ ] **Step 2: Run — verify it fails**

Expected: FAIL.

- [ ] **Step 3: Implement endpoints in `index.ts`**

```ts
app.post('/api/secrets/oauth-update', express.json(), async (req, res) => {
  const { providerId, accessToken, domains } = req.body ?? {};
  if (
    typeof providerId !== 'string' ||
    typeof accessToken !== 'string' ||
    !Array.isArray(domains) ||
    domains.length === 0
  ) {
    return res.status(400).json({ error: 'bad-request' });
  }
  const name = `oauth.${providerId}.token`;
  oauthStore.set(name, accessToken, domains);
  await proxyManager.reload();
  const masked = proxyManager.getMaskedEntries().find((e) => e.name === name)?.maskedValue;
  res.json({ providerId, name, maskedValue: masked, domains });
});

app.delete('/api/secrets/oauth/:providerId', async (req, res) => {
  const name = `oauth.${req.params.providerId}.token`;
  if (!oauthStore.list().some((e) => e.name === name)) {
    return res.status(404).json({ error: 'not-found' });
  }
  oauthStore.delete(name);
  await proxyManager.reload();
  res.status(204).end();
});
```

Also: at startup, construct `oauthStore = new OauthSecretStore()` and pass it as the third positional arg to `new SecretProxyManager(envStore, sessionId, oauthStore)`. Or use `proxyManager.setOauthStore(oauthStore)` after construction — pick one and stay consistent.

- [ ] **Step 4: Run — verify it passes**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/node-server/src/index.ts packages/node-server/tests/secrets/oauth-endpoints.test.ts
git add packages/node-server/src/index.ts packages/node-server/tests/secrets/oauth-endpoints.test.ts
git commit -m "feat(node-server/api): POST /api/secrets/oauth-update + DELETE"
```

---

### Task 4.5: `saveOAuthAccount` becomes async + sync hook; `removeAccount` async; `clearAllSettings` async

**Files:**

- Modify: `packages/webapp/src/ui/provider-settings.ts` (`saveOAuthAccount` line 430, `removeAccount` line 413, `clearAllSettings` line 627)
- Modify: callers of `saveOAuthAccount`: `packages/webapp/providers/github.ts` (517, 549), `packages/webapp/providers/adobe.ts` (356, 406, 528)
- Modify: callers of `removeAccount`: `packages/webapp/src/ui/provider-settings.ts` (566, 912, 1100)
- Modify: callers of `clearAllSettings`: `packages/webapp/src/ui/layout.ts` (715, 749)
- Modify: tests at `packages/webapp/tests/ui/provider-settings.test.ts` (340, 353, 456, 470 — they call `clearAllSettings` synchronously)
- Modify: `Account` interface — add `maskedValue?: string`
- Test: `packages/webapp/tests/providers/oauth-sync.test.ts`

The async migration is mechanical but wide; **every caller listed above needs `await` or chained `.then`**. Tests that wrap synchronous calls in `act(() => ...)` or similar must adapt.

- [ ] **Step 1: Write the failing test**

Mock `fetch` to capture POST `/api/secrets/oauth-update` and stub the response with a fixed `maskedValue`. Assert: after `await saveOAuthAccount({providerId: 'github', accessToken: 'ghp_x', tokenType: 'Bearer'})`, the `Account` stored in localStorage has `maskedValue` set.

- [ ] **Step 2: Run — verify it fails**

Expected: FAIL.

- [ ] **Step 3: Implement**

In `provider-settings.ts`:

- Add `maskedValue?: string` to `Account`.
- Change `saveOAuthAccount(opts): void` → `async (opts): Promise<void>`.
- Change `removeAccount(providerId: string): void` → `async (providerId): Promise<void>`.
- Change `clearAllSettings(): void` → `async (): Promise<void>` (iterates accounts with `await`).

Inside `saveOAuthAccount`:

- CLI: `POST /api/secrets/oauth-update {providerId, accessToken, domains: cfg.oauthTokenDomains}` → cache `maskedValue`.
- Extension: `chrome.storage.local.set({['oauth.<id>.token']: accessToken, ['oauth.<id>.token_DOMAINS']: domains.join(',')})` → `chrome.runtime.sendMessage('secrets.mask-oauth-token', {providerId})` → cache.
- Sync errors logged, non-blocking.

Inside `removeAccount`:

- CLI: `DELETE /api/secrets/oauth/:providerId`.
- Extension: `chrome.storage.local.remove(['oauth.<id>.token', 'oauth.<id>.token_DOMAINS'])`.

**Update every listed call site to `await`:**

- `github.ts:517, 549` — `await saveOAuthAccount(...)`.
- `adobe.ts:356, 406, 528` — `await saveOAuthAccount(...)`.
- `provider-settings.ts:566, 912, 1100` — `await removeAccount(...)`.
- `layout.ts:715` — the "Clear all accounts" handler is currently `clearAllBtn.addEventListener('click', () => { clearAllSettings(); … })` (**sync arrow**). Convert to `async () => { await clearAllSettings(); … }`. (The other call at `layout.ts:749` is already inside `async () => { … if (!getApiKey()) clearAllSettings(); … }` — change to `await clearAllSettings();`.)
- Tests `provider-settings.test.ts:353, 470` — the `it(...)` callbacks become `async`; wrap calls in `await`.

For `clearAllSettings`: iterate accounts with `await` so each OAuth replica is cleared before the localStorage entry is wiped:

```ts
export async function clearAllSettings(): Promise<void> {
  const accounts = getAccounts();
  for (const a of accounts) {
    await removeAccount(a.providerId);
  }
  // ... existing localStorage wipe
}
```

- [ ] **Step 4: Run — verify all relevant tests pass**

Run: `npx vitest run packages/webapp/tests/providers/ packages/webapp/tests/ui/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/webapp/src/ui/provider-settings.ts packages/webapp/src/ui/layout.ts packages/webapp/providers/github.ts packages/webapp/providers/adobe.ts packages/webapp/tests/providers/oauth-sync.test.ts packages/webapp/tests/ui/provider-settings.test.ts
git add packages/webapp/src/ui/provider-settings.ts packages/webapp/src/ui/layout.ts packages/webapp/providers/github.ts packages/webapp/providers/adobe.ts packages/webapp/tests/providers/oauth-sync.test.ts packages/webapp/tests/ui/provider-settings.test.ts
git commit -m "feat(webapp/providers): saveOAuthAccount/removeAccount/clearAllSettings async + dual-storage sync"
```

---

### Task 4.6: `oauth-token` returns masked

**Files:**

- Modify: `packages/webapp/src/shell/supplemental-commands/oauth-token-command.ts`
- Test: `packages/webapp/tests/shell/oauth-token-command.test.ts`

- [ ] **Step 1: Write the failing test**

Mock the Account store with a known `maskedValue`. Run `oauth-token github`. Assert stdout is the masked value. Crucially: assert the real `accessToken` value never appears in stdout.

- [ ] **Step 2: Run — verify it fails**

Expected: FAIL (today prints `info.token`, the real token).

- [ ] **Step 3: Implement**

Read `getOAuthAccountInfo(providerId)?.maskedValue` instead of `?.token`. If `maskedValue` is missing or `--scope` was passed: force a fresh `saveOAuthAccount` round-trip (may trigger OAuth popup if `--scope` set), then read the cached masked.

- [ ] **Step 4: Run — verify it passes**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/webapp/src/shell/supplemental-commands/oauth-token-command.ts packages/webapp/tests/shell/oauth-token-command.test.ts
git add packages/webapp/src/shell/supplemental-commands/oauth-token-command.ts packages/webapp/tests/shell/oauth-token-command.test.ts
git commit -m "feat(shell/oauth-token): return masked Bearer; never the real token"
```

---

### Task 4.7: `github.ts` writes the masked token to `/workspace/.git/github-token`

**Files:**

- Modify: `packages/webapp/providers/github.ts` (line 525)
- Test: extend `packages/webapp/tests/providers/oauth-sync.test.ts`

- [ ] **Step 1: Write the failing test**

Assert: after a successful GitHub OAuth login, `/workspace/.git/github-token` (via VFS mock) contains the **masked** token, not the real token.

- [ ] **Step 2: Run — verify it fails**

Expected: FAIL.

- [ ] **Step 3: Implement**

After the awaited `saveOAuthAccount(...)` in `github.ts:517`:

```ts
const masked = getOAuthAccountInfo('github')?.maskedValue;
if (masked) {
  await writeGitToken(masked);
} else {
  await clearGitToken();
}
```

Never fall back to writing the real token if `maskedValue` is missing.

- [ ] **Step 4: Run — verify it passes**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/webapp/providers/github.ts packages/webapp/tests/providers/oauth-sync.test.ts
git add packages/webapp/providers/github.ts packages/webapp/tests/providers/oauth-sync.test.ts
git commit -m "feat(providers/github): write masked token to /workspace/.git/github-token"
```

---

### Task 4.8: Bootstrap-on-init re-push

**Files:**

- Modify: webapp init path (find via `grep -rn "main\|init" packages/webapp/src/ui/main.ts | head`). Add the bootstrap loop where `getAccounts()` is reachable on startup.
- Test: extend `oauth-sync.test.ts`

- [ ] **Step 1: Write the failing test**

Stub fresh-start: `slicc_accounts` has 2 non-expired accounts; on init, expect 2 POSTs (CLI) or 2 SW dispatches (extension); `maskedValue` re-cached.

- [ ] **Step 2: Run — verify it fails**

Expected: FAIL.

- [ ] **Step 3: Implement**

In webapp init, after `getAccounts()` is reachable, fire a bootstrap loop:

```ts
for (const a of getAccounts()) {
  if (a.expiresAt && Date.now() >= a.expiresAt) continue;
  try {
    await saveOAuthAccount({ providerId: a.providerId, accessToken: a.token /* ... */ });
  } catch (err) {
    console.error('OAuth bootstrap failed for', a.providerId, err);
  }
}
```

- [ ] **Step 4: Run — verify it passes**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/webapp/src/ui/main.ts packages/webapp/tests/providers/oauth-sync.test.ts
git add packages/webapp/src/ui/main.ts packages/webapp/tests/providers/oauth-sync.test.ts
git commit -m "feat(webapp): bootstrap-on-init re-pushes OAuth replicas"
```

---

### Task 4.9: Phase 4 gate

```bash
npm run typecheck
npm run test
npm run build
npm run build -w @slicc/chrome-extension
```

Expected: all green.

---

## Phase 5: Direct-fetch migration (extension parity)

Spec: §"Phase 5: Direct-fetch migration".

Reframing: in CLI mode, `llm-proxy-sw.ts` already intercepts cross-origin fetches transparently. `createProxiedFetch()` already wraps everything in shell commands. Phase 3 already fixed `createProxiedFetch()`'s extension branch (Task 3.5). So most direct-fetch sites in supplemental commands are ALREADY centralized via `createProxiedFetch()`. Phase 5 audits the remaining outliers.

---

### Task 5.1: Audit current `createProxiedFetch()` coverage

**Files:**

- Read-only audit

- [ ] **Step 1: Map the call sites**

Run: `grep -rn "createProxiedFetch\|fetch(" packages/webapp/src/shell/supplemental-commands/ | grep -v "test.ts" | head -40`. Classify:

- Routed through `createProxiedFetch()`: man-command, node-fetch-adapter, upskill (via `fetch:` parameter), `wasm-shell-headless.ts` curl/wget shims.
- Direct `fetch()` remaining: models-command, magick-wasm (asset-only, leave), and any others surfaced by the grep.

- [ ] **Step 2: Document findings** (no code change yet)

Write the audit results into `docs/secrets.md` Phase 6 work (Task 6.1's "Migration policy" section). For each remaining direct-fetch site decide: migrate (Tasks 5.2-5.4) or document as accepted exception.

- [ ] **Step 3: Commit (if any audit-only doc change)**

Skip if no files change in this task; it's investigative.

---

### Task 5.2: Migrate `models-command.ts:50`

**Files:**

- Modify: `packages/webapp/src/shell/supplemental-commands/models-command.ts`
- Test: `packages/webapp/tests/shell/supplemental-commands/models-command.test.ts`

- [ ] **Step 1: Write the failing test**

Assert that in extension mode, `models` triggers a `chrome.runtime.connect({ name: 'fetch-proxy.fetch' })`.

- [ ] **Step 2: Run — verify it fails**

Expected: FAIL.

- [ ] **Step 3: Replace direct `fetch(AA_API_URL, ...)` with `createProxiedFetch()(AA_API_URL, ...)`**

Use the same pattern as `man-command.ts`. If `models` runs outside a shell context (no `ctx.fetch`), import `createProxiedFetch` and instantiate at module top-level.

- [ ] **Step 4: Run — verify it passes**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/webapp/src/shell/supplemental-commands/models-command.ts packages/webapp/tests/shell/supplemental-commands/models-command.test.ts
git add packages/webapp/src/shell/supplemental-commands/models-command.ts packages/webapp/tests/shell/supplemental-commands/models-command.test.ts
git commit -m "refactor(shell/models): route through createProxiedFetch"
```

---

### Task 5.3: Verify `upskill-command.ts` end-to-end on private repos

**Files:**

- Test: `packages/webapp/tests/shell/supplemental-commands/upskill-command.test.ts`

Per spec: no fetch refactor needed; the `fetch:` parameter at `installFromClawHub` (line 674, used at 701) already routes through SecureFetch.

- [ ] **Step 1: Write the failing test**

Simulate `upskill https://github.com/me/private-skill` with a GitHub OAuth token in `slicc_accounts` with `maskedValue` set (Phase 4). Mock the proxy/SW to unmask `Authorization: Bearer <masked>` → real for `raw.githubusercontent.com` / `api.github.com`. Assert install succeeds and agent-visible stdout contains masked at most.

- [ ] **Step 2: Run — verify it fails (or passes)**

If passes immediately: integration is already correct — note and move on.

- [ ] **Step 3: If FAIL, debug**

Probable causes: missing `Authorization` header on raw.githubusercontent fetch; wrong domain in `oauthTokenDomains`; `/workspace/.git/github-token` not consumed by GitHub install path. Fix as needed.

- [ ] **Step 4: Commit (only if changes)**

```bash
npx prettier --write <touched files>
git add <touched files>
git commit -m "test(shell/upskill): private-repo install end-to-end with masked OAuth"
```

---

### Task 5.4: Migrate the kernel-realm `fetch` shim

**Files:**

- Modify: `packages/webapp/src/kernel/realm/js-realm-shared.ts` (fetch RPC ~line 148; `fsBridge.fetchToFile` ~line 134)
- Test: `packages/webapp/tests/kernel/realm-fetch.test.ts`

- [ ] **Step 1: Locate the upstream end of the realm fetch RPC**

Read `js-realm-shared.ts` end-to-end. Identify the kernel-host side that receives the realm's `fetch` request. Trace to `realm-factory.ts` and the worker/iframe transport.

- [ ] **Step 2: Write the failing test**

Test: a `.jsh` script that calls `fetch('https://api.github.com/user', { headers: { authorization: \`Bearer ${MASKED}\` } })`inside the realm should reach`createProxiedFetch()` at the kernel-host side (and thus get unmasked).

- [ ] **Step 3: Run — verify it fails**

Expected: FAIL.

- [ ] **Step 4: Replace the kernel-host's `fetch(...)` with `createProxiedFetch()(...)`**

In the file servicing the realm's fetch RPC, swap direct `fetch` for `createProxiedFetch()`. Same for `fsBridge.fetchToFile`.

- [ ] **Step 5: Run — verify it passes**

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npx prettier --write packages/webapp/src/kernel/realm/js-realm-shared.ts packages/webapp/tests/kernel/realm-fetch.test.ts
git add packages/webapp/src/kernel/realm/js-realm-shared.ts packages/webapp/tests/kernel/realm-fetch.test.ts
git commit -m "refactor(kernel/realm): realm fetch shim routes through createProxiedFetch"
```

---

### Task 5.5: Phase 5 gate

```bash
npm run typecheck
npm run test
npm run build
npm run build -w @slicc/chrome-extension
```

Expected: all green.

---

## Phase 6: Documentation

Spec: §"Phase 6: Documentation". No tests; docs only. Commit-per-file for clean history.

---

### Task 6.1: Update `docs/secrets.md`

**Files:** Modify: `docs/secrets.md`

- [ ] **Step 1: Fix the `GITHUB_TOKEN_DOMAINS` example at line 22**

Change `GITHUB_TOKEN_DOMAINS=api.github.com,*.github.com` to `GITHUB_TOKEN_DOMAINS=github.com,*.github.com,api.github.com,raw.githubusercontent.com`. Add a sentence: bare `github.com` is required because `*.github.com` does not match the bare host (per `packages/shared/src/secret-masking.ts` comment).

- [ ] **Step 2: Flip the platform-support matrix**

"Extension: Requires server backend" → "Extension: ✅ via SW fetch proxy".

- [ ] **Step 3: Add "OAuth tokens as secrets" subsection**

Explain dual-storage replica model; pre-PR `oauth-token` returned real; post-PR returns masked; refresh path; tab-open + node restart 403-until-reload asymmetry.

- [ ] **Step 4: Add `oauth.*` reserved-namespace note**

"Keys starting with `oauth.` are reserved for OAuth replicas; user-defined `.env` / `chrome.storage.local` entries with that prefix are rejected at load."

- [ ] **Step 5: Add `nuke` semantics**

"Provider credentials (OAuth tokens, API keys in `slicc_accounts`) survive `nuke` by design. Logout is the user-controlled erasure."

- [ ] **Step 6: Add `oauth-token` per-invocation approval clarification**

Pre-PR doc claim was loose — actual gate is OAuth login popup. Cached-token reuse returns masked (no approval needed, benign).

- [ ] **Step 7: Add threat-model addendum**

`.jsh` / `node -e` / `python3 -c` run in kernel-realms (DedicatedWorker / sandbox iframe) without direct `localStorage` access. Code-review discipline: new shell commands must not echo localStorage to agent output.

- [ ] **Step 8: Add the request-shape decision table**

```markdown
| Request shape                              | Goes through                                                                                                                                                                                       |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read/write to /mnt/r2/foo.txt` (VFS API)  | mount backend → `s3-sign-and-forward` (CLI) or `mount.s3-sign-and-forward` (SW); SigV4-signed                                                                                                      |
| `mount --source da://...` ops              | mount backend → `da-sign-and-forward`; IMS bearer attached server/SW-side                                                                                                                          |
| `git push` / `git clone` over HTTPS        | isomorphic-git → `createProxiedFetch` → `/api/fetch-proxy` (CLI) or `fetch-proxy.fetch` (SW); Basic-auth unmask                                                                                    |
| `curl`, `wget`, `node fetch(...)`          | shell → `createProxiedFetch` → fetch proxy (CLI/SW); header-substring + Basic + URL-creds unmask                                                                                                   |
| `upskill <github-url>`                     | `createProxiedFetch` → fetch proxy; `Authorization: Bearer <masked>` unmasked at boundary                                                                                                          |
| LLM provider streaming (Anthropic, etc.)   | direct `fetch()` from page; routed via `llm-proxy-sw.ts` to `/api/fetch-proxy` (CLI) or extension `host_permissions` (CORS bypass; no secret injection — provider holds real key in webapp memory) |
| `aws s3 cp` from agent shell (raw S3 HTTP) | shell → `createProxiedFetch` → upstream. NOT signed. **Use `mount` instead.**                                                                                                                      |
```

- [ ] **Step 9: Add migration note for file-PAT users**

Note: the file-on-disk PAT workaround is no longer needed; put PATs in `~/.slicc/secrets.env` (CLI) or the options page (extension).

- [ ] **Step 10: Commit**

```bash
npx prettier --write docs/secrets.md
git add docs/secrets.md
git commit -m "docs(secrets): platform-matrix flip + oauth dual-storage + GITHUB_TOKEN_DOMAINS fix + decision table"
```

---

### Task 6.2: Update root `CLAUDE.md`

- [ ] **Step 1: Find the "Network behavior differs by runtime" line**

Run: `grep -n "differs by runtime\|routes git/fetch" CLAUDE.md`

- [ ] **Step 2: Replace with**

"Both modes now route agent-initiated HTTP through `createProxiedFetch()`. CLI uses `/api/fetch-proxy` over Express; extension uses `chrome.runtime.connect({ name: 'fetch-proxy.fetch' })` over a SW Port with response streaming. Webapp git uses `isomorphic-git` over LightningFS; auth uses `git config github.token <PAT>` or GitHub OAuth login (auto-writes masked token to `/workspace/.git/github-token`)."

- [ ] **Step 3: Commit**

```bash
npx prettier --write CLAUDE.md
git add CLAUDE.md
git commit -m "docs(root): network behavior — both modes now proxy"
```

---

### Task 6.3: Update package CLAUDE.md files

- [ ] **Step 1: One-paragraph addendum in each**

- `packages/webapp/CLAUDE.md` — new `@slicc/shared` dep, `createProxiedFetch` extension branch
- `packages/chrome-extension/CLAUDE.md` — new `fetch-proxy.fetch` SW handler + `secrets.list-masked-entries` + `secrets.mask-oauth-token`
- `packages/node-server/CLAUDE.md` — `OauthSecretStore`, `POST /api/secrets/oauth-update`, sessionId persistence, deleted `masking.ts`/`domain-match.ts`
- `packages/shared/CLAUDE.md` — **new file** documenting the workspace package
- `packages/swift-server/CLAUDE.md` — `OAuthSecretStore.swift` + endpoints (pending Phase 7)

`packages/shared/CLAUDE.md`:

```markdown
# @slicc/shared

Platform-agnostic primitives shared across `@slicc/webapp`, `@slicc/node-server`, and `@slicc/chrome-extension`.

## Contents

- `secret-masking.ts` — HMAC-SHA256 masking, domain matching, scrubbing.
- `secrets-pipeline.ts` — stateful unmask/scrub class; Basic-auth-aware, URL-credential-aware, byte-safe body unmask.

## Conventions

- Pure functions only (no DOM / Node specifics). Uses `crypto.subtle`, `TextEncoder`, `Headers` (globals in both targets).
- `SecretsPipeline.unmaskHeaders` mutates its input parameter in place — match `SecretProxyManager`'s legacy semantics.
- Build: `npm run build -w @slicc/shared` (must run before `@slicc/node-server` build in the chain).
```

- [ ] **Step 2: Commit**

```bash
npx prettier --write packages/*/CLAUDE.md
git add packages/shared/CLAUDE.md packages/webapp/CLAUDE.md packages/chrome-extension/CLAUDE.md packages/node-server/CLAUDE.md packages/swift-server/CLAUDE.md
git commit -m "docs(packages): navigation pointers + @slicc/shared CLAUDE.md"
```

---

### Task 6.4: Update other docs

- [ ] **Step 1: `docs/architecture.md`**
  - Update the `git-http.ts` row: "extension mode: direct fetch" → "extension mode: createProxiedFetch → SW Port `fetch-proxy.fetch`".
  - Add `fetch-proxy.fetch`, `secrets.list-masked-entries`, `secrets.mask-oauth-token` to the SW handler list.
  - Repoint any references to deleted `node-server/src/secrets/masking.ts` / `domain-match.ts` → `packages/shared/src/secret-masking.ts`.

- [ ] **Step 2: `docs/pitfalls.md`**
  - "Fetch uses `/api/fetch-proxy` in CLI, direct fetch in extension" → both modes proxy via `createProxiedFetch`.
  - Add a pitfall on `Response` construction with `status: 0` (use 413 for payload-too-large).
  - Add a pitfall on `SecretsPipeline.unmaskHeaders` mutating its input parameter.

- [ ] **Step 3: `docs/shell-reference.md`**
  - `oauth-token`: returns masked Bearer in both modes.
  - `curl`/`wget`: routes through fetch proxy in extension as well.

- [ ] **Step 4: `docs/tools-reference.md`** — any reference to fetch-proxy behavior or extension network flows.

- [ ] **Step 5: `docs/mounts.md`** — `oauth-token adobe` returns masked now; mount backends still consume the real IMS bearer via the existing path (mount handlers are unchanged).

- [ ] **Step 6: Skill files**
  - `packages/vfs-root/workspace/skills/skill-authoring/SKILL.md`
  - `packages/vfs-root/workspace/skills/mount/SKILL.md`

- [ ] **Step 7: Commit**

```bash
npx prettier --write docs/*.md packages/vfs-root/workspace/skills/skill-authoring/SKILL.md packages/vfs-root/workspace/skills/mount/SKILL.md
git add docs/architecture.md docs/pitfalls.md docs/shell-reference.md docs/tools-reference.md docs/mounts.md packages/vfs-root/workspace/skills/skill-authoring/SKILL.md packages/vfs-root/workspace/skills/mount/SKILL.md
git commit -m "docs: update architecture/pitfalls/shell/tools/mounts/skills for secret-aware fetch proxy"
```

---

### Task 6.5: Phase 6 gate

```bash
npx prettier --check .
npm run build
```

Expected: clean.

---

## Phase 7: swift-server port

Spec: §"Phase 7: swift-server port".

Mirror Phases 1, 2, 4 (CLI proxy changes + OAuth endpoints) into swift-server. Tests parallel the TS test vectors; verification runs in CI's `swift-server` job. Each task ends in `git commit` only — no local-run verification step.

The TS-side `npm run typecheck && npm run test && npm run build && npm run build -w @slicc/chrome-extension` must remain green after every commit in this phase.

---

### Task 7.1: `SecretsPipeline.swift` — port pure functions

**Files:**

- Create: `packages/swift-server/Sources/Keychain/SecretsPipeline.swift`
- Create: `packages/swift-server/Tests/SecretsPipelineTests.swift`

Mirror the TS file step-by-step. Use Foundation `CryptoKit` for HMAC-SHA256. Use Foundation `URL` + manual userinfo handling for `extractAndUnmaskUrlCredentials`. Use byte-level `Data` operations for `unmaskBodyBytes`.

- [ ] **Step 1: Write the test file**

`packages/swift-server/Tests/SecretsPipelineTests.swift` mirrors `packages/shared/tests/secrets-pipeline.test.ts`. Every TS test case has an XCTest counterpart with the same input/output expectation. Use `actor` testing patterns.

- [ ] **Step 2: Implement `SecretsPipeline.swift`**

```swift
import Foundation
import CryptoKit

public protocol FetchProxySecretSource {
    func get(name: String) async -> String?
    func listAll() async -> [(name: String, value: String, domains: [String])]
}

public struct ForbiddenInfo: Sendable, Equatable {
    public let secretName: String
    public let hostname: String
}

public enum HeaderUnmaskResult: Sendable {
    case unmasked(String)
    case forbidden(ForbiddenInfo)
}

public actor SecretsPipeline {
    public let sessionId: String
    private let source: FetchProxySecretSource
    private var entries: [Entry] = []
    private var maskedToEntry: [String: Entry] = [:]

    struct Entry {
        let name: String
        let realValue: String
        let maskedValue: String
        let domains: [String]
    }

    public init(sessionId: String, source: FetchProxySecretSource) {
        self.sessionId = sessionId
        self.source = source
    }

    public func reload() async throws {
        let all = await source.listAll()
        var built: [Entry] = []
        var map: [String: Entry] = [:]
        for s in all {
            let m = try await maskOne(name: s.name, value: s.value)
            let e = Entry(name: s.name, realValue: s.value, maskedValue: m, domains: s.domains)
            built.append(e)
            map[m] = e
        }
        self.entries = built
        self.maskedToEntry = map
    }

    public func maskOne(name: String, value: String) async throws -> String {
        let keyBytes = Data((sessionId + name).utf8)
        let key = SymmetricKey(data: keyBytes)
        let mac = HMAC<SHA256>.authenticationCode(for: Data(value.utf8), using: key)
        return Data(mac).map { String(format: "%02x", $0) }.joined()
    }

    public func unmaskAuthorizationBasic(_ value: String, targetHostname: String) async -> HeaderUnmaskResult {
        // TS: /^Basic\s+(.+)$/.exec(headerValue)
        guard value.hasPrefix("Basic ") else { return .unmasked(value) }
        let b64 = String(value.dropFirst("Basic ".count)).trimmingCharacters(in: .whitespacesAndNewlines)
        // TS: atob — Foundation's Data(base64Encoded:) is stricter on padding/whitespace.
        guard let decoded = Data(base64Encoded: b64),
              let decodedStr = String(data: decoded, encoding: .utf8),
              let colonIdx = decodedStr.firstIndex(of: ":") else {
            return .unmasked(value)
        }
        var user = String(decodedStr[..<colonIdx])
        var pass = String(decodedStr[decodedStr.index(after: colonIdx)...])
        var touched = false
        for entry in entries {
            if user.contains(entry.maskedValue) || pass.contains(entry.maskedValue) {
                guard isAllowedDomain(targetHostname, allowed: entry.domains) else {
                    return .forbidden(.init(secretName: entry.name, hostname: targetHostname))
                }
                if user.contains(entry.maskedValue) { user = user.replacingOccurrences(of: entry.maskedValue, with: entry.realValue); touched = true }
                if pass.contains(entry.maskedValue) { pass = pass.replacingOccurrences(of: entry.maskedValue, with: entry.realValue); touched = true }
            }
        }
        if !touched { return .unmasked(value) }
        let reencoded = Data("\(user):\(pass)".utf8).base64EncodedString()
        return .unmasked("Basic \(reencoded)")
    }

    // ... extractAndUnmaskUrlCredentials, unmaskHeaders (in-place via inout), unmaskBody, unmaskBodyBytes, scrubResponse, scrubHeaders
    // For each method: add a comment with the TS expression equivalent next to any Foundation API invocation that has subtle semantic differences.
}

func isAllowedDomain(_ host: String, allowed: [String]) -> Bool {
    for pattern in allowed {
        if pattern == host { return true }
        if pattern.hasPrefix("*.") {
            let suffix = String(pattern.dropFirst(2))
            if host == suffix || host.hasSuffix("." + suffix) { return true }
        }
    }
    return false
}
```

Mirror the rest from the TS structure step-by-step. Forbidden shape: `{ secretName, hostname }` — same as TS.

- [ ] **Step 3: Commit**

```bash
git add packages/swift-server/Sources/Keychain/SecretsPipeline.swift packages/swift-server/Tests/SecretsPipelineTests.swift
git commit -m "feat(swift-server/secrets): SecretsPipeline port + test vector parity"
```

---

### Task 7.2: `OAuthSecretStore.swift`

**Files:**

- Create: `packages/swift-server/Sources/Keychain/OAuthSecretStore.swift`
- Create: `packages/swift-server/Tests/OAuthSecretStoreTests.swift`

- [ ] **Step 1: Write the tests**

Mirror `oauth-secret-store.test.ts`: set/delete/list, empty-domains rejection, concurrency smoke.

- [ ] **Step 2: Implement**

```swift
import Foundation

public actor OAuthSecretStore {
    public struct Entry: Sendable, Equatable {
        public let name: String
        public let value: String
        public let domains: [String]
    }

    private var entries: [String: Entry] = [:]

    public init() {}

    public func set(name: String, value: String, domains: [String]) throws {
        guard !domains.isEmpty else {
            throw NSError(domain: "OAuthSecretStore", code: 1, userInfo: [NSLocalizedDescriptionKey: "domains must be non-empty"])
        }
        entries[name] = Entry(name: name, value: value, domains: domains)
    }

    public func delete(name: String) { entries.removeValue(forKey: name) }
    public func list() -> [Entry] { Array(entries.values) }
    public func get(name: String) -> String? { entries[name]?.value }
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/swift-server/Sources/Keychain/OAuthSecretStore.swift packages/swift-server/Tests/OAuthSecretStoreTests.swift
git commit -m "feat(swift-server/secrets): OAuthSecretStore in-memory writable"
```

---

### Task 7.3: `SecretInjector.swift` — chain stores + sessionId persistence

**Files:**

- Modify: `packages/swift-server/Sources/Keychain/SecretInjector.swift`
- Extend: `packages/swift-server/Tests/SecretInjectorTests.swift`
- Create: `packages/swift-server/Tests/SessionPersistenceTests.swift`

- [ ] **Step 1: Add `sessionDir`-based persistence**

```swift
static func readOrCreateSessionId(in dir: URL) throws -> String {
    let path = dir.appendingPathComponent("session-id")
    if FileManager.default.fileExists(atPath: path.path) {
        if let data = try? Data(contentsOf: path),
           let raw = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
           UUID(uuidString: raw) != nil {
            return raw
        }
    }
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let fresh = UUID().uuidString
    try fresh.data(using: .utf8)!.write(to: path, options: .atomic)
    try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
    return fresh
}
```

- [ ] **Step 2: Chain Keychain + OAuth stores**

Source's `listAll()` is the union, OAuth wins on name collision (mirror node-server's reserved-namespace decision).

- [ ] **Step 3: Add tests**

`SessionPersistenceTests.swift` — round-trip a mask across two `SecretInjector` instances pointed at the same temp dir.

- [ ] **Step 4: Commit**

```bash
git add packages/swift-server/Sources/Keychain/SecretInjector.swift packages/swift-server/Tests/SecretInjectorTests.swift packages/swift-server/Tests/SessionPersistenceTests.swift
git commit -m "feat(swift-server/secrets): chain OAuthSecretStore + persist sessionId"
```

---

### Task 7.4: API endpoints in `APIRoutes.swift`

**Files:**

- Modify: `packages/swift-server/Sources/Server/APIRoutes.swift`
- Extend: `packages/swift-server/Tests/SecretAPIRoutesTests.swift`

- [ ] **Step 1: Add `POST /api/secrets/oauth-update` + `DELETE /api/secrets/oauth/:providerId`**

JSON shape: `{providerId, accessToken, domains}` → `{providerId, name, maskedValue, domains}`. Localhost binding (Hummingbird config).

```swift
router.post("/api/secrets/oauth-update") { request, _ in
    struct Payload: Decodable { let providerId: String; let accessToken: String; let domains: [String] }
    let payload = try await request.decode(as: Payload.self, context: .init())
    guard !payload.domains.isEmpty else { return Response(status: .badRequest) }
    let name = "oauth.\(payload.providerId).token"
    try await oauthStore.set(name: name, value: payload.accessToken, domains: payload.domains)
    try await injector.reload()
    let masked = await injector.maskedFor(name: name)
    struct Reply: Encodable { let providerId: String; let name: String; let maskedValue: String?; let domains: [String] }
    return try Response(status: .ok, body: .init(buffer: .init(data: JSONEncoder().encode(
        Reply(providerId: payload.providerId, name: name, maskedValue: masked, domains: payload.domains)
    ))))
}

router.delete("/api/secrets/oauth/:providerId") { request, _ in
    let providerId = request.parameters.require("providerId")
    let name = "oauth.\(providerId).token"
    if await oauthStore.get(name: name) == nil { return Response(status: .notFound) }
    await oauthStore.delete(name: name)
    try await injector.reload()
    return Response(status: .noContent)
}
```

(Adjust to whatever Hummingbird API version the project uses.)

- [ ] **Step 2: Tests**

Mirror `oauth-endpoints.test.ts`: happy path, missing-domains, malformed JSON, DELETE 404.

- [ ] **Step 3: Commit**

```bash
git add packages/swift-server/Sources/Server/APIRoutes.swift packages/swift-server/Tests/SecretAPIRoutesTests.swift
git commit -m "feat(swift-server/api): POST /api/secrets/oauth-update + DELETE"
```

---

### Task 7.5: `CrossImplementationTests.swift` — pinned mask vectors

**Files:**

- Create: `packages/dev-tools/tools/gen-mask-vectors.mjs`
- Create: `packages/swift-server/Tests/CrossImplementationTests.swift`
- Create: `packages/shared/tests/cross-impl-vectors.test.ts`

- [ ] **Step 1: Write the vector generator**

`packages/dev-tools/tools/gen-mask-vectors.mjs`:

```js
import { mask } from '../../shared/src/secret-masking.js';

const vectors = [
  { sessionId: 'session-cross-impl-1', name: 'GITHUB_TOKEN', value: 'ghp_realToken123' },
  { sessionId: 'session-cross-impl-2', name: 'AWS_KEY', value: 'AKIAEXAMPLE' },
  { sessionId: '', name: 'X', value: '' },
  { sessionId: 'session-😀', name: 'Y', value: 'value with spaces' },
];

for (const v of vectors) {
  const m = await mask(v.sessionId, v.name, v.value);
  console.log(JSON.stringify({ ...v, expected: m }));
}
```

Run: `node packages/dev-tools/tools/gen-mask-vectors.mjs`. Capture the output.

- [ ] **Step 2: TS-side pinned vector test**

`packages/shared/tests/cross-impl-vectors.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mask } from '../src/secret-masking.js';

const PINNED = [
  {
    sessionId: 'session-cross-impl-1',
    name: 'GITHUB_TOKEN',
    value: 'ghp_realToken123',
    expected: '<paste from gen-mask-vectors>',
  },
  { sessionId: 'session-cross-impl-2', name: 'AWS_KEY', value: 'AKIAEXAMPLE', expected: '<...>' },
  { sessionId: '', name: 'X', value: '', expected: '<...>' },
  { sessionId: 'session-😀', name: 'Y', value: 'value with spaces', expected: '<...>' },
];

describe('cross-implementation mask vectors', () => {
  it.each(PINNED)(
    'mask($sessionId, $name) is stable',
    async ({ sessionId, name, value, expected }) => {
      expect(await mask(sessionId, name, value)).toBe(expected);
    }
  );
});
```

- [ ] **Step 3: Swift-side pinned vector test**

`packages/swift-server/Tests/CrossImplementationTests.swift` — embed the SAME pinned vectors. Both tests reference the same canonical hex strings; if one regresses, the other regresses with it.

```swift
final class CrossImplementationTests: XCTestCase {
    struct Vector { let sessionId: String; let name: String; let value: String; let expected: String }
    static let vectors: [Vector] = [
        .init(sessionId: "session-cross-impl-1", name: "GITHUB_TOKEN", value: "ghp_realToken123", expected: "<paste>"),
        .init(sessionId: "session-cross-impl-2", name: "AWS_KEY", value: "AKIAEXAMPLE", expected: "<...>"),
        .init(sessionId: "", name: "X", value: "", expected: "<...>"),
        .init(sessionId: "session-😀", name: "Y", value: "value with spaces", expected: "<...>"),
    ]

    func test_mask_matchesPinnedVectors() async throws {
        for v in Self.vectors {
            let pipeline = SecretsPipeline(sessionId: v.sessionId, source: EmptySource())
            let result = try await pipeline.maskOne(name: v.name, value: v.value)
            XCTAssertEqual(result, v.expected, "mask mismatch for (sessionId: \(v.sessionId), name: \(v.name))")
        }
    }
}
```

- [ ] **Step 4: Run TS vector test locally**

Run: `npx vitest run packages/shared/tests/cross-impl-vectors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/shared/tests/cross-impl-vectors.test.ts packages/dev-tools/tools/gen-mask-vectors.mjs
git add packages/swift-server/Tests/CrossImplementationTests.swift packages/shared/tests/cross-impl-vectors.test.ts packages/dev-tools/tools/gen-mask-vectors.mjs
git commit -m "test(secrets): cross-implementation mask vector pinning"
```

---

### Task 7.6: Phase 7 gate

- [ ] **Step 1: Run TS gates**

```bash
npm run typecheck
npm run test
npm run build
npm run build -w @slicc/chrome-extension
```

Expected: all green. TS `cross-impl-vectors.test.ts` passes; Swift parallel runs in CI.

- [ ] **Step 2: Push to trigger CI**

```bash
git push origin feat/git-auth-secrets-bridge
```

Expected:

- `node-server` / `webapp` / `chrome-extension` / `cloudflare-worker` jobs: green.
- `swift-server` job: `swift test --enable-code-coverage` passes; `swift-coverage-check.sh` holds the floor; `CrossImplementationTests` passes.

- [ ] **Step 3: Read CI output**

If `CrossImplementationTests` fails: fix in Swift code. TS side is the canonical reference. Check Foundation API divergences (base64 padding, HMAC byte order, URL userinfo parsing).

If `swift-coverage-check.sh` fails: add focused tests to hit the floor.

---

## Final PR

After Phase 7 is green on CI:

- [ ] **Step 1: Open the PR**

```bash
gh pr create --title "feat: secret-aware fetch proxy in CLI and extension" --body "$(cat <<'EOF'
## Summary

Closes the three documented gaps in the secret-aware fetch proxy:

1. HTTP Basic auth — `Authorization: Basic base64('x-access-token:<masked>')` now decodes, unmasks, re-encodes at the proxy/SW. `git push` works with a PAT in `.env` (CLI) or options page (extension).
2. Extension parity — new `fetch-proxy.fetch` SW handler with Port-based response streaming and a 32 MB request-body cap.
3. `oauth-token` returns masked Bearer; real OAuth tokens never enter the agent's context window. Dual-storage replica syncs on every `saveOAuthAccount` lifecycle event (login, silent refresh, logout).

Also: introduces `@slicc/shared` workspace package (single source of truth for `secret-masking.ts` + new `secrets-pipeline.ts`).

Spec: `docs/superpowers/specs/2026-05-08-secret-aware-fetch-proxy-design.md`

## PR shape

Seven phase-end commits + the @slicc/shared scaffolding.

## Test plan

- [ ] CLI: `git push` against private repo with PAT in `~/.slicc/secrets.env`.
- [ ] CLI: `curl -H "Authorization: Bearer $(oauth-token github)" https://api.github.com/user`.
- [ ] Extension: same two flows after side-loading the build with PAT in options page / OAuth logged in.
- [ ] Extension: `upskill` against a private GitHub skill repo.
- [ ] CI gates: typecheck, test, test:coverage, build, build:extension, swift-server tests.
EOF
)"
```

- [ ] **Step 2: Verify CI**

`gh pr checks` until all green.

---
