**Complicatification** — easy things done the hard way. Code that is far more
elaborate than the problem requires: incomprehensible control flow, needless
abstraction or indirection, "clever" one-liners that take minutes to read,
reinvented standard-library or existing-library features, and over-engineered
patterns (factories/managers/wrappers around something trivial).

## Signals to look for in this repo

- Hand-rolled helpers that duplicate built-ins (manual `Array`/`Object`
  iteration where `map`/`filter`/`Object.entries` would do; bespoke deep-clone,
  debounce, or path joining instead of stdlib).
- Deeply chained ternaries, nested closures, or callback gymnastics where a
  plain `if`/early-return would be clearer.
- Abstraction with a single caller: an interface, factory, or generic wrapper
  that is only ever instantiated one way.
- Re-implemented logic that a dependency already exports (e.g. re-deriving
  things `pi-agent-core`/`pi-ai`, `isomorphic-git`, or `@slicc/shared-ts`
  already provide).
- The shell/tools layers (`packages/webapp/src/shell/`,
  `packages/webapp/src/tools/`) and CDP layer (`packages/webapp/src/cdp/`) are
  common homes for accidental complexity.

## What makes an instance "most impactful"

Prefer code on a hot path or in a widely-touched module where the complexity
actively slows comprehension or invites bugs, and where a concrete, simpler
formulation is obvious. Favour a self-contained simplification over a sprawling
refactor.
