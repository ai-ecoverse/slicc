# SLICC — Copilot Code Review Instructions

SLICC is a browser-centric AI coding agent shipped across five runtimes — `webapp`
(browser), `chrome-extension`, `node-server`, `swift-server`, and `ios-app` — that share
behavior but not code. Review changed code against these recurring blind spots, highest
value first. Reason contextually: only flag a category when the surrounding code does not
already handle it. Full catalog: `docs/review-patterns.md`.

## 1. Error-path coverage (often Critical)

External calls need bounded failure. Flag `fetch()` to external hosts without
`AbortSignal.timeout(ms)`; e2b `Sandbox.create()` / `Sandbox.connect()` without
`requestTimeoutMs`; API calls with no retry/backoff; and `await`/promise chains with no
`.catch()` / `try`-`catch`. (A missing e2b timeout once caused production sandbox-start
failures.)

## 2. Cross-runtime parity (often Critical)

A change to a shared feature in one runtime usually needs its peers updated — or an explicit
note that a peer is intentionally excluded. Watch especially:

- `packages/node-server/` ↔ `packages/swift-server/` — HTTP endpoints, server-side signing,
  mount handling.
- browser ↔ extension — VFS, mount backends, secrets, agent integration.

The cloud / hosted-leader float reuses `node-server`; Cherry inherits browser behavior.

## 3. UI state preservation

Flag `innerHTML = …`, `replaceChildren()`, or reflow/navigation that rebuilds DOM holding
live UI state without first capturing and then restoring it (or persisting it to
`localStorage` / IndexedDB).

## 4. CDP / Chrome edge cases

Foreground the page (`Page.bringToFront()` / wake the renderer) before screenshots or visual
capture. Validate the CDP target and port before trusting them; handle disconnects gracefully.

## 5. Native / macOS permissions

In `swift-server` / `swift-launcher` / `ios-app`, keychain, camera, microphone, and
screen-recording access needs the matching entitlement or usage description plus a TCC check,
and must degrade gracefully when consent is denied.

## 6. Test coverage

New `src/` files need mirrored `tests/` files; changed logic needs updated tests; bug fixes
need a regression test. CI enforces per-package coverage floors — a drop below the floor fails
the build.

## Severity

🔴 Critical = likely production issue · 🟡 Major = bites in a specific scenario ·
🔵 Minor = quality / consistency. Stay high-signal; prefer no comment over a speculative one.
