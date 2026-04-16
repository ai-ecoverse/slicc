# ESM Import Support for Scripts

**Date:** 2026-04-15
**Status:** Deferred

---

## Status

**Disposition:** Deferred. The code lives on `feat/esm-import-support` — do not merge.

**Forward path:** The recommended continuation is a rollup-based bundling approach where scripts are pre-bundled before execution. A spec for that work will be added separately by the user.

**Reason for deferral:**

- Relative file imports cannot be served to the main page due to a fundamental SW scope constraint (see Gap Analysis)
- Dynamic `import()` calls are not covered by the static specifier rewriter — an oversight from the importmap → blob URL pivot
- The overall approach is patching around the limitations of `AsyncFunction`-based execution rather than solving them

---

## Problem

Scripts executed via `node -e` and `.jsh` files currently only support CommonJS-style `require()` calls. Skill scripts want to use standard ESM `import` syntax (`import chalk from 'chalk'`, `import './helpers.js'`). The existing execution engine wraps code in an `AsyncFunction` body where static `import` statements are syntactically invalid.

---

## What Was Implemented

### Two approaches, one pivot

**Original approach (abandoned):** Inject a `<script type="importmap">` into the document mapping bare specifiers to absolute URLs, write the entry script to a temp VFS file, and import it via the preview SW URL so the browser treats it as a real ES module. Import maps handle both static and dynamic imports through the browser's native resolution — they would have worked for all specifier types.

**Why it failed:** The preview SW is registered with `scope: '/preview/'`. The main app page lives at `/` — outside that scope. Requests from the main page for `/preview/...` URLs are never intercepted by the SW. `import('/preview/workspace/.slicc/esm-temp/entry.mjs')` from the main page went to Vite and returned 404. Widening SW scope to `/` was rejected: it would intercept all root-relative requests from the main page, breaking Vite HMR and app assets.

**Pivot:** Rewrite all import specifiers to absolute URLs in source text before execution, then execute via blob URL. Shims served by a Vite dev middleware at `/preview/__shims/*` (bypasses SW entirely). This works for static imports but the dynamic import coverage that importmaps provided for free was not replicated.

### What was built

- `hasESMImports()` / `extractImportSpecifiers()` in `shared.ts` — detection of static ESM imports
- `rewriteImportSpecifiers()` in `esm-import-map.ts` — rewrites bare specifiers and relative imports to absolute URLs
- `buildImportMap()` in `esm-import-map.ts` — **dead code**, built for the abandoned importmap approach, exported and tested but never called in production. Should be deleted.
- `executeEsmModule()` in `jsh-executor.ts` — blob URL execution path
- Synthetic shim modules (`preview-sw-shims.ts`) for `fs`, `process`, `buffer`
- Vite dev middleware serving `/preview/__shims/*` (main page access)
- Preview SW synthetic `/__shims/*` route (for pages within `/preview/` scope)
- Extension `sandbox.html` `esm_exec` handler

---

## Verified Findings

Full test collateral: `findings/FINDINGS.md` (run 2026-04-16, environment: SLICC browser-shimmed Node v20.0.0-js-shim at `localhost:5720`).

### What works

| Test | Case                                                          |
| ---- | ------------------------------------------------------------- |
| 01   | Static import, bare specifier (`import dotenv from 'dotenv'`) |
| 02   | Static named import (`import { parse } from 'dotenv'`)        |
| 07   | `process` global                                              |
| 10   | Shell env vars passed to `process.env`                        |
| 11   | Static import of scoped package (`@adobe/rum-distiller`)      |
| 13   | Static import of `path`                                       |
| 15   | Top-level `await`                                             |
| 17   | Inline env vars (`TEST_VAR=hello node file.mjs`)              |

### What doesn't work

| Test | Case                                                                    |
| ---- | ----------------------------------------------------------------------- |
| 03   | Dynamic import, bare specifier (`await import('dotenv')`)               |
| 04   | Dynamic import, relative path (`await import('./file.mjs')`)            |
| 05   | Dynamic import, file URL                                                |
| 06   | `import.meta.url`                                                       |
| 08   | Static import of local relative file (`import { x } from './file.mjs'`) |
| 09   | `export { x } from './file.mjs'` (re-export / barrel)                   |
| 12   | Named import from `fs` (`import { readFileSync } from 'fs'`)            |
| 14   | `createRequire` from `'module'`                                         |
| 16   | `import { readFile } from 'fs/promises'`                                |

---

## Gap Analysis

### 1. Relative file imports (Tests 04, 08)

`rewriteImportSpecifiers` converts `'./foo.mjs'` to `http://localhost:PORT/preview/workspace/.../foo.mjs`. The entry blob then fetches that URL. But the preview SW only controls pages at `/preview/*` — the main page at `/` is outside scope, so the SW never intercepts. The Vite middleware only serves `__shims`, not general VFS files. A Vite middleware fix is not viable because the VFS lives in IndexedDB (browser-only) and the Vite middleware runs in Node with no access to it.

### 2. `export...from` not detected or rewritten (Test 09)

`hasESMImports()` only matches `import` statements. A file containing only `export { x } from './y.js'` (a barrel file) is classified as non-ESM and routed to the CJS/AsyncFunction path where `export` is a syntax error. Additionally, `rewriteImportSpecifiers` regex only matches `import` syntax — `export { x } from '...'` specifiers are never rewritten even when the file does reach the ESM path.

### 3. Dynamic `import()` literals not rewritten (Test 03)

`rewriteImportSpecifiers` uses a regex that only matches static `import ... from '...'` syntax. `await import('dotenv')` is not matched. With importmaps this would have resolved automatically; the pivot to source-text rewriting dropped that coverage. When a file has both static and dynamic imports, it correctly reaches the ESM blob path but dynamic specifiers are left unrewritten and fail at runtime.

### 4. `fs/promises` sub-path not shimmed (Test 16)

`fs/promises` is not in `BUILTIN_NPM_ALIASES` or `SHIMMED_BUILTINS`. It falls through to `https://esm.sh/fs/promises` which does not exist. The `import { promises as fs } from 'fs'` pattern (used in real-world skill scripts) also fails because the fs shim exports methods directly rather than as a `.promises` sub-object.

### 5. Fundamental limitations (will not be fixed by this approach)

- **`readFileSync`, `writeFileSync`, `readdirSync`** — browser cannot perform synchronous I/O
- **`import.meta.url`** — not valid in `AsyncFunction` context; in blob execution it resolves to the blob URL, not a meaningful file path
- **`createRequire`** — Node-only API; `esm.sh/module` does not include it
- **`dynamic import(variable)`** — runtime-computed specifiers cannot be statically rewritten
- **Node-core packages** (`http`, `crypto`, `streams`, `child_process`) — unavailable in browser regardless of import mechanism

---

## Proposed Fixes (Continuation Guide)

These fixes address the non-fundamental gaps. They are not large changes individually.

### Fix 1 — Inline blob bundling for relative imports

In `executeEsmModule` (`jsh-executor.ts`), before creating the entry blob: scan for relative imports in the rewritten source, read each file from VFS via `fsBridge`, create a blob URL per file, substitute the absolute preview URL with the blob URL. Recurse one level for transitive imports. Revoke all sub-blobs in the `finally` block.

### Fix 2 — `export...from` detection and rewriting

In `hasESMImports()` (`shared.ts`), add:

```typescript
const reExportRe = /(?:^|;)\s*export\s+(?:\*|\{[^}]*\})\s+from\s+['"]/m;
```

In `rewriteImportSpecifiers()` (`esm-import-map.ts`), extend the regex to also match `export { ... } from '...'` and `export * from '...'` forms.

### Fix 3 — Dynamic `import()` string literals

In `rewriteImportSpecifiers()`, add a second replace pass:

```typescript
code.replace(/\bimport\s*\(\s*(["'])([\w@/.:\-][^"']*)\1\s*\)/g, (match, quote, specifier) => {
  /* same resolution logic */
});
```

### Fix 4 — `fs/promises` shim

Two parts:

1. Map `fs/promises` and `node:fs/promises` to the existing fs shim in `esm-import-map.ts`.
2. Add a `promises` named export to the fs shim that groups the async methods into a sub-object, making `import { promises as fs } from 'fs'` work:

```typescript
export const promises = {
  readFile: globalThis.__slicc_fs.readFile,
  writeFile: globalThis.__slicc_fs.writeFile,
  mkdir: globalThis.__slicc_fs.mkdir,
  readdir: globalThis.__slicc_fs.readDir,
  stat: globalThis.__slicc_fs.stat,
  rm: globalThis.__slicc_fs.rm,
};
```

Note: `readFile` ignores the encoding argument and always returns a string — sufficient for the `utf-8` read pattern but won't return a `Buffer` when called without encoding.

### Fix 5 — Remove dead code

Delete `buildImportMap()` and its export from `esm-import-map.ts`. Delete the corresponding tests in `tests/shell/esm-import-map.test.ts`.

---

## Architecture

### Detection & Routing

Pre-scan the entry script source for static `import` statements. Two execution paths:

- **ESM detected** — blob URL execution via `executeEsmModule()`
- **CJS only / neither** — existing AsyncFunction path (unchanged)

The fork is at the top of `executeJsCode()` in `jsh-executor.ts`.

Key functions in `packages/webapp/src/shell/supplemental-commands/shared.ts`:

- `hasESMImports(code)` — returns true if code contains static `import` statements
- `extractImportSpecifiers(code)` — extracts and deduplicates module specifier strings

### Specifier Rewriting

`rewriteImportSpecifiers()` in `esm-import-map.ts` rewrites specifiers to absolute URLs before blob execution:

- Node built-ins (`fs`, `process`, `buffer`, `node:*`) → `<origin>/preview/__shims/<name>.js`
- `path` → `https://esm.sh/path-browserify`
- Unavailable built-ins (`http`, `crypto`, etc.) → error shim that throws with a helpful hint
- npm packages → `https://esm.sh/<package>`
- Relative imports → absolute preview SW URL based on the script's VFS directory (broken — see Gap Analysis)

### Shim Modules

`preview-sw-shims.ts` generates shim code that re-exports `globalThis.__slicc_*` bridges as named ESM exports. Served two ways:

1. **Vite dev middleware** (`vite.config.ts`) — serves `/preview/__shims/*` directly from Node for main page access
2. **Preview SW synthetic route** (`preview-sw.ts`) — serves the same shims for pages within `/preview/` scope

Shims: `fs`, `process`, `buffer`. `path` → `esm.sh/path-browserify`. Unavailable built-ins → error shim.

### Execution Flow (ESM path)

1. Set up `globalThis.__slicc_*` shim objects
2. Monkey-patch `console` to capture stdout/stderr
3. Rewrite import specifiers to absolute URLs
4. Create `Blob` from rewritten source, execute via `await import(blobUrl)`
5. Collect stdout/stderr, restore console, revoke blob URL, clean up `globalThis.__slicc_*`

**CLI mode:** Runs directly in document context. Blob URL execution works. Shims served by Vite middleware.

**Extension mode:** Posts `esm_exec` message to `sandbox.html` (CSP-exempt manifest sandbox). Handler is implemented in `sandbox.html` but `executeEsmModule` still returns "not yet supported" — the two sides are not connected.

---

## Design Limitations

These are inherent to the browser execution environment and will not be resolved by any continuation of this approach:

- **Synchronous Node I/O** (`readFileSync`, `writeFileSync`, `readdirSync`) — browsers have no synchronous filesystem API
- **`import.meta.url`** — requires a true ES module context; not valid in `AsyncFunction`, not meaningful in blob URL context
- **`createRequire`** — Node-only API not available in any browser-compatible `module` shim
- **Node-core network/process packages** (`http`, `https`, `crypto`, `child_process`, `streams`) — no browser equivalent
- **Dynamic `import(variable)`** — runtime-computed specifiers cannot be statically analyzed or rewritten
- **Private npm packages** — `esm.sh` only serves the public npm registry
- **Package binaries** — `esm.sh` serves JavaScript modules only; `bin` entries are not executable
