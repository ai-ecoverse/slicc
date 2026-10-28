# Dev-Tools Deep Reference

Rationale, gotchas, and non-obvious behavior for tools listed in
[`packages/dev-tools/CLAUDE.md`](../packages/dev-tools/CLAUDE.md). The
guide keeps entry commands; this page keeps the "why".

## review-responder

`review-responder/` is woken by a reviewer. It answers the review feedback
left on `automation/*` PRs (today only `coverage-ratchet.yml` opens them) —
Codex, Copilot, and this repo's own `claude-pr-review.yml`. Before it existed
that feedback simply sat there; a human had to open a local session and say "take
over PR X and address the review comments".

Same two-part shape as `rum-error-triage.yml`: `scan-review-feedback.mjs` decides,
one Claude step does the work. Several things about it are non-obvious:

- **Only trusted authors reach the prompt, and the filter fails closed.** This repo
  is public, so anyone with a GitHub account can comment on a PR — and every
  comment body that survives the scan becomes prompt text for a step with
  unrestricted `Bash` and a checkout carrying `BOT_PAT`. `dropReason` therefore
  keeps feedback only from the three named reviewer bots
  (`TRUSTED_REVIEWER_BOTS` — the same identities as the workflow's `allowed_bots`,
  pinned equal by a test) or from an author whose `author_association` is `OWNER`,
  `MEMBER` or `COLLABORATOR`, the three that imply write access. `CONTRIBUTOR` is
  the trap: it only means an account has had a commit merged. That, the
  `FIRST_*`/`NONE`/`MANNEQUIN` values, and a missing or unrecognised association
  are dropped as `untrusted-author` and reported by `formatDrops`, because a
  swallowed comment must not look like an empty PR. `allowed_bots` cannot cover
  this — it gates the triggering **actor**, not the feedback a run collects — and
  the trigger is left ungated on purpose: a stranger's comment may start a run,
  which then finds nothing trusted and skips.
- **The marker records the feedback it processed, not when it finished.**
  `<!-- review-response:<sha>:<iso8601> -->`, where the timestamp is the newest
  `createdAt` in the snapshot that run answered (`feedback_watermark` from the
  scan, `none` for an empty snapshot). Comparing against the marker comment's own
  `created_at` loses a comment left after the snapshot but before the marker: it
  predates the marker, so the next run counted it as already answered and nothing
  ever re-raised it. `decideResponse` takes `respondedWatermark` from
  `lastResponseWatermark`; `lastResponseAt` survives for reporting only. Markers
  without a watermark still parse and fall back to the comment's `created_at`, so a
  PR mid-flight when this shipped does not re-answer everything. The marker is
  written in two places — `buildResponseMarker` and the workflow's `printf` — and a
  test asserts they are byte-equal.

- **It must read all THREE feedback endpoints.** `claude-pr-review.yml` posts its
  verdict as a top-level ISSUE comment, so `GET /pulls/{n}/reviews` alone sees
  nothing at all from the house reviewer — the scan looks like it works while
  ignoring the reviewer whose findings are most specific to this repo. Reviews,
  inline comments (`/pulls/{n}/comments`) and top-level comments
  (`/issues/{n}/comments`) are all required; `lib.test.mjs` pins the
  house-reviewer-only case as a regression test.
- **A reviewer can be wrong, and the prompt says so explicitly.** The right
  response to a bad finding is a reply explaining why, not a change; changing code
  to satisfy a finding the model believes is mistaken makes the code worse _and_
  hides the disagreement. The brief cites the real precedent from #2170, where the
  house reviewer LGTM'd a `Record<string, unknown>` rename that Codex correctly
  identified as defeating the spelling-based debt gate. Reviewers disagreeing is
  normal; the model is told to reason about the code rather than count votes.
- **A three-reviewer burst must produce one run.** `concurrency:
review-responder-<pr>` **queues** the runs (`cancel-in-progress: false`) behind a
  leading `sleep 300` debounce: the first answers a complete feedback set, and the
  rest wake to find its marker at an unmoved head SHA and skip. Two responders on
  one branch would race each other's pushes. `cancel-in-progress: true` is the
  trap: concurrency is evaluated _before_ the job `if:`, so a run the `if:` would
  skip still cancels the run in progress — and every inline reply the responder
  posts is such an event. The first reply would kill the responder that wrote it
  before it recorded its marker, and the replacement would start over: unbounded
  ping-pong presenting as cancelled runs rather than failures.
- **The gate must not be run by the branch it is judging.** The scanner executes
  from a checkout pinned to the default branch with `persist-credentials: false`.
  On `pull_request_review*` the default ref is the PR's merge ref, so omitting
  `ref:` would run the PR's own copy of the script that decides whether the
  privileged step happens. `BOT_PAT` and the branch's code enter the workspace
  only in a second checkout, after the gate has approved the head.
- **Loop safety is doubled everywhere, and the self-filter is NOT author-based.**
  The responder posts comments and comments are its trigger, so the job `if:`
  refuses any run whose triggering comment/review author is
  `github-actions[bot]`, AND `isSelfOutput` drops our own output from the
  feedback. It cannot drop it by author: `claude-pr-review.yml` posts its verdict
  under that same login (`claude-code-action` runs its Bash `gh` under
  GITHUB_TOKEN), so an author filter would discard the house reviewer entirely —
  the same blindness as the endpoint trap above, arrived at from the other side.
  The test is structural instead: either marker in the body at any authorship, or
  an inline comment authored by us with `in_reply_to_id` set (we only ever reply;
  the reviewer's inline comments open new threads). That is also why the workflow
  — not Claude — posts the summary, as one comment carrying the SHA marker.
  `allowed_bots` is not in tension with that `if:` — `allowed_bots` gates the
  _action_ for a triggering **actor**, the `if:` gates which **trigger** is worth a
  run. Claude's push fires `synchronize`, which this workflow does not subscribe
  to.
- **The reviewer bots are named actors** (`github-actions[bot]`,
  `chatgpt-codex-connector[bot]`, `copilot-pull-request-reviewer[bot]`), never
  `'*'`. Admitting third-party Apps as actors grants them no content control they
  lack anyway — their findings are this workflow's input by design, whichever event
  starts the run — while excluding them breaks the feature silently: Codex ignores
  bot-authored PRs and the house reviewer stands down once inline comments exist,
  so Copilot's review is sometimes the only event an `automation/*` PR gets.

Merging, opening a PR, and closing anything are removed from the tool surface
(`--disallowedTools "Bash(gh pr merge:*),Bash(gh pr create:*),Bash(gh pr close:*),Bash(gh issue close:*)"`)
rather than merely discouraged in the prompt: a model that ignores an instruction
regresses silently in a way that looks like success. Force-pushing is forbidden
because the branch may carry a human's commits, and the job holds `contents: read`
— the push goes through the `BOT_PAT` credential the checkout persisted, for the
same anti-recursion reason as its siblings.

The session is **not** resumed, deliberately. GitHub already is the durable state:
the diff is on the branch, the reasoning is in the threads, the verdict is the
check suite. A resumed session would be a second, private copy of that state that
can disagree with the public one — and would not survive a human pushing to the
branch, a rebase, or a week's delay anyway. The only memory the run needs is "did
we already answer at this SHA?", which is one HTML comment. Full rationale:
[`packages/dev-tools/review-responder/README.md`](../packages/dev-tools/review-responder/README.md).

```bash
gh workflow run review-responder.yml -f pr_number=2179 -f dry_run=true  # rehearse
gh workflow run review-responder.yml -f pr_number=2179                  # for real
```

## doc-dead-reference-gate

`check-doc-refs.mjs` (+ `check-doc-refs-lib.mjs`) skips globs,
angle-bracket templates, illustrative `my-*` paths, absolute VFS
runtime paths, and a small built-in allowlist for build artifacts,
external-repo refs, and spec/plan future files. TypeScript ESM
`.js`→`.ts` resolution is handled automatically. Chained after
`check-doc-sizes.mjs` in `lint:docs`.

## layer-back-edge-ratchet

`check-layer-back-edges.mjs` fails on any NEW import that points up a
documented per-package layer stack. The original webapp stack is
`fs → shell/git → cdp → tools → core → scoops → ui`
(e.g. `cdp/` → `scoops/`, or any layer → `ui/`). Unranked webapp
directories (`kernel/`, `providers/`, `speech/`, …) rank just below
`ui/`: they may import ranked layers but not `ui/`, and are never a
back-edge target — except a **value** import of `kernel/` from
`scoops/` (#3231), and a **value** import of ANY unranked directory from the
rank-0 `fs/` / `base/` (#3728, #3742, #3743), which every unranked
directory sits above. Pure helpers move down instead — e.g.
`base/panel-rpc-accessor.ts`, `base/port-bridge-client.ts`,
`base/sudo-refusal.ts`, `base/stored-accounts.ts`. Top-level `import type { … }` clauses still erase and are
allowed. Ranking `kernel/` itself is not cheap: `cdp/`, `shell/`, and
`core/` already value-import it.

The same script also ratchets the other TypeScript applications (#3149),
each with its own layer order and baseline file:

| Package             | Stack                                                                                | Baseline                                          |
| ------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------- |
| `webapp`            | `fs → shell/git → cdp → tools → core → scoops → ui`                                  | `layer-back-edge-baseline.json`                   |
| `node-server`       | `transport → services → entry`                                                       | `layer-back-edge-baseline-node-server.json`       |
| `cloudflare-worker` | `shared/links/auth → routes → entry` (routes are peer-isolated: no sideways imports) | `layer-back-edge-baseline-cloudflare-worker.json` |

Pre-existing back-edges are grandfathered per file in the matching
baseline (one-way ratchet; regenerate after paying debt down with
`--update`). The baselines double as debt lists for the boy-scout gate.
Chained into `npm run lint`, `lint:ci`, pre-commit (gated-package source
commits), and the pre-push gate.

The same pass also fails on any relative import that climbs OUT of
`packages/webapp/src` into a sibling package
(`../../../node-server/src/tray-url-shared.js`, #2798). Ranked layers are
webapp-internal directories, so such a specifier lands in no layer and the
ratchet above cannot see it. Zero tolerance, no baseline — the tree is clean.
Exempt: the inert asset queries `?raw` and `?url`, which hand back bytes or a
URL string rather than creating a module edge. That is an allowlist, not "any
query" — `?worker` / `?sharedworker` bundle and EXECUTE the target, so waving
them through would reopen the same wrong-direction dependency. A new asset mode
is a conscious decision; the gate fails closed. Shared code belongs in
`@slicc/shared-ts`, imported by package name.

A third zero-tolerance pass
(`scanWebcomponentsWebappEscapes`, #3027) flags `packages/webcomponents`
(`src/` and `tests/`) importing FROM `packages/webapp/src` — no type-only
exemption. webcomponents is a leaf library; the climb inverts the stack.

## float-probe-ratchet

`check-no-float-probes.mjs` (#2276 slice D) fails on any NEW read of one of
ten float/topology identifiers (`FLOAT_PROBE_NAMES`: `isExtensionRealm`,
`isChromeExtensionRealm`, `hasLocalNodeServer`, `resolveFloatTopology`,
`getChromeExtensionRealm`, `setChromeExtensionRealm`, `hasChromeRuntimeConnect`,
`canConnectToChromeRuntime`, `getExtensionDelegateId`,
`setExtensionDelegateId`), plus the raw `__slicc_connect_mode` global-bag key
`resolveFloatTopology` reads directly, under `scoops/`, `tools/`, or
`kernel/` — except two composition roots: `kernel/host.ts` and
`kernel/kernel-worker.ts` (each resolves the float's topology once, into a
`CapabilityBroker` or an extension-delegate id — `docs/work-unit.md` Phase
6). The extension-delegate Port/panel-RPC transport factory lives in
`base/port-bridge-client.ts`, outside the banned zone (#3728). Privileged float detection belongs on the injected
broker or, for a genuine transport decision, in `shell/` (which owns
topology).

Round-1 review (Grok + human) planted a batch of evasions against the first
cut of this gate and every one passed silently — a gate that passes on a
planted violation is worse than no gate. The design is now two layers:

- A **module-path ban**: `shell/float-topology.ts`, `core/float-topology.ts`,
  `base/runtime-env.ts`, `core/runtime-env.ts` exist for nothing but float
  detection, so importing from one, in ANY form (named, default, namespace
  `import * as`, dynamic `import(…)`, `export * from`, type-only), is banned
  regardless of what name the importer binds it to — `import * as topo from
'…/float-topology.js'` names the MODULE, not a banned identifier, and a
  pure name scan cannot see it.
- A **named-clause scan**, line-anchored to the statement's own start (so a
  string literal containing import-shaped text elsewhere on the line can
  never match — `export const x = "import { hasLocalNodeServer } from
'…'"` used to trip the unanchored version), for everything else: the
  mixed-surface `base/api-endpoint.ts` / `shell/proxied-fetch.ts` (which
  also export plenty of non-probe bindings) and `@slicc/shared-ts`'s two
  probe exports specifically (never the whole package). Every domain #2276
  migrated reuses a probe's OWN name for a local composition-time-answer
  const/parameter/property (`const hasLocalNodeServer = () =>
localNode.ok`), so this stays clause-based rather than a whole-file scan —
  a whole-file scan cannot tell that reuse apart from an actual import.

A discovery pass folds three alias shapes, found anywhere in
`packages/webapp/src`, into the named-clause scan: a bare value re-export
(`export const isTrayExtension = getChromeExtensionRealm`), a renamed
`export { … as … }`, and a THIN wrapper whose entire body is `return
PROBE(...)` (`export function inExtension() { return isExtensionRealm();
}`) — narrow enough on purpose that `shell/tray-fetch.ts`'s
`createTrayFetch` (a substantive function that merely reads topology as one
of several statements, already reviewed in the network-domain slice) is not
mistaken for a probe-identity wrapper. A pre-existing, legitimate,
out-of-zone rename (`core/secret-topology.ts`'s `resolveFloatTopology as
resolveSecretTopology`) is not itself flagged — the alias name is folded
into the banned-zone scan instead, so the violation would surface at a
banned-zone IMPORT site if one ever appeared, not at the file that defined
the alias.

Baseline `float-probe-baseline.json` starts EMPTY (one-way ratchet;
regenerate after paying debt down with `--update`) — slices A–C's migration
work made that the honest starting point — and `--update` refuses to WRITE a
larger baseline than the one already on disk unless `--allow-growth` is also
passed, so a careless local `--update` cannot silently grandfather a new
violation before it is even committed. The baseline doubles as a debt list
for the boy-scout gate (`check-touched-exemptions.mjs`, whose own
"list must not grow" check used to skip entirely whenever a debt list's
base-ref state was empty — indistinguishable from the list not existing yet
— fixed for all three ratcheted debt lists, not just this one). Chained into
`npm run lint` and `lint:ci`.

## record-string-unknown-ratchet

`check-record-string-unknown.mjs` fails on any NEW `Record<string, unknown>`
in non-test source. Detection is a Biome analyzer plugin
(`.biome-plugins/no-record-string-unknown.grit`), not a regex, so it matches
the real type node: line-wrapped occurrences count, `Record<string, string>`
does not, and `// biome-ignore lint/plugin: <reason>` suppresses a line the
same way it would any other Biome diagnostic.

The plugin cannot live in the root `biome.json`: at `severity = "error"` it
would fail `lint:ci` on all 604 pre-existing occurrences, and Biome's
`--skip=plugin` and `overrides[].plugins` are both group-level — there is no
per-plugin file exemption (`overrides[].plugins: []` is additive, not a
kill-switch). So `biome.record-gate.json` extends the root config, inheriting
`files.includes` verbatim (zero drift), and swaps in that one plugin; the
script runs it with `--only=plugin --reporter=json` and enforces the baseline.

Pre-existing occurrences are grandfathered per file in
`record-string-unknown-baseline.json` (one-way ratchet; regenerate after
paying debt down with `--update`). The baseline doubles as a debt list for
the boy-scout gate. Tests are out of scope — `(globalThis as Record<string,
unknown>).chrome = …` is idiomatic scaffolding, and `biome.json` already
exempts tests from `noExplicitAny` and the complexity rules for the same
reason. Chained into `npm run lint` and `lint:ci`.

## storybook-screenshots-upload

`storybook-screenshots-upload.mjs` (+ `storybook-screenshots-upload-lib.mjs`)
uploads the affected-story manifest to the `slicc-pr-screenshots` R2
bucket, content-hash deduplicated, with bounded concurrency
(`--concurrency`, default 4) via an injectable `r2` client so
`mapWithConcurrency`/dedup logic is testable without a real `wrangler`
process.

Sequential per-file `wrangler` subprocess spawns previously took ~4s per
file on large sets of affected stories. Each shot retries up to 5 times with
jittered exponential backoff, since R2 rate-limits upload bursts with `429` /
code 971. Agents can run this tool when they choose to share captured stories
through R2.

## knip-production-suffix-discipline

`npm run deadcode:production-files` runs `knip --production --include files`
to surface test-only dead files the default knip gate misses.

**Production-suffix discipline**: every workspace `entry`/`project`
glob in the production graph MUST be `!`-suffixed;
`knip --production` keeps only suffixed patterns. Test-only fixtures
are excluded via negated `project` patterns in `knip.json`, **not**
`ignoreFiles`. See the
[verifying-before-push skill](../.agents/skills/verifying-before-push/SKILL.md)
§ "Knip fixture exclusion" for why `ignoreFiles` is wrong and the
correct approach.

## swift-unused-dependency-gate

`npm run lint:swift-deps`
(`packages/dev-tools/tools/check-swift-unused-deps.mjs` + `-lib.mjs`)
gives the Swift/SPM packages the unused-dependency signal knip provides
for the TS workspaces (`npm run deadcode`) and `go mod tidy -diff` for
the Go modules (`make tidy-check` in `packages/{go-optel,slicc-cli}`).
SPM has no built-in equivalent: `swift build` links a declared
dependency whether or not any source imports it, so a dropped `import`
leaves a dead package pinned in `Package.resolved` and paid for on every
resolve.

The gate parses every `packages/*/Package.swift`, resolves each target's
sources (explicit `path:`/`sources:`/`exclude:`, else the **first**
matching conventional root — `Sources/<name>` before the enclosing
`Sources`, so a target never scans a sibling target's files), collects
the modules those sources import, and reports three findings:

| Code                        | Meaning                                                    |
| --------------------------- | ---------------------------------------------------------- |
| `unused-package-dependency` | a `.package(...)` clause no target consumes a product from |
| `unused-target-dependency`  | a target dependency no source of that target imports       |
| `unlisted-dependency`       | a module a target imports but only reaches transitively    |

Matching mirrors SPM's own rules: package identities compare
case-insensitively and come from the last URL/path component, target
names are normalised to module names (`slicc-server` → `slicc_server`),
local `path:` dependencies are resolved through their own manifests so a
product vending a differently-named module still matches — scoped to the
product the target actually declared, so a sibling product of the same
local package never satisfies it — and modules named in
`#if canImport(...)` count as used. Comments **and string literals** are
blanked before the import scan, so a generated-source fixture such as
`let src = """\nimport Logging\n"""` cannot make a dead dependency look
alive. `.product(…, condition:)`
entries are skipped — the importing sources sit behind `#if os(...)`,
which the gate does not evaluate. The `unlisted-dependency` check only
fires for modules whose origin is knowable from the manifest (a sibling
target, a local package, or a product another target in the same
manifest declares), so a transitive module of an external package is
never guessed at.

Parsing is string-level on purpose: the gate is chained into `lint` /
`lint:ci` and therefore runs in the Linux `lint` CI job, which has no
Swift toolchain and cannot evaluate `Package.swift` as code.

A legitimate exception (a product linked for its resources or plugin
rather than imported) is annotated at the declaration site:

```swift
.product(name: "SomeThing", package: "some-package"),  // unused-dep-ok: linked for its resource bundle
```

The marker applies to the entry's own line, any line a multi-line entry
spans, and the line directly above it. Behaviour is covered by
`check-swift-unused-deps.test.mjs`, including an end-to-end run against
the checked-in manifests.

## dead-feature-flag-gate

`npm run lint:dead-flags`
(`packages/dev-tools/tools/check-dead-flags.mjs`) is the other end of a
flag's life. The typed registry
(`packages/webapp/src/core/feature-flags.ts`) already drops unknown ids;
this gate fails when a declared id has no consumer, and when a consumer
names an id the registry does not declare. Worker overlay keys in
`wrangler.jsonc` and `FALLBACK_BASE_FLAGS` in
`packages/cloudflare-worker/src/flags.ts` are the string-boundary
sources the `FeatureFlagId` union cannot see.

A wrangler entry is not enough to keep a flag alive. Consumers are
`isFeatureEnabled('…')`, `getFeatureValue('…')`, and Cherry host `flags`
object keys. A parked flag is annotated on its registry entry with
`// unused-flag-ok: <reason>` (or `// unused-dep-ok:`). Every registry
entry needs `since` (`YYYY-MM-DD`); a flag whose bundled default has
been constant across every float for 90 days is reported as a
`stale-flag` warning. Lifecycle:
[`feature-flags.md`](feature-flags.md). Covered by
`check-dead-flags.test.mjs`.

## swift-forbidden-import-gate

`npm run lint:swift-forbidden-imports`
(`packages/dev-tools/tools/check-swift-forbidden-imports.mjs` + `-lib.mjs`)
is the Swift/iOS counterpart of the webapp layer-back-edge ratchet. Swift
layering leans on SPM modules (`swift-traykit`, `swift-widgetkit`,
`swift-traysession`, `swift-optel`): the cross-module surface is `public`,
not a directory stack. What the compiler still allows — and WidgetKit's
memory budget cannot — is a widget process importing WebRTC (or a
tray-follower module that pulls it in).

The gate is a frozen denylist, chained into `lint` / `lint:ci`, and needs
no Swift toolchain. It scans:

| Rule                           | Roots                                                       | Also checks                                                                  |
| ------------------------------ | ----------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `ios-widgets-no-webrtc`        | `packages/ios-app/SliccWidgets`                             | xcodegen target `SliccWidgets` in `packages/ios-app/project.yml`             |
| `sliccstart-widgets-no-webrtc` | `packages/swift-launcher/SliccstartWidgets`                 | xcodegen target `SliccstartWidgets` in `packages/swift-launcher/project.yml` |
| `widgetkit-no-webrtc`          | `packages/swift-widgetkit/Sources/SliccWidgetKit` (+ tests) | at least one `public`/`open` declaration (the cross-module surface)          |

Forbidden modules: `WebRTC`, `SliccTrayFollower`, `SliccTrayVFS`,
`SliccTrayKit`, `UIKit`, `AppKit`. Import collection is the same `collectImportHits` helper
the unused-dependency gate uses (comments and string literals blanked;
`@_exported` / `canImport` count). The xcodegen pass catches linking
WebRTC without an `import`. The `slicc-widget-gallery` executable is
outside the widgetkit root on purpose — it is a design-time AppKit tool,
not a widget process.

`node …/check-swift-forbidden-imports.mjs --help` lists every rule.
Behaviour is covered by `check-swift-forbidden-imports.test.mjs`,
including an end-to-end run against the checked-in sources.

## swift-coverage-retry

`swift-coverage-check.sh` sources `swift-coverage-runner-retry.sh` in
`--xcodebuild` mode to retry once when the UI-test runner dies at
initialization. This is an infrastructure failure
`-retry-tests-on-failure` cannot see (the runner never gets far enough
to report per-test results); tested by
`swift-coverage-runner-retry.test.mjs`. Set `SLICC_IOS_SIM_UDID` to a
worktree-owned simulator UDID to override automatic selection locally;
when unset or empty, existing SDK-runtime selection remains unchanged.

## fresh-dev-harnesses

Four harness scripts bring up isolated dev environments on distinct
ports so they can run concurrently. Port-selection, reaping, and
LaunchServices lifecycle are covered in
[`docs/development.md`](development.md) § "Fresh Dev Harness Details".

| Harness (script under `tools/`)              | Bridge             | CDP     | Notes                         |
| -------------------------------------------- | ------------------ | ------- | ----------------------------- |
| Standalone `dev-standalone-fresh.sh`         | `:$PORT` (`:5715`) | auto    | fails on occupied bridge      |
| Swift `dev-swift-fresh.sh`                   | `:5720`            | `:9224` | native; auto-signs with cert  |
| Electron-Node `dev-electron-node-fresh.sh`   | `:5730`            | `:9225` | external Electron app (Slack) |
| Electron-Swift `dev-electron-swift-fresh.sh` | `:5740`            | `:9226` | Swift backend + Electron      |

Run via `npm run dev:standalone:fresh` (also `dev:swift:fresh`,
`dev:electron:{node,swift}:fresh`; the extension harness moved to
ai-ecoverse/slicc-extension); override with
`PORT`/`WRANGLER_PORT`/`ELECTRON_APP`. Darwin helpers:
`clone-labeled-chrome.sh` (APFS COW-clone, distinct bundle name/id for
⌘-Tab entries), `tools/setup-dev-cert.sh` (one-time self-signed
`SLICC Dev Code Signing`).

Reaping semantics (also enforced in the harness scripts):

- The standalone harness fails if its selected bridge port is occupied
  by default.
- `SLICC_FRESH_REAP=1` opts into reaping a confirmed stale harness on
  that port.
- Forced reaping of the documented production bridge `:5710` is always
  refused.
- The harness never reaps Chrome CDP (`:9222` production, per-harness
  `:9224`/`:9225`/`:9226`/`:9333` dev).
- Other harness cleanup remains strictly port-scoped, never by process
  name.

Labeled Chrome bundle clones (`clone-labeled-chrome.sh`) provide
distinct ⌘-Tab entries.

## ios-ui-test-exclusion-registry

`npm run lint:ios-ui-tests`
(`packages/dev-tools/tools/ios-ui-test-exclusions.mjs` +
`packages/ios-app/ui-test-exclusions.json`) exists because the
`ios-app-tests` CI job runs the WHOLE `SliccFollowerUITests` bundle on
the GA cells and then subtracts this registry, so a newly added test
class is gated the day it lands rather than needing to be opted in. The
gate rejects a registry entry that has no reason, or one naming a
class/method that no longer exists in the bundle.

## ios-test-isolation-gate

`npm run lint:ios-test-isolation`
(`packages/dev-tools/tools/check-ios-test-isolation.mjs` + `-lib.mjs`)
guards the only suite in the repo that cannot buy isolation with
parallelism. Every vitest project gets a worker thread and a fresh module
registry per file, and the Swift/Go packages run their targets
concurrently; both `ios-app` bundles are pinned serial
(`-parallel-testing-enabled NO`) because cloning simulators races the
XCUITest runner's install and the clone that loses fails preflight with
`Busy` before a test runs.

Serial execution hides order dependence rather than exposing it, so
`ios-app` substitutes two properties the gate keeps honest:

- **Random execution order**, declared per test target in
  `packages/ios-app/project.yml`. The Xcode project is XcodeGen output
  and is not committed, so nothing else reads that declaration — dropping
  it would silently make the bundle order-dependent-friendly again. The
  gate hand-parses the scheme's test action (these gates stay
  dependency-free) and rejects a target that omits or disables it.
- **No test writes `UserDefaults.standard`.** A unit test runs inside the
  host app's process, which makes that the app's own persistent domain:
  shared by every test in the bundle _and_ written through to disk in the
  simulator container, so a value outlives both the test and the run.
  Tests take a per-test suite from `makeIsolatedDefaults`
  (`SliccFollowerTests/IsolatedTestDefaults.swift`) instead; reads of
  `.standard` are untouched, since that is where a UI test's launch
  arguments land.

The third leg is `ios-sim-prepare.sh`, sourced by both
`swift-coverage-check.sh` and `ios-sim-test.sh`: it boots the device,
blocks on `simctl bootstatus`, and uninstalls the app and the UI-test
runner so a run cannot inherit a killed run's container. Covered by
`ios-sim-prepare.test.mjs` (stub `xcrun`, no simulator) and
`check-ios-test-isolation.test.mjs`.

## swiftpm-lockfile-drift-gate

`packages/dev-tools/tools/check-swift-resolved-drift.mjs` runs AFTER a
resolve step (the `ios-app` CI job).
`xcodebuild -resolvePackageDependencies` rewrites `Package.resolved` in
place and then builds against what it wrote, so a floated **transitive**
pin lands with no diff; `lint:swift-pins` only inspects direct pins. The
gate compares identity/version/revision while ignoring `originHash` and
key order (both move with the toolchain), catching the transitive drift
`lint:swift-pins` cannot see.

## source-guards

Source-shape guards under `packages/dev-tools/tools/`, each wired to its
own lint script:

- `check-no-innerhtml.mjs` (`npm run lint:no-innerhtml`) bans
  `.innerHTML =`, `.outerHTML =`, and `insertAdjacentHTML()` in
  `@slicc/webcomponents` (stories/tests exempt).
- `check-no-ui-imports-in-providers.mjs`
  (`npm run lint:no-ui-in-providers`) bans `from '…ui/…'` imports in
  `providers/built-in/`.
- `check-hosted-origin-literal.mjs` — TS must import
  `SLICC_HOSTED_ORIGIN` from `@slicc/shared-ts` rather than hardcoding
  the origin.
- `check-no-raw-chrome-runtime-id.mjs` — use `isChromeExtensionRealm()`
  from `@slicc/shared-ts` instead of a raw `chrome.runtime.id` check
  (tests exempt).
- `check-agents-symlinks.mjs` — every `packages/*/CLAUDE.md` needs an
  `AGENTS.md` sibling symlink.

## first-load-size-gate

`packages/dev-tools/tools/check-first-load-size.mjs` (+
`first-load-size-lib.mjs`, `first-load-baseline.mjs`), part of
`npm run size -w @slicc/webapp`, measures the eager import closures of
the page entry (via `.vite/manifest.json`) and the kernel-worker entry
(parsed from emitted chunks). It guards cold-boot payload, not per-file
size.

It is **relative**: it builds the merge-base in a throwaway worktree
(workspace packages re-pointed at the worktree's own source, then the
root `postinstall` prerequisite builds — borrowing the caller's build
would mask a webcomponents-side regression) and fails on a change's own
growth past `maxDeltaKb`, so it never fires on inherited state and
cancels the ~1 kB Linux-vs-macOS build difference. Flags:
`--baseline=<ref>` (default `origin/main`), `--baseline=none` to skip,
`--json` to just measure.

**Dependency changes** are realigned before the baseline is measured. The
worktree borrows the caller's `node_modules` (npm workspaces hoist, so the
base build only needs them to resolve), which used to mean a version bump
built the NEW version on both sides and reported +0.0 kB for exactly the
change under test — `@imagemagick/magick-wasm` 0.0.42 -> 0.0.43 (PR #2744)
added 103 kB to the worker eager graph and the delta gate saw nothing, with
only ceiling headroom catching it. `dependencyDrift` now diffs the two
lockfiles and `realignDriftedDependencies` puts the base tree back via
`npm pack` (a symlinked `@scope` is split into per-child links first, so the
caller's real install is never written through). Aliases are fetched under
the lock entry's `name`, not its install directory — this repo has
`node_modules/undici8` for `undici`, and asking the registry for `undici8`
would fetch a different package.

The two corrections are not symmetric. A **version bump** is required: not
fixing it is the silently-wrong +0.0 kB, so a failed fetch aborts. A package
the change **removes** is best effort: HEAD's mirror has no copy, and if the
base source imports it the build fails on its own, so a failed fetch is not
fatal — aborting would newly fail PRs that merely drop an unused dependency.
Packages the change **adds** are ignored; the base never had them.

Drift it cannot realign — more than 25 changed packages, or a failed
`npm pack` of a required bump — makes the baseline unmeasurable rather
than quietly wrong, which a CI `pull_request` run fails. Un-hoisted nested
production copies (`node_modules/<pkg>/node_modules/<dep>`) are realigned
the same way as hoisted ones: `materializeLinkedParents` splits the parent
package symlink so the nested entry can be swapped without writing through
the caller's install (Dependabot PR #3200, `glob/node_modules/brace-expansion`
2.0.2 -> 2.1.7, is the specimen). Nested copies under a bumped or removed
parent are also realigned independently — `npm pack` of the parent does not
ship installed nested deps (`isomorphic-git` 1.41 → 1.42 nested `pako@1`, and
`@cantoo/pdf-lib` 2.9 → 2.11 dropping `@pdf-lib/upng` + nested `pako@1`, are
the specimens). Nested copies that
exist only in the dev tree (`dev: true`) and DefinitelyTyped `@types/*`
packages (declaration files; they cannot appear in `dist/ui`) are skipped
rather than refused — otherwise a types-only bump such as `@types/node`
24.13.3 → 24.13.4 (PR #3195) fails the gate while `npm pack` realigns a
package the eager graphs cannot see. Transitive dependencies of a realigned
package stay borrowed from HEAD: a deliberate approximation, since the
alternative is a full `npm ci` per gate run.

On `merge_group` the delta is skipped — a queue branch is cumulative, so
its delta is the batch sum and a per-change allowance would fail on
queue depth; only the ceilings run, with no baseline build. That split
is only safe because a CI `pull_request` run treats an unmeasurable
baseline as a hard failure rather than degrading, so a PR can never
clear both stages unmeasured. Local runs still degrade to ceilings with
a note. The absolute `*EagerCeilingKb` values in
`packages/webapp/first-load-budget.json` are the backstop against many
small under-threshold changes creeping upward — human-owned, not
numbers to nudge when a build goes red.

## agent-merch-grid

`packages/dev-tools/tools/agent-merch.mjs` (+ `agent-merch-lib.mjs`)
renders a hash-stable sparse grid of `<slicc-agent-avatar>` faces plus a
tagline, via Playwright, to transparent 300-dpi light/dark PNGs in
`dist/merch/`. Build `@slicc/webcomponents` first; `--help` lists the
knobs (`--seed`/`--grid`/`--rows`/…). `--rows` < `--grid` widens the
output (the square grid is locked at 1:1.595; DTG printing wants
1:1.333).

## release-gating

`packages/dev-tools/tools/release-plan.mjs` (Linux preflight) +
`release-native.mjs` gate macOS/iOS packaging, the `slicc` Go CLI
(`packages/slicc-cli/sign-and-package.sh`), the worker
publish, `@ai-ecoverse/biome-jsh`, and `@ai-ecoverse/cherry`.

`tools/merge-queue-busy.mjs` (+ `merge-queue-lib.mjs`) defers Release
while the default-branch merge queue has entries, so the queue never
waits on Release.

`tools/release-publish.mjs` wraps `npx semantic-release` and exits 0 when
the version-commit push is rejected because `main` moved during prepare
(`fetch first`); a later push or the schedule catch-up publishes. It also
exits 0 when `@semantic-release/github` success fails looking up a missing
issue after publish (v6.173.4: commit `c3bba29ca` wrote "pre-fix #141414"
for a CSS color; GraphQL `issue141414` is `NOT_FOUND`). `.releaserc.json`
sets `successCommentCondition` and `releasedLabels` to `false` so success
does not GraphQL-resolve `#NNNN` from commit messages. It writes
`deferred=true|false` to `$GITHUB_OUTPUT`. `tools/release-alert.mjs` opens
(or comments on) the "Release pipeline is red" tracking issue on a failed
publish, and closes it on a green non-deferred publish.

`tools/npm-publish-retry.mjs` runs `npm publish` for `sliccy` (first in the
`@semantic-release/exec` `publishCmd`), `@ai-ecoverse/biome-jsh`, and
`@ai-ecoverse/cherry`. It
retries transient DNS/socket, sigstore CA/TLog/TSA, and registry 408/429/5xx
failures with 15s–240s backoff (5-minute per-attempt kill, 60s registry
probes, 20-minute retry budget). After a transient failure or version
conflict it counts the version as published only when the registry
`dist.integrity` equals local `npm pack --dry-run` and, with `--provenance`,
a provenance attestation exists. `@semantic-release/npm` has `npmPublish: false` because its
single `npm publish` runs after the version tag is pushed: v6.231.1 was
stranded by `getaddrinfo ENOTFOUND fulcio.sigstore.dev` (#3719). `--verify`
(exec `verifyConditionsCmd`) fails early when the job lacks
`id-token: write`.

## gate-entry-guards

A script's "am I the entry point?" check must compare real paths on both sides: use `isMainModule(import.meta.url)` from `packages/dev-tools/tools/is-main-module.mjs` (or, outside dev-tools, `realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))`). Node resolves symlinks for `import.meta.url` but not for `process.argv[1]`, so `import.meta.url === pathToFileURL(argv[1]).href` is false through a symlinked checkout, and the script exits 0 without doing anything. `is-main-module.test.mjs` runs `coverage-gate.mjs` through a symlinked checkout and fails if any file in the repo uses the old comparison.

A gate's silence must never read as a pass. `require-verdict.mjs <label> -- <command>` fails unless the command printed `<label>: PASS …`. The `test:coverage:*` scripts wrap `coverage-gate.mjs` with it, and the CI steps wrap `verify-preview-lifecycle.mjs` with it. New gates should print a `<name>: PASS|FAIL …` line and run behind it.
