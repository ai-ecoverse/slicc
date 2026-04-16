# ESM Import Findings

**Date:** 2026-04-16  
**Environment:** SLICC browser-shimmed Node.js (v20.0.0-js-shim, runs inside `just-bash.js` at `localhost:5720`)  
**Tested via:** `.mjs` files executed with `node <file>.mjs`

---

## Summary

| # | Test | Result |
|---|------|--------|
| 01 | Static import, bare specifier (`import dotenv from 'dotenv'`) | ✅ PASS |
| 02 | Static named import (`import { parse } from 'dotenv'`) | ✅ PASS |
| 03 | Dynamic import, bare specifier (`await import('dotenv')`) | ❌ FAIL |
| 04 | Dynamic import, relative path (`await import('./file.mjs')`) | ❌ FAIL |
| 05 | Dynamic import, file URL (`await import('file:///...')`) | ❌ FAIL |
| 06 | `import.meta.url` | ❌ FAIL |
| 07 | `process` global | ✅ PASS |
| 08 | Static import of local relative file (`import { x } from './file.mjs'`) | ❌ FAIL |
| 09 | `export { x } from './file.mjs'` (re-export / barrel) | ❌ FAIL |
| 10 | Shell env vars passed to `process.env` (`DOMAINKEY_FILE=x node ...`) | ✅ PASS |
| 11 | Static import of scoped package (`import { DataChunks } from '@adobe/rum-distiller'`) | ✅ PASS |
| 12 | Named import from `fs` (`import { readFileSync } from 'fs'`) | ❌ FAIL |
| 12b | Default import from `fs` + checking shim exports | ❌ FAIL (partial) |
| 13 | Static import of `path` (`import path from 'path'`) | ✅ PASS |
| 14 | `createRequire` from `'module'` | ❌ FAIL |
| 15 | Top-level `await` | ✅ PASS |
| 16 | `import { readFile } from 'fs/promises'` | ❌ FAIL |
| 17 | Inline env vars (`TEST_VAR=hello node file.mjs`) | ✅ PASS |

---

## Failures — Detail

### ❌ Test 03 — Dynamic import, bare specifier

```js
const m = await import('dotenv');
```

**Error:** `Failed to resolve module specifier 'dotenv'`

Dynamic `import()` calls bypass the static specifier rewriting step. Bare specifiers have no resolution context at blob URL execution time.

---

### ❌ Test 04 — Dynamic import, relative path

```js
const m = await import('./test-helper.mjs');
```

**Error:** `Failed to fetch dynamically imported module: http://localhost:5720/packages/webapp/src/shell/supplemental-commands/test-helper.mjs`

The relative path resolves against the runtime's internal URL (`localhost:5720/packages/webapp/src/shell/supplemental-commands/`) — not the VFS path where the file lives. The file is never found.

---

### ❌ Test 05 — Dynamic import, file URL

```js
const m = await import('file:///slicc/findings/test-helper.mjs');
```

**Error:** `Failed to fetch dynamically imported module: file:///slicc/findings/test-helper.mjs`

The browser fetch mechanism cannot load `file://` URLs directly.

---

### ❌ Test 06 — `import.meta.url`

```js
const url = import.meta.url;
```

**Error:** `SyntaxError: Cannot use 'import.meta' outside a module`

The `.mjs` file is executed by wrapping it in an `AsyncFunction` body, which is not a true ES module context. `import.meta` is only valid inside a real ES module.

---

### ❌ Test 08 — Static import of local relative file

```js
import { value } from './test-helper.mjs';
```

**Error:** `TypeError: Failed to fetch dynamically imported module: blob:http://localhost:5720/...`

Static relative imports are rewritten to a blob URL. The blob URL fails to fetch the referenced file — the rewriting resolves to an internal blob URL that has no access to the VFS file. This is the unverified case noted in the spec.

---

### ❌ Test 09 — `export { x } from './file.mjs'` (re-export / barrel)

```js
export { value } from './test-helper.mjs';
```

**Error:** `SyntaxError: Unexpected token 'export'`

`export` statements at the top level are not recognized. The ESM detection logic only looks for `import` statements — files that start with or only contain `export` statements are routed to the CJS path, where `export` is a syntax error.

---

### ❌ Test 12 — Named import from `fs`

```js
import { readFileSync } from 'fs';
```

**Error:** `SyntaxError: The requested module '.../__shims/fs.js' does not provide an export named 'readFileSync'`

The `fs` shim only exposes async VFS bridge methods: `readFile`, `readFileBinary`, `writeFile`, `writeFileBinary`, `readDir`, `exists`, `stat`, `mkdir`, `rm`, `fetchToFile`. Sync variants (`readFileSync`, `writeFileSync`, `readdirSync`, etc.) are not implemented.

---

### ❌ Test 14 — `createRequire` from `'module'`

```js
import { createRequire } from 'module';
```

**Error:** `SyntaxError: The requested module 'https://esm.sh/module' does not provide an export named 'createRequire'`

`module` is rewritten to `https://esm.sh/module` — a browser-compatible shim that does not include `createRequire` (a Node-only API). This also makes `__dirname` / `__filename` emulation impossible via the standard pattern.

---

### ❌ Test 16 — `import { readFile } from 'fs/promises'`

```js
import { readFile } from 'fs/promises';
```

**Error:** `TypeError: Failed to fetch dynamically imported module: blob:http://localhost:5720/...`

`fs/promises` is not shimmed. The specifier `fs/promises` is not mapped by the rewriter — it falls through to a blob URL that fails to resolve. Only `fs` (the base specifier) has a shim.

---

## What Works

- Static `import` with bare npm specifiers — resolved via `esm.sh`
- Static named imports from npm packages
- Static import of `path` (rewritten to `path-browserify` via esm.sh)
- `process` global — available directly, no import needed
- Shell env vars passed via `KEY=value node file.mjs` — reflected in `process.env`
- Top-level `await`
- Scoped npm packages (`@adobe/rum-distiller`) via esm.sh

---

## Root Cause

`.mjs` files are executed by wrapping their source in an `AsyncFunction` body and running it as a blob URL. This means:

1. Static `import` specifiers are rewritten before execution — those work.
2. `export` statements are not detected/rewritten — those fail.
3. Dynamic `import()` calls happen at runtime inside the blob, where no specifier resolution context exists.
4. `import.meta` is not valid inside `AsyncFunction`.
5. Local relative imports get rewritten to blob URLs that can't reach the VFS.
6. The `fs` shim is incomplete — only async methods, no sync variants, no `fs/promises` sub-path.
