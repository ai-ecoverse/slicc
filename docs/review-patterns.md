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

### Intra-webapp parity axes

The five-runtime matrix above covers inter-package boundaries. Inside `packages/webapp/`
there are additional parity boundaries where bugs hide:

| Boundary                         | Left side                                                    | Right side                                 | Risk if unmatched                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Page realm ↔ kernel worker realm | Code with `window` / DOM access                              | `DedicatedWorkerGlobalScope` (no `window`) | Accidental `window` refs crash the worker; `RTCDataChannel` cannot cross the boundary (PR #667 — full revert)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Leader role ↔ follower role      | `tray-leader-sync.ts`, leader UI surfaces                    | `tray-follower-sync.ts`, `wc-follower.ts`  | A new broadcast with no follower handler silently no-ops (category 8 below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Boot paths                       | `mountWcUiLive` / `mountWcUiFollower` / `mountWcUiExtension` | Each other                                 | A fix on one boot path may leave the others broken (PR #1261 — fix on non-primary path caused 5s pill-reset regression)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Root unit ↔ child unit           | Cone (`parentJid === null`)                                  | Scoop (`parentJid` = owner)                | Cone and scoop are roles over one `WorkUnit` (#1666). The record carries no role field since #2279 (the compiler is the ratchet); a re-introduced role branch re-creates the singleton-cone assumption. Route on the unit's `policy.*`, `isRootUnit`, or `orchestrator.getWorkUnits()`. The tray wire's `isCone` is write-only leader-side (projected from `isRootUnit`, and stripped per peer for followers at protocol version ≥ 8 — #2358); the ONLY sanctioned read is `summaryIsRoot`'s absent-edge fallback (mirrored by Swift's `isRootUnit`), and any other read is the singleton-cone assumption returning — the compiler will NOT catch it until stage 3 deletes the field |

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
lagged until this PR brought it to parity. **Issue #2811** (`aem://` mounts empty on
Sliccstart): `#2227` added an `origin` allow-list to `executeDaSignAndForward` so Helix 6
Source Bus traffic can reach `api.aem.live`; swift-server kept hard-coding `admin.da.live`,
so Source Bus paths 404'd as `ENOENT '/'`. A reviewer who knows the parity model flags that
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
- `keychain-access-groups` on a Developer ID File Provider whose embedded profile
  (or lack of one) does not provision the _appex_ bundle id. AMFI then refuses
  spawn (`No matching profile found`, POSIX 163) and Finder still shows
  extensionKit error 2 even when WebRTC is packaged correctly. The host profile
  for `com.slicc.sliccstart` does not cover `com.slicc.sliccstart.fileprovider`.
- Camera / microphone / screen-recording use without a TCC (Transparency, Consent, Control)
  check and a graceful path when consent is denied.
- File-system or network access in `swift-server` / `swift-launcher` / `ios-app` that
  assumes a permission the bundle's entitlements / `Info.plist` don't grant.
- A File Provider / app-extension target that links a non-system framework (`WebRTC`,
  …) without embedding it in the appex's own `Contents/Frameworks` and signing that
  nested copy innermost-first. Sandboxed appexes cannot load the host `Resources/`
  copy; fileproviderd then fails with `extensionKit error 2` and Finder shows
  "encountered an error. Items may be out of date."
- A sandboxed appex that opens sockets (WebRTC ICE, tray hub) without
  `com.apple.security.network.client` (and usually `network.server`).

**Historical precedent** — Sliccstart's Finder File Provider shipped the appex without
an embedded `WebRTC.framework` or network entitlements, so enabling the extension in
System Settings still left Locations empty (#2363). 6.93.0 still failed in Finder
because the appex also claimed `keychain-access-groups` without an appex-specific
Developer ID profile. Packaging now lives in `stageFileProviderAppex` +
`SliccFileProvider.entitlements`; the join URL is an app-group file, not keychain.

**Remediation** — declare the required entitlement / usage-description; check TCC status
before touching a protected resource; degrade gracefully and tell the user when permission
is denied. For an appex, embed and sign every `@rpath` framework it links, and give it
the network entitlements its transport actually uses. Do not put restricted entitlements
on a Developer ID appex unless a profile for _that_ bundle id is embedded.

### 6. Model metadata / provider pipeline gaps

**Trigger patterns**

- A new Claude model ID appears in the proxy or pi-ai that isn't in the version-based
  predicates (`claude-model-version.ts`).
- Changes to `buildAdobeModel`, `enrichAdobeModel`, or `getModelIds` that add or rename
  model fields without checking all three are in sync.
- Changes to the shared cost-fallback path (`findFamilyCost` in
  `src/providers/family-cost.ts`, the `getProviderModels` unknown-model branch, or the
  `applyModelMetadata` cost branch in `account-store.ts`) — these run for every provider with
  `getModelIds`, not just Adobe. `findFamilyCost` inheritance is gated to Anthropic-API-routed
  models (`pm.api !== 'openai'`) so OpenAI-routed providers (local-llm, azure-openai) don't
  inherit Anthropic pricing for a Claude-style id; check that guard survives refactors.
- A pi-ai bump that adds new models — check if the new model's `thinkingLevelMap`, `cost`,
  and `reasoning` are correct. Also check for breaking API changes (e.g. function signature
  changes like `buildBaseOptions`).
- Changes to the thinking/effort pipeline (`PI_FROM_META`, `resolveThinkingLevel`,
  `thinkingLevelToEffort`, `clampXhighEffort`, `effortOverride`) without verifying
  end-to-end mapping for all 6 UI levels on the affected models.

**Historical precedent** — **PR #1399** (`fix(adobe): enable thinking for Sonnet 5`):
`getModelIds` forwarded only `{ id, name }` from cached models, silently discarding
`reasoning`, `input`, and `cost`. Sonnet 5 (unknown to pi-ai) lost thinking, effort levels,
and the cost counter. Also, `claudeSupportsNativeXhighEffort` was gated to Opus only, and
SLICC's `max` UI level was collapsed into pi-ai's `xhigh`.

**Remediation** — follow the "New Claude model release checklist" in `docs/pitfalls.md`.
Verify `getModelIds` forwards all metadata fields from cached models. Check
`parseClaudeVersion` handles the new ID format. Test the full effort mapping chain
(UI → pi-ai → API) for all 6 levels.

### 7. Test-coverage blind spots

**Trigger patterns**

- New source files under `src/` with no mirrored file under `tests/`.
- Modified business logic with no corresponding test change.
- A bug fix with no regression test.
- A new HTTP endpoint or shell command with no integration test.

**Historical precedent** — CI enforces per-package coverage floors via
`coverage-thresholds.json` and the nightly ratchet
(`packages/dev-tools/tools/coverage-ratchet.mjs`); a PR that drops coverage below a floor
fails. Tests live in `packages/*/tests/`, mirrored by subsystem (see
[writing-slicc-tests](../.agents/skills/writing-slicc-tests/SKILL.md)).

**Remediation** — add unit tests for new paths, update tests for changed behavior, add a
regression test for each bug fix, and keep coverage at or above the package floor.

### 8. Follower surface wiring parity

**Trigger patterns**

- A new or changed `LeaderToFollowerMessage` variant or `broadcast*` call in
  `packages/webapp/src/scoops/tray-leader-sync.ts`.
- A new interactive element (button, action card, selectable list) added to a leader-side
  UI surface.
- A new follower-side handler in `tray-follower-sync.ts` with no corresponding UI action
  wired in `ui/wc/wc-follower.ts` (or vice versa).
- **Removing a fallback from a shared helper** (e.g. `wc-shell.ts`) because a
  leader-only replacement now covers it. `wireDockToWorkbench`, `prepareWcShell` and
  friends run on every boot path; the replacement usually does not.
- **Gating behavior on a float name** (`isCherry`, `isExtensionRealm()`, `ui-only=1`)
  where the real condition is a capability. Float lists go stale the moment a new float
  ships; capability checks do not.

**Historical precedents**

- **PR #1286**: the follower scoop list rendered correctly but clicking a scoop did
  nothing — the `scoops.select` sender was missing from the follower UI.
- **PR #1283**: tool-approval cards were broadcast to followers but the Approve / Deny
  buttons had no action handler, so clicking them silently no-oped.
- **PR #1261**: a fix landed on the non-primary boot path first, then caused a 5-second
  pill-reset regression that had to be fixed the next day.
- **Issue #1706** (both shapes above, four months undetected). `a99a5faa4` added
  `if (id === 'browser') return;` to `wireDockToWorkbench` so the leader's new
  full-screen tab overlay had no dead pane behind it — but that helper is shared, and
  the overlay is wired only when `options.standalone` is set. Leaders traded a pane for
  an overlay; followers lost the pane and got nothing, leaving an inert dock item and an
  unreachable `slicc-surface`. Separately, the follower's CDP advertisement was gated on
  `isCherry && ui-only=1` rather than "has a local CDP bridge", so hosted-tab followers
  — a float that shipped nine days after the gate was written — dialed
  `wss://<hosted-origin>/cdp` every 5s indefinitely.

**Class size** — ~30–40 commits since 2026-03; the largest empirical failure class in the
repo.

**Remediation** — for every leader broadcast, verify the matching follower handler exists
_and_ that the UI surface wires the user action back to the leader. Check all three boot
paths (`mountWcUiLive` / `mountWcUiFollower` / `mountWcUiExtension`). Record the iOS
mirror decision in the corpus (`packages/ios-app/`).

When a leader-only feature supersedes shared behavior, let the feature **claim** what it
replaces at wiring time rather than teaching the shared helper about it (see
`WcShellRefs.overlaySurfaces`). The fallback then survives by default on every path that
does not wire the feature — including a leader whose lazy import fails — instead of
depending on two files agreeing forever.

### 9. Origin / bridge routing contract

**Trigger patterns**

- `fetch('/api/...')` or any absolute-vs-relative URL construction in webapp or extension
  code.
- Origin comparisons (`===`, `.startsWith()`, `new URL(...).origin`) that may not account
  for trailing slashes.
- Hard-coded origin strings (e.g. `'https://www.sliccy.ai'`) instead of the canonical
  accessor.

**Historical precedents**

- **PRs #1227 / #1229**: `SANDBOX_NOT_READY` errors because the hosted UI origin issued
  relative `/api/` fetches that hit the hosted server instead of the local bridge.
- **PRs #1235 → #1236 → #1238**: a mixed-content chase — three consecutive PRs to fix
  HTTP-vs-HTTPS mismatches between the hosted origin and the local bridge.
- **PR #1243**: the same origin fix had to be applied twice.
- **PR #1283**: a trailing-slash mismatch caused a silent allowlist failure.

**Class size** — 15 call-site fixes across ~9 PRs in the Jun–Jul 2026 thin-bridge tail.

**Remediation** — use the canonical origin / bridge-URL accessors rather than constructing
URLs by hand. Verify the call works when the UI origin is the hosted origin and the API is
the local bridge (thin-bridge mode). Normalize trailing slashes before comparing origins.
Test in both CLI and extension floats.

### 10. Layer-stack import direction (back-edges)

**Trigger patterns**

- Any new `import`/`import type`/`import(...)`/`require(...)` that points UP the stack
  `fs → shell/git → cdp → tools → core → scoops → ui` — a `ui/` import from any lower layer,
  but equally `cdp/` importing `scoops/` or `tools/` importing `core/`. Imports must point
  down, never up. Unranked directories (`providers/`, `kernel/`, `speech/`, `transcript/`,
  `sudo/`) sit below `ui/`: they may import any ranked layer except `ui/`.
- The tell-tale disguise: the imported symbol is a **pure helper** (a parser, a data
  accessor, a constant, a type) that merely _lives_ in a higher-layer god module. The
  import looks harmless; the transitive graph it drags into the kernel-worker bundle is not.
- `packages/dev-tools/tools/layer-back-edge-baseline.json` growing in a diff — someone is
  trying to grandfather a new violation instead of fixing it.
- A relative specifier in `packages/webapp/src/` that climbs out of the package
  (`../../../node-server/src/…`). This is the cross-**package** form of the same mistake and
  the ranked layers cannot see it, since they are webapp-internal directories. Shared code
  travels through `@slicc/shared-ts`, never a deep path into a sibling package.
- A new `isChromeExtensionRealm` / `isExtensionRealm` / `hasLocalNodeServer` /
  `resolveFloatTopology` call in `scoops/` or `tools/` business logic. Privileged
  float detection belongs on the injected `CapabilityBroker`
  (`work-unit/capability/`), composed once in `kernel/host.ts` (#2276). See
  [`work-unit.md`](work-unit.md) Phase 6. The tell is the same as a back-edge:
  the call site is in the wrong layer.

**Historical precedents**

- **Issues #869, #968, #1071, #1145, #1630, #1772** — six recurrences of the identical
  shape in under two months: worker-resident or lower-layer code importing `ui/` for pure
  helpers (`trackShellCommand`, provider-settings accessors, `quick-llm`, sprinkle routes,
  `parseFrozenArchive`/`readSessionsIndex`). Every one was introduced in a reviewed PR
  (e.g. #1638 shipped the #1772 back-edge) and caught only _after_ merge by nightly triage.
  None was flagged at review time — reviewers had no layering category to check against.
- **Issue #1950** — the same shape one rung lower: `cdp/` importing `reassembleCDPResponse`
  and `TrayTargetEntry` from `scoops/`. Invisible to the original ui-only ratchet, which is
  why the gate now covers every rung of the stack.
- **Issue #2537** — the largest single entry (7 back-edges): `shell/supplemental-commands/
host-command.ts` reaching three rungs up into `scoops/` for the tray status readers,
  `joinTray`/`leaveTray`, and the join-URL parser. Notable for the trap in its first
  proposed fix: **inverting** the dependency with UI-registered setters (the
  `setConnectedFollowersGetter` pattern) is realm-INCORRECT here — `ui/wc/wc-tray.ts` runs
  only on the page, while `host` executes in the kernel worker, so the setters would never
  fire and `host` would report `inactive` while genuinely connected. Relocation was the
  right tool: four of the six modules had no upward dependency at all and simply moved to
  `base/`, which preserves per-realm behavior exactly because the module global stays a
  single ESM singleton. Prefer moving state DOWN over injecting it SIDEWAYS.
- **Issue #2798** — the cross-package form, and an object lesson in fixing one back-edge by
  creating another: the #2537 relocation landed the tray URL parser in `base/` but pointed
  `base/` at `node-server/src/tray-url-shared.ts`, so the webapp's _bottom_ rung depended on
  the Node CLI package. Pure helpers, wrong package. Moving them to `@slicc/shared-ts` flipped
  the arrow; the gate now scans for the escape so the class cannot recur.

**Class size** — 152 grandfathered back-edges across 92 files at full-stack baseline freeze
(2026-08); 34 across 27 files at the original ui-only freeze (2026-07).

**Remediation** — never import from a higher layer. If the symbol you need is pure (no DOM,
no `window`), it is mislocated: move it (or extract it) into the appropriate lower layer and
have the higher layer re-export it for its existing callers, so the dependency points down.
This applies to module-global REGISTRIES too, not just stateless helpers — a status
singleton with a `localStorage` fallback (`base/tray-leader-status.ts`,
`base/permissions-surface-registry.ts`) relocates safely as long as it moves WHOLESALE and
is re-exported, never re-declared: two copies of the `let` would silently split the realms.
Reach for setter injection only when the registering layer runs in every realm that reads.
When the higher "layer" is a different package, the fix is the same move with a different
destination: relocate the pure helper into `@slicc/shared-ts` and import it by package name
from both sides, so one wrong-direction edge becomes two correct ones.
Deterministic enforcement: `npm run lint:layer-back-edges`
(`packages/dev-tools/tools/check-layer-back-edges.mjs`) fails on any back-edge not in the
frozen baseline; the baseline is a one-way ratchet — shrink it, never grow it. The same gate
fails on any relative import that escapes `packages/webapp/src` into a sibling package —
zero tolerance, no baseline (only the inert `?raw`/`?url` asset queries are exempt —
`?worker` executes its target, so it is still an escape).
`providers/built-in/` stays a zero-tolerance zone (`lint:no-ui-in-providers`).

### 11. Untyped string-keyed bags (`Record<string, unknown>`)

**Trigger patterns**

- A new `Record<string, unknown>` in non-test source — as a parameter, a return type, a
  field, or a cast target. It is what a type looks like when nobody decided what the shape
  is: it type-checks, so it never surfaces as an error, and it pushes the narrowing onto
  every consumer, ad-hoc and unverified.
- The tell-tale disguise: a value whose shape _is_ known at the call site (a config object,
  an options bag, a message payload with a fixed set of fields) typed as an open bag because
  writing the interface felt like ceremony.
- `packages/dev-tools/tools/record-string-unknown-baseline.json` growing in a diff — someone
  is grandfathering a new bag instead of naming the shape.

**Class size** — 604 grandfathered occurrences across 181 source files at baseline freeze
(2026-08), concentrated in `webapp` (984 including tests) and `shared-ts` (200). A further
782 occurrences in test files are deliberately out of scope: `(globalThis as Record<string,
unknown>).chrome = …` is idiomatic scaffolding with no better spelling, and `biome.json`
already exempts tests from `noExplicitAny` and the complexity rules for the same reason.

**Remediation** — declare a named `interface`/`type` for the shape you actually accept, and
narrow opaque input at the boundary (parse/validate once) rather than passing an open bag
inward. For a payload that is genuinely untyped at that point — JSON-RPC params, CDP
payloads, a third-party envelope — suppress the line with
`// biome-ignore lint/plugin: <reason>`; the reason is the review artifact.
Deterministic enforcement: `npm run lint:record-string-unknown`
(`packages/dev-tools/tools/check-record-string-unknown.mjs`) runs the GritQL plugin
`.biome-plugins/no-record-string-unknown.grit` via `biome.record-gate.json` and fails on any
occurrence not in the frozen baseline; the baseline is a one-way ratchet — shrink it, never
grow it. Touching a baselined file obliges you to clear that file
(`check-touched-exemptions.mjs`).

### 12. Agent skill freshness

**Trigger patterns**

- A shell command, tool, provider, approval flow, or runtime capability changes without the
  matching agent-facing `packages/vfs-root/workspace/skills/*/SKILL.md` update.
- New command arguments, flags, aliases, or output semantics are absent from the skill that
  teaches agents how to invoke the command.
- A developer workflow changes without updating the matching `.agents/skills/*/SKILL.md`
  procedure and its `.claude/skills/` discovery alias.

**Historical precedent** — **PR #1130** aligned SLICC's `playwright-cli` with the official
CLI, closing 39 command gaps and refreshing the runtime skill with the newly supported
commands. Its sync script detects command-surface drift; the skill update keeps that surface
usable by agents after it lands.

**Remediation** — follow the cross-reference checklist in
[adding-slicc-features](../.agents/skills/adding-slicc-features/SKILL.md): update each affected
audience's skill in the same PR—runtime skills for agent-facing capabilities, developer skills
for developer workflows. Run `npm run lint:skill-router` and any specialized sync check (such
as `playwright-cli-sync.mjs`) that covers the changed surface.

### 13. Transcript export — redaction boundary and protocol parity

Changes to export-service, redaction logic, or the Cherry/follower export protocol.

**What to check**

- Redaction is **fail-closed**: if the redactor fails to initialize, the export must abort with
  `redaction-unavailable`, not emit an unredacted bundle. Any code path that skips or
  short-circuits redaction is a Critical finding.
- `privacy.reasoningExcluded` must always be `true`. Any path that can produce an export with
  a reasoning block is a Critical finding.
- Binary attachments go through unchanged — confirm no text-redaction step touches them.
- Approval gate: every follower/Cherry export path must go through the sudo funnel —
  `requestSudoApproval({ kind: 'export', detail: <subject> })` → `SudoManager.approve()` —
  before streaming. A bypass, or a second export path that raises its own dialog, is Critical.
- Approval semantics: an export is **always gated**; the only way to skip the prompt is an
  explicit `NOPASSWD Export <glob>` sudoers grant (written by "Always" on the prompt, subject
  `active` / `frozen:<sessionId>`). There is no "no match means ungated" for `Export`.
- Approval **reachability**: a gate is only real if a human can answer it. A leader with
  `kind: 'hosted'` (cloud) is headless — `shouldDelegateSudo()` routes the prompt to a
  `sudoApproval`-capable follower via `sudo.approve.request` (the iOS card behind Face ID, or the
  web follower's `<slicc-dialog>`), parking it and push-waking phones when nobody is connected.
  `always` is honoured only from `biometric` followers. When touching approval code, check it
  still resolves in _every_ realm, and that every failure path (timeout, disconnect, unwired
  handler, throw, malformed reply) denies rather than hangs.
- Approval **lifecycle**: a consent dialog must not outlive the request it authorizes. Prompt
  only for a request that is still in flight, pass an `AbortSignal` that closes the dialog on
  every terminal outcome, and report a post-settlement verdict as a denial. A stale prompt whose
  "Allow" silently does nothing reads to the user as a granted approval.
- Consent copy must name the **actual recipient** of the bytes, which differs by realm
  (leader-side / delegated / delegated + Cherry host page). Derive an embedding origin from the
  value the transport resolved at boot, never by re-reading `location.ancestorOrigins` — it is
  non-standard and absent in Firefox, where Cherry still boots via the referrer fallback.
- Cherry protocol: `session.export.request` → approval → `session.export.progress*` →
  `session.export.response` OR `session.export.error`. Confirm cancel (`session.export.cancel`)
  is handled on both sides.
- Unknown error codes from followers must map to `transfer-corrupt` (M-1 guard in `mount.ts`).
- SHA-256 verification on receipt: a mismatch must reject with `transfer-corrupt`.
- No temporary files left behind after a cancelled or failed transfer.

**Historical precedents**

- **Task-4 review**: redaction was fail-open — export succeeded even when the redactor was
  unavailable, potentially emitting raw secrets.
- **Task-7 review**: legacy frozen-session IDs were not normalized, causing `session-not-found`
  on valid IDs.
- **Task-8 review (M-1)**: unknown error codes from followers were passed through unvalidated;
  the fix maps unknown codes to `transfer-corrupt`.
- **Cloud approval hang**: the approval dialog rendered into the _leader's_ DOM, which in the
  hosted-leader float is headless Chromium in an e2b sandbox. Nobody could click it, so follower
  exports hung at `pending` forever — no timeout on either side, and the per-follower in-flight
  cap then auto-denied every retry. Fixed by delegating the prompt to the requesting follower.

**Remediation** — verify the fail-closed path with a unit test that makes the redactor throw;
confirm the approval dialog is rendered before `streamExport()` is called; check both
follower (tray) and Cherry paths. See [docs/transcript-export.md](transcript-export.md).

### 14. `--help` that does the thing

Any command that dispatches on a subcommand verb — shell commands, CLI entry points, follower
tools.

**Trigger patterns**

- A dispatcher checks `args[0] === '--help'` (or `args.length === 0`) and then routes
  `args[0]` into a handler. That answers `cmd --help` but sends `cmd <verb> --help` straight
  into the verb.
- A handler defaults a missing argument (`positional[0] ?? 'about:blank'`, `rest[0] ?? '/tmp/x'`)
  or ignores its trailing args entirely (`case 'reset': return { kind: 'reset' }`). Combined
  with the above, asking for help performs the action.
- A destructive verb (`stop`, `delete`, `remove`, `reset`, `clear`) whose help check reads only
  the verb's _own_ position — `mcp delete <name> --help` deleted `<name>`.

**What to check**

- Help is answered **before** the handler runs, for every verb, and exits `0` on stdout.
- The check scans the whole arg list, not one index — `isHelpRequest()` in
  `packages/webapp/src/shell/supplemental-commands/subcommand-help.ts`.
- It respects value-taking flags: a `--help` that is a flag's VALUE
  (`route --body --help`) is not a help request. Parse first and read
  `flags.help` when the shared `arg-parser` is in play; otherwise declare the
  flags via `isHelpRequest(args, { valueFlags })`.
- Verbs whose payload is free text (`v86 type`, `sprinkle chat`, `playwright-cli fill`) keep a
  `--` escape so the literal string still gets through.
- POSIX conflicts are respected: `df -h` is `--human-readable`, not help.

**Historical precedent** — `playwright-cli record --help` opened a tab and started a HAR
recording (reported by a user, not by CI); the same dispatcher bug made `v86 stop --help` power
off the VM, `layout reset --help` rearrange the workbench, `sprinkle chat --help` render the
flag into the chat transcript, and `mcp delete x --help` delete the server.

**Remediation** — route the verb through `isHelpRequest()` / `subcommandHelpText()` and add the
command to `DISPATCHERS` in
`packages/webapp/tests/shell/supplemental-commands/subcommand-help.test.ts`. That suite builds
every command with dependencies that throw on use and runs `--help` against every verb, so a
help path that touches the browser, VFS, or network fails with the call site. Its coverage test
also fails when a new verb-dispatching command is added but not registered.

---

## Approval gate changes in `wc-tray.ts` or `wc-transcript-export.ts`

When the approval dialog is changed: verify that Deny still resolves with `permission-denied`,
that no approval escapes require a new prompt, and that the binary-attachment warning is
still visible.

---

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
   category. Mind the 15,000-char budget enforced by
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
