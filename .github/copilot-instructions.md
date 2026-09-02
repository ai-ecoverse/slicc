# SLICC — Copilot Code Review Instructions

Review SLICC's five runtimes (`webapp`, extension, Node, Swift, iOS) against these blind
spots. Flag only genuine risks. Catalog: `docs/review-patterns.md`.

## 1. Error-path coverage (often Critical)

External calls need bounded failure: timeouts, retry/backoff where appropriate, surfaced
errors. Flag unbounded `fetch()`, E2B calls, async work.

## 2. Cross-runtime parity (often Critical)

Shared behavior needs peer updates or explicit exclusion. Check Node ↔ Swift servers and
browser ↔ extension, especially endpoints, signing, mounts, VFS, secrets.

## 3. UI state preservation

DOM rebuilds (`innerHTML`, `replaceChildren`, reflow) must capture and restore live state.

## 4. CDP / Chrome edge cases

Foreground the page (`Page.bringToFront()` / wake the renderer) before screenshots or
capture. Validate the CDP target and port before trusting them; handle disconnects.

## 5. Native / macOS permissions

Native protected-resource access needs entitlements/usage descriptions, TCC checks,
graceful denial. A File Provider appex must embed and sign every `@rpath` framework it
links (host `Resources/` is invisible) and declare the network entitlements its transport uses.
No `keychain-access-groups` on the macOS File Provider: that restricted entitlement needs
an appex-specific Developer ID profile, else AMFI refuses launch (extensionKit error 2).

## 6. Model metadata / provider pipeline

When model IDs or provider metadata change, verify reasoning, input, cost, and
thinking levels forward through discovery, enrichment, account storage, API effort mapping.

## 7. Test coverage

New `src/` files need mirrored tests; changed logic needs updated tests; bug fixes a
regression test. Do not lower coverage floors.

## 8. Follower surface wiring parity (often Critical)

Leader broadcasts need follower handlers and UI actions. Check live, follower, and extension
boot paths; preserve shared fallbacks and prefer capability checks to float names.

## 9. Origin / bridge routing contract (often Major)

Thin-bridge UI and API origins differ. Flag same-origin `/api/` assumptions, hard-coded
origins, comparisons without slash normalization.

## 10. Layer import direction (Major)

Stack: `fs/base → shell/git → cdp → tools → core → scoops → ui`. Flag up-stack imports
(even types/helpers); move down, never grow the baseline. Registries: move wholesale,
never re-declare. Setter injection needs a registrar in every reading realm.
`isExtensionRealm` in `scoops/`/`tools/` belongs on `CapabilityBroker` (#2276).

## 11. Untyped string-keyed bags

Flag new `Record<string, unknown>` in source when the shape is known. Require a named type,
boundary validation, or a justified suppression; never grow the frozen baseline.
Cone and scoop are roles over one `WorkUnit` (#1666); the record carries no role
field — route on the unit's policy / `isRootUnit` / `getWorkUnits()`. `isCone` exists
only on the follower wire, write-only leader-side; flag any read of it in `scoops/` or
`kernel/` — the compiler cannot catch it.

## 12. Agent skill freshness

Capability, command, argument, or workflow changes must update the matching runtime and
developer `SKILL.md` files. Run skill-router and sync checks.

## 13. Transcript export — redaction boundary (Critical)

Require fail-closed redaction, `reasoningExcluded: true`, sudo-funnel approval
(`kind: 'export'`; only `NOPASSWD Export` skips it, follower-delegated when headless),
binary integrity, `transfer-corrupt` for unknown errors or SHA-256 mismatches.

## 14. `--help` that does the thing

A verb dispatcher checking only `args[0] === '--help'` sends `cmd <verb> --help` into the
handler; if it defaults a missing arg, help performs the action. Check help before
dispatch, scanning all args.

## Severity

🔴 Critical = likely production issue · 🟡 Major = scenario-specific · 🔵 Minor = quality.
Stay high-signal; prefer no comment to a speculative one.
