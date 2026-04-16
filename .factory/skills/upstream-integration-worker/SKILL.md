---
name: upstream-integration-worker
description: Fork, build, and vendor an upstream npm dependency. Used for tasks that require modifying a third-party package to expose hidden exports, applying upstream patches locally via rebuild+vendor, and opening pull requests upstream via the `gh` CLI. Not for writing webapp code.
---

# upstream-integration-worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE for external-dependency integration work.

## When to Use This Skill

Features that require:

- Cloning an upstream npm dependency repo and applying a small diff
- Running the upstream package's own build (tsup/rollup/esbuild/tsc/whatever it uses)
- Vendoring built artifacts into our repo (`packages/webapp/src/vendor/...`) and wiring Vite aliases so our webapp sees the patched version
- Opening a pull request upstream via the `gh` CLI so the patch can land in a future published release
- Any combination of the above

Do NOT use this skill for normal webapp/tool/bridge work — that's `webapp-worker`.

## Work Procedure

### 1. Read mission artifacts

- `mission.md`, `AGENTS.md`, `validation-contract.md` (if the feature fulfills contract assertions)
- The feature's description, preconditions, expected behavior, verification steps
- `.factory/library/architecture.md` to understand how the dependency is consumed
- Any relevant research in `.factory/research/` — do NOT re-investigate what's already documented

### 2. Verify tools are present

```bash
which gh && gh --version
which git && git --version
which node && node --version
corepack --version   # needed for pnpm/yarn auto-activation
```

If `gh` is missing, STOP and return to orchestrator. If corepack is missing, try `npm i -g corepack` or document the workaround.

### 3. Clone upstream to /tmp

```bash
git clone --depth 1 <upstream-url> /tmp/<pkg-name>-src
cd /tmp/<pkg-name>-src
git log --oneline -1   # record the HEAD we're working against
```

Read the upstream repo's README, CONTRIBUTING, package.json (scripts + exports map), and build config. Note which package manager upstream uses (pnpm/npm/yarn) and which Node version.

### 4. Apply the diff to upstream

- Make the smallest, most surgical change that achieves the goal
- Follow existing upstream code style (TypeScript strict, module conventions, etc.)
- Do NOT reformat files you don't need to touch
- Record the exact diff applied (you'll need it for the vendor side, the PR body, and the handoff)

### 5. Build upstream locally

```bash
<pkgmgr> install --ignore-scripts --no-frozen-lockfile
<pkgmgr> run build   # or the specific script the upstream package documents
```

If the build fails, diagnose (outdated lockfile, optional native deps, etc.). If the upstream's validation step (`pnpm validate` / `npm test` / etc.) exists, run it too — a PR that fails upstream's own gates is not mergeable.

### 6. Vendor the build artifacts into our repo (parallel to PR)

Vendor under a clear path:

```bash
mkdir -p packages/webapp/src/vendor/<pkg-name>/
# Copy ONLY the artifacts our webapp actually needs:
# - dist/bundle/<the specific bundle we consume>
# - dist/*.d.ts (type surface)
# - any subdirs of .d.ts our webapp's types require (e.g. dist/parser/, dist/ast/)
# Do NOT copy source maps unless strictly necessary; they bloat the repo.
```

**Important gotcha — .d.ts transitive references:** Most upstream packages' top-level `.d.ts` files transitively reference subdirectories beyond what the package.json `files` field advertises (e.g. `transform/`, `helpers/`, `security/`, `regex/`, `shell/`). A blanket "copy all `.d.ts` then prune test-only directories" strategy is the practical approach. After copying, run `npm run typecheck` from the repo root; any "cannot find module" error tells you which subdirectory is still missing.

Write a short `packages/webapp/src/vendor/<pkg-name>/README.md` documenting:

- The upstream URL, commit hash, and version
- The exact diff applied
- How to re-run the vendor rebuild (commands)
- The link to the upstream PR (once opened)
- A "remove this vendor directory when upstream version >= X.Y.Z is released and we bump our dependency" note

### 7. Wire the vendor via Vite alias

In the consuming package's Vite config (e.g. `packages/webapp/vite.config.ts`), add an alias so `import '<pkg>'` resolves to the vendored bundle. Prefer a conditional alias keyed on NODE_ENV so CI/prod both use the vendor. Document the change inline.

**Important:** `vitest.config.ts` needs the SAME alias duplicated — Vite and Vitest do NOT share resolver configs automatically in this repo. Similarly, if the package is also consumed by the Chrome extension build, add the alias to `packages/chrome-extension/vite.config.ts` as well.

Also update any TypeScript path mappings if the .d.ts lives in the vendor directory (`tsconfig.json` `paths`).

### 8. Verify the vendor works in our repo

From repo root:

```bash
npm run typecheck            # expect green — vendored .d.ts resolves
npm run test                 # existing tests still green
npm run build -w @slicc/webapp          # webapp bundles with vendor
npm run build -w @slicc/chrome-extension # extension bundles with vendor
npx prettier --check .       # no formatting regressions
```

If any gate fails, FIX before proceeding. Do NOT open the PR or commit until all gates are green.

### 9. Fork + open upstream PR via gh CLI

From the `/tmp/<pkg-name>-src` clone:

```bash
gh repo fork --clone=false --remote=false   # creates fork under the auth'd user
git remote add fork https://github.com/<gh-user>/<pkg-name>.git
git checkout -b <branch-name>
git add -A && git commit -m "<conventional commit>"
git push -u fork <branch-name>
gh pr create --repo <upstream-org>/<pkg-name> --title "<title>" --body-file /tmp/<pkg-name>-pr-body.md --base main
```

The PR body should:

- Briefly motivate the change
- Reference any prior similar PR (e.g. "follows PR #186")
- Confirm `<pkgmgr> validate` passes
- Note there are no `node:*` imports in the newly-exposed modules (if relevant)
- Keep it under 400 words

Record the PR URL in the handoff.

**Gotcha — GH_TOKEN injection:** Some environments inject `GH_TOKEN` / `GITHUB_TOKEN` backed by a GitHub App that lacks PR-creation scope on arbitrary public repos. If `gh pr create` fails with "GraphQL: Resource not accessible by integration", strip the injected token so `gh` falls back to keyring credentials:

```bash
env -i HOME="$HOME" PATH="$PATH" bash -c 'gh pr create --repo <upstream-org>/<pkg-name> --title "..." --body-file /tmp/<pkg-name>-pr-body.md --base main --head <fork-user>:<branch-name>'
```

### 10. Commit vendor changes + run CI gates in our repo

```bash
cd <repo-root>
npx prettier --write <changed-files>
git add packages/webapp/src/vendor/<pkg-name>/ packages/webapp/vite.config.ts <tsconfig changes if any>
git commit -m "<conventional commit referencing the upstream PR URL>"
```

### 11. Full handoff

Your handoff MUST include:

- `upstreamRepo`: the cloned URL + HEAD commit
- `upstreamDiff`: the exact patch applied (unified diff, small enough to include)
- `upstreamPrUrl`: the opened PR URL (or null if the PR step was skipped)
- `vendorPath`: absolute path in our repo where the vendor lives
- `viteAliasDiff`: the Vite config change
- `verificationResults`: typecheck/test/build exit codes and observations
- `removalPlan`: what conditions must hold for a future worker to delete the vendor directory (e.g., "when just-bash >= 2.15.0 is released with parse/AST exports, bump dep and delete vendor dir in a single commit")

### 12. Commit discipline

- Commit messages must be specific enough that future-you can find the vendor later
- Do NOT include secrets (PAT tokens, etc.) in commits
- Do NOT commit anything under `/tmp/...` or symlinks to it — all vendored content must be a real copy inside our repo
- Verify `git status` is clean after committing before declaring the feature done

## What NOT to do

- Do NOT modify any upstream source files in `node_modules/` directly (they get wiped on `npm install`).
- Do NOT attempt to patch minified bundles — mangled names change each build.
- Do NOT use `patch-package` unless you've confirmed the patch targets unminified files with stable identifiers.
- Do NOT write tests in `packages/webapp/tests/` for the vendored dependency itself — our tests go against our integration, not the upstream.
- Do NOT change any `packages/webapp/src/` application code in this skill; integration rewrites are a separate feature using `webapp-worker`.
