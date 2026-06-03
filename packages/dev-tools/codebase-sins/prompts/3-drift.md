**Drift** — code and its description out of sync. Comments, docstrings, names,
and docs that no longer match what the code actually does. The danger is that
the stale words are trusted over the code.

## Signals to look for in this repo

- Comments or JSDoc that contradict the adjacent implementation (describe a
  parameter, return value, or behaviour the code no longer has).
- Function/variable names that lie about behaviour (a `getX` that mutates, an
  `isReady` that means something else now).
- Stale developer docs: `CLAUDE.md` files (root + per-package),
  `docs/shell-reference.md`, and `docs/architecture.md` describing modules,
  commands, ports, or flows that have since changed. Cross-check claims like the
  supplemental-command list, layer stack, and the agent-facing
  `packages/vfs-root/shared/CLAUDE.md`.
- `TODO`/`FIXME` comments referencing work that is already done, or describing a
  plan that the code contradicts.
- Examples or README snippets that no longer run as written.

## What makes an instance "most impactful"

Prefer drift that would actively mislead a developer or agent — e.g. a
documented invariant or command that is now false — over cosmetic typos. Cite
the contradicting `file:line` on both sides (the claim and the code) so the fix
is unambiguous.
