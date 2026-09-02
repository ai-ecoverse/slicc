# skill-pin-reconcile

Keeps agent-skill install pins that must stay lockstep with an npm dependency.

Today: **v86** — `packages/webapp/package.json` is the source of truth; the
`ipk add -g v86@X` line in `packages/vfs-root/workspace/skills/v86/SKILL.md` is
the agent-facing mirror. Renovate's npm manager updates `package.json`. A regex
`customManagers` entry updates the skill. Those used to open a PR that only
bumped `package.json` (PR #2773), and the live canary in
`v86-wasm-live.test.ts` failed until the skill moved by hand.

- **`reconcile.mjs`** — `--write` rewrites the skill pin from `package.json`.
  Consumed by
  [`.github/workflows/renovate-skill-pin-reconcile.yml`](../../../.github/workflows/renovate-skill-pin-reconcile.yml).

The CI backstop is the live canary (not a separate lint gate): a Renovate bump
cannot merge while the skill is stale.
