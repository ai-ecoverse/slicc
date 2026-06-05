# Codebase Sins — nightly agentic-debt triage

A nightly job that hunts for ONE concrete instance of the **sin of the day** —
rotating through seven agentic-codebase failure modes, ordered by severity — and
files a single GitHub issue documenting the worst offender. Mirrors the
`packages/dev-tools/rum-error-triage/` layout (pure logic + CLI + co-located
tests run by the `dev-tools` vitest project).

## The seven sins (rotation order = severity)

1. **Complicatification** — easy things done the hard way.
2. **Entanglement** — muddy module boundaries / wrong call directions.
3. **Drift** — code vs. comments/docs/names out of sync.
4. **Duplication** — multiple implementations of the same thing.
5. **Bloat** — gigantic files/functions/classes.
6. **Necrophilia** — dead code.
7. **Paranoia** — overly defensive programming.

## Rotation

`selectSinOfDay(date)` picks the sin via **day-of-year (UTC) mod 7**:
`SINS[dayOfYearUTC % 7]`. The sin drifts by one each day, is independent of the
weekday, cycles through all seven, and is deterministic for a given `date` argument.

`resolveSin(override)` honours a `workflow_dispatch` override that may be a `1-7`
rank or a sin name/id, falling back to `selectSinOfDay()` when empty or invalid.

## Files

- `sins.mjs` — pure logic: `SINS` (the seven definitions), `selectSinOfDay`,
  `resolveSin`, and `buildPrompt` (composes the shared filing/dedup boilerplate,
  written once here, with a per-sin body). No I/O; unit-tested in `lib.test.mjs`.
- `prompts/<n>-<id>.md` — the seven per-sin bodies (definition + repo-specific
  signals to grep for + what makes an instance "most impactful").
- `select-sin.mjs` — CLI (I/O only): resolves the sin from `SIN_OVERRIDE`, reads
  its prompt body, composes the prompt, and writes `sin_id`, `sin_name`,
  `sin_label`, and the multi-line `prompt` to `$GITHUB_OUTPUT`.

## Run it locally

```bash
# Pick the necrophilia sin (override 6) and print the chosen sin + prompt
SIN_OVERRIDE=6 GITHUB_OUTPUT=/tmp/out.txt node packages/dev-tools/codebase-sins/select-sin.mjs

# Unit tests
npx vitest run --project dev-tools
```

### Environment variables

| Var             | Default            | Meaning                                                 |
| --------------- | ------------------ | ------------------------------------------------------- |
| `SIN_OVERRIDE`  | _(sin of the day)_ | `workflow_dispatch` override: a `1-7` rank or a name/id |
| `GITHUB_OUTPUT` | _(unset)_          | Actions output file; the CLI appends results when set   |
