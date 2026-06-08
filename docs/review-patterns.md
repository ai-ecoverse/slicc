# Review Patterns — Recurring Blind Spots

This is the **single source of truth** for SLICC's automated PR reviewers. All three
reviewers feed from it:

- **Claude action** (`.github/workflows/claude-pr-review.yml`) reads this file directly
  with its `Read` tool.
- **Codex** reads the condensed checklist in the root `CLAUDE.md` / `AGENTS.md`
  (`## Automated PR Review Checklist`), which points back here.
- **GitHub Copilot** reads `.github/copilot-instructions.md`, a ≤4,000-char summary of
  this file (Copilot truncates instruction files at 4,000 chars).

Human reviewers and new contributors should use it as a checklist too. When you change a
category here, update the two condensed copies so the reviewers stay in sync (see
[Keeping the reviewers in sync](#keeping-the-reviewers-in-sync)).

Each category lists the **trigger patterns** to scan the diff for, a **historical
precedent** (a real, merged PR — verify before citing new ones), and the **remediation**
to recommend. Reviewers should reason contextually, not just pattern-match: is the risk
genuine _here_, does surrounding code already mitigate it, is the omission intentional and
documented?

## The five-runtime parity model

SLICC ships the same product across runtimes that share behavior but not code. A change to
one runtime frequently needs a peer change — or an explicit note that the peer is
intentionally excluded.

| Feature domain         | Browser (`webapp`) | Extension | Node (`node-server`) | Swift (`swift-server`) | iOS (`ios-app`) |
| ---------------------- | ------------------ | --------- | -------------------- | ---------------------- | --------------- |
| VFS / file system      | ✓                  | ✓         | ✓                    | ✓                      | ⚠️              |
| Mount backends (S3/DA) | ✓                  | ✓         | ✓                    | ✓                      | ⚠️              |
| Server-side signing    | N/A                | N/A       | ✓                    | ✓                      | ⚠️              |
| CDP / browser control  | ✓                  | ✓         | ✓                    | ✓                      | ✗               |
| HTTP API endpoints     | N/A                | N/A       | ✓                    | ✓                      | ⚠️              |
| Secrets management     | ✓                  | ✓         | ✓                    | ✓                      | ⚠️              |
| Agent / AI integration | ✓                  | ✓         | N/A                  | N/A                    | ⚠️              |

**Legend:** ✓ should be present and consistent · N/A intentionally not applicable ·
⚠️ check once the iOS surface implements it · ✗ platform limitation (CDP is unavailable on
iOS). The **cloud / hosted-leader** float reuses `node-server` (`--hosted`), so node-server
changes usually carry into cloud automatically; **Cherry** is the webapp under `?cherry=1`,
so it inherits browser behavior.

## Detection categories

### 1. Error-path coverage gaps

**Trigger patterns**

- `fetch()` to an external host without `signal: AbortSignal.timeout(ms)`.
- E2B / sandbox calls (`Sandbox.create()`, `Sandbox.connect()`) without `requestTimeoutMs`.
- External API calls with no retry / backoff.
- Promise chains and `await`ed work with no `.catch()` / `try`-`catch` and no bound on
  execution time.

**Historical precedent** — **PR #779** (`fix(cloud-core): bump e2b requestTimeoutMs to
survive CF subrequest cap`): an e2b SDK call's timeout was too low for the Cloudflare
subrequest budget, so sandbox starts failed under load.

**Remediation** — add explicit timeouts to external calls; bound every async operation;
use backoff for retries; make sure failures surface rather than hang.

### 2. UI state preservation

**Trigger patterns**

- `el.innerHTML = …` or `replaceChildren()` that rebuilds a subtree holding live UI state.
- Navigation / routing / reflow that re-renders without capturing and restoring state.
- Component teardown without cleanup, or local state updated without persisting it.

**Historical precedent** — **PR #566 / #567** (`preserve tool-call cluster open state
across reflow`): a chat reflow rebuilt the DOM and dropped each tool-call cluster's
expand/collapse state, so the view reset under the user. (PR #568 was a closed follow-up,
not a separate merged fix.)

**Remediation** — capture the relevant state before the DOM mutation and restore it after;
persist anything durable to `localStorage` / IndexedDB; prefer surgical updates over full
rebuilds where state lives in the DOM.

### 3. Cross-runtime consistency

**Trigger patterns**

- A change under `packages/node-server/` with no matching `packages/swift-server/` change
  (or vice versa) for a shared feature — HTTP endpoints, signing, mount handling.
- A mount / VFS / secrets change in the browser without the matching extension change.
- A new capability added to one runtime without the parity matrix being consulted.

**Historical precedent** — **PR #565** (`feat(swift-server): server-side signing for S3 +
DA mounts (Sliccstart parity)`): `node-server` already signed mount requests; `swift-server`
lagged until this PR brought it to parity. A reviewer who knows the parity model flags that
gap _when the first runtime changes_, not a release later.

**Remediation** — apply the change to every applicable runtime in the parity matrix, or
state explicitly in the PR why a runtime is excluded; add a cross-runtime test when feasible.

### 4. CDP / Chrome integration edge cases

**Trigger patterns**

- `captureScreenshot()` / visual capture without first foregrounding the page
  (`Page.bringToFront()` / waking the renderer).
- CDP operations without validating the target / connection is live.
- A CDP port read from disk or input and trusted without validation.

**Historical precedent** — **PR #361** (`Wake renderer before screenshot to fix background
tab capture`): screenshots of backgrounded tabs came back blank because the renderer was
throttled. **PR #673** (`validate DevToolsActivePort port via /json/version before trusting
it`): an unvalidated CDP port was trusted directly.

**Remediation** — foreground the page before visual operations; probe / validate the CDP
target and port before use; handle disconnects gracefully rather than hanging.

### 5. macOS / native permissions

**Trigger patterns**

- Keychain access without the matching `keychain-access-groups` entitlement.
- Camera / microphone / screen-recording use without a TCC (Transparency, Consent, Control)
  check and a graceful path when consent is denied.
- File-system or network access in `swift-server` / `swift-launcher` / `ios-app` that
  assumes a permission the bundle's entitlements / `Info.plist` don't grant.

**Historical precedent** — none confirmed yet; this is a _forward-looking_ category for the
native targets. (Earlier drafts cited PR #453, but that PR is about port-conflict handling,
not permissions — do not cite it here.) Add a real precedent the first time a permissions
gap causes an incident.

**Remediation** — declare the required entitlement / usage-description; check TCC status
before touching a protected resource; degrade gracefully and tell the user when permission
is denied.

### 6. Test-coverage blind spots

**Trigger patterns**

- New source files under `src/` with no mirrored file under `tests/`.
- Modified business logic with no corresponding test change.
- A bug fix with no regression test.
- A new HTTP endpoint or shell command with no integration test.

**Historical precedent** — CI enforces per-package coverage floors via
`coverage-thresholds.json` and the nightly ratchet
(`packages/dev-tools/tools/coverage-ratchet.mjs`); a PR that drops coverage below a floor
fails. Tests live in `packages/*/tests/`, mirrored by subsystem (see
[testing.md](./testing.md)).

**Remediation** — add unit tests for new paths, update tests for changed behavior, add a
regression test for each bug fix, and keep coverage at or above the package floor.

## Severity rubric

Reviewers should label findings so authors can triage:

- 🔴 **Critical** — high likelihood of a production issue (e.g. a missing timeout on a hot
  external call, a parity gap that breaks one runtime's API).
- 🟡 **Major** — could bite in a specific scenario (e.g. unrestored UI state in an edge case).
- 🔵 **Minor** — quality / consistency issue (e.g. a coverage gap on trivial code).

Stay high-signal: prefer no comment over a speculative one, and skip a category when the
surrounding code clearly already handles it.

## Keeping the reviewers in sync

This file is the source of truth. When a category changes, update the two condensed copies:

1. **`CLAUDE.md`** (root) → `## Automated PR Review Checklist` — one terse line per
   category. Mind the 30,000-char budget enforced by
   `packages/dev-tools/tools/check-doc-sizes.mjs`. `AGENTS.md` symlinks to it, so this is
   also what Codex reads.
2. **`.github/copilot-instructions.md`** (and any `.github/instructions/*.instructions.md`)
   — a self-contained summary; lead with the highest-value rules. Each file must stay under
   **4,000 chars** because Copilot ignores everything past that. Both budgets above are
   enforced automatically by `check-doc-sizes.mjs` (`npm run lint:docs`), so you don't have
   to remember the numbers — overrun fails the build.

The Claude action needs no change — it reads this file directly.

## Maintenance

When a new recurring issue surfaces: document the incident (PR number, impact, root cause),
add or extend the matching category with a **verified** precedent, and refresh the two
condensed copies. When a category produces false positives, add nuance ("unless X mitigates
Y") rather than deleting the rule.
