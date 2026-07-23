# Pre-push / PR validation

The full verification pass to run **before committing, pushing, or opening a PR**.
These mirror the CI gates in `.github/workflows/ci.yml`; running them locally first
is the fastest way to avoid a red PR.

## The standard pass

```bash
npm run lint                           # Format + lint FIRST — CI fails on unformatted code
npm run typecheck
npm run test
npm run test:coverage                  # Enforces minimum coverage thresholds
npm run build
npm run build -w @slicc/chrome-extension
```

## Lint

`npm run lint` runs `biome check --write .` over JS/TS/JSON/CSS and `prettier --write .`
over the remaining doc / config-text formats (Markdown, YAML, HTML), then `lint:docs`
(CLAUDE.md size limits), `lint:skills` (tessl `SKILL.md` lint), `lint:skill-router`
(developer-skill router and alias sync), `lint:no-innerhtml`, and `lint:patches`.

CI runs the check-only/strict equivalents (`npm run lint:ci`) as a hard gate and will
reject any unformatted code. **This is the most common CI failure — don't skip it.**

## Boy-scout complexity gate (`check-touched-exemptions.mjs`)

CI's `lint` job runs a separate step **after** `lint:ci` that is **not** part of
`npm run lint`, so it's easy to miss locally:

```bash
node packages/dev-tools/tools/check-touched-exemptions.mjs
```

`biome.json` keeps two `overrides` "debt lists" of files that are grandfathered out of
the complexity rules:

- `complexity.noExcessiveCognitiveComplexity` (cap: cognitive complexity **≤ 25**)
- `complexity.noExcessiveLinesPerFunction` (cap: **≤ 150** lines per function)

When a PR **touches** any file still on one of those debt lists, this gate **fails**
unless, in the same change, you:

1. Refactor every function in that file under the relevant cap, then
2. Remove the file's entry from the corresponding `biome.json` `overrides` block.

It is a one-way ratchet — you may not add a file to the debt list to silence it. The
gate auto-skips on `merge_group` / `push` events (it resolves the merge-base against
`$GITHUB_BASE_REF`), so always run it locally before pushing if you touched a listed file.

To check whether a file is exempt, search `biome.json` for its path under the
`noExcessiveCognitiveComplexity: "off"` / `noExcessiveLinesPerFunction: "off"` overrides.

## Coverage

`npm run test:coverage` enforces per-package floors from `coverage-thresholds.json`. See
[`docs/testing.md` → Coverage](testing.md#coverage) for how the floors are maintained
(the nightly ratchet) and the per-package / Swift commands.

## Other CI-only gates

The `lint` job also checks the Chrome Web Store manifest justifications and runs knip
dead-code detection; the `cloudflare-worker` job runs `wrangler deploy --dry-run`. These
rarely trip for typical changes but live in `.github/workflows/ci.yml` if you need them.

## Knip fixture exclusion

The dead-code gate uses `knip --production` to detect test-only dead files. Test
fixtures must be kept out of the production graph **without** triggering knip's own
`Remove unused ignore` warning. Two mechanisms exist; only one works cleanly:

- **`ignoreFiles` with `!`-suffix patterns — does NOT work.** The `!` suffix is passed
  directly to picomatch and is not treated as a negation. Using it both fails to exclude
  the file from the dead-files report and may produce `Remove unused ignore` hints in
  the default gate.
- **Negated `project` patterns in `knip.json` — the correct approach.** Adding
  `"!tests/some-fixture.mjs"` to the workspace's `project` array keeps the file out of
  the production dependency graph and avoids the `Remove unused ignore` hint in both
  the default and `--production` gates.

Whenever a new test fixture triggers a knip dead-file warning, add a negated entry to
the relevant workspace's `project` list in `knip.json`, not to `ignoreFiles`.
