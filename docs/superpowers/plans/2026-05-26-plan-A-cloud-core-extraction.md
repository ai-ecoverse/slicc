# Plan A — cloud-core extraction

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the contents of `packages/node-server/src/cloud/` into a new shared package `packages/cloud-core/` so both node-server (CLI) and cloudflare-worker (future, Plan D) can consume the same orchestration logic. Pure refactor — no behavior changes.

**Architecture:** New workspace package `packages/cloud-core/` holding substrate interface + e2b adapter + operations (start/list/pause/resume/kill) + polling + secrets-filter + Registry interface + errors + types. node-server keeps its CLI dispatcher and adds a file-backed Registry implementation. Operations become pure functions taking a `{ substrate, registry, … }` deps object.

**Tech Stack:** TypeScript, npm workspaces, Vitest. Browser-and-Node-safe (no `node:fs` at module load).

**Plan in spec:** `docs/superpowers/specs/2026-05-26-cloud-cones-on-sliccy-ai-design.md` § "Shared orchestration module".

---

## File map (after refactor)

```
packages/cloud-core/                  ← NEW
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                      ← public re-exports
│   ├── substrate.ts                  ← interface (moved from node-server)
│   ├── substrates/
│   │   └── e2b.ts                    ← e2b adapter (moved)
│   ├── operations/
│   │   ├── start.ts                  ← startCone(deps, opts)
│   │   ├── list.ts                   ← listCones(deps)
│   │   ├── pause.ts                  ← pauseCone(deps, query)
│   │   ├── resume.ts                 ← resumeCone(deps, opts)
│   │   └── kill.ts                   ← killCone(deps, query)
│   ├── registry.ts                   ← Registry interface ONLY
│   ├── errors.ts                     ← shared error codes
│   ├── secrets-filter.ts             ← filterSecretsEnv
│   ├── polling.ts                    ← pollCloudStatus, pollForRefreshedStatus
│   └── types.ts                      ← ConeEntry, StartResult, ResumeResult
└── tests/
    ├── fake-substrate.ts             ← moved from node-server/tests/cloud/
    └── operations.test.ts            ← exercises ops against FakeSubstrate

packages/node-server/src/cloud/       ← reduced
├── dispatch.ts                       ← unchanged: CLI argv parser
├── registry-file.ts                  ← NEW: file-backed Registry impl
├── start.ts                          ← thin wrapper: builds deps, calls startCone
├── list.ts                           ← thin wrapper
├── pause.ts                          ← thin wrapper
├── resume.ts                         ← thin wrapper
└── kill.ts                           ← thin wrapper
```

---

### Task A1: Scaffold packages/cloud-core

**Files:**

- Create: `packages/cloud-core/package.json`
- Create: `packages/cloud-core/tsconfig.json`
- Create: `packages/cloud-core/src/index.ts`
- Create: `packages/cloud-core/vitest.config.ts`
- Modify: `package.json` (root) — add `packages/cloud-core` to workspaces

- [ ] **Step 1: Write package.json**

cloud-core needs a real build step (emitting `dist/`) so node-server's published-tarball case can inline it the same way `@slicc/shared-ts` is inlined today. Locally (dev), the workspace symlink + ts source resolution works directly; for `npm pack` / `sliccy` publish, we inline.

```json
{
  "name": "@slicc/cloud-core",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./tests/fake-substrate": {
      "types": "./dist/tests/fake-substrate.d.ts",
      "default": "./dist/tests/fake-substrate.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@slicc/shared-ts": "*",
    "e2b": "^2.23.0"
  },
  "devDependencies": {
    "vitest": "^4.1.6"
  }
}
```

- [ ] **Step 2: Write tsconfig.json**

```json
{
  "extends": "../../tsconfig.cli.json",
  "compilerOptions": {
    "rootDir": ".",
    "outDir": "dist",
    "composite": false,
    "noEmit": false,
    "declaration": true,
    "declarationMap": true
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

(`tests/` is included so `@slicc/cloud-core/tests/fake-substrate` resolves to a built artifact for downstream test consumers.)

- [ ] **Step 3: Write src/index.ts placeholder**

```ts
// Public re-exports for the @slicc/cloud-core package.
// Populated by subsequent tasks as we move code in.
export {};
```

- [ ] **Step 4: Write vitest.config.ts**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
```

- [ ] **Step 5: Add workspace entry to root package.json**

Find the `workspaces` array in `package.json` and add `"packages/cloud-core"` after `"packages/shared-ts"`:

```json
"workspaces": [
  "packages/shared-ts",
  "packages/cloud-core",
  "packages/webapp",
  "packages/node-server",
  "packages/chrome-extension",
  "packages/cloudflare-worker",
  "packages/swift-launcher",
  "packages/swift-server"
],
```

- [ ] **Step 6: Install + verify**

```bash
npm install
npm run typecheck -w @slicc/cloud-core
```

Expected: install succeeds, typecheck succeeds (empty package).

- [ ] **Step 7: Commit**

```bash
git add packages/cloud-core/ package.json package-lock.json
git commit -m "feat(cloud-core): scaffold @slicc/cloud-core workspace package"
```

---

### Task A2: Move types to cloud-core

**Files:**

- Create: `packages/cloud-core/src/types.ts`
- Modify: `packages/node-server/src/cloud/start.ts` (re-export from new location)
- Modify: callers that import these types

- [ ] **Step 1: Identify type exports currently in node-server/cloud/**

```bash
grep -E "^export (type|interface)" packages/node-server/src/cloud/*.ts
```

You should see types like `StartResult`, `ResumeResult`, `CloudStatus`, `RunStartOpts`, `RunResumeOpts`, `RunPauseOpts`, `RunKillOpts`, `RunListOpts`, `Cone`/`SandboxSummary`, etc.

- [ ] **Step 2: Create packages/cloud-core/src/types.ts**

Move these declarations (NOT the runtime code, just the type definitions) into a single file. Read each source file, copy out the `interface` and `type` blocks for the result types, and place them in types.ts. Suggested content:

```ts
// Shared types for cloud-core operations.

import type { Secret } from '@slicc/shared-ts';

export interface ConeEntry {
  /** Substrate-assigned ID, e.g. e2b sandbox ID. */
  sandboxId: string;
  /** User-supplied or auto-generated. */
  name?: string;
  /** ISO 8601 timestamp. */
  createdAt: string;
  /** ISO 8601 timestamp; updated on every list / mutation tick. */
  lastSeen: string;
  state: 'running' | 'paused' | 'dead';
  joinUrl?: string;
  trayId?: string;
  /** Baseline for resume's strict-newer check. */
  lastJoinUpdatedAt?: string;
  sliccVersion?: string;
  controllerUrl?: string;
  webhookUrl?: string;
  runtime?: string;
  /** Substrate-side metadata; for e2b reconciliation. */
  metadata?: Record<string, string>;
}

export interface CloudStatus {
  joinUrl: string;
  trayId?: string;
  controllerUrl?: string;
  webhookUrl?: string;
  runtime?: string;
  sliccVersion?: string;
  updatedAt?: string;
}

export interface StartResult {
  sandboxId: string;
  name?: string;
  joinUrl: string;
  trayId?: string;
}

export interface ResumeResult {
  sandboxId: string;
  joinUrl: string;
  trayRebuilt: boolean;
  versionMismatch?: { running: string; local: string };
}

export interface SandboxSummary {
  sandboxId: string;
  name?: string;
  state: 'running' | 'paused' | 'dead';
  metadata?: Record<string, string>;
}
```

(Field exact list: read the existing files first and copy what's there; this is the shape to aim for.)

- [ ] **Step 3: Re-export from cloud-core/src/index.ts**

```ts
export * from './types.js';
```

- [ ] **Step 4: Update node-server imports**

In each of `packages/node-server/src/cloud/{start,list,pause,resume,kill}.ts`, replace the local type declarations with imports from `@slicc/cloud-core`:

```ts
// Before:
// export interface StartResult { … }
// After:
import type { StartResult, ConeEntry, CloudStatus } from '@slicc/cloud-core';
```

If any type was exported and consumed by tests, update test imports too.

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: clean across all packages.

- [ ] **Step 6: Run tests**

```bash
npx vitest run --project node-server
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(cloud-core): move shared types from node-server"
```

---

### Task A3: Move errors to cloud-core

**Files:**

- Create: `packages/cloud-core/src/errors.ts`
- Modify: callers that reference these codes

- [ ] **Step 1: Identify existing error codes**

```bash
grep -rEh "code:\s*'[A-Z_]+'" packages/node-server/src/cloud/ | sort -u
```

You'll see codes like `CDP_NOT_READY`, `NO_LEADER_TAB`, `CDP_ERROR`, `INTERNAL`, etc. (some live in leader-restart.ts — leave those alone for now; move only the cloud-flow codes).

- [ ] **Step 2: Create packages/cloud-core/src/errors.ts**

```ts
/** Stable machine-readable error codes used across cloud operations. */
export type CloudErrorCode =
  | 'CAP_EXCEEDED'
  | 'NOT_FOUND'
  | 'NAME_TAKEN'
  | 'ALREADY_PAUSED'
  | 'ALREADY_RUNNING'
  | 'LEADER_NOT_READY'
  | 'SANDBOX_NOT_READY'
  | 'CDP_NOT_READY'
  | 'CDP_ERROR'
  | 'INTERNAL';

export class CloudError extends Error {
  constructor(
    public readonly code: CloudErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'CloudError';
  }
}

export function isCloudError(err: unknown): err is CloudError {
  return err instanceof CloudError;
}
```

- [ ] **Step 3: Re-export from cloud-core/src/index.ts**

```ts
export * from './errors.js';
```

- [ ] **Step 4: Replace ad-hoc error throwing in node-server/cloud/**

For each `throw new Error(\`cloud session not found: …\`)`style throw, switch to`throw new CloudError('NOT_FOUND', \`cloud session not found: …\`)`. Specifically:

- `pause.ts` / `resume.ts` / `kill.ts`: NOT_FOUND when query doesn't match
- `start.ts`: poll timeout uses `SANDBOX_NOT_READY`
- `resume.ts`: kick failure uses `LEADER_NOT_READY`

Search for the existing strings and update one at a time, running tests after each.

- [ ] **Step 5: Update tests asserting on error messages to also check code**

For each test that does `.toThrow(/some message/)`, augment to:

```ts
await expect(runPause({ … })).rejects.toMatchObject({
  name: 'CloudError',
  code: 'NOT_FOUND',
});
```

- [ ] **Step 6: Verify**

```bash
npm run typecheck && npx vitest run --project node-server
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(cloud-core): introduce CloudError with stable codes"
```

---

### Task A4: Move substrate interface to cloud-core

**Files:**

- Create: `packages/cloud-core/src/substrate.ts` (interface only, no e2b adapter yet)
- Modify: `packages/node-server/src/cloud/substrate.ts` → re-export shim, then delete after callers update
- Modify: callers

- [ ] **Step 1: Move substrate.ts**

Copy the entire contents of `packages/node-server/src/cloud/substrate.ts` to `packages/cloud-core/src/substrate.ts`. Adjust imports (the `@slicc/shared-ts` reference stays the same). Remove the `createSubstrate` factory for now — we'll move it with the e2b adapter in Task A5.

The interface portion to land in cloud-core:

```ts
import type { SandboxSummary } from './types.js';

export type SubstrateId = 'e2b';

export interface SubstrateConfig {
  apiKey: string;
}

export interface CreateOpts {
  template: string;
  autoPauseOnCap?: boolean;
  envVars?: Record<string, string>;
  metadata?: Record<string, string>;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SandboxInfo {
  sandboxId: string;
  state: 'running' | 'paused' | 'dead';
  metadata: Record<string, string>;
  createdAt: string;
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

export interface ListOpts {
  metadata?: Record<string, string>;
}

export interface SandboxSubstrate {
  readonly id: SubstrateId;
  create(opts: CreateOpts): Promise<SandboxHandle>;
  connect(sandboxId: string): Promise<SandboxHandle>;
  list(opts?: ListOpts): Promise<SandboxSummary[]>;
}
```

(Read the existing file first to ensure you preserve every field.)

- [ ] **Step 2: Re-export from cloud-core/src/index.ts**

```ts
export * from './substrate.js';
```

- [ ] **Step 3: Make node-server's substrate.ts a re-export shim**

Replace the contents of `packages/node-server/src/cloud/substrate.ts` with:

```ts
// All shared substrate types live in @slicc/cloud-core now.
// This shim exists temporarily for callers using the old import path; remove
// in Task A15 once all consumers are updated.
export * from '@slicc/cloud-core';
```

- [ ] **Step 4: Verify**

```bash
npm run typecheck && npx vitest run --project node-server
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(cloud-core): move SandboxSubstrate interface from node-server"
```

---

### Task A5: Move e2b adapter to cloud-core

**Files:**

- Create: `packages/cloud-core/src/substrates/e2b.ts`
- Create: `packages/cloud-core/src/substrate-factory.ts` (`createSubstrate`)
- Modify: `packages/node-server/src/cloud/substrates/e2b.ts` → re-export shim, then delete

- [ ] **Step 1: Copy substrates/e2b.ts**

Move `packages/node-server/src/cloud/substrates/e2b.ts` to `packages/cloud-core/src/substrates/e2b.ts`. Adjust import paths (relative ../substrate.js → ../substrate.js still works).

- [ ] **Step 2: Create substrate-factory.ts**

```ts
import type { SandboxSubstrate, SubstrateConfig, SubstrateId } from './substrate.js';
import { createE2bSubstrate } from './substrates/e2b.js';

export function createSubstrate(id: SubstrateId, cfg: SubstrateConfig): SandboxSubstrate {
  if (id === 'e2b') return createE2bSubstrate(cfg);
  throw new Error(`unknown substrate: ${id satisfies never}`);
}
```

- [ ] **Step 3: Re-export from cloud-core/src/index.ts**

```ts
export * from './substrate-factory.js';
```

- [ ] **Step 4: Replace node-server's substrates/e2b.ts with a shim**

```ts
export { createE2bSubstrate } from '@slicc/cloud-core';
```

- [ ] **Step 5: Verify**

```bash
npm run typecheck && npx vitest run --project node-server
```

The live test (`tests/cloud-live.test.ts`) is opt-in (gated on `SLICC_TEST_E2B_API_KEY`), so it doesn't run in CI but is the gold standard for e2b adapter correctness. Optionally run it:

```bash
SLICC_TEST_E2B_API_KEY="$E2B_API_KEY" npx vitest run --project node-server packages/node-server/tests/cloud-live.test.ts
```

Expected: 1 passed (~12s).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(cloud-core): move e2b substrate adapter"
```

---

### Task A5b: Make the e2b adapter worker-safe

**Files:**

- Modify: `packages/cloud-core/src/substrates/e2b.ts`

**Why:** the existing adapter uses `process.env['E2B_API_KEY'] = cfg.apiKey` and relies on the SDK reading the global env. That breaks in Cloudflare Workers (no `process.env`) and creates Workers-incompatibility that the Plan C spike wouldn't surface unless the spike actually goes through `createSubstrate`. Fix here so Plan C can validate the same path Plan D will use.

- [ ] **Step 1: Remove the env mutation; pass `apiKey` to every SDK call**

Replace the body of `createE2bSubstrate` so it threads `cfg.apiKey` explicitly to each `Sandbox.create` / `Sandbox.connect` / `Sandbox.list` call (the SDK supports an `apiKey` option on all of them in v2):

```ts
import { Sandbox } from 'e2b';
import type { SandboxSubstrate, SubstrateConfig /* … */ } from '../substrate.js';

export function createE2bSubstrate(cfg: SubstrateConfig): SandboxSubstrate {
  const apiKey = cfg.apiKey;
  return {
    id: 'e2b',
    async create(opts) {
      const sbx = await Sandbox.create(opts.template, {
        apiKey, // ← explicit, was process.env mutation
        envs: opts.envVars,
        metadata: opts.metadata,
        ...(opts.autoPauseOnCap ? { lifecycle: { onTimeout: 'pause' } } : {}),
      });
      return wrap(sbx, apiKey); // ← thread apiKey to handle ops
    },
    async connect(sandboxId) {
      const sbx = await Sandbox.connect(sandboxId, { apiKey });
      return wrap(sbx, apiKey);
    },
    async list(opts) {
      const paginator = Sandbox.list({ apiKey, query: { metadata: opts?.metadata } });
      const items: SandboxSummary[] = [];
      while (paginator.hasNext) {
        const page = await paginator.nextItems();
        for (const info of page) {
          if (info.name === 'slicc') {
            items.push({
              sandboxId: info.sandboxId,
              name: info.metadata?.['name'],
              state: mapState(info.state),
              metadata: info.metadata,
            });
          }
        }
      }
      return items;
    },
  };
}

function wrap(sbx: Sandbox, apiKey: string): SandboxHandle {
  // ... existing wrap impl unchanged, EXCEPT that any internal calls that
  // re-issue SDK requests (e.g., a hypothetical re-connect) pass apiKey too.
  // The current wrap only forwards calls to the already-connected `sbx`, so
  // no changes needed inside wrap itself — `apiKey` is kept for completeness.
  // ...
}
```

- [ ] **Step 2: Verify no process.env reference remains**

```bash
grep -n "process.env" packages/cloud-core/src/substrates/e2b.ts
```

Expected: no matches.

- [ ] **Step 3: Update live test (no change expected — it already passes apiKey via cfg)**

```bash
SLICC_TEST_E2B_API_KEY="$E2B_API_KEY" \
  npx vitest run --project node-server packages/node-server/tests/cloud-live.test.ts
```

Expected: 1 passed.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(cloud-core): make e2b adapter worker-safe (no process.env, apiKey passed explicitly)"
```

---

### Task A6: Move secrets-filter to cloud-core

**Files:**

- Create: `packages/cloud-core/src/secrets-filter.ts`
- Modify: `packages/node-server/src/cloud/start.ts` — remove the local function, import from cloud-core

- [ ] **Step 1: Locate filterSecretsEnv in node-server**

```bash
grep -n "filterSecretsEnv\b" packages/node-server/src/cloud/*.ts
```

Most likely in `start.ts`. Extract the function definition.

- [ ] **Step 2: Create packages/cloud-core/src/secrets-filter.ts**

```ts
/**
 * Strip variables that should never be uploaded to a sandbox.
 * - E2B_API_KEY / E2B_API_KEY_DOMAINS: would let the sandbox spawn further
 *   sandboxes on the user's account.
 *
 * Operates line-by-line; preserves comments and blank lines.
 */
const STRIP = /^E2B_API_KEY(?:_DOMAINS)?$/;

export function filterSecretsEnv(input: string): string {
  return input
    .split('\n')
    .filter((line) => {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (!match) return true;
      return !STRIP.test(match[1]!);
    })
    .join('\n');
}
```

- [ ] **Step 3: Re-export from cloud-core/src/index.ts**

```ts
export { filterSecretsEnv } from './secrets-filter.js';
```

- [ ] **Step 4: Replace local definition in node-server**

Remove the function from `packages/node-server/src/cloud/start.ts` and import:

```ts
import { filterSecretsEnv } from '@slicc/cloud-core';
```

- [ ] **Step 5: Move the unit test**

If `packages/node-server/tests/cloud/start.test.ts` has filterSecretsEnv tests, move them to `packages/cloud-core/tests/secrets-filter.test.ts`. Otherwise create one with the existing Tier-1 whitespace cases:

```ts
import { describe, it, expect } from 'vitest';
import { filterSecretsEnv } from '../src/secrets-filter.js';

describe('filterSecretsEnv', () => {
  it('strips E2B_API_KEY and E2B_API_KEY_DOMAINS', () => {
    const out = filterSecretsEnv(
      'ANTHROPIC_API_KEY=sk-x\nE2B_API_KEY=secret\nE2B_API_KEY_DOMAINS=e2b.dev'
    );
    expect(out).toContain('ANTHROPIC_API_KEY=sk-x');
    expect(out).not.toContain('E2B_API_KEY');
  });

  it('handles whitespace variations', () => {
    const out = filterSecretsEnv('  E2B_API_KEY=x\nE2B_API_KEY  =y\n\tE2B_API_KEY=z\nKEEP=1');
    expect(out).toContain('KEEP=1');
    expect(out.split('\n').every((l) => !l.includes('E2B_API_KEY'))).toBe(true);
  });

  it('preserves comments and blank lines', () => {
    const out = filterSecretsEnv('# c\n\nA=1\nE2B_API_KEY=x');
    expect(out.split('\n')).toEqual(['# c', '', 'A=1']);
  });
});
```

- [ ] **Step 6: Verify**

```bash
npx vitest run --project cloud-core
npx vitest run --project node-server
```

(If `cloud-core` isn't in the vitest workspace config yet, run `npx vitest run packages/cloud-core/`.)

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(cloud-core): move filterSecretsEnv with whitespace-handling tests"
```

---

### Task A7: Move polling helpers to cloud-core

**Files:**

- Create: `packages/cloud-core/src/polling.ts`
- Modify: `packages/node-server/src/cloud/{start,resume}.ts` — import from cloud-core

- [ ] **Step 1: Locate polling helpers**

```bash
grep -n "pollCloudStatus\|pollForRefreshedStatus" packages/node-server/src/cloud/*.ts
```

`pollCloudStatus` is in `start.ts`; `pollForRefreshedStatus` is in `resume.ts`.

- [ ] **Step 2: Create packages/cloud-core/src/polling.ts**

Move both functions verbatim into a single file. Both take a `SandboxHandle` and an opts object, return a `CloudStatus`. Adjust imports to use `./types.js` and `./substrate.js`:

```ts
import type { SandboxHandle } from './substrate.js';
import type { CloudStatus } from './types.js';

export interface PollOpts {
  timeoutMs: number;
  intervalMs: number;
}

/**
 * Poll /tmp/slicc-join.json inside the sandbox until a well-formed joinUrl appears.
 * Used on initial start.
 */
export async function pollCloudStatus(handle: SandboxHandle, opts: PollOpts): Promise<CloudStatus> {
  const start = Date.now();
  let lastError: unknown = null;
  while (Date.now() - start < opts.timeoutMs) {
    try {
      const raw = await handle.readFile('/tmp/slicc-join.json');
      const parsed = JSON.parse(raw) as CloudStatus;
      if (parsed.joinUrl) return parsed;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
  const suffix = lastError
    ? ` (last error: ${lastError instanceof Error ? lastError.message : String(lastError)})`
    : ' (file never appeared)';
  throw new Error(`cloud-status did not appear within ${opts.timeoutMs}ms${suffix}`);
}

/**
 * Poll /tmp/slicc-join.json after a resume kick, waiting for `updatedAt`
 * to be STRICTLY newer than `baselineUpdatedAt`. Differentiates
 * "file stale" from "file missing" in the timeout error.
 */
export async function pollForRefreshedStatus(
  handle: SandboxHandle,
  baselineUpdatedAt: string | undefined,
  opts: PollOpts
): Promise<CloudStatus> {
  const start = Date.now();
  let lastError: unknown = null;
  let lastStalePayload: CloudStatus | null = null;
  while (Date.now() - start < opts.timeoutMs) {
    try {
      const raw = await handle.readFile('/tmp/slicc-join.json');
      const parsed = JSON.parse(raw) as CloudStatus;
      if (parsed.joinUrl) {
        if (!baselineUpdatedAt) return parsed;
        if (parsed.updatedAt && parsed.updatedAt !== baselineUpdatedAt) return parsed;
        lastStalePayload = parsed;
      }
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
  let suffix = '';
  if (lastStalePayload) {
    suffix =
      ` (file present but stale: baseline.updatedAt=${baselineUpdatedAt}, ` +
      `current.updatedAt=${lastStalePayload.updatedAt}, ` +
      `current.trayId=${lastStalePayload.trayId})`;
  } else if (lastError) {
    suffix = ` (last error: ${lastError instanceof Error ? lastError.message : String(lastError)})`;
  } else {
    suffix = ' (file never appeared)';
  }
  throw new Error(`cloud-status did not refresh within ${opts.timeoutMs}ms${suffix}`);
}
```

- [ ] **Step 3: Re-export from cloud-core/src/index.ts**

```ts
export * from './polling.js';
```

- [ ] **Step 4: Update node-server callers**

In `start.ts` and `resume.ts`, replace the local definitions with:

```ts
import { pollCloudStatus, pollForRefreshedStatus } from '@slicc/cloud-core';
```

- [ ] **Step 5: Verify**

```bash
npm run typecheck && npx vitest run --project node-server
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(cloud-core): move polling helpers"
```

---

### Task A8: Define Registry interface; create FileRegistry in node-server

**Files:**

- Create: `packages/cloud-core/src/registry.ts`
- Create: `packages/node-server/src/cloud/registry-file.ts`
- Modify: `packages/node-server/src/cloud/registry.ts` → delete (replaced by file-impl below)
- Modify: callers

- [ ] **Step 1: Read the existing registry.ts**

```bash
cat packages/node-server/src/cloud/registry.ts
```

Note the existing class signature (`CloudSessionRegistry`) and methods (`list`, `findByNameOrId`, `append`, `update`, `remove`, etc.).

- [ ] **Step 2: Create the interface in cloud-core**

```ts
// packages/cloud-core/src/registry.ts
import type { ConeEntry } from './types.js';

export interface Registry {
  /** Read all entries. Async to support both file- and DO-backed impls. */
  list(): Promise<ConeEntry[]>;
  /** Resolve a query (name OR sandboxId) to a single entry. */
  findByNameOrId(query: string): Promise<ConeEntry | null>;
  /** Add a new entry. Implementations enforce no-duplicate-sandboxId. */
  append(entry: ConeEntry): Promise<void>;
  /** Partial update by sandboxId. Throws if not found. */
  update(sandboxId: string, patch: Partial<ConeEntry>): Promise<void>;
  /** Remove by sandboxId. Idempotent — no-op if absent. */
  remove(sandboxId: string): Promise<void>;
}
```

- [ ] **Step 3: Re-export from cloud-core/src/index.ts**

```ts
export type { Registry } from './registry.js';
```

- [ ] **Step 4: Create node-server's file-backed implementation**

Create `packages/node-server/src/cloud/registry-file.ts`. Move the class out of `registry.ts`, rename to `FileRegistry`, and have it `implements Registry`:

```ts
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import type { ConeEntry, Registry } from '@slicc/cloud-core';

// Lightweight runtime guard for entries read off disk; existing isCloudSessionEntry
// validation logic stays in this file.
function isConeEntry(x: unknown): x is ConeEntry {
  if (typeof x !== 'object' || x === null) return false;
  const e = x as Record<string, unknown>;
  return (
    typeof e['sandboxId'] === 'string' &&
    typeof e['createdAt'] === 'string' &&
    typeof e['lastSeen'] === 'string' &&
    (e['state'] === 'running' || e['state'] === 'paused' || e['state'] === 'dead')
  );
}

export class FileRegistry implements Registry {
  constructor(public readonly path: string) {}

  async list(): Promise<ConeEntry[]> {
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(this.path, 'utf-8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    if (typeof raw !== 'object' || raw === null) return [];
    // Preserve the legacy { sessions } schema used by existing ~/.slicc/cloud-sessions.json
    // files. DO NOT rename to `entries` — that'd silently empty out paused-cone state for
    // every existing CLI user on upgrade.
    const sessions = (raw as { sessions?: unknown }).sessions;
    if (!Array.isArray(sessions)) return [];
    return sessions.filter(isConeEntry);
  }

  async findByNameOrId(query: string): Promise<ConeEntry | null> {
    const entries = await this.list();
    return entries.find((e) => e.sandboxId === query || e.name === query) ?? null;
  }

  // Behavior contract: existing CLI's `append` was upsert. Preserve upsert here so
  // re-starting a sandbox with the same id (or a recovery rebuild that races) doesn't
  // throw. Tests must assert upsert semantics.
  async append(entry: ConeEntry): Promise<void> {
    const entries = await this.list();
    const i = entries.findIndex((e) => e.sandboxId === entry.sandboxId);
    if (i >= 0) {
      entries[i] = { ...entries[i]!, ...entry };
    } else {
      entries.push(entry);
    }
    await this.writeAll(entries);
  }

  async update(sandboxId: string, patch: Partial<ConeEntry>): Promise<void> {
    const entries = await this.list();
    const idx = entries.findIndex((e) => e.sandboxId === sandboxId);
    if (idx < 0) throw new Error(`entry not found: ${sandboxId}`);
    entries[idx] = { ...entries[idx]!, ...patch };
    await this.writeAll(entries);
  }

  async remove(sandboxId: string): Promise<void> {
    const entries = await this.list();
    const filtered = entries.filter((e) => e.sandboxId !== sandboxId);
    await this.writeAll(filtered);
  }

  private async writeAll(entries: ConeEntry[]): Promise<void> {
    await fs.mkdir(dirname(this.path), { recursive: true });
    // Preserve { sessions } schema for backwards-compat with existing files.
    await fs.writeFile(this.path, JSON.stringify({ sessions: entries }, null, 2));
  }
}
```

- [ ] **Step 5: Delete the old registry.ts**

```bash
rm packages/node-server/src/cloud/registry.ts
```

- [ ] **Step 6: Update consumers**

`grep -rn "from './registry" packages/node-server/src/` and replace each `CloudSessionRegistry` reference with `FileRegistry` imported from `./registry-file.js`.

- [ ] **Step 7: Update the registry test**

Move `packages/node-server/tests/cloud/registry.test.ts` references from `CloudSessionRegistry` to `FileRegistry`, import path `'../../src/cloud/registry-file.js'`. The test logic stays the same.

- [ ] **Step 8: Verify**

```bash
npm run typecheck && npx vitest run --project node-server
```

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor(cloud-core): Registry interface; FileRegistry impl in node-server"
```

---

### Task A9: Move startCone operation to cloud-core

**Files:**

- Create: `packages/cloud-core/src/operations/start.ts`
- Modify: `packages/node-server/src/cloud/start.ts` → thin wrapper

- [ ] **Step 1: Read existing start.ts in node-server**

Identify the runStart function's pure logic (substrate.create + writeFile + poll + registry.append).

- [ ] **Step 2: Create cloud-core/src/operations/start.ts**

```ts
import { CloudError } from '../errors.js';
import { filterSecretsEnv } from '../secrets-filter.js';
import { pollCloudStatus } from '../polling.js';
import type { Registry } from '../registry.js';
import type { SandboxSubstrate } from '../substrate.js';
import type { ConeEntry, StartResult } from '../types.js';

export interface StartConeOpts {
  /** Full secrets.env content (already read from disk by the caller). */
  envContents: string;
  /** Tray worker base URL exported to the sandbox. */
  workerBaseUrl: string;
  /** Substrate template ID (default 'slicc'). */
  template?: string;
  /** Optional user-supplied name. */
  name?: string;
  /** SLICC version string for the registry metadata. */
  sliccVersion: string;
  /** Additional metadata to tag on the substrate sandbox (e.g. userId). */
  metadata?: Record<string, string>;
  /** Substrate envs passed at create. The token write to /slicc/secrets.env
   * happens inside start.sh via these. */
  envs?: Record<string, string>;
  /** How long to wait for the leader to write /tmp/slicc-join.json. */
  pollTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Auto-pause on e2b idle. Default true. */
  autoPauseOnCap?: boolean;
}

export interface StartConeDeps {
  substrate: SandboxSubstrate;
  registry: Registry;
}

export async function startCone(deps: StartConeDeps, opts: StartConeOpts): Promise<StartResult> {
  // filterSecretsEnv stays in scope for the worker too (it strips E2B_API_KEY
  // whether the caller sourced the file from disk or stitched envs together).
  const safeSecrets = filterSecretsEnv(opts.envContents);

  const handle = await deps.substrate.create({
    template: opts.template ?? 'slicc',
    autoPauseOnCap: opts.autoPauseOnCap ?? true,
    envVars: {
      SLICC_TRAY_WORKER_BASE_URL: opts.workerBaseUrl,
      ...(opts.envs ?? {}),
    },
    metadata: {
      sliccVersion: opts.sliccVersion,
      ...(opts.name ? { name: opts.name } : {}),
      ...(opts.metadata ?? {}),
    },
  });

  // The CLI path historically wrote secrets.env via files.write here. We KEEP
  // that for backwards compatibility with the existing template (in case the
  // env-based bootstrap from Plan B hasn't shipped yet). It's idempotent:
  // start.sh prefers env-derived secrets and only falls through to existing
  // file content if envs aren't set. Plan B removes this line.
  await handle.writeFile('/slicc/secrets.env', safeSecrets);

  let status: Awaited<ReturnType<typeof pollCloudStatus>>;
  try {
    status = await pollCloudStatus(handle, {
      timeoutMs: opts.pollTimeoutMs ?? 120_000,
      intervalMs: opts.pollIntervalMs ?? 500,
    });
  } catch (err) {
    // Best-effort cleanup of the partially-created sandbox so the user isn't
    // billed for an orphan. Failure here is non-fatal.
    try {
      await handle.kill();
    } catch {
      /* swallow — surfacing the start error is more useful. */
    }
    throw new CloudError('SANDBOX_NOT_READY', err instanceof Error ? err.message : String(err), {
      sandboxId: handle.sandboxId,
    });
  }

  const now = new Date().toISOString();
  const entry: ConeEntry = {
    sandboxId: handle.sandboxId,
    name: opts.name,
    createdAt: now,
    lastSeen: now,
    state: 'running',
    joinUrl: status.joinUrl,
    trayId: status.trayId,
    lastJoinUpdatedAt: status.updatedAt,
    sliccVersion: opts.sliccVersion,
    controllerUrl: status.controllerUrl,
    webhookUrl: status.webhookUrl,
    runtime: status.runtime,
  };
  await deps.registry.append(entry);

  return {
    sandboxId: handle.sandboxId,
    name: opts.name,
    joinUrl: status.joinUrl,
    trayId: status.trayId,
  };
}
```

- [ ] **Step 3: Re-export from cloud-core/src/index.ts**

```ts
export { startCone } from './operations/start.js';
export type { StartConeOpts, StartConeDeps } from './operations/start.js';
```

- [ ] **Step 4: Rewrite node-server's start.ts as a thin wrapper**

```ts
import { promises as fs } from 'node:fs';
import { startCone, type StartResult } from '@slicc/cloud-core';
import type { SandboxSubstrate } from '@slicc/cloud-core';
import { FileRegistry } from './registry-file.js';

export interface RunStartOpts {
  substrate: SandboxSubstrate;
  envFilePath: string;
  registryPath: string;
  sliccVersion: string;
  workerBaseUrl: string;
  name?: string;
  template?: string;
  pollTimeoutMs?: number;
}

export async function runStart(opts: RunStartOpts): Promise<StartResult> {
  const envContents = await fs.readFile(opts.envFilePath, 'utf-8');
  const registry = new FileRegistry(opts.registryPath);
  return startCone(
    { substrate: opts.substrate, registry },
    {
      envContents,
      workerBaseUrl: opts.workerBaseUrl,
      template: opts.template,
      name: opts.name,
      sliccVersion: opts.sliccVersion,
      pollTimeoutMs: opts.pollTimeoutMs,
    }
  );
}
```

- [ ] **Step 5: Write a cloud-core operations test**

Create `packages/cloud-core/tests/start.test.ts` exercising startCone against FakeSubstrate (you'll move FakeSubstrate in Task A14 — for now copy it into the test):

```ts
import { describe, it, expect } from 'vitest';
import { startCone } from '../src/operations/start.js';
import type { Registry } from '../src/registry.js';
import type { ConeEntry } from '../src/types.js';
// FakeSubstrate will be imported from ./fake-substrate.js after Task A14;
// for this task, inline a minimal fake:
import type { SandboxSubstrate, SandboxHandle } from '../src/substrate.js';

function makeFakeSubstrate(): SandboxSubstrate {
  return {
    id: 'e2b',
    async create() {
      const handle: SandboxHandle = {
        sandboxId: 'sbx-fake',
        substrate: 'e2b',
        pause: async () => {},
        kill: async () => {},
        getInfo: async () => ({
          sandboxId: 'sbx-fake',
          state: 'running',
          metadata: {},
          createdAt: new Date().toISOString(),
        }),
        writeFile: async () => {},
        readFile: async () =>
          JSON.stringify({
            joinUrl: 'https://w/join/x',
            trayId: 't',
            updatedAt: '2026-05-26T00:00:00.000Z',
          }),
        run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      };
      return handle;
    },
    async connect() {
      throw new Error('not used in start');
    },
    async list() {
      return [];
    },
  };
}

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
    if (i < 0) throw new Error('not found');
    this.entries[i] = { ...this.entries[i]!, ...patch };
  }
  async remove(id: string) {
    this.entries = this.entries.filter((e) => e.sandboxId !== id);
  }
}

describe('startCone', () => {
  it('creates a sandbox, polls join.json, appends to registry', async () => {
    const substrate = makeFakeSubstrate();
    const registry = new MemRegistry();
    const result = await startCone(
      { substrate, registry },
      {
        envContents: 'A=1\n',
        workerBaseUrl: 'https://w',
        sliccVersion: 'test',
        name: 'smoke',
      }
    );
    expect(result.joinUrl).toBe('https://w/join/x');
    const entries = await registry.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe('smoke');
  });
});
```

- [ ] **Step 6: Verify**

```bash
npx vitest run --project cloud-core
npx vitest run --project node-server
```

(If vitest doesn't auto-discover the new package's tests, add `'packages/cloud-core/tests/**/*.test.ts'` to the workspace vitest config.)

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(cloud-core): move startCone operation"
```

---

### Task A10: Move listCones operation

**Files:**

- Create: `packages/cloud-core/src/operations/list.ts`
- Modify: `packages/node-server/src/cloud/list.ts` → thin wrapper

- [ ] **Step 1: Create operations/list.ts**

```ts
import type { Registry } from '../registry.js';
import type { SandboxSubstrate } from '../substrate.js';
import type { ConeEntry } from '../types.js';

export interface ListConesDeps {
  substrate: SandboxSubstrate;
  registry: Registry;
}

export interface ListConesOpts {
  /** Restrict substrate.list to sandboxes whose metadata matches.
   * Worker passes { userId } to scope per-user. CLI passes nothing. */
  metadata?: Record<string, string>;
}

/**
 * List the user's cones. Reconciles the registry against the substrate's view:
 *  - DO entries missing from substrate → marked 'dead'
 *  - Substrate entries missing from DO → rebuilt and added
 *  - State disagreements → substrate wins, registry updated
 */
export async function listCones(
  deps: ListConesDeps,
  opts: ListConesOpts = {}
): Promise<ConeEntry[]> {
  const registryEntries = await deps.registry.list();
  const live = await deps.substrate.list({ metadata: opts.metadata });
  const liveById = new Map(live.map((s) => [s.sandboxId, s] as const));

  // Pass 1: walk registry; reconcile state.
  const reconciled: ConeEntry[] = [];
  for (const entry of registryEntries) {
    const liveEntry = liveById.get(entry.sandboxId);
    if (!liveEntry) {
      // Substrate doesn't know about it — sandbox expired or was killed externally.
      if (entry.state !== 'dead') {
        await deps.registry.update(entry.sandboxId, { state: 'dead' });
      }
      reconciled.push({ ...entry, state: 'dead' });
      continue;
    }
    if (entry.state !== liveEntry.state) {
      await deps.registry.update(entry.sandboxId, { state: liveEntry.state });
    }
    reconciled.push({ ...entry, state: liveEntry.state });
    liveById.delete(entry.sandboxId);
  }

  // Pass 2: any substrate entries not in registry — recover from metadata.
  for (const summary of liveById.values()) {
    const now = new Date().toISOString();
    const recovered: ConeEntry = {
      sandboxId: summary.sandboxId,
      name: summary.metadata?.['name'] ?? summary.name,
      createdAt: summary.metadata?.['createdAt'] ?? now,
      lastSeen: now,
      state: summary.state,
      metadata: summary.metadata,
    };
    await deps.registry.append(recovered);
    reconciled.push(recovered);
  }
  return reconciled;
}
```

- [ ] **Step 2: Re-export**

In `packages/cloud-core/src/index.ts`:

```ts
export { listCones } from './operations/list.js';
export type { ListConesDeps, ListConesOpts } from './operations/list.js';
```

- [ ] **Step 3: Rewrite node-server's list.ts**

```ts
import { listCones, type ConeEntry, type SandboxSubstrate } from '@slicc/cloud-core';
import { FileRegistry } from './registry-file.js';

export interface RunListOpts {
  substrate: SandboxSubstrate;
  registryPath: string;
}

export async function runList(opts: RunListOpts): Promise<ConeEntry[]> {
  const registry = new FileRegistry(opts.registryPath);
  return listCones({ substrate: opts.substrate, registry });
}
```

- [ ] **Step 4: Verify**

```bash
npm run typecheck && npx vitest run --project node-server
```

The existing `tests/cloud/list.test.ts` should still pass — `runList` is now a thin wrapper but its behavior is unchanged.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(cloud-core): move listCones with reconciliation logic"
```

---

### Task A11: Move pauseCone operation

**Files:**

- Create: `packages/cloud-core/src/operations/pause.ts`
- Modify: `packages/node-server/src/cloud/pause.ts` → wrapper

- [ ] **Step 1: Create operations/pause.ts**

```ts
import { CloudError } from '../errors.js';
import type { Registry } from '../registry.js';
import type { SandboxSubstrate } from '../substrate.js';

export interface PauseConeDeps {
  substrate: SandboxSubstrate;
  registry: Registry;
}

export async function pauseCone(deps: PauseConeDeps, query: string): Promise<void> {
  const entry = await deps.registry.findByNameOrId(query);
  if (!entry) throw new CloudError('NOT_FOUND', `cloud session not found: ${query}`);
  if (entry.state === 'paused') {
    throw new CloudError('ALREADY_PAUSED', `cloud session is already paused: ${query}`);
  }
  const handle = await deps.substrate.connect(entry.sandboxId);
  await handle.pause();
  await deps.registry.update(entry.sandboxId, {
    state: 'paused',
    lastSeen: new Date().toISOString(),
  });
}
```

- [ ] **Step 2: Re-export**

```ts
export { pauseCone } from './operations/pause.js';
export type { PauseConeDeps } from './operations/pause.js';
```

- [ ] **Step 3: Rewrite node-server's pause.ts**

```ts
import { pauseCone, type SandboxSubstrate } from '@slicc/cloud-core';
import { FileRegistry } from './registry-file.js';

export interface RunPauseOpts {
  substrate: SandboxSubstrate;
  registryPath: string;
  query: string;
}

export async function runPause(opts: RunPauseOpts): Promise<void> {
  const registry = new FileRegistry(opts.registryPath);
  return pauseCone({ substrate: opts.substrate, registry }, opts.query);
}
```

- [ ] **Step 4: Verify**

```bash
npm run typecheck && npx vitest run --project node-server
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(cloud-core): move pauseCone operation"
```

---

### Task A12: Move resumeCone operation

**Files:**

- Create: `packages/cloud-core/src/operations/resume.ts`
- Modify: `packages/node-server/src/cloud/resume.ts` → wrapper

- [ ] **Step 1: Create operations/resume.ts**

Move the resume logic verbatim from `packages/node-server/src/cloud/resume.ts`, adjusting imports. Result-shape and KICK_CMD stay the same. Key changes vs the existing code:

- Imports from `../substrate.js`, `../registry.js`, `../errors.js`, `../polling.js`, `../types.js`
- Throws `CloudError('LEADER_NOT_READY', ...)` instead of `Error`
- Takes a `{ substrate, registry }` deps object instead of `RunResumeOpts`

```ts
import { CloudError } from '../errors.js';
import { pollForRefreshedStatus } from '../polling.js';
import type { Registry } from '../registry.js';
import type { SandboxSubstrate, SandboxHandle } from '../substrate.js';
import type { ResumeResult } from '../types.js';

export interface ResumeConeDeps {
  substrate: SandboxSubstrate;
  registry: Registry;
}

export interface ResumeConeOpts {
  query: string;
  localSliccVersion: string;
  /** If supplied, written to /slicc/secrets.env after resume and before the
   * leader-restart kick. Workers use this with the user's current Bearer
   * to refresh the in-sandbox IMS token. CLI passes undefined for now;
   * Plan B adds CLI support too. */
  refreshSecretsContents?: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

const KICK_CMD =
  'curl -sS -X POST http://localhost:5710/api/leader-restart -o /dev/null -w "%{http_code}"';

export async function resumeCone(
  deps: ResumeConeDeps,
  opts: ResumeConeOpts
): Promise<ResumeResult> {
  const entry = await deps.registry.findByNameOrId(opts.query);
  if (!entry) throw new CloudError('NOT_FOUND', `cloud session not found: ${opts.query}`);
  if (entry.state === 'running') {
    throw new CloudError('ALREADY_RUNNING', `cloud session is already running: ${opts.query}`);
  }

  const baselineUpdatedAt = entry.lastJoinUpdatedAt;
  const baselineTrayId = entry.trayId;
  const handle = await deps.substrate.connect(entry.sandboxId);

  if (opts.refreshSecretsContents !== undefined) {
    await handle.writeFile('/slicc/secrets.env', opts.refreshSecretsContents);
  }

  const kicked = await kickLeaderUntilReady(handle);
  if (!kicked) {
    throw new CloudError(
      'LEADER_NOT_READY',
      'Failed to kick leader after 5 retries (sandbox may not be healthy)'
    );
  }

  const refreshed = await pollForRefreshedStatus(handle, baselineUpdatedAt, {
    timeoutMs: opts.pollTimeoutMs ?? 60_000,
    intervalMs: opts.pollIntervalMs ?? 500,
  });

  const trayRebuilt = Boolean(
    baselineTrayId && refreshed.trayId && baselineTrayId !== refreshed.trayId
  );
  const versionMismatch =
    refreshed.sliccVersion && refreshed.sliccVersion !== opts.localSliccVersion
      ? { running: refreshed.sliccVersion, local: opts.localSliccVersion }
      : undefined;

  await deps.registry.update(entry.sandboxId, {
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

async function kickLeaderUntilReady(handle: SandboxHandle): Promise<boolean> {
  for (let i = 0; i < 5; i++) {
    const result = await handle.run(KICK_CMD);
    if (result.exitCode === 0) {
      const status = result.stdout.trim();
      if (status === '200') return true;
      if (status !== '503') {
        throw new CloudError(
          'LEADER_NOT_READY',
          `/api/leader-restart returned unexpected status ${status}`
        );
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}
```

- [ ] **Step 2: Re-export**

```ts
export { resumeCone } from './operations/resume.js';
export type { ResumeConeDeps, ResumeConeOpts } from './operations/resume.js';
```

- [ ] **Step 3: Rewrite node-server's resume.ts**

```ts
import { resumeCone, type ResumeResult, type SandboxSubstrate } from '@slicc/cloud-core';
import { FileRegistry } from './registry-file.js';

export interface RunResumeOpts {
  substrate: SandboxSubstrate;
  registryPath: string;
  query: string;
  localSliccVersion: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

export async function runResume(opts: RunResumeOpts): Promise<ResumeResult> {
  const registry = new FileRegistry(opts.registryPath);
  return resumeCone(
    { substrate: opts.substrate, registry },
    {
      query: opts.query,
      localSliccVersion: opts.localSliccVersion,
      pollIntervalMs: opts.pollIntervalMs,
      pollTimeoutMs: opts.pollTimeoutMs,
    }
  );
}
```

- [ ] **Step 4: Verify**

```bash
npm run typecheck && npx vitest run --project node-server
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(cloud-core): move resumeCone operation with refreshSecrets hook"
```

---

### Task A13: Move killCone operation

**Files:**

- Create: `packages/cloud-core/src/operations/kill.ts`
- Modify: `packages/node-server/src/cloud/kill.ts` → wrapper

- [ ] **Step 1: Create operations/kill.ts**

```ts
import { CloudError } from '../errors.js';
import type { Registry } from '../registry.js';
import type { SandboxSubstrate } from '../substrate.js';

export interface KillConeDeps {
  substrate: SandboxSubstrate;
  registry: Registry;
}

export async function killCone(deps: KillConeDeps, query: string): Promise<void> {
  const entry = await deps.registry.findByNameOrId(query);
  if (!entry) throw new CloudError('NOT_FOUND', `cloud session not found: ${query}`);
  try {
    const handle = await deps.substrate.connect(entry.sandboxId);
    await handle.kill();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const notFound = /not found|unknown sandbox|404|does not exist/i.test(msg);
    if (!notFound) {
      throw new CloudError(
        'INTERNAL',
        `substrate.kill failed (${entry.sandboxId}): ${msg}. Registry entry NOT removed.`
      );
    }
    // else: substrate doesn't know about it; proceed with registry cleanup.
  }
  await deps.registry.remove(entry.sandboxId);
}
```

- [ ] **Step 2: Re-export**

```ts
export { killCone } from './operations/kill.js';
export type { KillConeDeps } from './operations/kill.js';
```

- [ ] **Step 3: Rewrite node-server's kill.ts**

```ts
import { killCone, type SandboxSubstrate } from '@slicc/cloud-core';
import { FileRegistry } from './registry-file.js';

export interface RunKillOpts {
  substrate: SandboxSubstrate;
  registryPath: string;
  query: string;
}

export async function runKill(opts: RunKillOpts): Promise<void> {
  const registry = new FileRegistry(opts.registryPath);
  return killCone({ substrate: opts.substrate, registry }, opts.query);
}
```

- [ ] **Step 4: Verify**

```bash
npm run typecheck && npx vitest run --project node-server
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(cloud-core): move killCone operation"
```

---

### Task A14: Move FakeSubstrate to cloud-core

**Files:**

- Move: `packages/node-server/tests/cloud/fake-substrate.ts` → `packages/cloud-core/tests/fake-substrate.ts`
- Modify: every test that imports it

- [ ] **Step 1: Move the file**

```bash
mkdir -p packages/cloud-core/tests
git mv packages/node-server/tests/cloud/fake-substrate.ts packages/cloud-core/tests/fake-substrate.ts
```

Update its imports inside the moved file to `../src/substrate.js` and `../src/types.js`.

- [ ] **Step 2: Update test imports**

`grep -rn "fake-substrate" packages/node-server/tests/` — for each test that imports FakeSubstrate, replace:

```ts
// before:
import { FakeSubstrate } from './fake-substrate.js';
// after:
import { FakeSubstrate } from '@slicc/cloud-core/tests/fake-substrate';
```

(If TypeScript balks at the deep-test import, add `"types": ["./tests/fake-substrate.ts"]` to cloud-core's package.json exports, or use a relative path through node_modules. Pick whichever the typecheck accepts cleanly.)

- [ ] **Step 3: Replace the inline fake in cloud-core's start.test.ts**

In `packages/cloud-core/tests/start.test.ts` (created in Task A9), remove the inline `makeFakeSubstrate` and import the moved `FakeSubstrate` instead.

- [ ] **Step 4: Verify**

```bash
npm run typecheck && npm run test
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(cloud-core): move FakeSubstrate test helper"
```

---

### Task A15: Cleanup and final verification

**Files:**

- Delete: `packages/node-server/src/cloud/substrate.ts` (the shim from Task A4)
- Delete: `packages/node-server/src/cloud/substrates/e2b.ts` (the shim from Task A5)
- Modify: any remaining direct imports of these shimmed paths in node-server → import from `@slicc/cloud-core`

- [ ] **Step 1: Find remaining shim consumers**

```bash
grep -rn "from './substrate'\\|from './substrates/e2b'" packages/node-server/src/
```

For each match, replace with `from '@slicc/cloud-core'`.

- [ ] **Step 2: Delete the shims**

```bash
rm packages/node-server/src/cloud/substrate.ts
rm -r packages/node-server/src/cloud/substrates
```

- [ ] **Step 3: Run all the gates**

```bash
npx prettier --write packages/cloud-core packages/node-server/src/cloud
npm run typecheck
npm run test
npm run build -w @slicc/node-server -w @slicc/webapp
```

Expected: all green. Test count should match pre-refactor (no tests dropped).

- [ ] **Step 4: Run the live test (opt-in)**

```bash
SLICC_TEST_E2B_API_KEY="$E2B_API_KEY" \
  npx vitest run --project node-server packages/node-server/tests/cloud-live.test.ts
```

Expected: 1 passed. Confirms the e2b round-trip is unchanged.

- [ ] **Step 5: Commit cleanup**

```bash
git add -A
git commit -m "refactor(cloud-core): drop transitional shims; node-server imports @slicc/cloud-core directly"
```

---

### Task A16: Extend inline-shared.mjs to also inline cloud-core

**Files:**

- Modify: `packages/node-server/scripts/inline-shared.mjs`
- Modify: `packages/node-server/package.json` build script ordering

**Why:** the published `sliccy` npm tarball ships `dist/node-server/` but does NOT include private workspace packages. Today `inline-shared.mjs` inlines `@slicc/shared-ts` into `dist/node-server/_shared/`. We need the same treatment for `@slicc/cloud-core` so `node dist/node-server/index.js` works after `npm install sliccy` on a clean machine.

- [ ] **Step 1: Read current inline-shared.mjs**

```bash
cat packages/node-server/scripts/inline-shared.mjs
```

Understand the existing pattern: it copies `packages/shared-ts/dist/` into `dist/node-server/_shared/`, then rewrites `from '@slicc/shared-ts'` imports in `dist/node-server/**/*.{js,d.ts}` to relative paths.

- [ ] **Step 2: Add a second inline pass for cloud-core**

Either refactor the script into a parameterized "inline workspace dep" function, or copy the existing pattern. For minimal churn, copy the pattern:

```mjs
// After the existing shared-ts inline block, add:

const cloudCoreDist = resolve(repoRoot, 'packages/cloud-core/dist');
const inlinedCloudCoreDir = resolve(nodeServerDist, '_cloud-core');

if (!existsSync(cloudCoreDist)) {
  console.error(
    `[inline-shared] @slicc/cloud-core dist not found at ${cloudCoreDist}. ` +
      `Build @slicc/cloud-core first.`
  );
  process.exit(1);
}

// Copy cloud-core/dist/ → dist/node-server/_cloud-core/
copyDirRecursive(cloudCoreDist, inlinedCloudCoreDir);

// Rewrite '@slicc/cloud-core' imports → relative './_cloud-core/index.js'
// Rewrite '@slicc/cloud-core/tests/fake-substrate' → relative
//   './_cloud-core/tests/fake-substrate.js'
rewriteImports(nodeServerDist, [
  ['@slicc/cloud-core/tests/fake-substrate', '_cloud-core/tests/fake-substrate.js'],
  ['@slicc/cloud-core', '_cloud-core/index.js'],
]);

console.log('[inline-shared] inlined @slicc/cloud-core into', inlinedCloudCoreDir);
```

(The exact helper names — `copyDirRecursive`, `rewriteImports` — depend on the script's current shape. Refactor what's there to be reusable across both shared-ts and cloud-core.)

- [ ] **Step 3: Update node-server's build script**

In `packages/node-server/package.json`, prepend a cloud-core build to ensure `packages/cloud-core/dist/` exists before inline-shared runs:

```jsonc
"build": "node --input-type=module -e \"import { rmSync } from 'node:fs'; rmSync('../../dist/node-server', { recursive: true, force: true });\" && npm run build -w @slicc/shared-ts && npm run build -w @slicc/cloud-core && tsc -p ../../tsconfig.cli.json && node scripts/inline-shared.mjs"
```

(If the root `npm run build` already builds shared-ts before node-server, mirror that pattern for cloud-core. Adapt to whatever the actual current sequencing is.)

- [ ] **Step 4: Verify the inline works end-to-end**

```bash
npm run build
ls dist/node-server/_cloud-core
grep -l "from '@slicc/cloud-core'" dist/node-server/**/*.js || echo "all rewritten"
```

Expected: `_cloud-core` directory exists with the compiled output; no remaining `'@slicc/cloud-core'` imports in dist (all rewritten to relative paths).

- [ ] **Step 5: Sanity-check sliccy can run from dist**

```bash
node dist/node-server/index.js --help
```

Expected: prints CLI usage; no MODULE_NOT_FOUND for `@slicc/cloud-core`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "build(node-server): inline @slicc/cloud-core for published-tarball case"
```

---

## Plan A done

End state: `packages/cloud-core/` is a complete shared package. `packages/node-server/src/cloud/` is reduced to dispatcher + thin wrappers + FileRegistry. Live e2b round-trip still works. No behavior changes from a user's perspective. Plans B and D both consume `@slicc/cloud-core` directly.
