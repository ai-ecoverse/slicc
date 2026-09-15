# SLICC — Copilot Code Review Instructions

Review five runtimes (`webapp`, extension, Node, Swift, iOS). Flag concrete risks.
Catalog: `docs/review-patterns.md`.

## 1. Error-path coverage

Bound external calls and surface errors. Cap preload copies globally; cancel queued work on failure and drain active copies. Test OPFS reloads/async fallbacks; reject live wipes.

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

Model ID/metadata changes: verify reasoning, input, cost, thinking through
discovery→enrichment→storage→API. OpenRouter (Free): all pricing dims zero;
stream refuses IDs not in the live free catalog.

## 7. Tests

Probe FS limits through real shells; custom commands must use them.

Require mirrored tests and floors. Check OPFS reload/retries, concurrent append, scoped identity, metadata errors, and ACL/sudo gates.

## 8. Follower surface wiring parity

Leader broadcasts need follower handlers and UI actions. Check live, follower, and extension
boot paths; preserve shared fallbacks; prefer capability checks to float names.

## 9. Origin / bridge routing contract

Thin-bridge UI and API origins differ. Flag same-origin `/api/` assumptions, hardcoded
origins, and comparisons without slash normalization. Also flag iframe/channel/relay
messages or UI activation paths that lose routing ownership. Capture owner at the opening
interaction, not later focus; test shell-open, rail-open, and attention promotion.

## 10. Layer import direction

Stack: `fs/base → shell/git → cdp → tools → core → scoops → ui`. Flag up-stack and
cross-package relative imports; move shared code down or to `@slicc/shared-ts`, never grow
baselines. chrome-extension/webcomponents (src+tests)→webapp is zero-tolerance except the
documented kernel-message type import. Runtime probes below `ui/` use `CapabilityBroker`.

## 11. Untyped string-keyed bags

Flag new `Record<string, unknown>` in source when the shape is known. Require a named type,
boundary validation, or a justified suppression; never grow the frozen baseline.
Cone and scoop are roles over one `WorkUnit` (#1666); the record carries no role
field — route on the unit's policy / `isRootUnit` / `getWorkUnits()`. `isCone` exists
only on the tray wire, write-only and stripped for peers at protocol v8+ (#2358);
flag any read of it — the compiler cannot catch it yet.

## 12. Agent skill freshness

Capability/command/argument/workflow changes must update matching runtime + developer
`SKILL.md` files. Run skill-router + sync checks.

## 13. Transcript export

Require fail-closed redaction, `reasoningExcluded: true`, sudo-funnel approval
(`kind: 'export'`; only `NOPASSWD Export` skips it, follower-delegated when headless),
binary integrity, `transfer-corrupt` for unknown errors or SHA-256 mismatches.

## 14. `--help` that does the thing

A verb dispatcher checking only `args[0] === '--help'` sends `cmd <verb> --help` into the
handler; if it defaults a missing arg, help performs the action. Check help before
dispatch, scanning all args.

## Severity

🔴 Critical = likely prod issue · 🟡 Major = scenario-specific · 🔵 Minor = quality.
