**Paranoia** — overly defensive programming. Guard code for situations that
cannot actually occur: redundant null checks on values that are always present,
catch-all `try/catch` that swallows or masks real errors, and validation of
impossible internal states. It adds noise, hides bugs, and inflates complexity.

## Signals to look for in this repo

- Null/undefined checks on values a type or invariant already guarantees are
  present (e.g. re-checking a non-optional field right after constructing it).
- Broad `try { … } catch { /* ignore */ }` blocks that swallow errors instead
  of letting genuine failures surface — especially around tool calls, shell
  execution, and CDP/transport code.
- Defaulting/fallback branches for cases the caller can never produce, where the
  fallback silently hides a real contract violation.
- Validation of internal state that is fully controlled by the same module
  (defensive checks aimed at "impossible" inputs from trusted internal callers).
- Repeated belt-and-braces guards layered at multiple levels for the same
  condition.

## What makes an instance "most impactful"

Prefer defensive code that actively hides failures — e.g. a catch-all that turns
a real error into a silent no-op on a hot path — over harmless redundancy.
Explain why the guarded condition cannot occur (or why the swallow is harmful)
and cite the `file:line`, with a concrete tightening (remove the guard, narrow
the catch, or surface the error).
