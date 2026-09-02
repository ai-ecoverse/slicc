---
name: verifying-before-push
description: |
  Use when committing, pushing, opening or updating a PR, or when CI fails on lint, typecheck, build, or coverage. Covers the full verification pass (lint → typecheck → test → coverage → build), lint:ci strictness, the boy-scout debt gate (check-touched-exemptions.mjs — complexity, promise safety, and ui back-edges; not part of npm run lint, easy to miss locally), and coverage floors. Also triggered by CI error strings like 'check-touched-exemptions' failure, 'biome found errors', or 'below configured minimum coverage'.
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
```

Run `npm run verify` first because formatting is the most common CI failure. Do not omit the
separate `check-touched-exemptions.mjs` command: `npm run verify` does not include it.
`npm run bundle-size` needs both builds to have run first — it measures files in `dist/`.

## Pre-push lint gate (automatic)

The `.husky/pre-push` hook runs the full CI lint gate automatically before every
push to a feature branch. It mirrors every check from the CI `lint` job —
biome, prettier, custom lint scripts, complexity gate, manifest justifications,
and knip dead-code detection — all in parallel (~6 s wall-clock), then the
autofix-drift check (below) serially, because it writes.

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
npm run typecheck
npm run test
npm run test:coverage                  # Enforces minimum coverage thresholds
npm run build
npm run build -w @slicc/chrome-extension
npm run bundle-size                    # Bundle budgets; needs the builds above
```

The `check-touched-exemptions.mjs` gate runs right after lint because it catches
grandfathered debt that lint alone misses. See the section below for details.

## Lint

Run `npm run lint`. It runs `biome check --write .` over JS/TS/JSON/CSS and
`prettier --write .` over the remaining doc / config-text formats (Markdown, YAML, HTML),
then `lint:docs` (CLAUDE.md size limits), `lint:skills` (tessl `SKILL.md` lint),
`lint:skill-router` (developer-skill router and alias sync), `lint:no-innerhtml`,
`lint:layer-back-edges` (no new imports pointing up the layer stack — baseline-ratcheted;
fix the layering, never grow `layer-back-edge-baseline.json`),
`lint:record-string-unknown` (no new `Record<string, unknown>` in non-test source —
baseline-ratcheted; name the shape, or suppress a genuinely untyped payload with
`// biome-ignore lint/plugin: <reason>`, never grow
`record-string-unknown-baseline.json`), `lint:patches`,
`lint:swift-pins` (GitHub SPM packages dual-pinned in `Package.swift` and
xcodegen `project.yml` must overlap — see `packages/dev-tools/swift-pin-reconcile/`),
`lint:swift-deps` (SPM unused-dependency gate — see below), and `lint:duplication`.

CI runs the check-only/strict equivalents (`npm run lint:ci`) as a hard gate and will reject
any unformatted code. **This is the most common CI failure — do not skip it.**

CI then runs `npm run lint:autofix-drift`, which fails if `biome check --write` changes any
file. `biome check` only fails on errors, but `--write` applies every safe fix, including
those of warn/info rules, so a violation of one of those passes `lint:ci` yet gets rewritten by
every local `npm run lint` — re-dirtying every worktree. Such violations land through commits
that skip the pre-commit hook (GitHub web UI, Copilot Autofix). Fix: `npm run lint`, commit.

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

## Unused-dependency gates (all three toolchains)

Every shipped app has a hard gate that fails when a declared dependency is not
actually used. Run the one for the tree you touched:

```bash
npm run deadcode                       # knip: TS/JS workspaces (unused + unlisted deps)
npm run lint:swift-deps                # SPM: packages/*/Package.swift vs the import graph
cd packages/go-optel  && make tidy-check   # go mod tidy -diff
cd packages/slicc-cli && make tidy-check   # go mod tidy -diff
```

`lint:swift-deps`
([`check-swift-unused-deps.mjs`](../../../packages/dev-tools/tools/check-swift-unused-deps.mjs))
is chained into `lint` / `lint:ci`, so the CI `lint` job enforces it with no Swift
toolchain needed — the manifests are parsed as text. It reports
`unused-package-dependency`, `unused-target-dependency`, and `unlisted-dependency`
(a module imported but reached only transitively — declare it on the target that
imports it). Fix the manifest rather than the gate; a product that is genuinely
linked without being imported gets a `// unused-dep-ok: <reason>` annotation on
its declaration line. Full semantics:
[dev-tools-details.md#swift-unused-dependency-gate](../../../docs/dev-tools-details.md#swift-unused-dependency-gate).

The Go `tidy-check` targets also run inside each module's `make check`, which is
what the `go-optel` and `slicc-cli` CI jobs invoke.

## Bundle-size budgets (`bundle-size`)

`npm run bundle-size` runs size-limit for the two Vite-bundled browser apps. Budgets live in
the `size-limit` block of [`packages/webapp/package.json`](../../../packages/webapp/package.json)
and [`packages/chrome-extension/package.json`](../../../packages/chrome-extension/package.json),
next to the code they guard, and are measured on raw (non-brotli) bytes.

The webapp `size` script additionally runs
`packages/dev-tools/tools/check-first-load-size.mjs`, which measures the EAGER import
closures fetched on a cold-cache boot (the page entry graph and the kernel-worker graph).
A static import that hoists an existing lazy chunk into the boot graph fails this gate even
though no single file grew — make the import dynamic.

**This check is relative, not an absolute budget.** It builds your change's merge-base in a
throwaway git worktree (your working tree is never touched) and compares, so it fails only
when _your change_ grows a graph by more than `maxDeltaKb` in
[`packages/webapp/first-load-budget.json`](../../../packages/webapp/first-load-budget.json).
You will not inherit someone else's regression, and the number reproduces locally: both
sides are built on the same machine in the same run, which cancels the ~1 kB difference
between a Linux CI build and a macOS one. The baseline costs ~4 s: the worktree gets a
dependency tree whose workspace packages point at its OWN source (never the caller's, or a
webcomponents change would measure as 0 kB), then the same prerequisite workspace builds the
root `postinstall` runs, then the webapp build.

```bash
node packages/dev-tools/tools/check-first-load-size.mjs                    # vs origin/main
node packages/dev-tools/tools/check-first-load-size.mjs --baseline=none    # ceilings only
node packages/dev-tools/tools/check-first-load-size.mjs --json             # just measure
```

If the merge-base cannot be built (shallow clone, unknown ref) the delta is reported as
SKIPPED and only the ceilings are enforced, so you are not blocked locally. **In CI on a
pull request that same condition is a hard failure** — the merge queue deliberately does not
re-check the delta, so a PR whose baseline could not be built must not be waved through with
its growth unmeasured. Re-run if it looks transient.

**On `merge_group` the delta is deliberately not applied.** A queue branch is cumulative — it
carries every PR up to its position — so its delta is the SUM of the batch, not one change's
growth, and a per-change allowance would fail on queue depth (observed batches hit +3.8 kB
while their individual PRs measured 0.1-1.9 kB). The ceilings are the right check there, and
every PR in the batch was already delta-gated against its own merge-base.

The `*EagerCeilingKb` values in the same file are the absolute backstop, since a delta gate
alone would let many small under-threshold changes creep upward forever. They are a
deliberate cold-boot limit, **not** a number to nudge when a build goes red: tighten them
freely as payloads shrink, and raise one only with a reason in the PR body.

It reads built output, so run `npm run build` and
`npm run build -w @slicc/chrome-extension` first. CI enforces it in the `bundle-size` job,
which builds both apps itself.

The size-limit budgets are ratchets like the duplication threshold: tighten them as payloads
shrink. Raising one needs a justification in the PR body.

## Boy-scout debt gate (`check-touched-exemptions.mjs`)

Run this separate gate after lint:

```bash
node packages/dev-tools/tools/check-touched-exemptions.mjs
```

CI's `lint` job runs this step **after** `lint:ci`. It is **not** part of `npm run lint`, so
it is easy to miss locally.

The gate enforces five "debt lists" of files grandfathered out of a rule:

- `complexity.noExcessiveCognitiveComplexity` (`biome.json` `overrides`; cap: cognitive
  complexity **≤ 25**)
- `complexity.noExcessiveLinesPerFunction` (`biome.json` `overrides`; cap: **≤ 150** lines
  per function)
- `nursery.noFloatingPromises` (`biome.json` `overrides`; promises must be awaited,
  returned, or explicitly handled)
- `nursery.noMisusedPromises` (`biome.json` `overrides`; promises cannot stand in for
  synchronous callbacks or conditions)
- Layer-stack back-edges (`packages/dev-tools/tools/layer-back-edge-baseline.json`; cap:
  **0** imports pointing up the stack `fs → shell/git → cdp → tools → core → scoops → ui`)
- Untyped string-keyed bags (`packages/dev-tools/tools/record-string-unknown-baseline.json`;
  cap: **0** `Record<string, unknown>` in non-test source)

When a PR **touches** any file still on one of those debt lists, this gate **fails** unless,
in the same change, you pay the file's debt down and remove its entry:

- Biome lists: fix every violation of the named rule, then delete the file's entry from the
  corresponding `biome.json` `overrides` block.
- Back-edge baseline: remove every up-the-stack import from the file (move the pure helper
  into the lower layer), then run
  `node packages/dev-tools/tools/check-layer-back-edges.mjs --update`.
- `Record<string, unknown>` baseline: replace every occurrence in the file with a named type
  for the shape you actually accept (or, for a genuinely untyped payload, a
  `// biome-ignore lint/plugin: <reason>` line), then run
  `node packages/dev-tools/tools/check-record-string-unknown.mjs --update`.

Treat all six as one-way ratchets: never add a file to a debt list to silence it — the gate
also fails when a PR grows any list vs the base ref. The gate auto-skips on `merge_group` /
`push` events (it resolves the merge-base against `$GITHUB_BASE_REF`), so always run it
locally before pushing if you touched a listed file.

For warning-only cleanup PRs, this means "lint warning count down" is not enough: if you
touch a debt-listed file, you must fully pay down that file's debt in the same PR or avoid
touching that file.

To check whether a file is exempt, search `biome.json` for its path under a single-rule
`"off"` override, and `layer-back-edge-baseline.json` / `record-string-unknown-baseline.json`
for its path key.

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
npm run lint:swift-deps                # SPM unused-dependency gate (hard gate, in lint:ci)
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
