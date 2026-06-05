**Entanglement** — muddy module boundaries and wrong call directions.
Dependencies that point the wrong way, modules that know too much about each
other, and objects that have grown to do everything.

## Signals to look for in this repo

The package boundaries in `CLAUDE.md` define the intended layering. Hunt for
imports that violate it:

- The layer stack flows `fs → shell/git → cdp → tools → core → scoops → ui`.
  Look for back-edges, e.g. `packages/webapp/src/core/` importing from
  `packages/webapp/src/ui/`, or low layers reaching up into orchestration.
- `packages/node-server/` importing deep `packages/webapp/src/` internals
  instead of a stable entry point; `@slicc/shared-ts` (meant to be
  platform-agnostic) importing browser- or node-only code.
- Circular dependencies between modules.
- "God" modules: a single file imported by many otherwise-unrelated modules, or
  a class/object that accumulates unrelated responsibilities (orchestrator,
  shell, or a catch-all `utils`/`shared` file are usual suspects).

## What makes an instance "most impactful"

Prefer a boundary violation that couples two layers/packages that should be
independent (it blocks reuse and makes change risky), with clear `file:line`
evidence of the offending import and a concrete suggestion for which direction
the dependency should run.
