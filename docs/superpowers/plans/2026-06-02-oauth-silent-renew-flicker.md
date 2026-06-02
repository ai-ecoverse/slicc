# Silent Adobe OAuth Renewal (kill the handoff flicker) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Adobe IMS silent token renewal in the Chrome extension truly windowless, and stop the failing-renewal storm when the IMS SSO session is dead.

**Architecture:** Thread an `interactive` flag through the OAuth transport so the service worker can run `chrome.identity.launchWebAuthFlow` non-interactively for `prompt=none` renewals (with `abortOnLoadForNonInteractive:false` + a timeout, because IMS's authorize page JS-redirects after load). Add a per-process failure cooldown in the Adobe provider's `getValidAccessToken`, and classify the "session expired" error as non-retryable so a dead session fails fast with one clean error.

**Tech Stack:** TypeScript, Vitest, Chrome MV3 (`chrome.identity`), pi-ai/pi-agent-core, Biome + Prettier.

**Spec:** `docs/superpowers/specs/2026-06-02-oauth-silent-renew-flicker-design.md`

---

## Current branch state (read before starting)

Work continues on branch `spike/oauth-silent-renew`. The **silent transport** is
already implemented and validated against real IMS:

- `OAuthRequestMsg.interactive?: boolean` (`packages/chrome-extension/src/messages.ts`)
- `OAuthLauncher` accepts `opts?: { interactive?: boolean }` (`packages/webapp/src/providers/types.ts`)
- `launchOAuthExtension` forwards `interactive` into the message (`packages/webapp/src/providers/oauth-service.ts`)
- Service worker `handleOAuthRequest` uses `interactive: msg.interactive ?? true` and the
  non-interactive options (`packages/chrome-extension/src/service-worker.ts`)
- `chrome.d.ts` typing extended for the two non-interactive fields

These stay. The plan **removes** the spike-only test scaffolding, then **adds**
the backoff, the retry-classification tweak, extracted-for-testing helpers,
tests, and docs.

The working tree is currently uncommitted. Task 1 produces the first commit.

---

## File map

| File                                                                            | Responsibility                                                                                | Action |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------ |
| `packages/webapp/src/providers/types.ts`                                        | revert `onSilentRenew` to no-arg                                                              | Modify |
| `packages/webapp/providers/adobe.ts`                                            | revert `silentRenewToken`/`onSilentRenew` signatures; wire backoff into `getValidAccessToken` | Modify |
| `packages/webapp/src/shell/supplemental-commands/oauth-token-command.ts`        | drop `--expire`/`--interactive`; keep `--renew`                                               | Modify |
| `packages/chrome-extension/src/oauth-flow-options.ts`                           | pure `buildWebAuthFlowOptions` + `SILENT_RENEW_TIMEOUT_MS`                                    | Create |
| `packages/chrome-extension/src/service-worker.ts`                               | use `buildWebAuthFlowOptions`                                                                 | Modify |
| `packages/chrome-extension/tests/oauth-flow-options.test.ts`                    | unit tests for the option builder                                                             | Create |
| `packages/webapp/src/providers/silent-renew-backoff.ts`                         | pure cooldown unit                                                                            | Create |
| `packages/webapp/tests/providers/silent-renew-backoff.test.ts`                  | unit tests for the cooldown                                                                   | Create |
| `packages/webapp/src/scoops/scoop-context.ts`                                   | add session-expiry to `isNonRetryableError`                                                   | Modify |
| `packages/webapp/tests/scoops/scoop-context.test.ts`                            | test the new non-retryable case                                                               | Modify |
| `packages/webapp/tests/shell/supplemental-commands/oauth-token-command.test.ts` | `--renew` coverage                                                                            | Modify |
| `docs/shell-reference.md`, `docs/oauth-intercept.md`, `docs/pitfalls.md`        | docs                                                                                          | Modify |

---

## Task 1: Strip spike-only artifacts (clean transport baseline)

Removes the test scaffolding so only the real transport fix remains. No new
behavior; existing tests must still pass.

**Files:**

- Modify: `packages/webapp/src/providers/types.ts`
- Modify: `packages/webapp/providers/adobe.ts`
- Modify: `packages/webapp/src/shell/supplemental-commands/oauth-token-command.ts`

- [ ] **Step 1: Revert `onSilentRenew` type to no-arg**

In `packages/webapp/src/providers/types.ts`, replace the `onSilentRenew` block
(the version with the `opts?: { interactive }` parameter and its added doc
paragraph) with:

```ts
  /**
   * Optional: refresh an expired/expiring token silently from page context.
   * Called by oauth-bootstrap at page load so the kernel-worker can stream
   * with a fresh token without needing window access. Returns the new token
   * (also persists it via saveOAuthAccount) or null if renewal is impossible
   * (e.g. user must re-authenticate).
   */
  onSilentRenew?: () => Promise<string | null>;
```

- [ ] **Step 2: Revert Adobe `silentRenewToken` / `onSilentRenew` to silent-only**

In `packages/webapp/providers/adobe.ts`:

Replace the signature + interactive-capture block:

```ts
async function silentRenewToken(opts?: { interactive?: boolean }): Promise<string | null> {
```

…and the comment block introducing `const interactive = opts?.interactive ?? false;`
with the no-arg form:

```ts
async function silentRenewToken(): Promise<string | null> {
```

Remove the `const interactive = opts?.interactive ?? false;` line and its
preceding comment paragraph.

Change the launcher call from:

```ts
const redirectUrl = await launcher(authorizeUrl, { interactive });
```

to:

```ts
// prompt=none needs no user interaction → drive the launcher silently.
// In the extension this maps to launchWebAuthFlow({ interactive: false }).
const redirectUrl = await launcher(authorizeUrl, { interactive: false });
```

Change `onSilentRenew` from:

```ts
  onSilentRenew: async (opts) => {
    const account = getAdobeAccount();
    if (!account?.accessToken) return null;
    return silentRenewToken(opts);
  },
```

to:

```ts
  onSilentRenew: async () => {
    const account = getAdobeAccount();
    if (!account?.accessToken) return null;
    return silentRenewToken();
  },
```

- [ ] **Step 3: Drop `--expire` and `--interactive` from `oauth-token`**

In `packages/webapp/src/shell/supplemental-commands/oauth-token-command.ts`:

1. Remove the `--expire` dispatch block:

```ts
// ── Silent-renewal spike: --expire [provider] ──
// … comment …
if (args.includes('--expire')) {
  return runExpireToken(args);
}
```

2. Remove the entire `runExpireToken(...)` function.

3. In `runSilentRenew`, remove the A/B flag. Replace:

```ts
const interactive = args.includes('--interactive');

// First non-flag arg is the provider id; fall back to the selected
```

with:

```ts
// First non-flag arg is the provider id; fall back to the selected
```

Replace the header push:

```ts
const lines: string[] = [`oauth-token --renew ${providerId} (interactive=${interactive})`];
```

with:

```ts
const lines: string[] = [`oauth-token --renew ${providerId}`];
```

Replace the call:

```ts
result = await config.onSilentRenew({ interactive });
```

with:

```ts
result = await config.onSilentRenew();
```

4. In `helpText()`, remove the `--expire` line and trim `--renew`'s
   `--interactive` mention so it reads:

```ts
  oauth-token --renew [<id>]      Force a silent token renewal now (onSilentRenew),
                                  bypassing the expiry gate. Reports success and
                                  the new expiry.
```

5. De-spike the `runSilentRenew` doc comment and the `--renew` dispatch
   comment (they still say "spike" / mention `--interactive` A/B). Replace the
   `runSilentRenew` JSDoc with:

```ts
/**
 * Force a silent token renewal now via the provider's `onSilentRenew()` hook,
 * bypassing the expiry gate. Reports whether a fresh token came back and the
 * new expiry — useful for verifying renewal without waiting for natural expiry.
 */
```

and the dispatch comment above `if (args.includes('--renew'))` with:

```ts
// Force a silent renewal now via onSilentRenew(), bypassing the expiry gate.
```

- [ ] **Step 4: Lint, typecheck, run the affected tests**

```bash
node_modules/.bin/biome check --write \
  packages/webapp/src/providers/types.ts \
  packages/webapp/providers/adobe.ts \
  packages/webapp/src/shell/supplemental-commands/oauth-token-command.ts
npm run typecheck
npx vitest run packages/webapp/tests/shell/supplemental-commands/oauth-token-command.test.ts packages/webapp/tests/providers/oauth-config.test.ts
```

Expected: typecheck clean; tests PASS (22+).

- [ ] **Step 5: Commit**

This commit intentionally bundles the chrome-extension transport files
(`messages.ts`, `service-worker.ts`, `chrome.d.ts`, `oauth-service.ts`) that
are **already modified in the working tree** from the validated spike, together
with the Step 1–3 spike-removal edits — it is the "transport baseline" commit.
Do **not** stage `package-lock.json` (see executor notes).

```bash
git add packages/webapp/src/providers/types.ts \
  packages/webapp/providers/adobe.ts \
  packages/webapp/src/shell/supplemental-commands/oauth-token-command.ts \
  packages/chrome-extension/src/messages.ts \
  packages/chrome-extension/src/service-worker.ts \
  packages/chrome-extension/src/chrome.d.ts \
  packages/webapp/src/providers/oauth-service.ts \
  docs/superpowers/specs/2026-06-02-oauth-silent-renew-flicker-design.md \
  docs/superpowers/plans/2026-06-02-oauth-silent-renew-flicker.md
git commit -m "$(cat <<'EOF'
feat(extension): silent OAuth renewal transport + drop spike scaffolding

Thread an `interactive` flag through OAuthRequestMsg / OAuthLauncher /
launchOAuthExtension to the service worker. Silent (prompt=none) renewals run
launchWebAuthFlow non-interactively (interactive:false +
abortOnLoadForNonInteractive:false + timeoutMsForNonInteractive) so IMS's
JS-redirecting authorize page completes without a visible window. Keep the
`oauth-token --renew` diagnostic; drop the spike-only --expire/--interactive.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Extract `buildWebAuthFlowOptions` (testable) and use it in the SW

**Files:**

- Create: `packages/chrome-extension/src/oauth-flow-options.ts`
- Modify: `packages/chrome-extension/src/service-worker.ts`
- Test: `packages/chrome-extension/tests/oauth-flow-options.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/chrome-extension/tests/oauth-flow-options.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { SILENT_RENEW_TIMEOUT_MS, buildWebAuthFlowOptions } from '../src/oauth-flow-options.js';

describe('buildWebAuthFlowOptions', () => {
  it('interactive flow → only url + interactive:true', () => {
    expect(buildWebAuthFlowOptions('https://idp/authorize', true)).toEqual({
      url: 'https://idp/authorize',
      interactive: true,
    });
  });

  it('silent flow → non-interactive options that survive IMS JS redirect', () => {
    expect(buildWebAuthFlowOptions('https://idp/authorize', false)).toEqual({
      url: 'https://idp/authorize',
      interactive: false,
      abortOnLoadForNonInteractive: false,
      timeoutMsForNonInteractive: SILENT_RENEW_TIMEOUT_MS,
    });
  });

  it('SILENT_RENEW_TIMEOUT_MS is a positive, bounded budget', () => {
    expect(SILENT_RENEW_TIMEOUT_MS).toBeGreaterThan(0);
    expect(SILENT_RENEW_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run -r packages/chrome-extension packages/chrome-extension/tests/oauth-flow-options.test.ts
```

Expected: FAIL — cannot resolve `../src/oauth-flow-options.js`.

- [ ] **Step 3: Create the module**

Create `packages/chrome-extension/src/oauth-flow-options.ts`:

```ts
/**
 * Builds the options object for `chrome.identity.launchWebAuthFlow`.
 *
 * Silent renewals (prompt=none) must NOT show a window. Plain
 * `interactive:false` is insufficient for Adobe IMS: its authorize page loads
 * and then performs a JS-driven redirect, and the default non-interactive mode
 * aborts the moment that page loads ("User interaction required"). Setting
 * `abortOnLoadForNonInteractive:false` keeps the hidden web view alive across
 * the follow-up navigations until it reaches the redirect URL;
 * `timeoutMsForNonInteractive` bounds a stuck flow. (Chrome 113+.)
 */
export const SILENT_RENEW_TIMEOUT_MS = 10_000;

export function buildWebAuthFlowOptions(url: string, interactive: boolean) {
  if (interactive) {
    return { url, interactive: true as const };
  }
  return {
    url,
    interactive: false as const,
    abortOnLoadForNonInteractive: false,
    timeoutMsForNonInteractive: SILENT_RENEW_TIMEOUT_MS,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run -r packages/chrome-extension packages/chrome-extension/tests/oauth-flow-options.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Use the helper in the service worker**

In `packages/chrome-extension/src/service-worker.ts`:

Remove the local `SILENT_RENEW_TIMEOUT_MS` constant and the inline ternary in
`handleOAuthRequest`. Add the import near the other imports:

```ts
import { buildWebAuthFlowOptions } from './oauth-flow-options.js';
```

Replace the `handleOAuthRequest` flow-options block:

```ts
const interactive = msg.interactive ?? true;
const redirectUrl = await chrome.identity.launchWebAuthFlow(
  interactive
    ? { url: msg.authorizeUrl, interactive: true }
    : {
        url: msg.authorizeUrl,
        interactive: false,
        abortOnLoadForNonInteractive: false,
        timeoutMsForNonInteractive: SILENT_RENEW_TIMEOUT_MS,
      }
);
```

with:

```ts
const redirectUrl = await chrome.identity.launchWebAuthFlow(
  buildWebAuthFlowOptions(msg.authorizeUrl, msg.interactive ?? true)
);
```

- [ ] **Step 6: Add a test that `launchOAuthExtension` forwards `interactive`**

The spec's testing section requires this and the SW relies on it. In
`packages/webapp/tests/providers/oauth-service.test.ts`, inside the existing
`describe('createOAuthLauncher — runtime gating regression', …)` block (it
already sets up a `chrome.runtime` mock with `sendMessage`/`onMessage` and has
an `afterEach` that deletes `globalThis.chrome` + resets modules), add:

```ts
it('extension launcher forwards interactive:true into the oauth-request by default', async () => {
  const sendMessage = vi.fn(() => Promise.resolve());
  const onMessage = { addListener: vi.fn(), removeListener: vi.fn() };
  (globalThis as any).chrome = { runtime: { id: 'test-extension-id', sendMessage, onMessage } };

  vi.resetModules();
  const mod = await import('../../src/providers/oauth-service.js');
  const launcher = mod.createOAuthLauncher();

  void launcher('https://idp.example.com/authorize');
  await Promise.resolve();

  expect(sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      source: 'panel',
      payload: expect.objectContaining({ type: 'oauth-request', interactive: true }),
    })
  );
});

it('extension launcher forwards interactive:false when requested (silent renewal)', async () => {
  const sendMessage = vi.fn(() => Promise.resolve());
  const onMessage = { addListener: vi.fn(), removeListener: vi.fn() };
  (globalThis as any).chrome = { runtime: { id: 'test-extension-id', sendMessage, onMessage } };

  vi.resetModules();
  const mod = await import('../../src/providers/oauth-service.js');
  const launcher = mod.createOAuthLauncher();

  void launcher('https://idp.example.com/authorize', { interactive: false });
  await Promise.resolve();

  expect(sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      payload: expect.objectContaining({ type: 'oauth-request', interactive: false }),
    })
  );
});
```

- [ ] **Step 7: Typecheck, lint, run SW + launcher + new tests**

```bash
node_modules/.bin/biome check --write \
  packages/chrome-extension/src/oauth-flow-options.ts \
  packages/chrome-extension/src/service-worker.ts \
  packages/chrome-extension/tests/oauth-flow-options.test.ts \
  packages/webapp/tests/providers/oauth-service.test.ts
npm run typecheck
npx vitest run -r packages/chrome-extension packages/chrome-extension/tests/oauth-flow-options.test.ts packages/chrome-extension/tests/service-worker.test.ts
npx vitest run packages/webapp/tests/providers/oauth-service.test.ts
```

Expected: typecheck clean; extension tests PASS (3 + 11); oauth-service tests
PASS (26 + 2 new).

- [ ] **Step 8: Commit**

```bash
git add packages/chrome-extension/src/oauth-flow-options.ts \
  packages/chrome-extension/src/service-worker.ts \
  packages/chrome-extension/tests/oauth-flow-options.test.ts \
  packages/webapp/tests/providers/oauth-service.test.ts
git commit -m "$(cat <<'EOF'
refactor(extension): extract buildWebAuthFlowOptions for unit testing

Pure helper picks interactive vs silent launchWebAuthFlow options; documents
the IMS JS-redirect rationale for the non-interactive triple. Add tests that
launchOAuthExtension forwards `interactive` (default true, false on request).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Silent-renewal failure backoff (pure unit)

**Files:**

- Create: `packages/webapp/src/providers/silent-renew-backoff.ts`
- Test: `packages/webapp/tests/providers/silent-renew-backoff.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/webapp/tests/providers/silent-renew-backoff.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createSilentRenewBackoff } from '../../src/providers/silent-renew-backoff.js';

describe('createSilentRenewBackoff', () => {
  it('runs renew and returns the token on success, no cooldown', async () => {
    const backoff = createSilentRenewBackoff(1000);
    const renew = vi.fn(async () => 'token-1');
    const t0 = 10_000;
    expect(await backoff.run(renew, t0)).toBe('token-1');
    expect(renew).toHaveBeenCalledTimes(1);
    expect(backoff.inCooldown(t0)).toBe(false);
  });

  it('sets a cooldown after a null renewal and skips renew during it', async () => {
    const backoff = createSilentRenewBackoff(1000);
    const renew = vi.fn(async () => null);
    const t0 = 10_000;
    expect(await backoff.run(renew, t0)).toBeNull();
    expect(renew).toHaveBeenCalledTimes(1);
    expect(backoff.inCooldown(t0 + 500)).toBe(true);
    // within cooldown → renew NOT called again
    expect(await backoff.run(renew, t0 + 500)).toBeNull();
    expect(renew).toHaveBeenCalledTimes(1);
  });

  it('re-attempts after the cooldown elapses', async () => {
    const backoff = createSilentRenewBackoff(1000);
    const renew = vi.fn(async () => null);
    const t0 = 10_000;
    await backoff.run(renew, t0); // fail → cooldown until t0+1000
    await backoff.run(renew, t0 + 999); // still cooling → skip
    expect(renew).toHaveBeenCalledTimes(1);
    await backoff.run(renew, t0 + 1000); // elapsed → re-attempt
    expect(renew).toHaveBeenCalledTimes(2);
  });

  it('treats a thrown renewal as a failure (cooldown set, returns null)', async () => {
    const backoff = createSilentRenewBackoff(1000);
    const renew = vi.fn(async () => {
      throw new Error('boom');
    });
    const t0 = 10_000;
    expect(await backoff.run(renew, t0)).toBeNull();
    expect(backoff.inCooldown(t0)).toBe(true);
  });

  it('clears the cooldown after a later success', async () => {
    const backoff = createSilentRenewBackoff(1000);
    const t0 = 10_000;
    await backoff.run(async () => null, t0); // fail → cooldown
    const ok = await backoff.run(async () => 'tok', t0 + 1000); // elapsed → success
    expect(ok).toBe('tok');
    expect(backoff.inCooldown(t0 + 1000)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run packages/webapp/tests/providers/silent-renew-backoff.test.ts
```

Expected: FAIL — cannot resolve `../../src/providers/silent-renew-backoff.js`.

- [ ] **Step 3: Create the module**

Create `packages/webapp/src/providers/silent-renew-backoff.ts`:

```ts
/**
 * Failure backoff for silent token renewal.
 *
 * After a failed silent renewal we avoid re-hitting the IdP on every stream /
 * turn: a genuinely dead session won't recover by retrying, and pi-agent-core
 * stream retries amplify the traffic. The cooldown re-probes once it elapses
 * (so it recovers if the user re-authenticated elsewhere) and clears
 * immediately on a successful renewal. A valid token never reaches this unit —
 * callers gate it behind their own expiry check.
 *
 * Five minutes balances "stop hammering IMS on a dead session" against
 * "recover promptly after re-auth". Not derived from token lifetime; tune
 * freely.
 */
export const SILENT_RENEW_FAILURE_COOLDOWN_MS = 5 * 60_000;

export interface SilentRenewBackoff {
  /**
   * Run `renew` unless we're inside a post-failure cooldown. Returns the token
   * on success, or null if renewal failed/threw or was skipped due to cooldown.
   */
  run(renew: () => Promise<string | null>, now?: number): Promise<string | null>;
  /** True while a post-failure cooldown is active. */
  inCooldown(now?: number): boolean;
}

export function createSilentRenewBackoff(
  cooldownMs: number = SILENT_RENEW_FAILURE_COOLDOWN_MS
): SilentRenewBackoff {
  let cooldownUntil = 0;
  return {
    async run(renew, now = Date.now()) {
      if (now < cooldownUntil) return null;
      let token: string | null = null;
      try {
        token = await renew();
      } catch {
        token = null;
      }
      cooldownUntil = token ? 0 : now + cooldownMs;
      return token;
    },
    inCooldown(now = Date.now()) {
      return now < cooldownUntil;
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run packages/webapp/tests/providers/silent-renew-backoff.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 5: Lint, typecheck, commit**

```bash
node_modules/.bin/biome check --write \
  packages/webapp/src/providers/silent-renew-backoff.ts \
  packages/webapp/tests/providers/silent-renew-backoff.test.ts
npm run typecheck
git add packages/webapp/src/providers/silent-renew-backoff.ts \
  packages/webapp/tests/providers/silent-renew-backoff.test.ts
git commit -m "$(cat <<'EOF'
feat(providers): add silent-renewal failure backoff unit

Per-process cooldown that skips re-attempting a failed silent renewal until it
elapses, then re-probes; clears on success. Pure + injectable clock for tests.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Wire the backoff into `getValidAccessToken`

**Files:**

- Modify: `packages/webapp/providers/adobe.ts`

- [ ] **Step 1: Import and instantiate the backoff**

In `packages/webapp/providers/adobe.ts`, add to the imports from
`../src/providers/...` (alongside the existing provider imports):

```ts
import { createSilentRenewBackoff } from '../src/providers/silent-renew-backoff.js';
```

Just below the existing `let renewalInProgress: Promise<string | null> | null = null;`
line, add the singleton:

```ts
/** Skips re-attempting a failed silent renewal until the cooldown elapses. */
const silentRenewBackoff = createSilentRenewBackoff();
```

- [ ] **Step 2: Route renewal through the backoff**

Replace the renewal block in `getValidAccessToken` — currently:

```ts
// Token expired or about to expire — try silent renewal
console.log('[adobe] Token expired or expiring soon, attempting silent renewal...');
try {
  const newToken = await silentRenewToken();
  if (newToken) return newToken;
} catch (err) {
  console.warn('[adobe] Silent renewal failed:', err instanceof Error ? err.message : String(err));
}
```

with:

```ts
// Token expired or about to expire — try silent renewal, throttled so a dead
// session doesn't re-hit IMS on every stream/turn (see silent-renew-backoff).
console.log('[adobe] Token expired or expiring soon, attempting silent renewal...');
const newToken = await silentRenewBackoff.run(() => silentRenewToken());
if (newToken) return newToken;
```

(The backoff swallows/throttles failures internally, so the surrounding
try/catch is no longer needed. The existing re-read + `throw new Error('Adobe
session expired — please log in again')` below stays unchanged.)

- [ ] **Step 3: Typecheck, lint**

```bash
node_modules/.bin/biome check --write packages/webapp/providers/adobe.ts
npm run typecheck
```

Expected: clean.

- [ ] **Step 4: Verify existing adobe tests still pass**

```bash
npx vitest run packages/webapp/tests/providers/adobe-provider.test.ts packages/webapp/tests/providers/oauth-config.test.ts
```

Expected: PASS.

> **Note (optional, not required):** the cooldown state machine itself is fully
> covered by the pure `silent-renew-backoff` tests (Task 3); the Task 4 change is
> thin wiring (`getValidAccessToken` delegates to `silentRenewBackoff.run`). A
> literal "getValidAccessToken short-circuits the 2nd call" integration test is
> awkward here — `adobe.ts` can't be imported directly in the node test env
> (`import.meta.glob` / `chrome` globals; see `adobe-provider.test.ts`'s header
> comment) and in node `silentRenewToken` returns null immediately (no `window`).
> Skip it; the unit + wiring coverage is sufficient.

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/providers/adobe.ts
git commit -m "$(cat <<'EOF'
feat(adobe): throttle failed silent renewals with a 5-minute cooldown

getValidAccessToken routes renewal through silentRenewBackoff so a dead IMS
session no longer re-hits the authorize endpoint on every stream/turn; the
cooldown re-probes after it elapses and clears on success.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Fail fast on a dead session (non-retryable classification)

**Files:**

- Modify: `packages/webapp/src/scoops/scoop-context.ts`
- Test: `packages/webapp/tests/scoops/scoop-context.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/webapp/tests/scoops/scoop-context.test.ts`, inside the existing
`describe('isNonRetryableError', …)` block, add:

```ts
it('treats session-expired / re-login messages as non-retryable', () => {
  expect(isNonRetryableError('Adobe session expired — please log in again')).toBe(true);
  expect(isNonRetryableError('Session expired, please re-authenticate')).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run packages/webapp/tests/scoops/scoop-context.test.ts -t "non-retryable"
```

Expected: FAIL — the new assertions return `false`.

- [ ] **Step 3: Add the session-expiry pattern**

In `packages/webapp/src/scoops/scoop-context.ts`, in `isNonRetryableError`, add
a clause to the `||` chain (after the authentication clause):

```ts
    // Expired session that needs interactive re-auth (won't succeed on retry)
    /session expired|log in again|re-?authenticate/i.test(msg) ||
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run packages/webapp/tests/scoops/scoop-context.test.ts -t "non-retryable"
```

Expected: PASS, and the existing `isNonRetryableError` / `isRetryableError`
assertions in that file still pass.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
node_modules/.bin/biome check --write \
  packages/webapp/src/scoops/scoop-context.ts \
  packages/webapp/tests/scoops/scoop-context.test.ts
npm run typecheck
git add packages/webapp/src/scoops/scoop-context.ts \
  packages/webapp/tests/scoops/scoop-context.test.ts
git commit -m "$(cat <<'EOF'
fix(scoops): classify session-expired errors as non-retryable

A dead session won't succeed by retrying the same prompt; fail the turn on the
first attempt with one clean "session expired" error instead of 3×.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `oauth-token --renew` test coverage

**Files:**

- Test: `packages/webapp/tests/shell/supplemental-commands/oauth-token-command.test.ts`

- [ ] **Step 1: Write the tests**

Add to `packages/webapp/tests/shell/supplemental-commands/oauth-token-command.test.ts`,
inside the existing `describe('oauth-token command', …)` block:

```ts
it('--renew triggers onSilentRenew and reports success', async () => {
  const onSilentRenew = vi.fn(async () => 'fresh-token');
  mockGetRegisteredProviderConfig.mockReturnValue({
    id: 'adobe',
    name: 'Adobe',
    isOAuth: true,
    onSilentRenew,
  } as never);
  mockGetOAuthAccountInfo
    .mockReturnValueOnce({ token: 'old', expiresAt: Date.now() - 1000, expired: true })
    .mockReturnValueOnce({
      token: 'fresh-token',
      expiresAt: Date.now() + 24 * 3600_000,
      expired: false,
    });

  const cmd = createOAuthTokenCommand();
  const result = await cmd.execute(['--renew', 'adobe'], createMockCtx());

  expect(onSilentRenew).toHaveBeenCalledTimes(1);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain('SUCCESS');
});

it('--renew reports failure when onSilentRenew returns null', async () => {
  const onSilentRenew = vi.fn(async () => null);
  mockGetRegisteredProviderConfig.mockReturnValue({
    id: 'adobe',
    name: 'Adobe',
    isOAuth: true,
    onSilentRenew,
  } as never);
  mockGetOAuthAccountInfo.mockReturnValue({
    token: 'old',
    expiresAt: Date.now() - 1000,
    expired: true,
  });

  const cmd = createOAuthTokenCommand();
  const result = await cmd.execute(['--renew', 'adobe'], createMockCtx());

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toContain('FAILED');
});

it('--renew errors when the provider has no onSilentRenew hook', async () => {
  mockGetRegisteredProviderConfig.mockReturnValue({
    id: 'noauth',
    name: 'NoAuth',
    isOAuth: true,
  } as never);

  const cmd = createOAuthTokenCommand();
  const result = await cmd.execute(['--renew', 'noauth'], createMockCtx());

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('no onSilentRenew hook');
});
```

- [ ] **Step 2: Run the tests**

```bash
npx vitest run packages/webapp/tests/shell/supplemental-commands/oauth-token-command.test.ts
```

Expected: PASS (existing 22 + 3 new).

- [ ] **Step 3: Lint, commit**

```bash
node_modules/.bin/biome check --write \
  packages/webapp/tests/shell/supplemental-commands/oauth-token-command.test.ts
git add packages/webapp/tests/shell/supplemental-commands/oauth-token-command.test.ts
git commit -m "$(cat <<'EOF'
test(oauth-token): cover --renew success/failure/no-hook paths

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Documentation

**Files:**

- Modify: `docs/shell-reference.md`
- Modify: `docs/oauth-intercept.md`
- Modify: `docs/pitfalls.md`

- [ ] **Step 1: Document `oauth-token --renew` in the shell reference**

`docs/shell-reference.md` **already has an `oauth-token` entry** (find it with
`grep -n "oauth-token" docs/shell-reference.md`). **Extend that existing
entry** — do not add a duplicate section. Add a line/row, matching the file's
existing formatting for the `oauth-token` flags, documenting:

```
`oauth-token --renew [<id>]` — force a silent token renewal now via the
provider's `onSilentRenew` hook (bypasses the expiry gate). Reports success and
the new expiry. Useful for verifying renewal without waiting for natural expiry.
```

- [ ] **Step 2: Document the silent-renewal transport in `oauth-intercept.md`**

In `docs/oauth-intercept.md`, add a section:

```markdown
## Silent token renewal (extension, launchWebAuthFlow)

Providers with an `onSilentRenew` hook renew expired tokens without UI. In the
extension this routes through `chrome.identity.launchWebAuthFlow`. The provider
passes `{ interactive: false }` to the launcher; the service worker then calls
`launchWebAuthFlow` with **three** required options
(`packages/chrome-extension/src/oauth-flow-options.ts`):

- `interactive: false` — no window.
- `abortOnLoadForNonInteractive: false` — do **not** stop when the authorize
  page loads. Adobe IMS's `prompt=none` page loads and then performs a
  JS-driven redirect; the default non-interactive mode aborts before that
  redirect fires ("User interaction required").
- `timeoutMsForNonInteractive: 10000` — bound a stuck flow.

**Do not regress this triple** — `interactive: false` alone fails for IMS.
Requires Chrome 113+ (older Chrome ignores the options → renewal fails silently,
no window).

### Failure backoff (Adobe)

`getValidAccessToken` routes silent renewal through a 5-minute cooldown
(`packages/webapp/src/providers/silent-renew-backoff.ts`): after a failure it
short-circuits to "session expired — please log in again" without re-hitting
IMS, then re-probes once the cooldown elapses (recovering if the user re-authed
elsewhere). That error is classified non-retryable in `scoop-context.ts` so a
dead-session turn fails fast with one clean error.
```

- [ ] **Step 3: Add a pitfalls cross-reference**

In `docs/pitfalls.md`, add a short entry under an OAuth/extension-appropriate
heading:

```markdown
### Silent OAuth renewal must stay windowless (IMS JS redirect)

`launchWebAuthFlow({ interactive: false })` alone flashes / fails for Adobe IMS
because its `prompt=none` page JS-redirects after load. Keep the
`abortOnLoadForNonInteractive: false` + `timeoutMsForNonInteractive` options in
`packages/chrome-extension/src/oauth-flow-options.ts`. See
`docs/oauth-intercept.md` "Silent token renewal".
```

- [ ] **Step 4: (Optional) cross-link from the webapp package guide**

In `packages/webapp/CLAUDE.md`, in the existing "OAuth flow + page-side
bootstrap" subsection, append one sentence so the silent-renewal contract is
discoverable from the package guide:

```markdown
- Extension silent renewal runs `launchWebAuthFlow` non-interactively
  (`interactive:false` + `abortOnLoadForNonInteractive:false` +
  `timeoutMsForNonInteractive`) and throttles repeat failures via a 5-minute
  cooldown; see `docs/oauth-intercept.md` "Silent token renewal".
```

- [ ] **Step 5: Format and verify docs**

```bash
node_modules/.bin/prettier --write docs/shell-reference.md docs/oauth-intercept.md docs/pitfalls.md packages/webapp/CLAUDE.md
node_modules/.bin/prettier --check docs/shell-reference.md docs/oauth-intercept.md docs/pitfalls.md packages/webapp/CLAUDE.md
```

Expected: "All matched files use Prettier code style!".

- [ ] **Step 6: Commit**

```bash
git add docs/shell-reference.md docs/oauth-intercept.md docs/pitfalls.md packages/webapp/CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: silent OAuth renewal transport, backoff, and oauth-token --renew

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Full verification + extension build

**Files:** none (verification only)

- [ ] **Step 1: Run the full gates**

```bash
npm run lint
npm run typecheck
npm run test
npm run test:coverage
npm run build
npm run build -w @slicc/chrome-extension
```

Expected: all pass. (`npm run build -w @slicc/chrome-extension` requires
`@ffmpeg/core` installed — run `npm install` first if the asset-copy step
errors with a missing `ffmpeg-core.js`.)

- [ ] **Step 2: Confirm the silent options survived bundling**

```bash
grep -o "abortOnLoadForNonInteractive:[^,}]*" dist/extension/service-worker.js
grep -o "interactive:[^,}]*" dist/extension/service-worker.js | head
```

Expected: `abortOnLoadForNonInteractive:!1` and an `interactive:` reference
present.

- [ ] **Step 3: Manual QA (regression recipe from the spec)**

Build **without** `SLICC_EXT_DEV` (production manifest key → stable id → IMS
callback resolves). With a live Adobe SSO, expire the cached token and send a
message → silent renewal, **no window**. Sign out of Adobe / clear
`*.adobelogin.com` cookies → renewal fails **windowless** with one clean
"session expired" chat error and a single `login_required` per turn in the
offscreen console.

**Expiring the token now that `--expire` is gone** — the agent reads its token
from the **offscreen** document's `localStorage`, so backdate it there. Open
`chrome://extensions` → SLICC → _Inspect views: offscreen.html_ and run in that
console:

```js
const a = JSON.parse(localStorage.getItem('slicc_accounts'));
const adobe = a.find((x) => x.providerId === 'adobe');
adobe.tokenExpiresAt = Date.now() - 1000; // backdate → reads as expired
localStorage.setItem('slicc_accounts', JSON.stringify(a));
```

Then send a message — the next stream hits the expired path and renews.
(Alternatives: edit the value in the DevTools _Application → Local Storage_
pane, or wait for natural ~24 h expiry.)

- [ ] **Step 4: Ensure `package-lock.json` is unchanged**

This fix introduces **no new dependencies**, so `package-lock.json` must not be
in the diff. If it shows modified (e.g. from an interim `npm install` that
reconciled a partial node_modules), discard it:

```bash
git checkout -- package-lock.json   # only if the fix added no deps
```

- [ ] **Step 5: Commit any formatting-only changes** (only if `npm run lint` rewrote source files)

```bash
git status --short   # confirm only intended files changed (NOT package-lock.json)
git add packages/ docs/
git commit -m "$(cat <<'EOF'
chore: formatting after silent-renewal fix

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Notes for the executor

- **Branch:** continue on `spike/oauth-silent-renew` (optionally rename to
  `fix/oauth-silent-renew` before opening the PR: `git branch -m fix/oauth-silent-renew`).
- **Coverage floors** (root `CLAUDE.md`): webapp 50/40, chrome-extension
  55/45/60. The new pure modules + tests should raise, not lower, coverage.
- **`docs/superpowers/`** is branch-only and scrubbed before merge to `main`
  (`docs/CLAUDE.md`) — do not expect to keep the spec/plan on `main`.
- **No new dependencies.** `package-lock.json` must stay unchanged. The current
  working tree may show it modified from an interim `npm install` (which
  restored the locally-missing `@ffmpeg/core` and `@biomejs/biome` binaries);
  `git checkout -- package-lock.json` to drop that before any commit.
