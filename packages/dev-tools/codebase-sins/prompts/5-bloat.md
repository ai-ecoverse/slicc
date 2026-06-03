**Bloat** — things that have grown too big. Gigantic files, sprawling functions
or classes, deep nesting, and modules that have accreted far too many
responsibilities.

## Signals to look for in this repo

- Outsized files — quantify with line counts (e.g. `wc -l`). The orchestrator
  (`packages/webapp/src/scoops/orchestrator.ts`), the shell
  (`packages/webapp/src/shell/`), and the UI layer
  (`packages/webapp/src/ui/`) are common places for files to balloon.
- Single functions that are hundreds of lines long, or with deep nesting
  (many levels of `if`/`for`/`try`), where the cyclomatic complexity makes them
  hard to follow.
- Classes/modules doing too much: a file exporting a grab-bag of unrelated
  helpers, or one object owning many distinct concerns.
- Supplemental-command files in `packages/webapp/src/shell/supplemental-commands/`
  that mix many commands' logic into one oversized module.

## What makes an instance "most impactful"

Prefer the single biggest offender by a concrete measure (line count, function
length, nesting depth) that also sits in frequently-edited code, where a clear
split along responsibility lines would help. Include the measured numbers and a
suggested decomposition.
