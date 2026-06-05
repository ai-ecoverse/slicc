**Duplication** — multiple implementations of the same thing. Copy-pasted
blocks, parallel implementations of one concept across packages, and repeated
logic or constants that should live in one place.

## Signals to look for in this repo

- Near-identical functions or blocks that have drifted slightly (the classic
  copy-paste-then-tweak), especially across the three floats
  (`packages/webapp/`, `packages/node-server/`, `packages/chrome-extension/`)
  which must stay dual-mode compatible.
- Logic or constants repeated in more than one package that belong in
  `@slicc/shared-ts` (the home for platform-agnostic primitives) — e.g.
  duplicated secret-masking, parsing, or formatting helpers.
- Two code paths doing the "same" thing for CLI vs. extension where a shared
  helper already exists or could.
- Repeated magic strings/constants (action SHAs, model id aliases, env-var
  names, paths) defined independently in several spots.

## What makes an instance "most impactful"

Prefer duplication that has already started to diverge or sits in code that
changes often, where a single shared definition would prevent the copies from
falling out of sync. Quantify it (how many copies, which files) and name the
single place the logic should live.
