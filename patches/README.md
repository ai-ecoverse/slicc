# Dependency patches

This directory holds [`patch-package`](https://github.com/ds300/patch-package)
patches applied to installed dependencies on `postinstall` (see the root
`package.json`). Each patch is version-pinned by filename
(`<pkg>+<version>.patch`; scoped packages encode the scope slash as `+`, e.g.
`@zenfs+core+2.5.6.patch`).

Because patches are pinned to an exact version, a Renovate bump moves the
installed version past the patch and the fix **silently stops applying**. The
machinery below makes that impossible to miss and (mostly) self-healing.

## `patches.json` — the manifest (required)

Every patch **must** have an entry in [`patches.json`](./patches.json), keyed by
the npm package name:

| Field            | Meaning                                                                           |
| ---------------- | --------------------------------------------------------------------------------- |
| `patchedVersion` | Must match the version in the patch filename (and the installed version).         |
| `upstream`       | The upstream PR/issue/repo carrying the real fix (or the repo if none tracked).   |
| `issue`          | Our tracking issue, if any.                                                       |
| `reason`         | One line: what the patch changes and why.                                         |
| `removeWhen`     | The condition under which the patch can be deleted (e.g. "released in upstream"). |
| `verify`         | The command that proves the patch still works after a regenerate.                 |

## Guard — `npm run lint:patches`

[`packages/dev-tools/patch-reconcile/check-patches.mjs`](../packages/dev-tools/patch-reconcile/check-patches.mjs)
runs as part of `npm run lint` / `lint:ci` (so it gates every PR). It fails when
a patch is undocumented, out of sync with `patches.json`, or **orphaned** — the
patch version no longer matches `package-lock.json`. It reads only the lockfile
and `patches/`, so it needs no install. This is the deterministic backstop: an
orphaned patch cannot merge silently.

## Renovate + auto-reconcile

- `renovate.json` routes patched packages into the **`patched dependencies`**
  group, labels them **`patched-dependency`**, and **disables automerge** for
  them. Keep that rule's `matchPackageNames` in sync with this directory.
- [`.github/workflows/renovate-patch-reconcile.yml`](../.github/workflows/renovate-patch-reconcile.yml)
  runs on those PRs: it detects the orphaned patch and hands it to
  `claude-code-action`, which either **removes** the patch (upstream fix landed)
  or **regenerates** it for the new version, runs the manifest `verify` command,
  pushes to the PR branch, and comments. The guard above still has the final say.

## Adding a patch

1. Edit `node_modules/<pkg>/…`, then `npx patch-package <pkg>`.
2. Add a `patches.json` entry (all fields above).
3. Add the package to the `patched dependencies` rule in `renovate.json`.
4. `npm run lint:patches` to confirm it's consistent.

## Removing a patch

Delete `patches/<pkg>+<version>.patch`, drop its `patches.json` entry, and remove
the package from the `renovate.json` rule. (The reconcile workflow does this for
you when a bump shows the upstream fix has landed.)
