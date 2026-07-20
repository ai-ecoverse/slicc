# VirtualFS Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract three concept-cohesive blocks (error rebranding, symlink resolution, directory walking) out of the 2,165-line `VirtualFS` class into sibling modules under `packages/webapp/src/fs/`, with zero public-API change.

**Architecture:** `VirtualFS` stays the sole public entry point (99 importers, re-exported from `fs/index.ts`). Each extracted block becomes module-level functions that take an explicit deps object; the matching `VirtualFS` method becomes a thin delegate. Behavior is preserved and proven by the existing API-level tests, which stay green with zero edits in every `refactor` commit.

**Tech Stack:** TypeScript (ESM, `"type": "module"`), Vitest (`fake-indexeddb/auto` for VFS tests), Biome + Prettier lint, knip dead-code gate, `@zenfs/core` / `@zenfs/dom` backends.

## Global Constraints

- Scope is **subset B only**: `error-rebrand`, `symlink-resolver`, `walker`. Do NOT touch mount-registry, backend-init, sync-fast-path, or path-prefix shims.
- No public API change: every `VirtualFS` method keeps its exact name, signature, and return type.
- One PR; every commit must independently **compile (`npm run typecheck`), pass `knip --production` (no unused exports), and keep all tests green.** No "add module now, wire later" commits.
- New files must stay under the complexity caps (cognitive complexity ≤ 25, ≤ 150 lines/function). `virtual-fs.ts` is NOT on the biome debt list, so no forced whole-file refactor.
- Absolute-style intra-package imports use the existing `./x.js` relative form already used throughout `fs/` (match the file's established pattern; ESM `.js` extensions required).
- Test relocation = **mirror**: add co-located unit tests that exercise each extracted module directly (with lightweight fakes for injected deps). Keep the existing `VirtualFS` API tests in place as the behavior guard — do NOT delete them.

## Verification commands (used throughout)

- Single test file: `npx vitest run packages/webapp/tests/fs/<file>.test.ts`
- Whole fs suite: `npx vitest run packages/webapp/tests/fs/`
- Typecheck: `npm run typecheck`
- Dead-code gate: `npx knip --production`
- Lint (autofix): `npm run lint`
- Complexity gate (only if a listed file is touched — none here): `node packages/dev-tools/tools/check-touched-exemptions.mjs`

---

## Task 1: Extract `convertError` into `error-rebrand.ts`

**Files:**

- Create: `packages/webapp/src/fs/error-rebrand.ts`
- Modify: `packages/webapp/src/fs/virtual-fs.ts` (remove `convertError` method body at ~2118–2164; replace with delegate; add import)
- Test guard: `packages/webapp/tests/fs/virtual-fs.test.ts` (unchanged, must stay green)

**Interfaces:**

- Produces: `export function convertError(err: unknown, path: string): FsError`
- Consumes: `FsError`, `FsErrorCode` from `./types.js`

- [ ] **Step 1: Create the module** — move the current `convertError` body verbatim into a free function.

```typescript
// packages/webapp/src/fs/error-rebrand.ts
import { type FsErrorCode, FsError } from './types.js';

const KNOWN_CODES: FsErrorCode[] = [
  'ENOENT',
  'EEXIST',
  'ENOTDIR',
  'EISDIR',
  'ENOTEMPTY',
  'EINVAL',
  'EACCES',
  'ELOOP',
  'EBUSY',
  'EFBIG',
  'EBADF',
  'EIO',
];

/**
 * Convert LightningFS / ZenFS errors to {@link FsError}.
 *
 * ZenFS throws `ErrnoError` with a `.code` POSIX string (and `.errno`);
 * LightningFS embeds the code in the message text. Prefer the structured
 * `.code` form, then fall back to substring matching.
 */
export function convertError(err: unknown, path: string): FsError {
  if (err instanceof FsError) return err;
  const structured = (err as { code?: unknown })?.code;
  if (typeof structured === 'string') {
    const code = structured as FsErrorCode;
    if ((KNOWN_CODES as string[]).includes(code)) {
      const msg = err instanceof Error ? err.message : String(err);
      return new FsError(code, msg || code, path);
    }
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('ENOENT')) return new FsError('ENOENT', 'no such file or directory', path);
  if (msg.includes('EEXIST')) return new FsError('EEXIST', 'file already exists', path);
  if (msg.includes('ENOTDIR')) return new FsError('ENOTDIR', 'not a directory', path);
  if (msg.includes('EISDIR')) return new FsError('EISDIR', 'is a directory', path);
  if (msg.includes('ENOTEMPTY')) return new FsError('ENOTEMPTY', 'directory not empty', path);
  if (msg.includes('ELOOP')) return new FsError('ELOOP', 'too many levels of symbolic links', path);
  return new FsError('EINVAL', msg, path);
}
```

- [ ] **Step 2: Delegate from `VirtualFS`** — add `import { convertError } from './error-rebrand.js';` at the top of `virtual-fs.ts`, then replace the whole `private convertError(...) { ... }` method (~2118–2164) with a thin delegate that keeps callsites (`this.convertError(...)`) working:

```typescript
  private convertError(err: unknown, path: string): FsError {
    return convertError(err, path);
  }
```

- [ ] **Step 3: Typecheck + dead-code + tests**

Run: `npm run typecheck && npx knip --production && npx vitest run packages/webapp/tests/fs/`
Expected: typecheck clean, knip reports no unused `error-rebrand` export (it is imported by `virtual-fs.ts`), all fs tests PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/webapp/src/fs/error-rebrand.ts packages/webapp/src/fs/virtual-fs.ts
git commit -m "refactor(fs): extract convertError into error-rebrand.ts"
```

---

## Task 2: Move `rebrandFsError` into `error-rebrand.ts`

**Files:**

- Modify: `packages/webapp/src/fs/error-rebrand.ts` (add `rebrandFsError`)
- Modify: `packages/webapp/src/fs/virtual-fs.ts` (remove `static rebrandFsError` ~1226–1240; rewrite the ~4 `VirtualFS.rebrandFsError(...)` callsites to call the imported free function; extend import)

**Interfaces:**

- Produces: `export function rebrandFsError(err: unknown, normalizedPath: string): never`
- Consumes: `FsError` from `./types.js`

- [ ] **Step 1: Add `rebrandFsError` to the module** — move the current `static rebrandFsError` body verbatim into a free function in `error-rebrand.ts`:

```typescript
/**
 * Re-throw an `FsError` from a backend with the VFS-absolute path. Backends
 * throw with mount-relative paths (e.g. `'pack'`); callers expect the path
 * they passed in (e.g. `'/mnt/repo/pack'`).
 */
export function rebrandFsError(err: unknown, normalizedPath: string): never {
  if (err instanceof FsError) {
    const codePrefix = `${err.code}: `;
    let inner = err.message;
    if (inner.startsWith(codePrefix)) inner = inner.slice(codePrefix.length);
    if (err.path && inner.endsWith(` '${err.path}'`)) {
      inner = inner.slice(0, inner.length - ` '${err.path}'`.length);
    }
    throw new FsError(err.code, inner, normalizedPath);
  }
  throw err;
}
```

- [ ] **Step 2: Rewire callsites** — update the import in `virtual-fs.ts` to `import { convertError, rebrandFsError } from './error-rebrand.js';`, delete the `private static rebrandFsError(...)` method, and replace each `VirtualFS.rebrandFsError(err, normalized)` callsite with `rebrandFsError(err, normalized)`.

Find callsites: `rg -n "VirtualFS\.rebrandFsError\(" packages/webapp/src/fs/virtual-fs.ts`
Expected: ~4 hits (in `readFile`, `writeFile`, and other mount-backend catch blocks). Replace all.

- [ ] **Step 3: Typecheck + dead-code + tests**

Run: `npm run typecheck && npx knip --production && npx vitest run packages/webapp/tests/fs/`
Expected: all clean/PASS. Confirm no remaining `VirtualFS.rebrandFsError` reference: `rg -n "rebrandFsError" packages/webapp/src/fs/virtual-fs.ts` shows only the import + free-function calls.

- [ ] **Step 4: Commit**

```bash
git add packages/webapp/src/fs/error-rebrand.ts packages/webapp/src/fs/virtual-fs.ts
git commit -m "refactor(fs): extract rebrandFsError into error-rebrand.ts"
```

---

## Task 3: Add `error-rebrand` unit tests

**Files:**

- Create: `packages/webapp/tests/fs/error-rebrand.test.ts`

**Interfaces:**

- Consumes: `convertError`, `rebrandFsError` from `../../src/fs/error-rebrand.js`; `FsError` from `../../src/fs/types.js`

- [ ] **Step 1: Write the tests** — cover the three mapping branches (structured `.code`, message-substring fallback, `EINVAL` default) plus `rebrandFsError` path rewrite and passthrough.

```typescript
// packages/webapp/tests/fs/error-rebrand.test.ts
import { describe, expect, it } from 'vitest';
import { convertError, rebrandFsError } from '../../src/fs/error-rebrand.js';
import { FsError } from '../../src/fs/types.js';

describe('convertError', () => {
  it('passes through an existing FsError unchanged', () => {
    const e = new FsError('ENOENT', 'x', '/a');
    expect(convertError(e, '/b')).toBe(e);
  });

  it('maps a structured ZenFS .code to FsError', () => {
    const err = Object.assign(new Error('boom'), { code: 'EISDIR' });
    const out = convertError(err, '/dir');
    expect(out).toBeInstanceOf(FsError);
    expect(out.code).toBe('EISDIR');
    expect(out.path).toBe('/dir');
  });

  it('falls back to substring matching for LightningFS-style messages', () => {
    const out = convertError(new Error('ENOTDIR: not a directory'), '/p');
    expect(out.code).toBe('ENOTDIR');
  });

  it('defaults unknown errors to EINVAL', () => {
    const out = convertError(new Error('weird'), '/p');
    expect(out.code).toBe('EINVAL');
    expect(out.message).toContain('weird');
  });
});

describe('rebrandFsError', () => {
  it('rethrows an FsError with the caller-facing path', () => {
    const backendErr = new FsError('ENOENT', 'no such file or directory', 'pack');
    expect(() => rebrandFsError(backendErr, '/mnt/repo/pack')).toThrow(FsError);
    try {
      rebrandFsError(backendErr, '/mnt/repo/pack');
    } catch (e) {
      expect((e as FsError).code).toBe('ENOENT');
      expect((e as FsError).path).toBe('/mnt/repo/pack');
    }
  });

  it('rethrows a non-FsError untouched', () => {
    const raw = new Error('native');
    expect(() => rebrandFsError(raw, '/x')).toThrow(raw);
  });
});
```

- [ ] **Step 2: Run the new tests**

Run: `npx vitest run packages/webapp/tests/fs/error-rebrand.test.ts`
Expected: all PASS.

- [ ] **Step 3: Verify no knip regression** (new test file must not trip the dead-file gate)

Run: `npx knip --production`
Expected: clean. If it flags the test fixture, add a negated `project` entry in the webapp workspace of `knip.json` (per `docs/verification.md` → Knip fixture exclusion) — NOT `ignoreFiles`.

- [ ] **Step 4: Commit**

```bash
git add packages/webapp/tests/fs/error-rebrand.test.ts
git commit -m "test(fs): add error-rebrand unit tests"
```

---

## Task 4: Extract symlink leaf helpers into `symlink-resolver.ts`

The symlink cluster splits into two commits at its natural seam: the leaf
helpers (`lstatOrThrow`, `readAndResolveLink`) depend only on `lfs` +
`convertError`; the recursive driver (`realpath` chain) depends on the leaves.
This task extracts the leaves.

**Files:**

- Create: `packages/webapp/src/fs/symlink-resolver.ts`
- Modify: `packages/webapp/src/fs/virtual-fs.ts` (replace `lstatOrThrow` ~2071–2083 and `readAndResolveLink` ~2086–2096 with delegates; add import)

**Interfaces:**

- Produces:
  - `interface FsStatsLike { size: number; mode: number; mtimeMs: number; ctimeMs: number; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }` — re-declared here (structural; matches the one in `virtual-fs.ts`)
  - `interface SymlinkLfs { lstat(path: string): Promise<FsStatsLike>; readlink(path: string): Promise<string> }`
  - `lstatOrThrow(lfs: SymlinkLfs, next: string, isTail: boolean, originalPath: string): Promise<FsStatsLike | null>`
  - `readAndResolveLink(lfs: SymlinkLfs, linkPath: string, originalPath: string): Promise<string>`
- Consumes: `convertError` from `./error-rebrand.js`; `joinPath`, `normalizePath`, `splitPath` from `./path-utils.js`

- [ ] **Step 1: Create the module** with the two leaf helpers, taking `lfs` as an explicit parameter (was `this.lfs`) and importing `convertError` (was `this.convertError`).

```typescript
// packages/webapp/src/fs/symlink-resolver.ts
import { convertError } from './error-rebrand.js';
import { joinPath, normalizePath, splitPath } from './path-utils.js';

export interface FsStatsLike {
  size: number;
  mode: number;
  mtimeMs: number;
  ctimeMs: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface SymlinkLfs {
  lstat(path: string): Promise<FsStatsLike>;
  readlink(path: string): Promise<string>;
}

/**
 * lstat a path for realpath. Returns null if ENOENT on the tail component
 * (allowed per POSIX realpath). Throws for all other errors.
 */
export async function lstatOrThrow(
  lfs: SymlinkLfs,
  next: string,
  isTail: boolean,
  originalPath: string
): Promise<FsStatsLike | null> {
  try {
    return await lfs.lstat(next);
  } catch (err) {
    const converted = convertError(err, originalPath);
    if (converted.code === 'ENOENT' && isTail) return null;
    throw converted;
  }
}

/** Read a symlink target and resolve it to an absolute normalized path. */
export async function readAndResolveLink(
  lfs: SymlinkLfs,
  linkPath: string,
  originalPath: string
): Promise<string> {
  let target: string;
  try {
    target = await lfs.readlink(linkPath);
  } catch (err) {
    throw convertError(err, originalPath);
  }
  return target.startsWith('/')
    ? normalizePath(target)
    : normalizePath(joinPath(splitPath(linkPath).dir, target));
}
```

- [ ] **Step 2: Delegate from `VirtualFS`** — add `import { lstatOrThrow, readAndResolveLink } from './symlink-resolver.js';`, then replace the two private methods with delegates that pass `this.lfs`:

```typescript
  private lstatOrThrow(next: string, isTail: boolean, originalPath: string) {
    return lstatOrThrow(this.lfs, next, isTail, originalPath);
  }

  private readAndResolveLink(linkPath: string, originalPath: string) {
    return readAndResolveLink(this.lfs, linkPath, originalPath);
  }
```

Note: `this.lfs` is typed `FsPromisesLike`; it structurally satisfies `SymlinkLfs`. If the compiler complains, pass `this.lfs as unknown as SymlinkLfs` — but check first; the structural subset should match.

- [ ] **Step 3: Typecheck + dead-code + tests**

Run: `npm run typecheck && npx knip --production && npx vitest run packages/webapp/tests/fs/`
Expected: all clean/PASS (symlink behavior is exercised by `virtual-fs.test.ts` → `describe('symlinks')` and `realpath` cases).

- [ ] **Step 4: Commit**

```bash
git add packages/webapp/src/fs/symlink-resolver.ts packages/webapp/src/fs/virtual-fs.ts
git commit -m "refactor(fs): extract symlink leaf helpers into symlink-resolver.ts"
```

---

## Task 5: Extract `realpath` driver + `resolveSymlinks` into `symlink-resolver.ts`

**Files:**

- Modify: `packages/webapp/src/fs/symlink-resolver.ts` (add `realpath`, `resolveRealpathComponent`, `resolveSymlinks`, `MAX_SYMLINK_DEPTH`)
- Modify: `packages/webapp/src/fs/virtual-fs.ts` (replace `realpath` ~2014–2037, `resolveRealpathComponent` ~2043–2065, `resolveSymlinks` ~2103–2107 with delegates; remove the now-duplicated `MAX_SYMLINK_DEPTH` const at the top if no longer referenced elsewhere; extend import)

**Interfaces:**

- Produces:
  - `type FindMount = (path: string) => unknown` — a truthiness-only predicate here (realpath/resolveSymlinks only check "is this under a mount?"). Use `(path: string) => boolean` and have the `VirtualFS` delegate pass `(p) => this.findMount(p) !== null`.
  - `realpath(lfs: SymlinkLfs, findMount: (path: string) => boolean, path: string): Promise<string>`
  - `resolveSymlinks(lfs: SymlinkLfs, findMount: (path: string) => boolean, path: string): Promise<string>`
- Consumes (from Task 4, same file): `lstatOrThrow`, `readAndResolveLink`, `SymlinkLfs`; `FsError` from `./types.js`; `normalizePath` from `./path-utils.js`

- [ ] **Step 1: Add the driver functions** to `symlink-resolver.ts`. Add `MAX_SYMLINK_DEPTH` and import `FsError`:

```typescript
import { FsError } from './types.js';

/**
 * Maximum number of symlink hops {@link realpath} follows before throwing
 * `ELOOP`. ZenFS' own resolve recurses without a hop counter, so a
 * `/a → /b → /a` cycle would OOM the async stack; this bounds it.
 */
export const MAX_SYMLINK_DEPTH = 10;

async function resolveRealpathComponent(
  lfs: SymlinkLfs,
  resolved: string,
  part: string,
  isTail: boolean,
  originalPath: string,
  hops: number
): Promise<{ resolved: string; hops: number }> {
  let next = resolved === '/' ? `/${part}` : `${resolved}/${part}`;
  while (true) {
    const stats = await lstatOrThrow(lfs, next, isTail, originalPath);
    if (stats === null) return { resolved: next, hops };
    if (!stats.isSymbolicLink()) return { resolved: next, hops };
    if (++hops > MAX_SYMLINK_DEPTH) {
      throw new FsError('ELOOP', 'too many symbolic links encountered', originalPath);
    }
    next = await readAndResolveLink(lfs, next, originalPath);
  }
}

/** Resolve all symlinks in a path to produce the final canonical path. */
export async function realpath(
  lfs: SymlinkLfs,
  findMount: (path: string) => boolean,
  path: string
): Promise<string> {
  const normalized = normalizePath(path);
  if (findMount(normalized)) return normalized; // mount paths are already real
  const parts = normalized.split('/').filter(Boolean);
  let resolved = '/';
  let hops = 0;
  for (let i = 0; i < parts.length; i++) {
    const result = await resolveRealpathComponent(
      lfs,
      resolved,
      parts[i],
      i === parts.length - 1,
      normalized,
      hops
    );
    resolved = result.resolved;
    hops = result.hops;
  }
  return resolved;
}

/** Resolve symlinks in a path before an operation; mount points pass through. */
export async function resolveSymlinks(
  lfs: SymlinkLfs,
  findMount: (path: string) => boolean,
  path: string
): Promise<string> {
  if (findMount(path)) return path;
  return realpath(lfs, findMount, path);
}
```

- [ ] **Step 2: Delegate from `VirtualFS`** — extend the import to `import { MAX_SYMLINK_DEPTH, lstatOrThrow, readAndResolveLink, realpath, resolveSymlinks } from './symlink-resolver.js';` (import `MAX_SYMLINK_DEPTH` only if still referenced in `virtual-fs.ts`; otherwise delete the local const and leave it out), remove the three private methods, and add delegates:

```typescript
  async realpath(path: string): Promise<string> {
    return realpath(this.lfs, (p) => this.findMount(p) !== null, path);
  }

  private resolveSymlinks(path: string): Promise<string> {
    return resolveSymlinks(this.lfs, (p) => this.findMount(p) !== null, path);
  }
```

Also delete the top-of-file `const MAX_SYMLINK_DEPTH = 10;` and its doc block in `virtual-fs.ts` (now owned by the module). Confirm nothing else references it: `rg -n "MAX_SYMLINK_DEPTH" packages/webapp/src/fs/virtual-fs.ts`.

- [ ] **Step 3: Typecheck + dead-code + tests**

Run: `npm run typecheck && npx knip --production && npx vitest run packages/webapp/tests/fs/`
Expected: all clean/PASS. Pay attention to `virtual-fs.test.ts` realpath/ELOOP cases and `restricted-fs*` symlink tests.

- [ ] **Step 4: Commit**

```bash
git add packages/webapp/src/fs/symlink-resolver.ts packages/webapp/src/fs/virtual-fs.ts
git commit -m "refactor(fs): extract realpath + resolveSymlinks into symlink-resolver.ts"
```

---

## Task 6: Mirror symlink-resolver unit tests

**Files:**

- Create: `packages/webapp/tests/fs/symlink-resolver.test.ts`

**Interfaces:**

- Consumes: `realpath`, `resolveSymlinks`, `lstatOrThrow`, `readAndResolveLink`, `MAX_SYMLINK_DEPTH`, `type SymlinkLfs` from `../../src/fs/symlink-resolver.js`; `FsError` from `../../src/fs/types.js`

- [ ] **Step 1: Write direct unit tests with a fake `lfs`** — cover component-walk symlink following, ELOOP past the hop cap, tail-ENOENT tolerance, and mount passthrough via the `findMount` predicate.

```typescript
// packages/webapp/tests/fs/symlink-resolver.test.ts
import { describe, expect, it } from 'vitest';
import {
  MAX_SYMLINK_DEPTH,
  realpath,
  resolveSymlinks,
  type SymlinkLfs,
} from '../../src/fs/symlink-resolver.js';
import { FsError } from '../../src/fs/types.js';

function statFor(kind: 'file' | 'dir' | 'link'): any {
  return {
    size: 0,
    mode: 0,
    mtimeMs: 0,
    ctimeMs: 0,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'dir',
    isSymbolicLink: () => kind === 'link',
  };
}

function fakeLfs(links: Record<string, string>, files: Set<string>): SymlinkLfs {
  return {
    async lstat(p: string) {
      if (p in links) return statFor('link');
      if (files.has(p)) return statFor('file');
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    async readlink(p: string) {
      if (p in links) return links[p];
      throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' });
    },
  };
}

const noMount = () => false;

describe('symlink-resolver.realpath', () => {
  it('follows a tail symlink to its target', async () => {
    const lfs = fakeLfs({ '/link.txt': '/real.txt' }, new Set(['/real.txt']));
    expect(await realpath(lfs, noMount, '/link.txt')).toBe('/real.txt');
  });

  it('tolerates ENOENT on the tail component (returns canonical path)', async () => {
    const lfs = fakeLfs({}, new Set());
    expect(await realpath(lfs, noMount, '/missing.txt')).toBe('/missing.txt');
  });

  it('throws ELOOP past the hop cap', async () => {
    const links: Record<string, string> = { '/a': '/b', '/b': '/a' };
    const lfs = fakeLfs(links, new Set());
    await expect(realpath(lfs, noMount, '/a')).rejects.toMatchObject({ code: 'ELOOP' });
  });

  it('has a documented hop cap of 10', () => {
    expect(MAX_SYMLINK_DEPTH).toBe(10);
  });
});

describe('symlink-resolver.resolveSymlinks', () => {
  it('returns mount paths unchanged', async () => {
    const lfs = fakeLfs({}, new Set());
    expect(await resolveSymlinks(lfs, () => true, '/mnt/x/y')).toBe('/mnt/x/y');
  });
});
```

- [ ] **Step 2: Run**

Run: `npx vitest run packages/webapp/tests/fs/symlink-resolver.test.ts`
Expected: all PASS.

- [ ] **Step 3: Dead-code gate**

Run: `npx knip --production`
Expected: clean (add negated `project` entry in `knip.json` if the fixture is flagged).

- [ ] **Step 4: Commit**

```bash
git add packages/webapp/tests/fs/symlink-resolver.test.ts
git commit -m "test(fs): mirror symlink-resolver unit tests"
```

---

## Task 7: Extract walk leaf helpers into `walker.ts`

The walk cluster splits at its seam: `canUseWalkFastPath` (reads
`mountPoints`/`mountIndex`) and `safeRealpath` (wraps `realpath`) are leaves;
the recursive generators depend on them. This task extracts the leaves.

**Files:**

- Create: `packages/webapp/src/fs/walker.ts`
- Modify: `packages/webapp/src/fs/virtual-fs.ts` (replace `canUseWalkFastPath` ~1817–1824 and `safeRealpath` ~1827–1833 with delegates; add import)

**Interfaces:**

- Produces:
  - `interface WalkMountView { size: number; has(path: string): boolean; keys(): IterableIterator<string> }` — structural view of the `mountPoints` Map.
  - `interface WalkIndexView { isReady(path: string): boolean }` — structural view of `MountIndex`.
  - `canUseWalkFastPath(mountPoints: WalkMountView, mountIndex: WalkIndexView, normalized: string): boolean`
  - `safeRealpath(realpath: (p: string) => Promise<string>, normalized: string): Promise<string>`
  - `MAX_WALK_DEPTH: number`, `MAX_WALK_ENTRIES: number`
- Consumes: nothing external (pure logic over injected views)

- [ ] **Step 1: Create the module** with the two leaf helpers and the walk-bound constants:

```typescript
// packages/webapp/src/fs/walker.ts

// Bound walk()'s slow-path recursion. realpath leaves mount paths unchanged,
// so the visited-set cannot collapse a self-referential mount; cap depth +
// total entries so it can't loop forever.
export const MAX_WALK_DEPTH = 64;
export const MAX_WALK_ENTRIES = 100_000;

export interface WalkMountView {
  readonly size: number;
  has(path: string): boolean;
  keys(): IterableIterator<string>;
}

export interface WalkIndexView {
  isReady(path: string): boolean;
}

/** Whether the walk fast path (indexed mount, no nested mounts) is available. */
export function canUseWalkFastPath(
  mountPoints: WalkMountView,
  mountIndex: WalkIndexView,
  normalized: string
): boolean {
  if (mountPoints.size === 0 || !mountPoints.has(normalized)) return false;
  if (!mountIndex.isReady(normalized)) return false;
  const hasNestedMounts = [...mountPoints.keys()].some(
    (mp) => mp !== normalized && mp.startsWith(normalized + '/')
  );
  return !hasNestedMounts;
}

/** Resolve realpath, falling back to the input path on any error. */
export async function safeRealpath(
  realpath: (p: string) => Promise<string>,
  normalized: string
): Promise<string> {
  try {
    return await realpath(normalized);
  } catch {
    return normalized;
  }
}
```

- [ ] **Step 2: Delegate from `VirtualFS`** — add `import { MAX_WALK_DEPTH, MAX_WALK_ENTRIES, canUseWalkFastPath, safeRealpath } from './walker.js';`, remove the top-of-file `MAX_WALK_DEPTH`/`MAX_WALK_ENTRIES` consts and their comment, and replace the two private methods with delegates:

```typescript
  private canUseWalkFastPath(normalized: string): boolean {
    return canUseWalkFastPath(this.mountPoints, this.mountIndex, normalized);
  }

  private safeRealpath(normalized: string): Promise<string> {
    return safeRealpath((p) => this.realpath(p), normalized);
  }
```

`this.mountPoints` (`Map<string, MountBackend>`) structurally satisfies `WalkMountView`; `this.mountIndex` (`MountIndex`) satisfies `WalkIndexView`. `walk()` still references `MAX_WALK_DEPTH`/`MAX_WALK_ENTRIES` — now from the import. Confirm: `rg -n "MAX_WALK_DEPTH|MAX_WALK_ENTRIES" packages/webapp/src/fs/virtual-fs.ts` shows only the import + the `walk` usage.

- [ ] **Step 3: Typecheck + dead-code + tests**

Run: `npm run typecheck && npx knip --production && npx vitest run packages/webapp/tests/fs/`
Expected: all clean/PASS (guarded by `virtual-fs-walk-cycle.test.ts` and `virtual-fs.test.ts` → `describe('walk')`).

- [ ] **Step 4: Commit**

```bash
git add packages/webapp/src/fs/walker.ts packages/webapp/src/fs/virtual-fs.ts
git commit -m "refactor(fs): extract walk leaf helpers into walker.ts"
```

---

## Task 8: Extract `walk` generators into `walker.ts`

**Files:**

- Modify: `packages/webapp/src/fs/walker.ts` (add `walk`, `walkEntry`, `walkSymlink` as generator functions over an injected deps object)
- Modify: `packages/webapp/src/fs/virtual-fs.ts` (replace `walk` ~1779–1814, `walkEntry` ~1836–1851, `walkSymlink` ~1854–1869 with a single `walk` delegate; remove the two now-private helpers; extend import)

**Interfaces:**

- Produces:
  - `interface WalkDeps { mountPoints: WalkMountView; mountIndex: WalkIndexView & { getFiles(path: string): Iterable<string> | null | undefined }; realpath(p: string): Promise<string>; readDir(p: string): Promise<DirEntry[]>; stat(p: string): Promise<Stats> }`
  - `walk(deps: WalkDeps, path: string, visited?: Set<string>, depth?: number): AsyncGenerator<string>`
- Consumes (same file, Task 7): `canUseWalkFastPath`, `safeRealpath`, `MAX_WALK_DEPTH`, `MAX_WALK_ENTRIES`; `DirEntry`, `Stats` from `./types.js`; `normalizePath` from `./path-utils.js`

- [ ] **Step 1: Add the generators** to `walker.ts`. Keep `walkEntry`/`walkSymlink` as module-private (not exported) generators that recurse via the exported `walk`:

```typescript
import { normalizePath } from './path-utils.js';
import type { DirEntry, Stats } from './types.js';

export interface WalkDeps {
  mountPoints: WalkMountView;
  mountIndex: WalkIndexView & { getFiles(path: string): Iterable<string> | null | undefined };
  realpath(p: string): Promise<string>;
  readDir(p: string): Promise<DirEntry[]>;
  stat(p: string): Promise<Stats>;
}

/** Recursively walk a directory tree, yielding all file paths. */
export async function* walk(
  deps: WalkDeps,
  path: string,
  visited?: Set<string>,
  depth = 0
): AsyncGenerator<string> {
  const normalized = normalizePath(path);

  if (canUseWalkFastPath(deps.mountPoints, deps.mountIndex, normalized)) {
    const files = deps.mountIndex.getFiles(normalized);
    if (files) {
      for (const filePath of files) yield filePath;
      return;
    }
  }

  const seen = visited ?? new Set<string>();
  if (depth > MAX_WALK_DEPTH || seen.size >= MAX_WALK_ENTRIES) return;

  const realPath = await safeRealpath((p) => deps.realpath(p), normalized);
  if (seen.has(realPath)) return;
  seen.add(realPath);

  const entries = await deps.readDir(normalized);
  for (const entry of entries) {
    const childPath = normalized === '/' ? `/${entry.name}` : `${normalized}/${entry.name}`;
    yield* walkEntry(deps, entry, childPath, seen, depth + 1);
  }
}

async function* walkEntry(
  deps: WalkDeps,
  entry: DirEntry,
  childPath: string,
  visited: Set<string>,
  depth: number
): AsyncGenerator<string> {
  if (entry.type === 'file') {
    yield childPath;
    return;
  }
  if (entry.type === 'symlink') {
    yield* walkSymlink(deps, childPath, visited, depth);
    return;
  }
  yield* walk(deps, childPath, visited, depth);
}

async function* walkSymlink(
  deps: WalkDeps,
  childPath: string,
  visited: Set<string>,
  depth: number
): AsyncGenerator<string> {
  try {
    const targetStat = await deps.stat(childPath);
    if (targetStat.type === 'file') {
      yield childPath;
    } else if (targetStat.type === 'directory') {
      yield* walk(deps, childPath, visited, depth);
    }
  } catch {
    // Dangling symlink — skip
  }
}
```

- [ ] **Step 2: Delegate from `VirtualFS`** — extend the import to include `walk`, delete `VirtualFS.walkEntry` and `VirtualFS.walkSymlink`, and replace `VirtualFS.walk` with a delegate that builds the deps object once and yields through:

```typescript
  async *walk(path: string, _visited?: Set<string>, _depth = 0): AsyncGenerator<string> {
    yield* walk(
      {
        mountPoints: this.mountPoints,
        mountIndex: this.mountIndex,
        realpath: (p) => this.realpath(p),
        readDir: (p) => this.readDir(p),
        stat: (p) => this.stat(p),
      },
      path,
      _visited,
      _depth
    );
  }
```

Confirm removals: `rg -n "walkEntry|walkSymlink" packages/webapp/src/fs/virtual-fs.ts` shows no hits.

- [ ] **Step 3: Typecheck + dead-code + tests**

Run: `npm run typecheck && npx knip --production && npx vitest run packages/webapp/tests/fs/`
Expected: all clean/PASS. `virtual-fs-walk-cycle.test.ts` must still terminate (the depth/entry bound moved intact into `walker.ts`).

- [ ] **Step 4: Commit**

```bash
git add packages/webapp/src/fs/walker.ts packages/webapp/src/fs/virtual-fs.ts
git commit -m "refactor(fs): extract walk generators into walker.ts"
```

---

## Task 9: Mirror walker unit tests

**Files:**

- Create: `packages/webapp/tests/fs/walker.test.ts`

**Interfaces:**

- Consumes: `walk`, `canUseWalkFastPath`, `MAX_WALK_DEPTH`, `type WalkDeps` from `../../src/fs/walker.js`

- [ ] **Step 1: Write direct unit tests with fake deps** — cover the fast-path (indexed mount), slow-path recursion over a small tree, symlink-to-file yield, and cycle termination via the depth bound.

```typescript
// packages/webapp/tests/fs/walker.test.ts
import { describe, expect, it } from 'vitest';
import { MAX_WALK_DEPTH, canUseWalkFastPath, walk, type WalkDeps } from '../../src/fs/walker.js';

function entry(name: string, type: 'file' | 'directory' | 'symlink'): any {
  return { name, type };
}

async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const v of gen) out.push(v);
  return out;
}

describe('canUseWalkFastPath', () => {
  it('is false when the path is not a mount', () => {
    const mountPoints = new Map();
    expect(canUseWalkFastPath(mountPoints as any, { isReady: () => true }, '/x')).toBe(false);
  });

  it('is true for a ready indexed mount with no nested mounts', () => {
    const mountPoints = new Map([['/mnt', {}]]);
    expect(canUseWalkFastPath(mountPoints as any, { isReady: () => true }, '/mnt')).toBe(true);
  });
});

describe('walk', () => {
  it('uses the index fast path when available', async () => {
    const deps: WalkDeps = {
      mountPoints: new Map([['/mnt', {}]]) as any,
      mountIndex: { isReady: () => true, getFiles: () => ['/mnt/a', '/mnt/b'] },
      realpath: async (p) => p,
      readDir: async () => [],
      stat: async () => ({ type: 'file' }) as any,
    };
    expect(await collect(walk(deps, '/mnt'))).toEqual(['/mnt/a', '/mnt/b']);
  });

  it('recurses the slow path over a small tree', async () => {
    const tree: Record<string, any[]> = {
      '/root': [entry('dir', 'directory'), entry('f.txt', 'file')],
      '/root/dir': [entry('g.txt', 'file')],
    };
    const deps: WalkDeps = {
      mountPoints: new Map() as any,
      mountIndex: { isReady: () => false, getFiles: () => null },
      realpath: async (p) => p,
      readDir: async (p) => tree[p] ?? [],
      stat: async () => ({ type: 'file' }) as any,
    };
    expect((await collect(walk(deps, '/root'))).sort()).toEqual(['/root/dir/g.txt', '/root/f.txt']);
  });

  it('terminates on a self-referential tree via the depth bound', async () => {
    // Every directory re-exposes a child of the same shape → infinite without the cap.
    const deps: WalkDeps = {
      mountPoints: new Map() as any,
      mountIndex: { isReady: () => false, getFiles: () => null },
      realpath: async (p) => p, // mount-like: paths stay distinct, visited-set can't collapse
      readDir: async () => [entry('loop', 'directory')],
      stat: async () => ({ type: 'directory' }) as any,
    };
    const out = await collect(walk(deps, '/root'));
    expect(out.length).toBe(0); // no files, and it returns rather than looping
    expect(MAX_WALK_DEPTH).toBe(64);
  });
});
```

- [ ] **Step 2: Run**

Run: `npx vitest run packages/webapp/tests/fs/walker.test.ts`
Expected: all PASS (the cycle test must complete, not time out).

- [ ] **Step 3: Dead-code gate**

Run: `npx knip --production`
Expected: clean (add negated `project` entry in `knip.json` if flagged).

- [ ] **Step 4: Commit**

```bash
git add packages/webapp/tests/fs/walker.test.ts
git commit -m "test(fs): mirror walker unit tests"
```

---

## Task 10: Full verification pass + PR

**Files:** none (verification only)

- [ ] **Step 1: Run the full pre-push pass** (per `docs/verification.md`)

```bash
npm run lint
npm run typecheck
npm run test
npm run test:coverage:webapp
npm run build -w @slicc/webapp
node packages/dev-tools/tools/check-touched-exemptions.mjs   # touched files are not on the debt list → should pass/skip
```

Expected: all green. `test:coverage:webapp` stays at or above the floor (new unit tests add coverage).

- [ ] **Step 2: Sanity-check the line reduction**

Run: `wc -l packages/webapp/src/fs/virtual-fs.ts`
Expected: ~250–350 fewer lines than the 2,165 baseline; `error-rebrand.ts`, `symlink-resolver.ts`, `walker.ts` exist and are imported.

- [ ] **Step 3: Open the PR**

```bash
git push -u origin issue-1572
gh pr create --fill --base main
```

PR description: reference #1572, state this is subset B (error-rebrand + symlink-resolver + walker), no public API change, mount-registry/backend-init deferred, behavior guarded by unchanged API-level tests.

---

## Self-Review

**Spec coverage:**

- error-rebrand extraction → Tasks 1–3 ✓
- symlink-resolver extraction → Tasks 4–6 ✓
- walker extraction → Tasks 7–9 ✓
- one PR / ~9 idempotent commits → Tasks 1–9 produce 9 commits; Task 10 opens the PR ✓
- no public API change → every delegate keeps the original `VirtualFS` signature ✓
- tests move/mirror alongside → Tasks 3, 6, 9 ✓
- verification per commit → each task Step 3; full pass in Task 10 ✓
- knip-clean intermediate commits → each extraction adds+wires in one commit ✓

**Placeholder scan:** No TBD/TODO/"add error handling"; every code step shows complete code.

**Type consistency:** `convertError`/`rebrandFsError` signatures match across Tasks 1–2 and their consumers (Tasks 4–5). `SymlinkLfs`/`FsStatsLike` defined in Task 4, reused in Tasks 5–6. `WalkMountView`/`WalkIndexView`/`WalkDeps` defined in Tasks 7–8, reused in Task 9. `findMount` is adapted to a `(path) => boolean` predicate at the `VirtualFS` delegate boundary (Task 5), matching the module signature.

**Note on test strategy:** "move alongside" is implemented as _mirror_ — new co-located unit tests exercise the extracted modules directly with fakes, while the existing `VirtualFS` API tests remain in place as the behavior-preservation guard. Deleting the integration tests would remove the very guard that proves no behavior changed, so they are kept.
