# CLAUDE.md

This file covers the documentation surface in `docs/`.

## Documentation Tiers

| Tier            | Primary file/location              | Purpose                                                            |
| --------------- | ---------------------------------- | ------------------------------------------------------------------ |
| Public          | `README.md`                        | User-facing overview and onboarding                                |
| Development     | root and package `CLAUDE.md` files | High-signal developer guidance and package navigation              |
| Agent reference | `docs/`                            | Detailed architecture, commands, patterns, pitfalls, and workflows |

## How to Update Docs

- Update the nearest package `CLAUDE.md` when a change is package-specific.
- Update the root `CLAUDE.md` only for repo-wide navigation, CI gates, or cross-cutting principles.
- Put long-form implementation detail in the appropriate `docs/*.md` file rather than bloating a `CLAUDE.md`.

### Size budgets (enforced by `npm run lint:docs`)

| File                                                    | Limit  | Unit  | Note                               |
| ------------------------------------------------------- | ------ | ----- | ---------------------------------- |
| `CLAUDE.md` (root)                                      | 15,000 | chars | enforced                           |
| `packages/*/CLAUDE.md`                                  | 20,000 | chars | two files grandfathered; see below |
| `packages/vfs-root/shared/CLAUDE.md`                    | 3,000  | bytes | bundled into the VFS               |
| `.github/copilot-instructions.md` + `*.instructions.md` | 4,000  | chars | Copilot truncation limit           |

Two package files still exceed the 20,000-char cap and are grandfathered with frozen
per-file exemptions in `check-doc-sizes-lib.mjs`: `packages/webapp/CLAUDE.md` (67,000)
and `packages/cloudflare-worker/CLAUDE.md` (45,000).
The nightly ratchet (#1469 Wave 3) will lower these mechanically. Exemption values
may only be lowered or deleted — never added or raised.

### No PR breadcrumbs

Do not add "Added in PR #NNN" or "Changed in PR #NNN" lines to `CLAUDE.md` files.
Provenance belongs in `git log`; durable lessons (gotchas, anti-patterns, decisions)
belong in `docs/pitfalls.md` or `docs/review-patterns.md`, not inline breadcrumbs.
Deep implementation detail that does not fit the budget should move to `docs/`, not
shrink to a one-liner in a `CLAUDE.md`.

## Common Destinations in `docs/`

Architecture and build:

- `architecture.md` — detailed subsystem/file maps, layer stack, IndexedDB inventory, tray/sync matrix (opens with `architecture-diagram.png`, the float topology overview)
- `development.md` — build, run, and debug workflows
- `testing.md` — testing patterns and command selection
- `verification.md` — pre-push/PR validation pass: lint internals, the boy-scout complexity gate, coverage floors, and other CI-only gates
- `adding-features.md` — how to add a new shell command, tool, provider, sprinkle, etc.
- `kernel/process-model.md` — kernel-host / process-manager deep reference

Subsystems:

- `shell-reference.md` — shell command reference (authoritative per-command list)
- `playwright-cli-sync.md` — how Slicc's `playwright-cli` stays aligned with the official `@playwright/cli`: the sync script, the Slicc command manifest, when to run, and how to add a new command
- `tools-reference.md` — agent tool surface reference
- `mounts.md` — `mount` setup for local FS Access, S3/R2/MinIO, and Adobe da.live
- `secrets.md` — secrets storage, masking, and domain-scoped injection
- `approvals.md` — capability approval gates: shared pattern + authority axis, sudo policy, device & gesture gates, OS capture gates
- `oauth-intercept.md` — provider OAuth intercept and silent renewal
- `operational-telemetry.md` — Helix RUM beacons and debug sampling
- `extension-thin-bridge.md` — Chrome extension deep reference: bridge Port protocol, toast attribution/dedup, leader-tab lifecycle rationale, side-panel flow, dev-watch loop, QA recipe, and smoke test
- `slicc-handoff.md` — external handoff protocol (RFC 8288 `Link` header + `navigate` lick)
- `link-discovery.md` — the standalone `discover` shell command and the `--discover` flag on `playwright-cli` subcommands (`fetch`, `goto`, `navigate`, `open`, `tab-new`); covers RFC 8288 / RFC 9727 parsing, emission, and the SLICC handoff/upskill rels
- `urls.md` — production URL inventory
- `electron.md` — Electron float workflow

Review & gotchas:

- `pitfalls.md` — runtime and extension gotchas (CSP, dual-mode runtime detection, WASM heap views, etc.)
- `review-patterns.md` — source of truth for the automated PR reviewers (Claude action, Codex, Copilot): the nine recurring blind-spot categories, the five-runtime parity matrix, and the severity rubric

Other:

- `exploration/` — open design notes (not load-bearing reference)
- `screenshots/` — image assets used by README and other docs

Planning artifacts (`docs/superpowers/specs/`, `docs/superpowers/plans/`) are intentionally **not** kept on `main` — they're scrubbed by the planning-artifact cleanup. Live in branches only.

Keep this directory explanatory, not redundant: prefer one authoritative page per topic and link to it from the shorter `CLAUDE.md` files.
