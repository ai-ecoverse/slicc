# ESM Import Support for Scripts

**Date:** 2026-04-15
**Status:** Approved

## Problem

Scripts executed via `node -e` and `.jsh` files currently only support CommonJS-style `require()` calls. Skill scripts want to use standard ESM `import` syntax (`import chalk from 'chalk'`, `import './helpers.js'`). The existing execution engine wraps code in an `AsyncFunction` body where static `import` statements are syntactically invalid.

## Design

### Detection & Routing

Pre-scan the entry script source for static `import` statements using a regex (same pattern as the existing `extractRequireSpecifiers`). Two execution paths:

- **ESM detected** — new path: specifier rewriting + blob URL module execution
- **CJS only / neither** — existing path: AsyncFunction + requireShim (unchanged)

The fork happens at the top of `executeJsCode()` / the `node -e` handler. Zero changes to the existing CJS path.

Key functions in `packages/webapp/src/shell/supplemental-commands/shared.ts`:

- `hasESMImports(code)` — returns true if code contains static `import` statements; ignores dynamic `import()`, `require()`, and imports inside comments or strings
- `extractImportSpecifiers(code)` — extracts and deduplicates the module specifier strings

### Specifier Rewriting

Before executing, all import specifiers in the source are rewritten to absolute URLs so the code can run from a blob URL without relying on any service worker interception.

**Rewrite rules:**

- `import { readFile } from 'fs'` → `import { readFile } from 'http://localhost:5710/preview/__shims/fs.js'`
- `import chalk from 'chalk'` → `import chalk from 'https://esm.sh/chalk'`
- `import './helpers.js'` → `import './helpers.js'` resolved to `http://localhost:5710/preview/workspace/skills/my-skill/helpers.js`
- Already-absolute URLs → untouched

Specifier classification in `packages/webapp/src/shell/esm-import-map.ts`:

- Node built-ins (`fs`, `process`, `buffer`, `node:*`) → `<origin>/preview/__shims/<name>.js`
- `path` → `https://esm.sh/path-browserify` (browser-compatible npm equivalent)
- Unavailable built-ins (`http`, `crypto`, etc.) → `<origin>/preview/__shims/<name>.js` (error shim that throws with a helpful hint)
- npm packages → `https://esm.sh/<package>`
- Relative imports → absolute preview SW URL based on the script's VFS directory

The rewritten source is bundled into a `Blob` and executed via `await import(blobUrl)`. The blob's internal imports use absolute URLs — they go straight to the network without needing any SW interception.

#### Alternative considered: Browser Import Maps

The original design used browser `<script type="importmap">` to resolve bare specifiers, combined with writing the code to a temp VFS file and importing via the preview SW URL.

**Why it didn't work:**

The preview SW is registered with `scope: '/preview/'`, meaning it only controls pages whose URL starts with `/preview/`. The main app page lives at `/` — outside that scope. As a result:

1. `import('/preview/workspace/.slicc/esm-temp/entry.mjs')` from the main page was never intercepted by the SW — the request went to Vite, which returned 404.
2. Even with blob URL execution, the blob's inner imports (e.g. to `/preview/__shims/fs.js`) were similarly not intercepted because the SW determines what to intercept based on the _client page_, not the request URL.

Widening scope to `/` was considered but rejected: with `projectRoot` set in serve mode, the SW intercepts all root-relative requests from controlled pages — which would break Vite HMR and app assets on the main page.

**The fix:** Shims are served via a Vite dev middleware at `/preview/__shims/*`, bypassing the SW entirely. NPM packages go directly to `esm.sh`. No SW scope change needed.

### Synthetic Shim Modules

Shim modules expose the `globalThis.__slicc_*` bridges (set up before execution) as named ESM exports. They are served two ways:

1. **Vite dev middleware** (`packages/webapp/vite.config.ts`) — serves `/preview/__shims/*` directly from Node, making shims available to the main page without SW interception
2. **Preview SW synthetic route** (`packages/webapp/src/ui/preview-sw.ts`) — serves the same shims for requests from pages within `/preview/` scope (e.g. nested preview pages)

Shim generator: `packages/webapp/src/ui/preview-sw-shims.ts`

Shims provided:

- `fs` — readFile, writeFile, readFileBinary, writeFileBinary, readDir, exists, stat, mkdir, rm, fetchToFile
- `process` — argv, env, cwd, exit, stdout, stderr
- `buffer` — re-export globalThis.Buffer
- `path` — no shim; rewritten to `https://esm.sh/path-browserify` at specifier-rewrite time
- Unavailable built-ins (`http`, `crypto`, etc.) — throws with a helpful hint (e.g. "Use fetch() instead")

### Execution Flow (ESM Path)

1. Set up shims on `globalThis` — `globalThis.__slicc_fs = fsBridge`, `__slicc_process`, `__slicc_exec`
2. Monkey-patch `console` — replace `console.log/error/warn/info` with capturing versions for stdout/stderr collection
3. Rewrite import specifiers to absolute URLs
4. Create a `Blob` from the rewritten source and execute via `await import(blobUrl)`
5. Collect results — stdout/stderr from captured console output
6. Restore console, revoke blob URL
7. Clean up `globalThis.__slicc_*` properties

### Local File Imports

Local relative imports (e.g. `import './helpers.js'`) are rewritten to absolute preview SW URLs during the specifier-rewrite step:

```
import './helpers.js'
→ import 'http://localhost:5710/preview/workspace/skills/my-skill/helpers.js'
```

The preview SW (scoped to `/preview/`) serves VFS files at these URLs. Mounted directories are supported via the SW's existing fallback to the main-page VFS bridge.

> **Note:** This behaviour is implemented but not yet smoke-tested. Local file imports may encounter the same SW scope issue as shims — requests from a blob module may not be intercepted if the blob's client context is not controlled by the SW. If this occurs, local file imports would need to be handled via the Vite middleware or an alternative approach, similar to how shims were fixed.

### CLI vs Extension Mode

**CLI mode:** Specifier rewriting runs in the main document context. A blob URL is created and executed directly via `await import(blobUrl)`. Shims are served by the Vite dev middleware.

**Extension mode:** The extension has two isolated execution contexts (side panel and offscreen document) that cannot use `AsyncFunction` directly due to CSP. Both route dynamic code execution through `sandbox.html` — a manifest-declared sandbox page that is CSP-exempt.

The `esm_exec` postMessage flow:

1. `executeEsmModule` in `jsh-executor.ts` serializes the rewritten code + argv/env/cwd into a message: `{ type: 'esm_exec', id, code, argv, env, cwd }`
2. Posts it to the sandbox iframe via `contentWindow.postMessage`
3. The sandbox receives the message, sets up `globalThis.__slicc_*` shims, creates a `Blob` from the code, and executes `await import(blobUrl)` (works because the sandbox is CSP-exempt)
4. Captures stdout/stderr via console monkey-patching, separating log/info (stdout) from error/warn (stderr)
5. Posts back `{ type: 'exec_result', id, result: JSON.stringify({ stdout, stderr }) }`

This is the same pattern already used for CJS execution (`exec` message type). `esm_exec` is the ESM variant — same postMessage plumbing, real ES module execution inside the sandbox instead of AsyncFunction.

## Files Changed

| File                                                              | Change                                                        |
| ----------------------------------------------------------------- | ------------------------------------------------------------- |
| `packages/webapp/src/shell/supplemental-commands/node-command.ts` | Add ESM detection, fork to ESM execution path                 |
| `packages/webapp/src/shell/jsh-executor.ts`                       | Add ESM detection + `executeEsmModule` (CLI blob URL path)    |
| `packages/webapp/src/shell/supplemental-commands/shared.ts`       | Add `hasESMImports()` + `extractImportSpecifiers()`           |
| `packages/webapp/src/shell/esm-import-map.ts`                     | New: `buildImportMap` + `rewriteImportSpecifiers`             |
| `packages/webapp/src/ui/preview-sw.ts`                            | Add `/__shims/*` synthetic route                              |
| `packages/webapp/src/ui/preview-sw-shims.ts`                      | New: shim code generator for built-in modules                 |
| `packages/webapp/vite.config.ts`                                  | Add middleware for `/preview/__shims/*` (serves main page)    |
| `packages/chrome-extension/sandbox.html`                          | Add `esm_exec` handler for ESM execution in extension sandbox |

## What Doesn't Change

- The entire CJS/require path — untouched
- Preview SW's existing `/preview/*` VFS serving — untouched
- Tool definitions, shell registration — untouched

## Limitations

### Implementation gaps (follow-up work)

**Extension mode ESM not wired in jsh-executor**

`sandbox.html` has the `esm_exec` handler implemented, but `executeEsmModule` in `jsh-executor.ts` still returns "not yet supported" for extension mode. The handler and the caller need to be connected: `executeEsmModule` should rewrite specifiers, serialize the rewritten code, and post an `esm_exec` message to the sandbox iframe (same VFS/shell/fetch proxy bridge pattern as the existing CJS extension path).

**Local file imports unverified**

Local relative imports are rewritten to absolute preview SW URLs and assumed to work, but this has not been smoke-tested. If the SW scope issue affects blob module sub-requests, a Vite middleware for VFS file serving would be needed.

### Design limitations

**Private / scoped npm packages**

The esm.sh CDN only has access to the public npm registry. Private or scoped packages hosted on private registries will fail to load. This also affects packages that are public but have complex build steps or native dependencies that esm.sh cannot handle.

Possible future solutions:

- Vendor the package locally into the skill folder and import via relative paths
- Serve from VFS if the package exists in a local `node_modules/` on VFS
- Configurable registry to point scoped packages to a custom registry URL

**npm package binaries**

Packages that provide CLI binaries (via the `bin` field in `package.json`) are not supported. esm.sh serves JavaScript modules, not executable scripts. Skills that need to invoke package binaries cannot do so through this import mechanism.

Possible future solutions:

- Shell-level `npx`-like command that fetches and runs package binaries
- Pre-installed binaries bundled into the VFS
