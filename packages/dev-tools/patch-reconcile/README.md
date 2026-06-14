# patch-reconcile

Tooling that keeps `patch-package` patches (in the repo-root `patches/`) honest
across Renovate dependency bumps. A patch is version-pinned by filename, so a
bump silently orphans it; these helpers detect that and drive reconciliation.

- **`lib.mjs`** — pure helpers (unit-tested in `lib.test.mjs`):
  - `parsePatchFilename` — `<pkg>+<version>.patch` → `{ pkg, version }` (handles
    scoped + sequenced patches).
  - `lockedVersion` — installed version from a parsed `package-lock.json`.
  - `checkPatches` — validates patch files against `patches/patches.json` and the
    lockfile; returns `{ problems, notes, checked }`.
  - `orphanedPatches` — the drifted patches plus their manifest metadata.
- **`check-patches.mjs`** — the guard. Run via `npm run lint:patches` (wired into
  `lint` / `lint:ci`). Exits non-zero on an undocumented, out-of-sync, or
  orphaned patch. Reads only the lockfile + `patches/` (no install).
- **`reconcile-context.mjs`** — prints the orphaned patches (markdown, or `--json`)
  with upstream / removeWhen / verify metadata. Consumed by
  `.github/workflows/renovate-patch-reconcile.yml` to brief Claude on exactly
  what to regenerate-or-remove.

See [`patches/README.md`](../../../patches/README.md) for the end-to-end flow.
