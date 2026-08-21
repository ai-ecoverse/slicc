# SLICC — Copilot Code Review Instructions

Review SLICC's five runtimes (`webapp`, extension, Node, Swift, iOS) against these blind
spots. Flag only genuine risks. Full catalog: `docs/review-patterns.md`.

## 1. Error-path coverage (often Critical)

External calls need bounded failure: timeouts, retry/backoff where appropriate, and surfaced
errors. Flag unbounded `fetch()`, E2B calls, and async work.

## 2. Cross-runtime parity (often Critical)

Shared behavior needs peer updates or an explicit exclusion. Check Node ↔ Swift servers and
browser ↔ extension, especially endpoints, signing, mounts, VFS, and secrets.

## 3. UI state preservation

DOM rebuilds (`innerHTML`, `replaceChildren`, reflow) must capture and restore live state.

## 4. CDP / Chrome edge cases

Foreground the page (`Page.bringToFront()` / wake the renderer) before screenshots or visual
capture. Validate the CDP target and port before trusting them; handle disconnects gracefully.

## 5. Native / macOS permissions

Native protected-resource access needs entitlements/usage descriptions, TCC checks, and
graceful denial.

## 6. Model metadata / provider pipeline

When model IDs or provider metadata change, verify forwarding of reasoning, input, cost, and
thinking levels through discovery, enrichment, account storage, and API effort mapping.

## 7. Test coverage

New `src/` files need mirrored tests; changed logic needs updated tests; bug fixes need a
regression test. Do not lower coverage floors.

## 8. Follower surface wiring parity (often Critical)

Leader broadcasts need follower handlers and UI actions. Check live, follower, and extension
boot paths; preserve shared fallbacks and prefer capability checks over float names.

## 9. Origin / bridge routing contract (often Major)

Thin-bridge UI and API origins differ. Flag same-origin `/api/` assumptions, hard-coded
origins, and comparisons without slash normalization.

## 10. Layer import direction (Major)

Stack: `fs → shell/git → cdp → tools → core → scoops → ui`. Flag imports up the stack,
even types or pure helpers; move helpers down. Never grow the back-edge baseline.

## 11. Untyped string-keyed bags

Flag new `Record<string, unknown>` in source when the shape is known. Require a named type,
boundary validation, or a justified Biome suppression; never grow the frozen baseline.
Same for `scoop.isCone` reads outside `ui/`: cone and scoop are roles over one `WorkUnit`
(#1666) — route on the unit's policy / `isRootUnit` / `getWorkUnits()`, never grow
`iscone-baseline.json`.

## 12. Agent skill freshness

Capability, command, argument, or workflow changes must update the matching runtime and
developer `SKILL.md` files. Run the skill-router and any specialized sync check.

## 13. Transcript export — redaction boundary (Critical)

Require fail-closed redaction, `reasoningExcluded: true`, approval through the sudo funnel
(`kind: 'export'`; only `NOPASSWD Export` skips it, delegated to a follower when headless), binary
integrity, and `transfer-corrupt` for unknown errors or SHA-256 mismatches.

## 14. `--help` that does the thing

A verb dispatcher that checks only `args[0] === '--help'` sends `cmd <verb> --help` into the
handler; if that handler defaults a missing arg, help performs the action. Require the help
check before dispatch, scanning all args.

## Severity

🔴 Critical = likely production issue · 🟡 Major = scenario-specific · 🔵 Minor = quality.
Stay high-signal; prefer no comment over a speculative one.
