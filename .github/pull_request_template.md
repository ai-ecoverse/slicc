<!--
SLICC PR template. House style: `## Summary` + `## Why` + `## Test plan` /
`## Verification`. Delete sections that don't apply; keep the headings you do
fill in. The prompts in HTML comments are written to surface the things
reviewers most often have to ask for after a draft lands.
-->

<!-- Stacked on / follow-up to: e.g. "Stacked on top of #545. Merge that first." -->
<!-- Linked issue: "Fixes #NNN" / "Closes #NNN" — auto-closes on merge. -->

## Summary

<!--
1-3 sentences. *What* changed, in plain English. The "why" goes in the next
section. If this is a bug fix, say what the user saw before and what they see
now (one sentence each).
-->

## Why

<!--
Motivation. Link issues, prior PRs, design docs, or transcripts.
For bug fixes, include a minimal **Repro** the reviewer can run:
  1. <step>
  2. <step>
  Expected: <…>
  Actual:   <…>
For new behavior, link the spec / plan / discussion.
-->

## Approach / Implementation notes

<!--
Only the things a reviewer can't infer from the diff. Pick the bullets that
apply; delete the rest.

- Layering: which subsystems / files own the new behavior
- Non-obvious design choices and the alternatives you rejected (and why)
- New runtime invariants, mutex/lock semantics, or ordering requirements
- New dependencies (confirm the lib is already in package.json before adding)
- Migration / data-shape changes for IndexedDB stores (`browser-coding-agent`,
  `slicc-fs`, session schemas, ledgers, localStorage keys)
-->

## Cross-cutting impact

<!--
This is the section reviewers ask for most often. Be explicit about what
changes for code paths NOT directly named by this PR.

- **Floats exercised**: CLI / Chrome extension / Electron / Sliccstart / worker
- **Shell contexts** (extension only): side panel `WasmShell`, offscreen
  `WasmShell`, sandbox iframe — name each one this PR touches or leaves alone.
- **Other callers of the changed function/contract**: if you broadened a
  try/catch, changed an error shape, or rewrote a helper, list the *unrelated*
  callers you checked. ("This `catch` also catches `validateApiKey`'s 404; that
  caller already tolerates rejection.")
- **Persisted state side-effects**: does opening / surfacing / muting also write
  to a ledger that survives reload? (e.g. `slicc-known-sprinkles`,
  `slicc-open-sprinkles`, `selected-model`).
- **Async lifecycle**: disposal guards on `.then(...)` after fetch, listener
  removal on `close`/`error`, debounce vs real `setTimeout` in tests, UTF-8 /
  multi-byte boundaries when scrubbing or chunking streams.
- **Security**: secrets in shell echo / logs / process args, XSS via
  `innerHTML` of attacker-controlled SVG, CSP/MV3 sandbox boundary, deploy-key
  scope across CI steps.
- **Bundle size**: importing a full registry (e.g. `lucide` icons) into the UI
  bundle — quantify if non-trivial.
-->

## Test plan

<!--
Be specific: command + result, not "tested locally". Pre-existing failures are
fine — name them so reviewers don't conflate them with your changes.
-->

- [ ] `npx prettier --write <changed-files>` — CI runs `prettier --check .` as a lint gate
- [ ] `npm run typecheck`
- [ ] `npm run test` — `<N>` passing, no new failures
- [ ] `npm run build`
- [ ] `npm run build -w @slicc/chrome-extension`
- [ ] **New / changed behavior is covered by a unit test** in
      `packages/*/tests/` mirroring the changed `src/` path
      (e.g. `npx vitest run packages/webapp/tests/<area>/<file>.test.ts`)
- [ ] Manual smoke (CLI): `npm run dev` + …
- [ ] Manual smoke (extension): load unpacked `dist/extension/` + …
- [ ] Manual smoke (Electron / Sliccstart / worker) — if relevant
- [ ] N/A — explain below

**Pre-existing failures** (verified against `main`, unrelated to this PR):

<!--
e.g. "17 failures in chat-panel-attachments / telemetry / chat-panel-telemetry
reproduce on `main` at <sha> — unrelated localStorage issues in the test env."
-->

## Documentation

<!-- Pick the tier(s) that apply. See CLAUDE.md > "Documentation". -->

- [ ] `README.md` (user-facing behavior)
- [ ] Relevant `CLAUDE.md` (developer / package architecture)
- [ ] `docs/` (agent reference: tools, commands, skills, patterns)
- [ ] `packages/vfs-root/shared/CLAUDE.md` or `packages/vfs-root/workspace/skills/<skill>/SKILL.md` (agent-facing)
- [ ] No documentation changes needed

## Risk & rollback

<!--
- Blast radius if this regresses (single float / all floats / data migration).
- Feature flags, kill switches, or env knobs introduced.
- How to roll back: revert this PR cleanly? Need a follow-up to undo a
  persisted state migration?
- Anything CI cannot catch (real Chrome CDP behavior, OAuth round-trip,
  Keychain prompt z-order, mounted-folder TCC) that the reviewer should verify
  by hand before approving.
-->

## Checklist

- [ ] Commits are focused and package-local where possible
- [ ] No hand-edited files under `dist/`
- [ ] No secrets, credentials, OAuth client secrets, or tokens in the diff (incl. logs, fixtures, `.env*`, snapshots)
- [ ] Public API / tool / shell-command / lick-channel changes are intentional and reflected in docs
- [ ] If this changes a contract used by other floats (CLI ↔ extension ↔ tray), I checked the followers/leader/offscreen paths
