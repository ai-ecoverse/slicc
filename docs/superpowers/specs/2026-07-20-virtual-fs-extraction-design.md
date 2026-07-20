# VirtualFS Extraction — Design (Issue #1572, subset B)

## Problem

`packages/webapp/src/fs/virtual-fs.ts` is 2,165 lines: a single `VirtualFS`
class fusing ~8 distinct responsibilities (backend bootstrap, path prefixing,
mount registry, async POSIX surface, sync fast-path, symlink resolution, walk
engine, concurrency/error handling). It is a hot change path (13+ bug-fix
commits recently), so complexity keeps ratcheting up.

Issue #1572 proposes a full 8-way split. The nightly Backlog Dispatcher
**skipped** it as too large / not well-localised. This spec scopes a
**pragmatic subset (option B)**: extract only the cleanest, lowest-risk,
near-self-contained boundaries first, prove the pattern, then re-evaluate
before touching the higher-risk mount/backend internals.

## Scope

**In scope** — three extractions, ordered by risk (low → high):

1. `fs/error-rebrand.ts` — `convertError`, `rebrandFsError`
2. `fs/symlink-resolver.ts` — `realpath`, `resolveRealpathComponent`,
   `lstatOrThrow`, `readAndResolveLink`, `resolveSymlinks`, `MAX_SYMLINK_DEPTH`
3. `fs/walker.ts` — `walk`, `walkEntry`, `walkSymlink`, `canUseWalkFastPath`,
   `safeRealpath`, `MAX_WALK_DEPTH`, `MAX_WALK_ENTRIES`

**Out of scope** (deliberately deferred; re-evaluate after this lands):
`mount-registry`, `backend-init`, `sync-fast-path`, path-prefix/deferred-proxy
shims. These carry the most invariants and churn risk.

## Architecture

`VirtualFS` remains the sole public entry point. It is exported from
`packages/webapp/src/fs/index.ts` and imported by 99 files; none reach into its
private members, so the public API is the only contract that matters.

Each extracted module is an internal sibling under `packages/webapp/src/fs/`.
Extracted logic becomes **module-level functions that take an explicit deps
object**; the corresponding `VirtualFS` method becomes a one-line delegate. No
public API changes, no `VirtualFS` method signature changes.

Dependency shapes (verified against source):

- **error-rebrand**: zero state. `convertError(err, path)` and
  `rebrandFsError(err, normalizedPath)` are already pure (`rebrandFsError` is
  already `static`). Export as free functions.
- **symlink-resolver**: injected deps `{ lfs, findMount }`; imports
  `convertError` from error-rebrand. `findMount` stays on `VirtualFS` (a
  mount-registry concern, out of scope) and is passed as a callback.
- **walker**: injected deps `{ mountPoints, mountIndex, realpath, readDir,
  stat }`. Recurses back through `readDir`/`stat`, passed as bound callbacks.

## Delivery

**One PR, ~9 idempotent commits.** Binding constraint: every commit must
independently compile, pass `knip` (no unused exports), and keep tests green.
That forbids "add module now, wire later" commits, so each extraction adds the
module and rewires `VirtualFS` in the same commit. Splits happen only at seams
where a group is independent (leaf helpers) or depends solely on
already-extracted code.

1. `refactor(fs): extract convertError into error-rebrand.ts` (+delegate)
2. `refactor(fs): extract rebrandFsError into error-rebrand.ts` (+delegate)
3. `test(fs): add error-rebrand unit tests`
4. `refactor(fs): extract lstatOrThrow + readAndResolveLink leaf helpers`
5. `refactor(fs): extract realpath + resolveRealpathComponent + resolveSymlinks`
6. `test(fs): move symlink resolver tests alongside module`
7. `refactor(fs): extract canUseWalkFastPath + safeRealpath leaf helpers`
8. `refactor(fs): extract walk + walkEntry + walkSymlink generators`
9. `test(fs): move walk tests alongside module`

The count may shift by ±1–2 during implementation if a seam is cleaner/messier
than the source suggests. Finer-than-this per-symbol splits are rejected: the
mutually-recursive clusters (`realpath`↔`resolveRealpathComponent`,
`walk`↔`walkEntry`↔`walkSymlink`) cannot be split without an intermediate
commit that fails to compile or needs a throwaway shim.

Rollback granularity = revert any single commit.

## Testing

Existing API-level tests (`virtual-fs*.test.ts`, symlink tests,
`virtual-fs-walk-cycle.test.ts`) are the behavior-preservation guard and stay
green with zero edits in every `refactor` commit. Test handling per the agreed
approach: tests move/mirror alongside each new module (steps 3, 6, 9).

- error-rebrand gains a new unit test file
  (`tests/fs/error-rebrand.test.ts`) — the ZenFS/LightningFS error-code mapping
  is now testable in isolation.
- symlink-resolver and walker keep their existing behavior tests, relocated to
  module-named files under `tests/fs/`.

Coverage floors are CI-enforced and never hand-lowered; the new error-rebrand
unit test raises coverage, and relocated tests preserve it.

## Verification (per commit, before push)

Per `docs/verification.md`: `lint` (first — most common CI failure) →
`typecheck` → the `fs` test suite → `test:coverage:webapp` → touched-file
complexity gate. `knip` runs in the lint gate and must stay clean at every
commit (this is what forbids unused-export intermediate states).

## Risks / mitigations

- **Deps-object drift** (extracted fn diverging from `this` semantics):
  mitigated by each `refactor` commit being a pure move + delegate, verified by
  unchanged API-level tests.
- **`findMount` coupling** in symlink-resolver: injected as a callback rather
  than extracted, keeping subset-B scope honest.
- **knip on intermediate commits**: avoided by add+wire in the same commit.
- **Coverage floor**: new unit test raises it; relocations preserve it.
