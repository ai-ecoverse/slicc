# Playwright realm shim: four new features

Date: 2026-07-14
Status: approved

## Context

`packages/webapp/src/kernel/realm/playwright-shim.ts` implements `require('playwright')` /
`import('playwright')` for scripts running in SLICC's JS realm, backed by the existing
`BrowserAPI`/CDP connection instead of a bundled Playwright/browser binary (PR #1496).
It is deliberately scoped to the ~15 methods real fixture scripts (stardust, AEM) call, and
documents an explicit "not supported" list in `docs/node-compat-shims.md`, including
`BrowserContext`, `connectOverCDP`/`connect`, and several `Page` methods.

A user hit four concrete gaps running existing scripts against the shim:

| API                                                     | Current state                                     |
| ------------------------------------------------------- | ------------------------------------------------- |
| `chromium.launch()`                                     | works                                             |
| `browser.newContext(...)`                               | `TypeError: browser.newContext is not a function` |
| `browser.newPage()`                                     | works                                             |
| `page.goto/evaluate/screenshot/setViewportSize/content` | work                                              |
| `chromium.connectOverCDP` / `chromium.connect`          | undefined                                         |
| `page.waitForTimeout`, `page.$$eval`                    | undefined                                         |

This spec closes those four gaps. It does not attempt full Playwright API parity (locators,
request interception, tracing, video, distinct browser engines remain out of scope — see
`docs/node-compat-shims.md`).

## Constraints from the existing architecture

- **Single real browser.** SLICC drives exactly one already-running Chrome instance via
  `BrowserAPI`. There is no `Target.createBrowserContext`/`disposeBrowserContext` usage and no
  concept of multiple isolated cookie jars — `chromium`/`firefox`/`webkit` are already aliases
  of the same launcher for this reason.
- **No new host RPC ops needed for three of the four features.** The realm already has real
  wall-clock timers (`js-realm-shared.ts`) and the existing `evalAsync` host op takes an
  arbitrary code string — `$$eval` and `waitForTimeout` need no changes to `realm-host.ts`.
- **Args-in-code-string convention.** `page.evaluate` serializes function bodies via
  `fn.toString()` and JSON-stringifies each arg into an IIFE call
  (`playwright-shim.ts:133-141`). New methods that evaluate script must follow this same
  convention rather than inventing a new arg-passing mechanism.

## Decisions (confirmed with user)

1. **`browser.newContext()` is grouping-only, not isolated.** It returns a context object that
   tracks its own set of pages (same shape as `PlaywrightBrowser` today) so `context.close()`
   tears down only its own tabs. It does **not** provide separate cookies/storage — all
   contexts and the top-level browser share the one real Chrome profile. This is documented as
   a known limitation with the same prominence as the firefox/webkit aliasing note.
2. **`connectOverCDP`/`connect` ignore their endpoint argument.** Since the realm is always
   already attached to SLICC's one real Chrome, there is nothing else to dial. Both return a
   fresh `PlaywrightBrowser`, identical in behavior to `launch()`. The endpoint parameter is
   accepted (for API-shape compatibility with real Playwright call sites) but unused.

## Design

### 1. `page.waitForTimeout(ms: number): Promise<void>`

Added to `PlaywrightPage`. Pure client-side delay, no RPC:

```ts
async waitForTimeout(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
```

### 2. `page.$$eval<R>(selector: string, fn: (elements: Element[], ...args) => R, ...args): Promise<R>`

Added to `PlaywrightPage`, mirroring `evaluate`'s args convention and `$$`'s selector-querying:

- Build an IIFE body: `Array.from(document.querySelectorAll(<selector>))` piped into
  `(<fn>)(els, ...args)`, with args JSON-stringified exactly like `evaluate` does.
- Dispatch through the existing `evalAsync` host op — no `realm-host.ts` change.
- String-form `fn` (raw code) is supported the same way `evaluate` supports it, for
  consistency, though `$$eval`'s primary use is a function.

### 3. `browser.newContext(options?): Promise<PlaywrightBrowserContext>`

New class `PlaywrightBrowserContext`, structurally identical to `PlaywrightBrowser`:

- Own `pageTargetIds: string[]` bookkeeping array.
- `newPage(options?)`, `pages()` (returns tracked `PlaywrightPage` wrappers — track pages, not
  just target ids, so `pages()` can return live objects), `close()` (closes all its own tabs).

`PlaywrightBrowser` changes:

- Tracks contexts it creates in a private array.
- `newContext(options?)` creates a `PlaywrightBrowserContext`, tracks it, returns it.
- `contexts()` returns the tracked list.
- `close()` now closes both its own directly-created pages AND every tracked context's pages,
  so no tabs leak when a script creates contexts but never explicitly closes them.

`options` (viewport, storageState, etc.) is accepted per the shim's existing
`[key: string]: unknown` open-options convention but not interpreted — no real per-context
behavior exists to apply it to, consistent with decision #1.

### 4. `connectOverCDP` / `connect`

- `chromium.connectOverCDP(endpoint: string, options?): Promise<PlaywrightBrowser>` — added
  only to `chromium` (matches real Playwright, where this is Chromium-specific).
- `<launcher>.connect(wsEndpoint: string, options?): Promise<PlaywrightBrowser>` — added to
  `chromium`, `firefox`, and `webkit` (matches real Playwright's generic `BrowserType.connect`).
- Both share `launch()`'s body verbatim (`return new PlaywrightBrowser(rpc)`), with a doc
  comment explaining the endpoint argument is accepted but ignored per decision #2.

### Interface changes

`PlaywrightShim`'s per-launcher type gains `connect`; `chromium`'s gains `connectOverCDP` too.
`createPlaywrightShim` wires all four the same way `launch` is wired today (thin closures over
`rpc`).

## Testing

- `packages/webapp/tests/kernel/realm/playwright-shim.test.ts` (unit, mocked RPC): new cases
  for `waitForTimeout` (fake timers or bounded real delay), `$$eval` (asserts the generated
  code string queries the selector and maps the function), `newContext`/`pages`/`close`
  (asserts context tab tracking and that `browser.close()` cleans up context tabs too),
  `connectOverCDP`/`connect` (asserts a working `PlaywrightBrowser` is returned regardless of
  endpoint value).
- `packages/webapp/tests/kernel/realm/playwright-shim-integration.test.ts`: one live-Chrome-fixture
  case per addition, e.g. a `$$eval` over a real list of DOM nodes, a `newContext` + two pages
  - context-only `close()` leaving the browser's other pages open, a `connectOverCDP` round trip
    driving a real navigation.

## Documentation

- `docs/node-compat-shims.md`: move `newContext`/`connectOverCDP`/`connect`/`waitForTimeout`/
  `$$eval` from "not supported" to "supported," with the isolation caveat kept prominent next
  to `newContext`.
- Update the `playwright-shim.ts` module doc comment's "~15 methods" description if it becomes
  materially stale.

## Out of scope

- Real per-context cookie/storage isolation (would require CDP `Target.createBrowserContext`
  plumbing that doesn't exist in `BrowserAPI` today).
- Actually dialing a different CDP endpoint for `connectOverCDP`/`connect` (SLICC has exactly
  one real browser).
- Locators, request interception, tracing, video, distinct firefox/webkit engines — unchanged
  from the existing "not supported" list.
