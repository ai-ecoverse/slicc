---
name: verifying-before-push
description: |
  Use when committing, pushing, opening or updating a PR, or when CI fails on lint, typecheck, build, or coverage. Covers the full verification pass (lint → typecheck → test → coverage → build), lint:ci strictness, the boy-scout debt-list gate (check-touched-exemptions.mjs — not part of npm run lint, easy to miss locally), the CI quarantine registry, and coverage floors. Also triggered by CI error strings like 'check-touched-exemptions' failure, 'check-ci-quarantine' failure, 'biome found errors', or 'below configured minimum coverage'.
---

# verifying-before-push

Run the full verification pass **before committing, pushing, or opening or updating a PR**.
These commands mirror the CI gates in
[`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml); running them locally first
is the fastest way to avoid a red PR.

## Quick Reference

```bash
npm run verify
npm run typecheck
npm run test
npm run test:coverage
npm run build
npm run build -w @slicc/chrome-extension
npm run bundle-size
node packages/dev-tools/tools/check-touched-exemptions.mjs
npm run lint:ci-quarantine
```

Run `npm run verify` first because formatting is the most common CI failure. Do not omit the
separate `check-touched-exemptions.mjs` command: `npm run verify` does not include it.
`npm run bundle-size` needs both builds to have run first — it measures files in `dist/`.

## Pre-push lint gate (automatic)

The `.husky/pre-push` hook runs the full CI lint gate automatically before every
push to a feature branch. It mirrors every check from the CI `lint` job —
biome, prettier, custom lint scripts, complexity gate, manifest justifications,
and knip dead-code detection — all in parallel (~6 s wall-clock).

You can also run it manually:

```bash
npm run verify                         # Same gate, run on demand
```

Escape hatch: `git push --no-verify` bypasses the gate when needed.

## The standard pass

Run every command in order:

```bash
npm run verify                         # Lint gate (mirrors CI lint job)
node packages/dev-tools/tools/check-touched-exemptions.mjs  # NOT in npm run verify — easy to miss
npm run lint:ci-quarantine             # Also not in npm run verify
npm run typecheck
npm run test
npm run test:coverage                  # Enforces minimum coverage thresholds
npm run build
npm run build -w @slicc/chrome-extension
npm run bundle-size                    # Bundle budgets; needs the builds above
```

The `check-touched-exemptions.mjs` gate runs right after lint because it catches
complexity debt that lint alone misses. See the section below for details.

## Lint

Run `npm run lint`. It runs `biome check --write .` over JS/TS/JSON/CSS and
`prettier --write .` over the remaining doc / config-text formats (Markdown, YAML, HTML),
then `lint:docs` (CLAUDE.md size limits), `lint:skills` (tessl `SKILL.md` lint),
`lint:skill-router` (developer-skill router and alias sync), `lint:no-innerhtml`,
`lint:patches`, and `lint:duplication`.

CI runs the check-only/strict equivalents (`npm run lint:ci`) as a hard gate and will reject
any unformatted code. **This is the most common CI failure — do not skip it.**

## Duplicate-code gate (`lint:duplication`)

`npm run lint:duplication` runs jscpd against `jscpd.json` and fails when total duplicated
lines exceed the `threshold` there. It is chained into both `lint` and `lint:ci`, so the CI
`lint` job and the pre-push gate both enforce it — there is no separate CI job.

Coverage spans all eight shipped applications: TypeScript/JS for `packages/webapp`,
`packages/node-server`, `packages/chrome-extension` and `packages/cloudflare-worker`, Swift
for `packages/swift-launcher`, `packages/swift-server` and `packages/ios-app`, and Go for
`packages/slicc-cli`.

```bash
npm run lint:duplication               # The gate (silent unless over threshold)
npm run lint:duplication:report        # Browsable HTML + JSON clone report in dist/jscpd/
```

When the gate trips, run the report script and read `dist/jscpd/` to find the clone pairs.

The threshold is a **one-way ratchet**, held just above the measured baseline in the same
spirit as `coverage-thresholds.json`. Lower it as duplication is paid down; never raise it
to turn a red run green. The nightly `debt:duplication` rotation in
[`.github/workflows/agentic-debt-triage.yml`](../../../.github/workflows/agentic-debt-triage.yml)
is the intended driver for paying it down.

`packages/dev-tools/tools/duplication-config.test.mjs` guards the config itself: it asserts
every application path is still scanned with a non-zero file count, so an over-broad `ignore`
entry cannot silently drop an app from the signal.

jscpd's config parser prints a harmless `unknown field '$comment'` warning for the rationale
key in `jscpd.json`. That is expected — do not silence it by deleting the key.

## Bundle-size budgets (`bundle-size`)

`npm run bundle-size` runs size-limit for the two Vite-bundled browser apps. Budgets live in
the `size-limit` block of [`packages/webapp/package.json`](../../../packages/webapp/package.json)
and [`packages/chrome-extension/package.json`](../../../packages/chrome-extension/package.json),
next to the code they guard, and are measured on raw (non-brotli) bytes.

It reads built output, so run `npm run build` and
`npm run build -w @slicc/chrome-extension` first. CI enforces it in the `bundle-size` job,
which builds both apps itself.

Budgets are ratchets like the duplication threshold: tighten them as payloads shrink. Raising
one needs a justification in the PR body.

## Boy-scout debt-list gate (`check-touched-exemptions.mjs`)

Run this separate gate after lint:

```bash
node packages/dev-tools/tools/check-touched-exemptions.mjs
```

CI's `lint` job runs this step **after** `lint:ci`. It is **not** part of `npm run lint`, so
it is easy to miss locally.

It covers every debt / exemption list in the repo, with **deliberately different semantics
per list** (registry: [`packages/dev-tools/tools/debt-list-sources.mjs`](../../../packages/dev-tools/tools/debt-list-sources.mjs)):

| List                                                               | Frozen (no growth) | Touched-file rule | On growth |
| ------------------------------------------------------------------ | ------------------ | ----------------- | --------- |
| `biome.json` complexity debt (function-size, cognitive-complexity) | yes                | **yes**           | fail      |
| `biome.json` overrides that disable non-complexity rules           | yes                | no                | fail      |
| `coverageExclude` in `coverage-thresholds.json`                    | yes                | no                | fail      |
| `ignore` in `jscpd.json`                                           | yes                | no                | fail      |
| `ignore` / `ignoreDependencies` / `ignoreBinaries` in `knip.json`  | reported           | no                | warn only |

The touched-file rule applies **only** to the two complexity debt lists, because every entry
there is a file that can actually be brought under the cap. The other lists legitimately
contain permanent entries (generated files, `*.d.ts`, vendored code, fixtures), so touching a
listed file is fine — growing the list is not. `knip.json` never fails: Renovate and new build
tools legitimately add ignore entries.

`coverageExclude` matters most: it is the **denominator** of the floors the nightly ratchet
raises, so a new exclusion makes the reported percentage go up while real coverage goes down.

Every list has the same bootstrapping exemption: entries in a scope the base ref does not
have at all (a brand-new list, or a newly added package inside a per-package list) are being
introduced rather than grown, and are ignored. If the base version of a config cannot be read
at all, that list's growth check is skipped with a `notice —` line instead of failing.

`biome.json` keeps two `overrides` "debt lists" of files that are grandfathered out of the
complexity rules:

- `complexity.noExcessiveCognitiveComplexity` (cap: cognitive complexity **≤ 25**)
- `complexity.noExcessiveLinesPerFunction` (cap: **≤ 150** lines per function)

When a PR **touches** any file still on one of those debt lists, this gate **fails** unless,
in the same change, you:

1. Refactor every function in that file under the relevant cap, then
2. Remove the file's entry from the corresponding `biome.json` `overrides` block.

Treat this as a one-way ratchet: never add a file to the debt list to silence it. The gate
auto-skips on `merge_group` / `push` events (it resolves the merge-base against
`$GITHUB_BASE_REF`), so always run it locally before pushing if you touched a listed file.

For warning-only cleanup PRs, this means "lint warning count down" is not enough: if you
touch a debt-listed file, you must fully pay down that file's complexity debt in the same
PR or avoid touching that file.

To check whether a file is exempt, search `biome.json` for its path under the
`noExcessiveCognitiveComplexity: "off"` / `noExcessiveLinesPerFunction: "off"` overrides.

## CI quarantine registry (`lint:ci-quarantine`)

```bash
npm run lint:ci-quarantine
```

A `continue-on-error: true` step cannot fail its job, so every one of them is a hole in CI.
[`ci-quarantine.json`](../../../ci-quarantine.json) declares each one with a `reason`, an
`owner` (the package or area that owns paying it down) and a `reviewBy` date;
[`packages/dev-tools/tools/check-ci-quarantine.mjs`](../../../packages/dev-tools/tools/check-ci-quarantine.mjs)
enforces it in the CI `lint` job over the workflows listed in the registry's `workflows` key.

- **Fails** on a `continue-on-error: true` step that is not declared, and on a malformed
  registry entry (placeholder reason, missing owner, non-`YYYY-MM-DD` date). The failure output
  prints a paste-ready JSON stub.
- **Warns only** when an entry is past its `reviewBy`, and when an entry's step no longer
  exists (delete the entry). A date-triggered hard failure would break unrelated PRs, which is
  worse than the debt it flags.

Adding a quarantine is therefore a deliberate, reviewable act. Removing one is always allowed —
delete its registry entry in the same PR. Keys are `workflow` + `job` + `step` name, so
renaming a step counts as a new quarantine.

## Coverage

Run `npm run test:coverage` to enforce the per-package floors from
`coverage-thresholds.json`. See [`writing-slicc-tests` → Enforce Coverage](../writing-slicc-tests/SKILL.md#enforce-coverage)
for how the floors are maintained by the nightly ratchet and for the per-package and Swift
commands.

## Native gates (Swift / Go)

`npm run verify` covers only the JS/TS tree. The five native CI jobs
(`swift-server`, `swift-optel`, `swift-launcher`, `ios-app`, `slicc-cli`) have their own
gates; run them when you touched a native package:

```bash
npm run lint:swift                     # SwiftLint across all four Swift/iOS packages
npm run lint:swift:format              # swift format lint --strict (config: root .swift-format)
npm run format:swift                   # swift format --in-place (fixes the above)
npm run deadcode:swift                 # Periphery on the 3 SPM packages (informational)
cd packages/slicc-cli && make check    # gofmt + tidy-check + vet + golangci-lint + race + coverage
```

`ios-app` has no `package.json`, so its Periphery scan lives only in its CI job —
`knip.json` (off-limits to hand-edits here) does not allow `periphery` as a root-script
binary, unlike the per-package scripts, which sit inside knip's ignore list.

`swift format` ships with the Swift 6+ toolchain — no install step. It is a formatter;
SwiftLint remains the linter, and the two configs are deliberately consistent (4-space
indentation, 160-column lines).

Swift coverage floors come from the same `coverage-thresholds.json` as the TypeScript ones:

```bash
./packages/dev-tools/tools/swift-coverage-check.sh packages/swift-server SliccServerPackageTests
./packages/dev-tools/tools/swift-coverage-check.sh packages/swift-optel SwiftOptelPackageTests
./packages/dev-tools/tools/swift-coverage-check.sh packages/swift-launcher SliccstartPackageTests
./packages/dev-tools/tools/swift-coverage-check.sh --xcodebuild SliccFollower packages/ios-app SliccFollower
```

`ios-app` cannot use `swift test` (its WebRTC dependency is iOS-only), so it takes the
script's `--xcodebuild` mode, which runs `xcodebuild test` on a simulator and reports over
the same `llvm-cov` path as the SPM packages. See
[`packages/ios-app/CLAUDE.md`](../../../packages/ios-app/CLAUDE.md) for the simulator
prerequisites.

## Other CI-only gates

If local checks pass but CI still fails, inspect
[`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml). The `cloudflare-worker`
job runs `wrangler deploy --dry-run`. This rarely trips for typical changes but lives in
`.github/workflows/ci.yml` if you need it. The `bundle-size` job is the other CI-only gate;
reproduce it locally with `npm run bundle-size` after both builds. All other lint-job gates (manifest
justifications, knip dead-code) are now covered by the pre-push lint gate (`npm run
verify`).

## Knip fixture exclusion

The dead-code gate uses `knip --production` to detect test-only dead files. Keep test
fixtures out of the production graph **without** triggering knip's own
`Remove unused ignore` warning. Two mechanisms exist; only one works cleanly:

- **`ignoreFiles` with `!`-suffix patterns — does NOT work.** The `!` suffix is passed
  directly to picomatch and is not treated as a negation. Using it both fails to exclude
  the file from the dead-files report and may produce `Remove unused ignore` hints in the
  default gate.
- **Negated `project` patterns in `knip.json` — the correct approach.** Add
  `"!tests/some-fixture.mjs"` to the workspace's `project` array to keep the file out of
  the production dependency graph and avoid the `Remove unused ignore` hint in both the
  default and `--production` gates.

Whenever a new test fixture triggers a knip dead-file warning, add a negated entry to the
relevant workspace's `project` list in `knip.json`, not to `ignoreFiles`.
