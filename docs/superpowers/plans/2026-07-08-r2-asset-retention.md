# R2 Asset Retention — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Keep content-hashed `/assets/*` chunks in a per-env R2 bucket across deploys so long-lived tabs stop crashing (#1330) on gone lazy chunks; the worker serves archived chunks on an ASSETS miss, and every deploy uploads its assets to the archive before going live.

**Architecture:** Cloudflare Worker (`packages/cloudflare-worker`) gains an `ASSET_ARCHIVE` R2 binding. A new `serveAssetWithArchiveFallback` handles `/assets/*` GET/HEAD: serve the current build from `ASSETS`; on a miss (ASSETS returns the SPA `text/html` shell) serve the archived bytes from R2 with `immutable` cache, else fall back to today's shell (the shipped #1364 reload). A shared pure module supplies the hashed-asset predicate + MIME map, used by both the worker and the upload script. A Node upload script (`scripts/upload-assets-to-r2.mjs`) re-puts the full current asset set to the bucket before each `wrangler deploy`, wired into all four deploy paths.

**Tech stack:** TypeScript (worker, `@cloudflare/workers-types`), Vitest, Node ESM script, `wrangler r2`, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-07-08-r2-asset-retention-design.md` (read it; this plan implements **option A**).

## Global Constraints

- **Option A only** — pure 14-day age-based GC, **no manifest/touch job**. Option B is future work; do not build it.
- **Conditional (304/412) and Range (206) NOT implemented** for archived assets — serve full `200` / bodyless `HEAD` with validators; ignore any `Range`/`If-*` headers. (Present assets served via `ASSETS` keep platform behavior.)
- **Hash invariant enforced** — the upload script fails if any `dist/ui/assets/*` name lacks a content hash; the worker gate requires the same predicate. Worker + script import **one** shared predicate.
- **Deploy gated on upload** — every deploy path runs the upload as a single hard-fail step (`continue-on-error: false`) after build and before the first deploy attempt.
- **Per-env buckets** — `slicc-asset-archive` (prod) / `slicc-asset-archive-staging` (staging). Preview worker excluded.
- **Never `500` an asset request** — any R2 error → fall back to the shell.
- **Verification each task:** `npm run lint:ci`, `npm run deadcode`, `npm run typecheck`, `npm run test:coverage:cloudflare-worker` (kept ≥ floor), `npx prettier --write` before commit. No Co-Authored-By trailer. Keep `docs/superpowers/` commits (release strips them).
- **Manual Cloudflare ops are prerequisites, not code** (Task 7 runbook): create both R2 buckets; apply the 14-day lifecycle rule; grant the deploy API token R2 Object Read&Write. CI upload/deploy will fail until these exist.

## File Structure

- Create `packages/cloudflare-worker/src/asset-archive.mjs` (+ `asset-archive.d.mts`) — pure ESM helpers: `HASHED_ASSET_RE`, `matchHashedAssetPath`, `mimeForAssetPath`. **Plain `.mjs` (not `.ts`)** so the Node upload script can import it directly at runtime (no build step); the worker (TS, wrangler/esbuild-bundled) imports `'./asset-archive.mjs'` and TS resolves the co-located **`.d.mts`** declaration (an explicit-ESM `.d.mts` is required — `tsconfig.worker.json` has no `allowJs`, and a plain `.d.ts` is not a reliable companion for a `.mjs` import). **This is the single source of the predicate/MIME for both realms.** **Rule for this feature: every `.mjs` that a `.ts`/`.test.ts` imports must have a co-located `.d.mts`; a runnable CLI `.mjs` that no TS file imports needs none.**
- Modify `packages/cloudflare-worker/src/index.ts` — `WorkerEnv.ASSET_ARCHIVE`; thread `ExecutionContext` (`ctx`) from `worker.fetch` through `handleWorkerRequest`; add `serveAssetWithArchiveFallback`; wire into dispatch before the SPA/JSON split. Do **not** change `ROUTES_INDEX_BODY` (no new route).
- Modify `packages/cloudflare-worker/wrangler.jsonc` — `r2_buckets` binding (top-level + `env.staging`).
- Create `packages/cloudflare-worker/scripts/upload-lib.mjs` (+ `upload-lib.d.mts`) — the testable pure/injectable helpers (`assertAllHashed`, `buildPutArgs`, `runUploads`); and `packages/cloudflare-worker/scripts/upload-assets-to-r2.mjs` — the thin runnable CLI wrapper (imports `upload-lib.mjs`; **not** imported by any TS, so it needs no `.d.mts`). The test imports `upload-lib.mjs` (typed via its `.d.mts`).
- Modify `packages/cloudflare-worker/scripts/publish-worker.sh` + `.github/workflows/worker.yml` + `.github/workflows/ci.yml` + `.github/workflows/worker-staging.yml` — gated upload step.
- Create `packages/cloudflare-worker/tests/asset-archive.test.ts`, `tests/upload-assets-to-r2.test.ts`; modify `tests/index.test.ts`, `tests/deployed.test.ts`.
- Modify `packages/cloudflare-worker/CLAUDE.md` (+ a runbook section) and root `CLAUDE.md` module map if needed.

---

### Task 1: Shared pure helpers (predicate + MIME)

**Files:**

- Create: `packages/cloudflare-worker/src/asset-archive.mjs` (plain ESM JS) + `packages/cloudflare-worker/src/asset-archive.d.mts` (explicit-ESM types sidecar)
- Test: `packages/cloudflare-worker/tests/asset-archive.test.ts`

**Interfaces:**

- Produces: `HASHED_ASSET_RE: RegExp`; `matchHashedAssetPath(pathname: string): boolean`; `mimeForAssetPath(pathname: string): string`. Imported by both `index.ts` (worker) and `upload-assets-to-r2.mjs` (Node) — one source.

- [ ] **Step 1: Write failing tests** (`tests/asset-archive.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import { matchHashedAssetPath, mimeForAssetPath } from '../src/asset-archive.mjs';

describe('matchHashedAssetPath', () => {
  it('accepts hashed chunk names', () => {
    expect(matchHashedAssetPath('/assets/anthropic-messages-DP3-Xd3J.js')).toBe(true);
    expect(matchHashedAssetPath('/assets/index-a1b2c3d4.css')).toBe(true);
    expect(matchHashedAssetPath('/assets/entry-abcd1234.js.map')).toBe(true);
    expect(matchHashedAssetPath('/assets/logo-DEADBEEF.svg')).toBe(true);
  });
  it('rejects non-asset / un-hashed / traversal / encoded paths', () => {
    expect(matchHashedAssetPath('/index.html')).toBe(false);
    expect(matchHashedAssetPath('/assets/index.html')).toBe(false); // wrong ext
    expect(matchHashedAssetPath('/assets/foo.js')).toBe(false); // no hash
    expect(matchHashedAssetPath('/assets/../secret-abcd1234.js')).toBe(false);
    expect(matchHashedAssetPath('/assets/a%2Fb-abcd1234.js')).toBe(false);
    expect(matchHashedAssetPath('/other/x-abcd1234.js')).toBe(false);
  });
});

describe('mimeForAssetPath', () => {
  it('maps critical types', () => {
    expect(mimeForAssetPath('/assets/x-abcd1234.js')).toBe('text/javascript');
    expect(mimeForAssetPath('/assets/x-abcd1234.mjs')).toBe('text/javascript');
    expect(mimeForAssetPath('/assets/x-abcd1234.css')).toBe('text/css');
    expect(mimeForAssetPath('/assets/x-abcd1234.wasm')).toBe('application/wasm');
    expect(mimeForAssetPath('/assets/x-abcd1234.js.map')).toBe('application/json');
    expect(mimeForAssetPath('/assets/x-abcd1234.woff2')).toBe('font/woff2');
  });
  it('falls back to octet-stream', () => {
    expect(mimeForAssetPath('/assets/x-abcd1234.zzz')).toBe('application/octet-stream');
  });
});
```

- [ ] **Step 2: Run — expect FAIL** — use a focused run: `cd packages/cloudflare-worker && npx vitest run tests/asset-archive.test.ts` (the `test:coverage:cloudflare-worker` gate ignores test-name args and always runs the whole project, so use `npx vitest run <file>` for focused iteration and the gate command only for the coverage check).

- [ ] **Step 3: Implement** (`src/asset-archive.mjs`, plain ESM — no TS annotations):

```js
/**
 * Pure helpers shared by the worker asset-serving path (TS, esbuild-bundled) and
 * the CI upload script (Node, run from source). Plain ESM so both import it with
 * no build step. No worker/DOM/Node deps.
 */

/** Vite-hashed asset under /assets/: `<name>-<8+ url-safe>[.compound].<ext>`. */
export const HASHED_ASSET_RE =
  /^\/assets\/[A-Za-z0-9][A-Za-z0-9._-]*-[A-Za-z0-9_-]{8,}(\.[a-z0-9]+)*\.(js|mjs|css|map|wasm|woff2|woff|ttf|svg|png|jpg|jpeg|gif|webp|avif|ico|json)$/;

export function matchHashedAssetPath(pathname) {
  return HASHED_ASSET_RE.test(pathname);
}

const MIME = {
  js: 'text/javascript',
  mjs: 'text/javascript',
  css: 'text/css',
  json: 'application/json',
  map: 'application/json',
  wasm: 'application/wasm',
  svg: 'image/svg+xml',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
};

export function mimeForAssetPath(pathname) {
  const ext = pathname.slice(pathname.lastIndexOf('.') + 1).toLowerCase();
  return MIME[ext] ?? 'application/octet-stream';
}
```

And the explicit-ESM types sidecar (`src/asset-archive.d.mts`) so `index.ts` gets
types from `import { … } from './asset-archive.mjs'`:

```ts
export declare const HASHED_ASSET_RE: RegExp;
export declare function matchHashedAssetPath(pathname: string): boolean;
export declare function mimeForAssetPath(pathname: string): string;
```

The `.d.mts` (not `.d.ts`) is required: `tsconfig.worker.json` has no `allowJs`,
and TS pairs a `./x.mjs` import with a `./x.d.mts` declaration. Verify with
`npm run typecheck` after adding both files.

- [ ] **Step 4: Run — expect PASS.** Validate `HASHED_ASSET_RE` against a real build if available (`ls dist/ui/assets | while read f; do node -e "..."`); adjust the hash length only if real Vite output disagrees.
- [ ] **Step 5: Commit** `feat(worker): shared hashed-asset predicate + MIME map (#1330 retention)`.

---

### Task 2: R2 binding — `WorkerEnv` type + wrangler config

**Files:**

- Modify: `packages/cloudflare-worker/src/index.ts:45` (`WorkerEnv`)
- Modify: `packages/cloudflare-worker/wrangler.jsonc`

**Interfaces:**

- Produces: `WorkerEnv.ASSET_ARCHIVE: R2Bucket` (used by Task 3).

- [ ] **Step 1:** Add to `WorkerEnv` (after `ASSETS`): `ASSET_ARCHIVE: R2Bucket;` (`R2Bucket` from `@cloudflare/workers-types`, already a dev dep). If the file avoids the global types, declare a minimal structural type `{ get(key: string): Promise<R2ObjectBody | null> }` — prefer the real `R2Bucket`.
- [ ] **Step 1b (required — else existing tests fail typecheck):** Making `ASSET_ARCHIVE` a required field breaks **every** existing `WorkerEnv` construction in `packages/cloudflare-worker/tests/**` (e.g. `index.test.ts` and any shared env factory). Grep for env objects passed to `handleWorkerRequest`/`worker.fetch` (`grep -rn "ASSETS:" packages/cloudflare-worker/tests`) and add a default fake to each — a shared helper is cleanest, e.g. a `tests/helpers/fake-env.ts` `makeEnv(overrides)` returning `{ ASSETS, ASSET_ARCHIVE: { get: async () => null }, … }`. Update all call sites to it. (Run `npm run typecheck` to enumerate the failures.)
- [ ] **Step 2:** In `wrangler.jsonc`, add a top-level `r2_buckets` array beside `assets`:

```jsonc
"r2_buckets": [
  { "binding": "ASSET_ARCHIVE", "bucket_name": "slicc-asset-archive" }
],
```

and inside `env.staging` (env configs do not inherit top-level):

```jsonc
"r2_buckets": [
  { "binding": "ASSET_ARCHIVE", "bucket_name": "slicc-asset-archive-staging" }
],
```

- [ ] **Step 3:** `npm run typecheck` (worker tsconfig) — expect PASS. `npm run build -w @slicc/cloudflare-worker` (`wrangler deploy --dry-run`) may warn that the bucket doesn't exist yet; that is fine locally (buckets are the Task 7 ops step). If the dry-run hard-fails on a missing bucket, note it and proceed (CI needs the buckets created first — documented in Task 7).
- [ ] **Step 4: Commit** `feat(worker): ASSET_ARCHIVE R2 binding (prod + staging)`.

---

### Task 3: `serveAssetWithArchiveFallback` + dispatch wiring + unit tests

**Files:**

- Modify: `packages/cloudflare-worker/src/index.ts` (new function + call before the SPA/JSON split at `~:412`)
- Test: `packages/cloudflare-worker/tests/index.test.ts`

**Interfaces:**

- Consumes: `matchHashedAssetPath`, `mimeForAssetPath` (Task 1); `WorkerEnv.ASSET_ARCHIVE` (Task 2).

- [ ] **Step 1: Write failing tests** (`tests/index.test.ts`, add a `describe('asset archive fallback')`). Build a fake `env` with `ASSETS.fetch` and an `ASSET_ARCHIVE.get` mock (the impl only calls `get`, never `head`). Cases (see spec §Testing):
  - present asset: `ASSETS` returns `200` non-HTML → returned unchanged, `ASSET_ARCHIVE.get` **not** called.
  - miss (`ASSETS` returns `200 text/html`) + archive hit → `200`, `Content-Type: text/javascript`, `ETag`, `Content-Length`, `Cache-Control: …immutable`, **no** `Accept-Ranges`.
  - `HEAD` hit → `200`, empty body.
  - request with `Range` / `If-None-Match` → still full `200`; assert `ASSET_ARCHIVE.get` called with **no** `onlyIf`/`range`.
  - miss + archive miss (`get` → null) → the shell (`200 text/html`); a `HEAD` archive-miss fallback has **no body**.
  - `get` throws → shell (never a 500).
  - non-hashed / traversal / `POST` /assets path → falls through (no archive).
  - Cache API: mock `caches.default` (or the module's cache accessor); a `GET` populates cache and a second `GET` hits it; a `HEAD` does not consult it.

  Example (present + miss hit):

```ts
function fakeEnv(assetsRes: Response, archive?: { body: string; etag: string }) {
  return {
    ASSETS: { fetch: async () => assetsRes.clone() },
    ASSET_ARCHIVE: {
      get: async () =>
        archive
          ? {
              body: archive.body,
              httpEtag: archive.etag,
              size: archive.body.length,
              writeHttpMetadata: (h: Headers) => h.set('content-type', 'text/javascript'),
              uploaded: new Date(0),
            }
          : null,
    },
  } as unknown as WorkerEnv;
}
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3a: Thread `ExecutionContext`.** Today `worker.fetch(request, env)` calls `handleWorkerRequest(request, env, fetchImpl = fetch)` — there is **no `ctx`** in scope. Add a module-level `const NOOP_CTX: ExecutionContext = { waitUntil() {}, passThroughOnException() {} } as ExecutionContext;` and change the signature to `handleWorkerRequest(request, env, ctx: ExecutionContext = NOOP_CTX, fetchImpl = fetch)`. `worker.fetch(request, env, ctx)` passes the real `ctx`. **`ctx` must be defaulted (not required)** so the many existing 2-arg `handleWorkerRequest(request, env)` / `worker.fetch(request, env)` calls in `tests/index.test.ts` still typecheck. New archive tests can pass a fake ctx to assert `waitUntil` is called, or rely on `NOOP_CTX`.
- [ ] **Step 3b: Import the shared predicate** in `index.ts`: `import { matchHashedAssetPath, mimeForAssetPath } from './asset-archive.mjs';`.
- [ ] **Step 3c: Implement** `serveAssetWithArchiveFallback` and wire it in. Insert the call in the dispatch just before the SPA/JSON split (`index.ts:~412`); do **not** modify `ROUTES_INDEX_BODY` (no new route):

```ts
// #1330 retention: serve content-hashed /assets/* from the R2 archive when the
// current build no longer has them, before the SPA fallback turns them into HTML.
if (
  (request.method === 'GET' || request.method === 'HEAD') &&
  matchHashedAssetPath(new URL(request.url).pathname)
) {
  return serveAssetWithArchiveFallback(request, env, ctx);
}
```

Function (add near `serveSPA`):

```ts
const ASSET_IMMUTABLE = 'public, max-age=31536000, immutable';

async function serveAssetWithArchiveFallback(
  request: Request,
  env: WorkerEnv,
  ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);
  const isHead = request.method === 'HEAD';

  // Classify present-vs-miss with a sanitized canonical GET so Range/conditional
  // headers can't make ASSETS answer 206/304 for the shell.
  const hasCond =
    request.headers.has('range') ||
    request.headers.has('if-none-match') ||
    request.headers.has('if-modified-since') ||
    request.headers.has('if-match') ||
    request.headers.has('if-unmodified-since');
  const probe = hasCond
    ? await env.ASSETS.fetch(new Request(url.toString(), { method: 'GET' }))
    : await env.ASSETS.fetch(request); // plain GET/HEAD: original IS the probe
  const probeCT = probe.headers.get('content-type') ?? '';
  const isMiss = (probe.status === 200 && probeCT.includes('text/html')) || probe.status === 404;

  if (!isMiss) {
    // Present: for a plain GET/HEAD the probe IS the answer; only a conditional/
    // Range request needs the original re-fetched so the platform honors it.
    return hasCond ? env.ASSETS.fetch(request) : probe;
  }

  // Miss → archive. Cache only plain GET (HEAD bypasses).
  const cache = caches.default;
  const cacheKey = new Request(`${url.origin}${url.pathname}`, { method: 'GET' });
  if (!isHead) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    } catch {
      /* cache read failure → fall through to R2; never 500 an asset */
    }
  }

  let obj: R2ObjectBody | null = null;
  try {
    obj = await env.ASSET_ARCHIVE.get(url.pathname.slice(1)); // no onlyIf/range
  } catch {
    obj = null;
  }
  if (!obj) {
    // Fallback to the shell; a HEAD must stay bodyless.
    return isHead ? new Response(null, { status: probe.status, headers: probe.headers }) : probe;
  }

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  if (!headers.has('content-type')) headers.set('content-type', mimeForAssetPath(url.pathname));
  headers.set('etag', obj.httpEtag);
  headers.set('last-modified', obj.uploaded.toUTCString());
  headers.set('cache-control', ASSET_IMMUTABLE);
  headers.set('content-length', String(obj.size));

  if (isHead) return new Response(null, { status: 200, headers });

  const res = new Response(obj.body, { status: 200, headers });
  ctx.waitUntil(cache.put(cacheKey, res.clone()).catch(() => {}));
  return res;
}
```

Notes: `R2ObjectBody`/`ExecutionContext` from `@cloudflare/workers-types`. Confirm the handler signature exposes `ctx` at the call site (thread it through if the current dispatch does not already). Asset responses intentionally skip `serveSPA`'s CSP mutation; they still pass through the outer `applySliccLinks` wrapper.

- [ ] **Step 4: Run — expect PASS**; coverage ≥ floor.
- [ ] **Step 5:** `npm run lint:ci && npm run deadcode && npm run typecheck`.
- [ ] **Step 6: Commit** `feat(worker): serve /assets/* from R2 archive on ASSETS miss (#1330)`.

---

### Task 4: Upload script (`upload-assets-to-r2.mjs`) + tests

**Files:**

- Create: `packages/cloudflare-worker/scripts/upload-lib.mjs` + `scripts/upload-lib.d.mts` (testable helpers), `packages/cloudflare-worker/scripts/upload-assets-to-r2.mjs` (thin CLI wrapper)
- Test: `packages/cloudflare-worker/tests/upload-assets-to-r2.test.ts` (imports `../scripts/upload-lib.mjs`)

**Interfaces:**

- Helpers in `upload-lib.mjs` (typed via `upload-lib.d.mts`): `assertAllHashed(names: string[]): void`; `buildPutArgs(bucket: string, file: string): string[]`; `runUploads(files: string[], opts: { bucket: string; dir: string; exec: Exec; concurrency?: number; retries? : number }): Promise<void>`. Imports `matchHashedAssetPath`/`mimeForAssetPath` from `../src/asset-archive.mjs` (single shared source, Task 1).
- CLI `upload-assets-to-r2.mjs`: `node scripts/upload-assets-to-r2.mjs <bucket> [--dir <dir>]` (default dir = repo-root `dist/ui/assets`); imports the helpers, passes the default `exec` = `execFile` of **`npx wrangler`** (a plain `run:`/shell step is not an npm script, so `node_modules/.bin` is not on `PATH`); exits non-zero on hash-invariant violation or any upload failure (after retries). Not imported by any TS → no `.d.mts` needed.

- [ ] **Step 1:** First verify the exact wrangler CLI: `npx wrangler r2 object put --help` — confirm `--file`, `--content-type`, and the remote/`--remote` flags for the pinned wrangler; adjust `buildPutArgs` accordingly.
- [ ] **Step 2: Write failing tests** (`tests/upload-assets-to-r2.test.ts`, importing `../scripts/upload-lib.mjs`). Cases:
  - `assertAllHashed` throws when a name lacks a hash (`foo.js`), passes for hashed names.
  - `buildPutArgs` yields `<bucket>/assets/<file>` + `--content-type <mime>`.
  - `runUploads` with an injected `exec` retries a failing `exec` up to N then throws; respects the concurrency cap; re-puts **every** file (no skip).
- [ ] **Step 3: Implement** `upload-lib.mjs` (+ `.d.mts`) with the injectable `exec`, `assertAllHashed`, `buildPutArgs`, bounded-concurrency `runUploads` with per-file retries; then the thin `upload-assets-to-r2.mjs` CLI (`main()` reads `--dir`, lists files, `assertAllHashed`, `runUploads` with default `npx wrangler` exec; on any rejection `process.exit(1)`).
- [ ] **Step 4: Run — expect PASS** (`cd packages/cloudflare-worker && npx vitest run tests/upload-assets-to-r2.test.ts`).
- [ ] **Step 5: Commit** `feat(worker): R2 asset upload script (assert-hash, re-put-all, retries)`.

---

### Task 5: Wire the gated upload into all four deploy paths

**Files:**

- Modify: `packages/cloudflare-worker/scripts/publish-worker.sh` (automated prod)
- Modify: `.github/workflows/worker.yml` (manual prod), `.github/workflows/ci.yml` (`cloudflare-worker` job, staging), `.github/workflows/worker-staging.yml` (staging)

- [ ] **Step 1:** `publish-worker.sh` runs from **repo root** — before its `wrangler deploy`, add (hard-fail, after the webapp build already present in the release) using the **full path** + explicit `--dir`:

```sh
node packages/cloudflare-worker/scripts/upload-assets-to-r2.mjs slicc-asset-archive --dir dist/ui/assets
```

with `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` in scope (already available to the release deploy). The script shells `npx wrangler`.

- [ ] **Step 2:** `worker.yml` — add one `run:` step **before deploy attempt 1**, `env: { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID }`, running `node packages/cloudflare-worker/scripts/upload-assets-to-r2.mjs slicc-asset-archive --dir dist/ui/assets`. Not `continue-on-error`, so its failure fails the job before any deploy attempt.
- [ ] **Step 3:** `ci.yml` `cloudflare-worker` job + `worker-staging.yml` — same, **staging** bucket (`slicc-asset-archive-staging`), inserted after the webapp build / dry-run gate and before the first staging deploy attempt. **Fork-PR guard is mandatory** (a hard-fail upload must not run without Cloudflare secrets): in `ci.yml`, copy the exact `if:` from the existing staging "Deploy … (attempt 1)" step onto the upload step. In `worker-staging.yml` the deploy attempt has **no `if:`** to copy, so add an explicit non-fork guard to the upload step (and ideally the deploy/secrets/smoke steps, or at job level), e.g. `if: github.event_name == 'push' || github.event.pull_request.head.repo.full_name == github.repository`.
- [ ] **Step 4: Verify** by inspection + `actionlint` if available; no unit test (workflow/shell). Confirm ordering (build → [dry-run] → upload → deploy), that no deploy attempt is reachable without a successful upload, and that the upload step's `if:` matches the deploy step's `if:` in each workflow.
- [ ] **Step 5: Commit** `ci(worker): upload assets to R2 before every deploy (gated)`.

---

### Task 6: Deployed smoke — staging-only archive recovery + present-asset

**Files:**

- Modify: `packages/cloudflare-worker/tests/deployed.test.ts`

- [ ] **Step 1:** Add a **present-asset** check (both envs). **Do not fetch bare `/`** — the production worker redirects `https://www.sliccy.ai/` to the `.com` marketing site before `handleWorkerRequest`, so `/` may not be the SPA. Fetch **`/?json=false`** (or another non-root SPA path) with `redirect: 'manual'` and assert it is **not** a 3xx redirect, then parse a real `/assets/*` URL from the HTML, fetch it, assert `200` + JS/CSS `Content-Type`; repeat the asset fetch with `?json=true` to confirm the asset branch runs before the JSON split. Send `Accept-Encoding: br,gzip`, record `Content-Encoding`, do **not** assert exact `Content-Length`.
- [ ] **Step 2:** Add a **staging-only archive-recovery** check. The test currently only reads `WORKER_BASE_URL`; this case needs more, so it must **self-gate**: run only when `SLICC_ARCHIVE_SMOKE === '1'` **and** `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` + a staging bucket name are present; otherwise `it.skip`. Additionally **self-verify it is pointed at staging** (assert `WORKER_BASE_URL` host matches the staging worker, e.g. contains `staging`/`workers.dev`) and hard-fail if `SLICC_ARCHIVE_SMOKE==='1'` but the base looks like production — defense-in-depth so a misconfigured env never writes to the prod bucket. It uploads a synthetic non-ASSETS `assets/r2-retention-smoke-<hash>.js` via `npx wrangler r2 object put … --remote` to the staging bucket, fetches it through the worker, asserts `200` + JS `Content-Type` + `ETag` + a working `HEAD`; a second fetch (cache hit) still serves; an unknown `assets/<hash>.js` returns the shell; then cleans up (`npx wrangler r2 object delete`).
- [ ] **Step 2b (workflow wiring):** In the **staging** smoke steps (`ci.yml` `cloudflare-worker` job + `worker-staging.yml`) pass `SLICC_ARCHIVE_SMOKE: '1'`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and the staging bucket name **in addition to** `WORKER_BASE_URL`, sharing the deploy step's `if:`. The **production** smoke (`worker.yml` / `publish-worker.sh`) must **not** set `SLICC_ARCHIVE_SMOKE`, so the R2-write case skips against prod (no prod R2 writes).
- [ ] **Step 3:** Document/verify the lifecycle rule via `wrangler r2 bucket lifecycle list <bucket>` in the runbook (Task 7); optionally assert its presence in the staging-only block.
- [ ] **Step 4: Run** the unit suite (deployed smoke runs in CI against staging; locally it skips without creds). **Commit** `test(worker): deployed smoke for R2 asset archive (staging-only) + present-asset`.

---

### Task 7: Docs + ops runbook

**Files:**

- Modify: `packages/cloudflare-worker/CLAUDE.md` (Static Asset Serving section + a new "R2 asset retention" + runbook)
- Modify: root `CLAUDE.md` only if a new cross-cutting note is warranted
- Modify: `docs/review-patterns.md` only if a new reviewer pattern emerges (likely N/A)

- [ ] **Step 1:** In `cloudflare-worker/CLAUDE.md`, document: the `ASSET_ARCHIVE` binding + per-env buckets; the ASSETS-first/R2-on-miss serving; option A GC + the build-unique limitation + option B as future work; conditional/Range not implemented; the upload-before-deploy gate across the four paths.
- [ ] **Step 2:** Add an **ops runbook** (prerequisites, must exist before CI deploys): create buckets (`wrangler r2 bucket create slicc-asset-archive` + `-staging`); apply the 14-day lifecycle (`wrangler r2 bucket lifecycle add …` / dashboard, then verify with `wrangler r2 bucket lifecycle list`); grant the deploy `CLOUDFLARE_API_TOKEN` **R2 Object Read & Write** on both buckets.
- [ ] **Step 3: Commit** `docs(worker): R2 asset retention + ops runbook (#1330)`.

---

## Self-Review (author checklist)

- Spec coverage: serving (T3), buckets/binding (T2), upload (T4), deploy gate (T5), GC/ops (T7), tests (T1/T3/T4/T6). ✓
- Types consistent: `matchHashedAssetPath`/`mimeForAssetPath` (T1) used identically in T3 + T4; `ASSET_ARCHIVE` (T2) used in T3. ✓
- No option B, no conditional/Range, no touch job. ✓
- Ops prerequisites (buckets/lifecycle/token scope) called out as non-code and blocking CI. ✓
