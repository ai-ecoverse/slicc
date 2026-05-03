<!--
Thanks for contributing to SLICC! Please fill out the sections below so reviewers
(human and agent) have the context they need. Delete sections that don't apply,
but keep the headings so the structure stays consistent.
-->

## Summary

<!--
1-3 sentences describing *what* changed and *why*. Focus on intent, not
implementation detail (the diff covers that). If this fixes an issue, link it
with `Fixes #123` so it auto-closes on merge.
-->

## Affected Packages / Floats

<!--
Tick everything this PR touches. This helps reviewers know which CI matrix
slices and runtime modes (CLI, extension, Electron, Sliccstart, cloud) need
extra attention. See CLAUDE.md > "Module Map" for the full list.
-->

- [ ] `packages/webapp/` (UI, VFS, shell, CDP, tools, providers, skills, scoops)
- [ ] `packages/chrome-extension/` (MV3 entry points, side panel, offscreen, service worker)
- [ ] `packages/cloudflare-worker/` (tray hub, signaling, TURN credentials)
- [ ] `packages/node-server/` (CLI / Electron server, Chrome launch, CDP proxy)
- [ ] `packages/vfs-root/` (default VFS content, skills bundled to `/workspace`/`/shared`)
- [ ] `packages/swift-launcher/` (`Sliccstart` native macOS launcher)
- [ ] `packages/swift-server/` (`slicc-server` Hummingbird server)
- [ ] `packages/dev-tools/` / `packages/assets/`
- [ ] `docs/` only
- [ ] CI / workflows / repo tooling

**Floats exercised:** <!-- e.g. CLI, Chrome extension, Electron, Sliccstart, cloud -->

## Type of Change

- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that changes existing behavior)
- [ ] Refactor / internal cleanup (no user-visible behavior change)
- [ ] Documentation only
- [ ] CI / build / tooling
- [ ] Skill, scoop, or lick change (`workspace/skills/`, scoops, webhooks, cron tasks)

## Context

<!--
Why is this change needed? Link to:
- The issue, ticket, or discussion this came out of
- Relevant prior PRs or design docs
- Screenshots / screen recordings for UI changes (drag and drop into the
  textarea — GitHub will host them)
- Any deviation from the architecture in CLAUDE.md and the reasoning behind it
-->

## Implementation Notes

<!--
Call out anything a reviewer might miss from the diff alone:
- Non-obvious design choices or trade-offs
- New dependencies (note: confirm the lib is actually installed before using it,
  per CLAUDE.md > "Coding conventions")
- Cross-cutting concerns (CSP, Manifest V3 sandbox, two-shell extension model,
  RestrictedFS path ACLs, dual-mode CLI/extension compatibility)
- Migration / data-shape changes for IndexedDB stores (`browser-coding-agent`,
  VFS), session schemas, or persisted state
-->

## Testing Done

<!--
Describe what you actually ran. Be specific: command + result, not "tested
locally". The repo's CI gates are listed in CLAUDE.md > "Verification".
-->

- [ ] `npx prettier --write <changed-files>` (CI runs `prettier --check .` — do **not** skip)
- [ ] `npm run typecheck`
- [ ] `npm run test`
- [ ] `npm run build`
- [ ] `npm run build -w @slicc/chrome-extension`
- [ ] Added or updated tests in `packages/*/tests/` mirroring the changed `src/` paths
- [ ] Manually verified in CLI mode (`npm run dev`)
- [ ] Manually verified in Chrome extension mode (loaded `dist/extension/`)
- [ ] Manually verified in Electron / Sliccstart (if relevant)
- [ ] N/A — explain below

**Manual verification steps:**

<!--
Step-by-step repro for reviewers. For UI changes, include before/after
screenshots. For agent / scoop changes, include the prompt you tested with and
a snippet of the resulting transcript.
-->

## Documentation

<!-- See CLAUDE.md > "Documentation" for the three-tier doc model. -->

- [ ] `README.md` updated (user-facing behavior changed)
- [ ] Relevant `CLAUDE.md` updated (developer conventions / package architecture changed)
- [ ] `docs/` updated (agent reference: tools, commands, skills, patterns)
- [ ] `packages/vfs-root/shared/CLAUDE.md` updated (agent-facing instructions changed)
- [ ] No documentation changes needed

## Risk & Rollout

<!--
- What's the blast radius if this regresses? (single float vs. all floats,
  reversible vs. data migration, etc.)
- Any feature flags, kill switches, or config knobs introduced?
- Anything reviewers should manually verify before merge that CI cannot catch
  (e.g. CDP behavior in a real Chrome, extension permissions, OAuth flow)?
-->

## Checklist

- [ ] Commits are focused and package-local where possible
- [ ] No hand-edited files under `dist/`
- [ ] No secrets, credentials, API keys, or tokens in the diff (incl. logs and fixtures)
- [ ] Public API / tool / shell command changes are intentional and documented
- [ ] Co-authored-by trailers preserved if pairing with another agent or human
