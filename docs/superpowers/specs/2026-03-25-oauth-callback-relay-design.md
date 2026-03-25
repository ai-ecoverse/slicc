# OAuth Callback Relay via sliccy.ai

**Date:** 2026-03-25
**Branch:** `feat/oauth-callback-relay`
**Status:** Draft

## Problem

The CLI/standalone OAuth callback is hardcoded to `http://localhost:5710/auth/callback`. This breaks when:

1. **Parallel instances** run on different ports (5720, 5730, etc.) — each port needs a separate IMS allowlist entry
2. **Port conflicts** force a different port — the allowlisted redirect URI no longer matches
3. **localhost URLs** look unprofessional and some IdPs treat them as less trustworthy

The extension is not affected — it uses `chrome.identity.launchWebAuthFlow` with its own `chromiumapp.org` callback.

## Design

### Stable Redirect URI

Use `https://www.sliccy.ai/auth/callback` as the OAuth redirect URI for all CLI/standalone instances. This is a single, stable URL that works on any port.

The `www.sliccy.ai` domain already routes to the tray hub Cloudflare Worker (PR #212). We add a `/auth/callback` route that serves a static HTML relay page.

### OAuth State Parameter

The standard OAuth `state` parameter carries the information needed to redirect back to the correct localhost port and path:

```json
{
  "port": 5720,
  "path": "/auth/callback",
  "nonce": "a1b2c3d4e5f6..."
}
```

Base64-encoded and passed as `&state=eyJwb3J0Ijo1NzIwLC4uLn0` in the authorize URL.

**Fields:**

| Field   | Type   | Purpose                                                                   |
| ------- | ------ | ------------------------------------------------------------------------- |
| `port`  | number | The CLI server's port (e.g., 5710, 5720)                                  |
| `path`  | string | The local callback path (e.g., `/auth/callback`, `/auth/github/callback`) |
| `nonce` | string | Random value for CSRF protection — CLI verifies it on the local callback  |

### Flow

```
1. CLI generates nonce, builds state = base64({"port":5720,"path":"/auth/callback","nonce":"abc123"})
2. CLI opens: https://ims.adobelogin.com/authorize?...&redirect_uri=https://www.sliccy.ai/auth/callback&state=...
3. User completes login on IMS
4. IMS redirects to: https://www.sliccy.ai/auth/callback?state=eyJ...#access_token=xxx&expires_in=3600
5. Relay page decodes state, redirects to: http://localhost:5720/auth/callback?nonce=abc123#access_token=xxx&expires_in=3600
6. CLI's local /auth/callback handler receives the token + nonce
7. CLI verifies nonce matches what it generated in step 1
8. Callback page postMessages the redirect URL to the opener (existing flow)
```

### Relay Page

The worker route `GET /auth/callback` returns a self-contained HTML page (no external dependencies):

```html
<!DOCTYPE html>
<html>
  <head>
    <title>Redirecting...</title>
  </head>
  <body>
    <p>Redirecting to SLICC...</p>
    <script>
      try {
        const params = new URLSearchParams(location.search);
        const state = JSON.parse(atob(params.get('state') || ''));
        const port = Number(state.port);
        const path = state.path || '/auth/callback';
        const nonce = state.nonce || '';
        if (!port || port < 1024 || port > 65535) throw new Error('Invalid port');
        if (!path.startsWith('/')) throw new Error('Invalid path');

        // Build localhost URL, preserving the fragment (access_token etc.)
        const target = `http://localhost:${port}${path}?nonce=${encodeURIComponent(nonce)}`;
        // Fragment isn't sent to the server in the redirect — must use JS
        location.replace(target + location.hash);
      } catch (e) {
        document.body.textContent = 'OAuth redirect failed: ' + e.message;
      }
    </script>
  </body>
</html>
```

**Security:**

- Port must be 1024-65535 (no privileged ports)
- Path must start with `/` (no protocol injection)
- Redirects only to `localhost` (hardcoded)
- Nonce is opaque — the relay page passes it through without interpreting it
- No cookies, no server-side state, no external requests

### Nonce Verification

The CLI generates a cryptographically random nonce before starting the OAuth flow and stores it in memory. When the local callback is received, the CLI checks that the `nonce` query parameter matches. If it doesn't, the callback is rejected.

This prevents CSRF attacks where an attacker crafts a malicious callback URL to inject their own token.

### Provider Agnostic

The relay is provider-agnostic. The `path` field in `state` determines where the local redirect goes:

| Provider   | `path` value                | Local callback                                     |
| ---------- | --------------------------- | -------------------------------------------------- |
| Adobe IMS  | `/auth/callback`            | `http://localhost:{port}/auth/callback`            |
| GitHub     | `/auth/github/callback`     | `http://localhost:{port}/auth/github/callback`     |
| Any future | `/auth/{provider}/callback` | `http://localhost:{port}/auth/{provider}/callback` |

The relay page doesn't know or care about the provider — it just reads `state` and redirects.

## Changes

### File: `packages/cloudflare-worker/src/index.ts`

Add route handler for `GET /auth/callback`:

- Returns the static relay HTML page
- No Durable Object interaction, no state, just a static response

### File: `packages/webapp/providers/adobe.ts`

In `onOAuthLogin` and `silentRenewToken`:

- Generate a random nonce (e.g., `crypto.randomUUID()` or `crypto.getRandomValues`)
- Build `state` as base64 JSON with `{port, path, nonce}`
- Set `redirect_uri` to `https://www.sliccy.ai/auth/callback`
- Add `state` to the authorize URL params

### File: `packages/webapp/providers/adobe-config.json`

Update `redirectUri`:

```json
"redirectUri": "https://www.sliccy.ai/auth/callback"
```

### File: `packages/node-server/src/index.ts`

In the `/auth/callback` route handler:

- Extract `nonce` from query params
- Verify it matches the stored nonce (need a way to pass it — could use a module-level variable or the callback page itself)

### File: `packages/webapp/src/providers/oauth-service.ts`

The CLI OAuth launcher (`launchOAuthCli`) may need to:

- Store the nonce before opening the popup
- Verify the nonce when the callback is received via postMessage

### File: `packages/cloudflare-worker/tests/`

Add tests for the relay page:

- Valid state → correct redirect URL
- Missing state → error message
- Invalid port (< 1024) → error
- Invalid path (no leading `/`) → error
- Missing nonce → still redirects (nonce is verified by CLI, not relay)

## IMS Configuration (Manual)

Allowlist `https://www.sliccy.ai/auth/callback` as a redirect URI in the Adobe IMS console. The old `http://localhost:5710/auth/callback` can be kept as a fallback during transition.

## Backwards Compatibility

- The old `localhost:5710` redirect URI still works — the local `/auth/callback` route is unchanged
- The relay is additive — it's a new route on the worker, doesn't change existing tray functionality
- `adobe-config.json` change affects new sessions only

## Electron Overlay Compatibility

The Electron overlay opens the system browser for OAuth (not a popup). `window.opener` is null, so the existing local `/auth/callback` page falls back to POSTing the result to `/api/oauth-result`, which the UI polls.

With the relay, the flow becomes: IMS → `sliccy.ai/auth/callback` → redirect to `localhost:{port}/auth/callback?nonce=...#access_token=...` → local callback page runs → `window.opener` is null → POST fallback to `/api/oauth-result` → UI polls and picks it up.

**No changes needed** — the relay just adds a hop before the local callback. The local callback page sends `location.href` (which includes the nonce) in the POST payload. The Electron overlay flow works transparently.

## Out of Scope

- Extension OAuth (uses `chrome.identity.launchWebAuthFlow` — has its own `chromiumapp.org` callback)
- Token storage or server-side session management
- PKCE (Adobe IMS uses implicit grant with fragment-based tokens)
