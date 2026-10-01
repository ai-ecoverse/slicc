# SLICC — Code Review

Review `webapp`, extension, Node, Swift, and iOS. Details: `docs/review-patterns.md`.

## 1. Error-path coverage

Bound external calls and surface errors. Drain failed preload copies. Test OPFS reloads; reject live wipes.

## 2. Cross-runtime parity

Check Node ↔ Swift endpoints/signing and browser ↔ extension mounts/VFS/secrets.
FS adapters must honor encodings; test Unicode and binary pipelines without byte guessing.

## 3. UI state preservation

Preserve state across DOM rebuilds. Sprinkle activation places its parked container; serialize
open/reload per sprinkle so watcher and command renders cannot overlap.

## 4. CDP / Chrome edge cases

Foreground the page (`Page.bringToFront()` / wake renderer) before screenshots or capture.
Validate CDP target + port before trusting them; handle disconnects.

## 5. Native / macOS permissions

Protected access needs entitlements/usage descriptions, TCC checks, and graceful denial.
File Provider appexes must embed+sign every `@rpath` framework and declare network
entitlements. Avoid `keychain-access-groups` without an appex-specific Developer ID profile.

## 6. Model metadata / provider pipeline

Pi 0.99 stores tools in system messages. Reload, compact, clear-chat:
preserve prompt and tools. Never summarize system messages.

Model ID/metadata changes: verify reasoning, input, cost, thinking through
discovery→enrichment→storage→API. OpenRouter (Free): all pricing dims zero;
stream refuses IDs not in the live free catalog.
Ordinary scoops freeze model at creation; Gelatiere alone follows
`modelFor(leadingRootOf(roster))` on boot/run/leader changes, never global selection.

## 7. Tests

Probe FS limits through real shells; custom commands must use them.

Require mirrored tests and floors. Check OPFS retries, concurrent append, scoped identity, metadata errors, and ACL/sudo gates.

## 8. Follower surface wiring parity

Leader broadcasts need follower handlers and UI actions. Check live, follower, and extension
boot paths; preserve shared fallbacks; prefer capability checks to float names.

## 9. Origin / bridge routing contract

Thin-bridge UI/API origins differ. Flag same-origin `/api/`, hardcoded origins, and
unnormalized comparisons. Iframe/channel/relay messages and UI activation must retain
the owner captured at opening, not later focus.

## 10. Layer import direction

CI-gated (`lint:layer-back-edges`; never grow baselines): webapp `fs/base → shell/git → cdp → tools → core → scoops → ui` + other TS apps. Flag up-stack, scoops/fs/base→kernel values, and cross-package imports. chrome-extension/webcomponents→webapp is zero-tolerance bar kernel-message types. Swift: SPM + `public`; widgets must not import WebRTC. Probes below `ui/` use `CapabilityBroker`.

## 11. Untyped string-keyed bags

Flag new `Record<string, unknown>` in source. Require a named type,
boundary validation, or a justified suppression; never grow the frozen baseline.
Cone/scoop are roles over one `WorkUnit`; records have no role field. Route on policy /
`isRootUnit` / `getWorkUnits()`. Tray role = `ScoopSummary.parentId` (#2358); `.isCone` is a type error.

## 12. Agent skill freshness

Capability/command/argument/workflow changes must update matching runtime + developer
`SKILL.md` files. Run skill-router + sync checks.

## 13. Transcript export

Require fail-closed redaction, `reasoningExcluded: true`, sudo approval
(`kind: 'export'`; only `NOPASSWD Export` skips it),
binary integrity, `transfer-corrupt` for unknown errors or SHA-256 mismatches.
Bench recovery must abort at timeout/cost cap and confirm flat spend before scoring.

## 14. `--help` that does the thing

A verb dispatcher checking only `args[0] === '--help'` sends `cmd <verb> --help` into the
handler; if it defaults a missing arg, help performs the action. Check help before
dispatch, scanning all args.

## Severity

🔴 Critical = likely prod issue · 🟡 Major = scenario-specific · 🔵 Minor = quality.
