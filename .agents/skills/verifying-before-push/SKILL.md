---
name: verifying-before-push
description: |
  Use when committing, pushing, opening or updating a PR, or when CI fails on lint, typecheck, build, or coverage. Covers the full verification pass (lint → typecheck → test → coverage → build), lint:ci strictness, the boy-scout complexity gate (check-touched-exemptions.mjs — not part of npm run lint, easy to miss locally), and coverage floors. Also triggered by CI error strings like 'check-touched-exemptions' failure, 'biome found errors', or 'below configured minimum coverage'.
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
node packages/dev-tools/tools/check-touched-exemptions.mjs
```

Run `npm run verify` first because formatting is the most common CI failure. Do not omit the
separate `check-touched-exemptions.mjs` command: `npm run verify` does not include it.

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
npm run typecheck
npm run test
npm run test:coverage                  # Enforces minimum coverage thresholds
npm run build
npm run build -w @slicc/chrome-extension
```

The `check-touched-exemptions.mjs` gate runs right after lint because it catches
complexity debt that lint alone misses. See the section below for details.

## Lint

Run `npm run lint`. It runs `biome check --write .` over JS/TS/JSON/CSS and
`prettier --write .` over the remaining doc / config-text formats (Markdown, YAML, HTML),
then `lint:docs` (CLAUDE.md size limits), `lint:skills` (tessl `SKILL.md` lint),
`lint:skill-router` (developer-skill router and alias sync), `lint:no-innerhtml`, and
`lint:patches`.

CI runs the check-only/strict equivalents (`npm run lint:ci`) as a hard gate and will reject
any unformatted code. **This is the most common CI failure — do not skip it.**

## Boy-scout complexity gate (`check-touched-exemptions.mjs`)

Run this separate gate after lint:

```bash
node packages/dev-tools/tools/check-touched-exemptions.mjs
```

CI's `lint` job runs this step **after** `lint:ci`. It is **not** part of `npm run lint`, so
it is easy to miss locally.

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

## Coverage

Run `npm run test:coverage` to enforce the per-package floors from
`coverage-thresholds.json`. See [`writing-slicc-tests` → Enforce Coverage](../writing-slicc-tests/SKILL.md#enforce-coverage)
for how the floors are maintained by the nightly ratchet and for the per-package and Swift
commands.

## Other CI-only gates

If local checks pass but CI still fails, inspect
[`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml). The `cloudflare-worker`
job runs `wrangler deploy --dry-run`. This rarely trips for typical changes but lives in
`.github/workflows/ci.yml` if you need it. All other lint-job gates (manifest
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
