**Necrophilia** — dead code kept alive. Unused or unexported functions,
unreferenced files, commented-out blocks, unreachable branches, and exports
that nobody imports.

## Signals to look for in this repo

- Run the repo's dead-code tooling if available: `npm run deadcode` (knip) is a
  strong starting point — corroborate its findings with Grep before trusting
  them.
- Exported symbols with zero importers; internal functions defined but never
  called. Search across `packages/*/src/` for the symbol name.
- Whole files that nothing imports (orphaned modules left behind after a
  refactor).
- Large commented-out blocks of code (as opposed to explanatory comments).
- Unreachable branches: conditions that can never be true, code after an
  unconditional `return`/`throw`, dead `switch` cases.
- Stale build/config entries pointing at files or scripts that no longer exist.

## What makes an instance "most impactful"

Prefer a clearly dead, self-contained unit (an unimported file or an unused
exported function) where removal is obviously safe — verify there are genuinely
no references (including dynamic `*.jsh`/`*.bsh` discovery and string-based
lookups) before claiming it. Cite the symbol, its definition `file:line`, and
the evidence of zero references.
