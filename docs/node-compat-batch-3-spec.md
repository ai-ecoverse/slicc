# Batch 3: Synchronous FS — Implementation Spec

## Branch

`feat/node-compat-batch-3` (this worktree)

## Goal

Add `readFileSync`, `writeFileSync`, `existsSync`, `mkdirSync`, `statSync`,
`readdirSync`, `rmSync`, `copyFileSync`, `mkdtempSync`, `unlinkSync` to the
realm's `require('fs')` module. These are used by **28 of 37** audited
`adobe/skills` `.mjs` files.

## Architectural Constraint

The realm executes user code in an `AsyncFunction` wrapper, but sync FS APIs
cannot `await` anything. The VFS lives on the host side behind async RPC.
`SharedArrayBuffer` / `Atomics.wait` is not available (no COEP headers).

## Design: Pre-loaded In-Memory FS Cache

### Overview

```
Host (kernel worker)                    Realm (per-task worker/iframe)
─────────────────────                   ─────────────────────────────
1. Before realm-init,
   walk cwd + /tmp →
   serialize file tree
                         ───────────►   2. Receive snapshot in RealmInitMsg
                                           Build SyncFsCache (Map<path, entry>)

                                        3. User code runs:
                                           readFileSync → reads from cache
                                           writeFileSync → writes to cache
                                           existsSync → checks cache
                                           (all synchronous, zero RPC)

                                        4. After runUserCode completes:
4. Receive mutations,    ◄───────────      diff cache vs initial snapshot,
   apply to real VFS                       send {created, modified, deleted}
                                           via vfs.flushWrites RPC
```

### Key Properties

- Sync reads see prior sync writes within the same execution (shared Map).
- Async `readFile`/`writeFile` (from Batch 2) still use RPC — they are NOT
  routed through the cache. This keeps them always-fresh for long-running scripts.
- The snapshot is bounded: only `cwd` tree + `/tmp` (configurable depth/size).
- Files larger than 1MB are excluded from the snapshot (available via async only).

## Files to Create/Modify

### New: `packages/webapp/src/kernel/realm/sync-fs-cache.ts`

Pure in-memory filesystem tree. No RPC, no async. Consumed by the sync shim
functions inside `js-realm-shared.ts`.

```ts
export interface SyncFsEntry {
  content: Uint8Array;    // file content (empty for dirs)
  isDirectory: boolean;
}

export interface SyncFsSnapshot {
  entries: Array<{ path: string; content: Uint8Array; isDirectory: boolean }>;
}

export interface SyncFsMutations {
  created: Array<{ path: string; content: Uint8Array; isDirectory: boolean }>;
  modified: Array<{ path: string; content: Uint8Array }>;
  deleted: string[];
}

export class SyncFsCache {
  private tree: Map<string, SyncFsEntry>;
  private initialPaths: Set<string>;  // tracks what existed at snapshot time

  constructor(snapshot: SyncFsSnapshot) { ... }

  readFile(path: string): Uint8Array { ... }       // throws ENOENT
  writeFile(path: string, content: Uint8Array): void { ... }
  exists(path: string): boolean { ... }
  stat(path: string): { isFile: boolean; isDirectory: boolean; size: number } { ... }
  readdir(path: string): string[] { ... }
  mkdir(path: string, recursive?: boolean): void { ... }
  rm(path: string, recursive?: boolean): void { ... }
  copyFile(src: string, dest: string): void { ... }
  rename(oldPath: string, newPath: string): void { ... }
  unlink(path: string): void { ... }
  mkdtemp(prefix: string): string { ... }

  /** Compute the diff against the initial snapshot. */
  getMutations(): SyncFsMutations { ... }
}
```

### Modify: `packages/webapp/src/kernel/realm/realm-types.ts`

Add `syncFsSnapshot?: SyncFsSnapshot` to `RealmInitMsg`. This carries the
pre-loaded file tree from host to realm.

### Modify: `packages/webapp/src/kernel/realm/realm-host.ts`

Add a `dispatchVfs` case `'snapshot'` that walks a directory tree and returns
a `SyncFsSnapshot`. Called by the host before sending `realm-init`.

Actually — better approach: add the snapshot to the module-graph build RPC
response (which already runs before execution). Or add a new `'vfs'/'snapshot'`
op that `runInRealm` calls before posting `realm-init`.

**Recommended**: Add a new RPC call in `realm-runner.ts` that the host serves.
The realm requests `rpc.call('vfs', 'snapshot', [cwd, '/tmp'])` during
`runJsRealm` startup (before `runUserCode`), receives the snapshot, and builds
the `SyncFsCache`. This avoids changing `RealmInitMsg` (which is a cross-float
wire format).

### Modify: `packages/webapp/src/kernel/realm/js-realm-shared.ts`

1. Import `SyncFsCache` and `SyncFsSnapshot`.
2. After `createFsBridge` but before `runUserCode`, call
   `rpc.call('vfs', 'snapshot', [init.cwd])` to get the snapshot.
3. Build `const syncFs = new SyncFsCache(snapshot)`.
4. Create `createSyncFsBridge(syncFs)` which returns the `*Sync` functions.
5. Merge the sync bridge into the `fsBridge` object so `require('fs')` exposes
   both async and sync APIs on the same object.
6. After `runUserCode`, call `rpc.call('vfs', 'flushWrites', [syncFs.getMutations()])`.

### Modify: `packages/webapp/src/kernel/realm/realm-host.ts` (dispatcher)

Add two new VFS ops:

- `'snapshot'`: walk `args[0]` (cwd) recursively, return `SyncFsSnapshot`.
  Limit: max 500 files, max 1MB per file, max 10MB total. Skip `node_modules`.
- `'flushWrites'`: receive `SyncFsMutations`, apply to `ctx.fs`:
  - `created`: `mkdir` or `writeFile`
  - `modified`: `writeFile`
  - `deleted`: `rm`

### Modify: `packages/chrome-extension/sandbox.html`

Mirror the sync FS surface on the `fsBridge`. The sandbox iframe realm uses
the same RPC pattern — it can request the snapshot and build the cache
identically.

## Sync API Surface (on `require('fs')`)

All of these operate on `SyncFsCache` — zero RPC:

| API                                  | Behavior                                                          |
| ------------------------------------ | ----------------------------------------------------------------- |
| `readFileSync(path, encoding?)`      | Read from cache. `'utf8'` → string, no encoding → Buffer          |
| `writeFileSync(path, data)`          | Write to cache. String → encode to UTF-8, Buffer → store directly |
| `existsSync(path)`                   | Check cache                                                       |
| `mkdirSync(path, {recursive?})`      | Create dir entries in cache                                       |
| `statSync(path)`                     | Return `{isFile(), isDirectory(), size}` from cache               |
| `readdirSync(path)`                  | List from cache                                                   |
| `rmSync(path, {recursive?, force?})` | Remove from cache                                                 |
| `copyFileSync(src, dest)`            | Read + write in cache                                             |
| `mkdtempSync(prefix)`                | Random suffix, mkdir in cache                                     |
| `unlinkSync(path)`                   | Remove file from cache                                            |

## Flush-back Semantics

After `runUserCode` resolves:

1. `syncFs.getMutations()` computes the diff.
2. If mutations is non-empty, `rpc.call('vfs', 'flushWrites', [mutations])`.
3. The host applies mutations to the real VFS.

Edge cases:

- Script crashes (throws) → still flush. The writes up to the crash are
  intentional (partial progress pattern is common in Node scripts).
- Script is killed (SIGKILL → `worker.terminate()`) → no flush. The worker
  is dead; mutations are lost. This is acceptable — kill is exceptional.

## Snapshot Scope

The host snapshots:

- `cwd` recursively (the script's working directory — usually the project root)
- `/tmp` (scripts use `mkdtempSync('/tmp/...')`)

Exclusions:

- `node_modules/` directories (too large, scripts access them via `require()`)
- Files > 1MB (available via async `readFile` only)
- Total snapshot budget: 10MB

If a `readFileSync` targets a path NOT in the snapshot → throw ENOENT (the
script should use async `readFile` for paths outside the working tree, or the
snapshot scope should be expanded).

## Test Strategy

New test file: `packages/webapp/tests/kernel/realm/sync-fs-cache.test.ts`

Unit tests for `SyncFsCache`:

- readFileSync sees writeFileSync within same execution
- existsSync returns false for missing, true after writeFileSync
- mkdirSync + readdirSync
- rmSync removes from cache
- getMutations returns correct diff
- readFileSync with 'utf8' encoding returns string
- readFileSync without encoding returns Buffer

Integration test via `runCode`:

- Script that uses readFileSync/writeFileSync round-trips content
- Script that creates files via writeFileSync → files appear in VFS after execution
- existsSync on pre-existing file returns true
- existsSync on missing file returns false

## Commit Plan (1 per function, as requested)

1. `SyncFsCache` class (pure in-memory tree + mutations tracking)
2. Host-side `vfs.snapshot` RPC op (walk + serialize)
3. Host-side `vfs.flushWrites` RPC op (apply mutations)
4. Wire snapshot request + cache creation in `runJsRealm`
5. `readFileSync` (reads from cache, encoding support)
6. `writeFileSync` (writes to cache, string/Buffer support)
7. `existsSync` (checks cache)
8. `mkdirSync` with `{recursive}` option
9. `statSync` (returns `{isFile(), isDirectory(), size}`)
10. `readdirSync` (lists from cache)
11. `rmSync` with `{recursive, force}` options
12. `copyFileSync` (read + write in cache)
13. `mkdtempSync` (random suffix + mkdir in cache)
14. `unlinkSync` (remove file from cache)
15. Flush-back after `runUserCode` (diff + RPC)
16. Wire sync APIs onto `require('fs')` module export
17. Mirror in `sandbox.html`
18. Tests

## Notes for Implementation

- `SyncFsCache` must handle path normalization (leading `/`, no trailing `/`,
  `..` resolution). Use a simple `normalizePath` that splits on `/` and resolves.
- The `Buffer` polyfill is already available in the realm (`globalThis.Buffer`).
  Use it for `readFileSync` return values.
- The sync bridge functions are plain JS (not async) — they go on the fsBridge
  object alongside the existing async methods. `require('fs')` returns the
  unified object, so `fs.readFileSync` and `fs.readFile` coexist.
- `process.cwd()` is already shimmed — use it as the default snapshot root.
