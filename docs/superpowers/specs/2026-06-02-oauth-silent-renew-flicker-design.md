# Design: Silent Adobe OAuth renewal (kill the handoff "flicker")

**Date:** 2026-06-02
**Status:** Approved — spike validated, ready for implementation plan
**Branch:** `spike/oauth-silent-renew`

## Problem

With the extension installed, visiting a handoff-advertising site (e.g.
`admin.aem.live`) fires a `navigate` lick. That lick is delivered to the cone
as a real turn (`host.ts:defaultLickEventHandler` → `orchestrator.handleMessage`),
which streams to the LLM. When the user is signed into the Adobe provider but
the cached access token has expired, the stream's `getValidAccessToken()`
triggers `silentRenewToken()`. Users report this as a page "flicker" — it is
actually the Adobe IMS OAuth window (`adobeid-na1.services.adobe.com/ims/authorize`)
appearing briefly on essentially every navigation.

### Root cause

The OAuth transport had no concept of "silent." `silentRenewToken()` builds an
authorize URL with `prompt=none` (the IMS-level "no UI" signal) and hands it to
the shared launcher, but the extension service worker called
`chrome.identity.launchWebAuthFlow({ url, interactive: true })` with `interactive`
**hardcoded** (`service-worker.ts`). The `OAuthRequestMsg` and `OAuthLauncher`
types carried no flag, so the `prompt=none` intent never reached Chrome.
`interactive: true` makes Chrome display the auth window whenever a page load
completes — which is exactly what IMS does mid-flow — so even a renewal that
_would_ succeed flashed a window.

Two compounding weaknesses:

1. **Interactive-only transport** → the window is shown for silent renewals.
2. **No failure backoff** → `renewalInProgress` only dedupes _concurrent_ calls.
   When the IMS SSO session is also dead, every navigate-lick turn re-attempts
   renewal, and pi-agent-core retries each failed stream 3×, so a single dead
   session produces a storm of failing IMS round-trips (observed: 6×
   `login_required` in a few seconds across two messages).

## Spike findings (empirical, validated 2026-06-02)

A spike threaded an `interactive` flag through the transport and added an
on-demand trigger (`oauth-token --renew`, `--expire`). Testing against real IMS
in the extension established:

- `launchWebAuthFlow({ interactive: false })` **alone fails** for IMS with
  `"User interaction required. Try setting abortOnLoadForNonInteractive and
timeoutMsForNonInteractive … if code is used for redirects in the
authorization page after it's loaded."` — i.e. IMS's `prompt=none` page loads
  and then performs a **JS-driven redirect**; the default non-interactive mode
  aborts the instant that page loads, before the redirect fires.
- `launchWebAuthFlow({ interactive: false, abortOnLoadForNonInteractive: false,
timeoutMsForNonInteractive: 10000 })` **works**: the hidden web view follows
  the JS redirect to the `chromiumapp.org` URL and returns a fresh token, with
  **no window**. (Chrome 113+; confirmed in the running browser.)
- End-to-end in the real message flow: live SSO → `[adobe] Token renewed
silently` (no window); dead SSO → `[oauth-service] Extension OAuth error:
login_required` surfaced as a clean in-chat error (no window). The
  hidden-iframe fallback considered earlier is **not needed**.

## Goals

- Eliminate the OAuth window for silent (`prompt=none`) renewals in the
  extension.
- Stop the failing-renewal storm when the IMS SSO session is genuinely dead.
- Keep explicit, user-initiated logins interactive (unchanged).

## Non-goals (follow-ups)

- **CLI-mode silent renewal.** In CLI mode `silentRenewToken` runs in the page
  and uses `launchOAuthCli` (`window.open` popup), which has the analogous
  latent popup. Out of scope for this (extension-reported) fix.
- **User-facing re-login affordance.** A dead session currently surfaces as
  `"Adobe session expired — please log in again"` in chat. A clickable
  re-login affordance is a possible future improvement, not part of this fix.

## Design

### 1. Silent transport (generic; implemented in spike — productionize on merge)

Thread an optional `interactive` flag from the provider through to
`launchWebAuthFlow`. Benefits any provider whose `onSilentRenew` routes through
the launcher, not just Adobe.

- `OAuthRequestMsg` (`chrome-extension/src/messages.ts`): add `interactive?: boolean`.
- `OAuthLauncher` (`webapp/src/providers/types.ts`): signature becomes
  `(authorizeUrl, opts?: { interactive?: boolean }) => Promise<string | null>`.
  CLI/worker launchers may ignore `opts`.
- `launchOAuthExtension` (`webapp/src/providers/oauth-service.ts`): forward
  `interactive` into the `oauth-request` message (`?? true`).
- Service worker (`chrome-extension/src/service-worker.ts`): for the silent
  case run
  ```ts
  { url, interactive: false,
    abortOnLoadForNonInteractive: false,
    timeoutMsForNonInteractive: SILENT_RENEW_TIMEOUT_MS /* 10_000 */ }
  ```
  Interactive logins keep `{ url, interactive: true }`. Extend the local
  `chrome.identity.launchWebAuthFlow` typing in `chrome.d.ts` to include the two
  optional non-interactive fields.
- `silentRenewToken` (`webapp/providers/adobe.ts`): call the launcher with
  `{ interactive: false }`.

The existing service-worker dispatch already `.catch`es a rejected flow and
sends an `oauth-result` error, so a non-interactive failure returns promptly
(no 120 s hang).

### 2. Failure backoff (uniform cooldown; Adobe provider)

Add a uniform cooldown in `adobe.ts`. Module-level state alongside
`renewalInProgress`:

```ts
const SILENT_RENEW_FAILURE_COOLDOWN_MS = 5 * 60_000; // 5 minutes
let silentRenewCooldownUntil = 0;
```

Gate **only the renewal path** inside `getValidAccessToken()` — a still-valid
token always returns directly and never consults the cooldown:

```
account missing            → throw "Not logged in to Adobe…"
token valid (>60s buffer)  → return it
cooldown active            → throw "Adobe session expired — please log in again"  (no IMS call)
otherwise                  → silentRenewToken()
                               success → silentRenewCooldownUntil = 0; return token
                               failure → silentRenewCooldownUntil = now + COOLDOWN; throw
```

Properties:

- Within one turn, pi-agent-core's 3 retries collapse to **one** IMS round-trip
  (attempt 1 sets the cooldown; attempts 2–3 short-circuit).
- Repeat navigations during the cooldown short-circuit entirely.
- After the cooldown elapses the next expired-token call re-probes once — now
  flicker-free — so it auto-recovers if the user re-authenticated elsewhere
  (e.g. signed back into Adobe in another tab, reviving the SSO cookie).
- A successful explicit re-login produces a valid token, so the renewal path
  (and the cooldown) is bypassed entirely.

The cooldown lives in `getValidAccessToken` (the streaming hot path where the
storm originates), **not** inside `silentRenewToken`, so the `oauth-token
--renew` diagnostic and page-load `oauth-bootstrap` can still force an attempt.

**Why 5 minutes:** long enough to stop per-navigation IMS round-trips on a dead
session, short enough that recovery after the user re-authenticates elsewhere
feels prompt. Not derived from token lifetime (24 h) or IMS session length —
purely a "stop hammering, re-probe occasionally" interval. Easy to tune; we can
adjust if it draws complaints.

### 2b. Fail fast on a dead session (scoop retry alignment)

`getValidAccessToken`'s `"Adobe session expired — please log in again"` is not
matched by `scoop-context.ts:isNonRetryableError`, so a dead-SSO turn currently
retries the full prompt 3× (`MAX_RETRIES`). The cooldown makes attempts 2–3
cheap (no IMS call) but the user still sees `failed after 3 attempts`. Add a
session-expiry pattern (e.g. `/session expired|log in again|re-?authenticate/i`)
to `isNonRetryableError` so the turn fails on the **first** attempt with one
clean error. Generic and correct for any provider — a session that needs
re-auth will not succeed by retrying the same prompt.

### Accepted limitations

- **`oauth-bootstrap` not cooldown-gated.** On each panel load an expired Adobe
  token triggers one `onSilentRenew()`; on a dead SSO that's one (silent,
  windowless) IMS attempt per reload. Rare, no storm — left ungated so bootstrap
  keeps its pre-renew role.
- **Overlapping navigate-lick turns.** Two turns can each attempt once before the
  first failure sets the cooldown (`renewalInProgress` dedupes concurrent
  `silentRenewToken`, not two separate turns). Rare; accepted.
- **Chrome version.** The manifest pins no `minimum_chrome_version`. The
  non-interactive options are Chrome 113+; on older Chrome they are ignored, so
  silent renewal simply fails (windowless) rather than crashing — graceful
  degradation, no flicker.

### 3. Diagnostic command: `oauth-token --renew [<id>]`

Keep `oauth-token --renew` as a documented diagnostic: it calls the provider's
`onSilentRenew()` on demand (bypassing the expiry gate) and reports success +
new expiry. It is silent (`interactive:false`) and useful for verifying
renewal without waiting for natural expiry.

### Spike artifacts to remove before merge

- `oauth-token --expire` (test-only token-backdating helper).
- `oauth-token --renew --interactive` A/B flag.
- The `onSilentRenew(opts?: { interactive })` parameter — only the A/B flag used
  it. `onSilentRenew` reverts to `() => Promise<string | null>`;
  `silentRenewToken` keeps `interactive:false` internally.

(The `interactive` flag on `OAuthRequestMsg` / `OAuthLauncher` / the SW handler
**stays** — it is the core transport fix.)

## Error handling

- Non-interactive failure (`login_required`, timeout, etc.) → launcher resolves
  `null` → `silentRenewToken` returns `null` → `getValidAccessToken` sets the
  cooldown and throws the user-facing "session expired" message, surfaced in
  chat by the normal scoop-error path. No window.
- `timeoutMsForNonInteractive` (10 s) bounds a stuck flow so renewal fails fast
  rather than hanging.

## Testing

**Unit (Vitest):**

- Service worker: extract a pure `buildWebAuthFlowOptions(url, interactive)`
  helper so the option selection is unit-testable without mocking
  `chrome.identity` — assert silent (`interactive:false`) yields
  `abortOnLoadForNonInteractive:false` + `timeoutMsForNonInteractive`, and
  interactive yields `{ url, interactive:true }` only.
- `launchOAuthExtension` forwards `interactive` into the `oauth-request` payload
  (default `true` when omitted).
- `adobe.ts` backoff state machine: valid token bypasses cooldown; first
  failure sets cooldown; second call within cooldown throws without invoking
  `silentRenewToken`; success clears the cooldown; cooldown expiry re-probes.
- `isNonRetryableError` matches the session-expiry message (and the existing
  patterns still pass).
- `oauth-token --renew` happy/err paths (existing test file extended).

**Manual QA (validated; keep as the regression recipe):**

1. Build extension **without** `SLICC_EXT_DEV` (production manifest key →
   stable extension id → IMS `chromiumapp.org` callback resolves).
2. Sign into Adobe (live SSO). Expire the cached token in the agent context
   (during development, via the spike `--expire`; post-merge, by waiting or a
   test hook). Send a message → renews silently, no window.
3. Sign out of Adobe / clear `*.adobelogin.com` cookies. Trigger renewal → no
   window; clean `Adobe session expired — please log in again` in chat; offscreen
   log shows a single `login_required` per turn (not 3) once backoff lands.

## Documentation

- `docs/shell-reference.md` — document `oauth-token --renew`.
- `docs/oauth-intercept.md` — the authoritative "provider OAuth intercept and
  silent renewal" page (per `docs/CLAUDE.md`). Record the silent-renewal
  transport requirements and **why**: IMS's `prompt=none` page uses a JS
  redirect, so `launchWebAuthFlow` needs `interactive:false` +
  `abortOnLoadForNonInteractive:false` + `timeoutMsForNonInteractive`
  (Chrome 113+); plus the Adobe renewal cooldown and the `isNonRetryableError`
  alignment.
- `docs/pitfalls.md` and/or `packages/webapp/CLAUDE.md` (OAuth flow section) —
  a short cross-reference / institutional-memory note pointing at the above
  "do not regress this triple" rule.

## Verification

Standard gates: `npm run lint`, `npm run typecheck`, `npm run test`,
`npm run test:coverage`, `npm run build`, `npm run build -w @slicc/chrome-extension`.
