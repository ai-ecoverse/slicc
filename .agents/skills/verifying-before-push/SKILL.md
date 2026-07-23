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
npm run lint
npm run typecheck
npm run test
npm run test:coverage
npm run build
npm run build -w @slicc/chrome-extension
node packages/dev-tools/tools/check-touched-exemptions.mjs
```

Run `npm run lint` first because formatting is the most common CI failure. Do not omit the
separate `check-touched-exemptions.mjs` command: `npm run lint` does not include it.

## The standard pass

Run every command in order:

```bash
npm run lint                           # Format + lint FIRST — CI fails on unformatted code
node packages/dev-tools/tools/check-touched-exemptions.mjs  # NOT in npm run lint — easy to miss
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

To check whether a file is exempt, search `biome.json` for its path under the
`noExcessiveCognitiveComplexity: "off"` / `noExcessiveLinesPerFunction: "off"` overrides.

## Coverage

Run `npm run test:coverage` to enforce the per-package floors from
`coverage-thresholds.json`. See [`docs/testing.md` → Coverage](../../../docs/testing.md#coverage)
for how the floors are maintained by the nightly ratchet and for the per-package and Swift
commands.

## Other CI-only gates

If local checks pass but CI still fails, inspect
[`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml). The `lint` job also checks
the Chrome Web Store manifest justifications and runs knip dead-code detection; the
`cloudflare-worker` job runs `wrangler deploy --dry-run`. These rarely trip for typical
changes.

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
