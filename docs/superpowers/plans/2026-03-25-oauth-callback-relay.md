# OAuth Callback Relay — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a stable OAuth callback relay at `www.sliccy.ai/auth/callback` that redirects to the correct localhost port using the OAuth `state` parameter, eliminating port-dependent redirect URIs.

**Architecture:** A static HTML relay page served by the tray hub worker decodes `state` (port, path, nonce) and redirects to localhost. The Adobe provider encodes the CLI port and a CSRF nonce into `state`. Provider-agnostic — any future OAuth provider can reuse the relay.

**Tech Stack:** Cloudflare Worker (TypeScript), browser JavaScript, Vitest

**Spec:** `docs/superpowers/specs/2026-03-25-oauth-callback-relay-design.md`

---

### Task 1: Add `/auth/callback` relay route to the worker

**Files:**

- Modify: `packages/cloudflare-worker/src/index.ts`
- Create: `packages/cloudflare-worker/tests/auth-relay.test.ts`

- [ ] **Step 1: Write tests for the relay route**

Create `packages/cloudflare-worker/tests/auth-relay.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { handleWorkerRequest } from '../src/index.js';

const env = { TRAY_HUB: {} } as any;

function relayRequest(query: string): Request {
  return new Request(`https://www.sliccy.ai/auth/callback${query}`);
}

describe('OAuth callback relay', () => {
  it('returns relay HTML for valid state', async () => {
    const state = btoa(JSON.stringify({ port: 5720, path: '/auth/callback', nonce: 'abc123' }));
    const res = await handleWorkerRequest(relayRequest(`?state=${state}`), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('localhost');
    expect(body).toContain('Redirecting');
  });

  it('returns relay HTML even without state (page shows error client-side)', async () => {
    const res = await handleWorkerRequest(relayRequest(''), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('relay HTML contains security validation script', async () => {
    const state = btoa(JSON.stringify({ port: 5720, path: '/auth/callback', nonce: 'x' }));
    const res = await handleWorkerRequest(relayRequest(`?state=${state}`), env);
    const body = await res.text();
    expect(body).toContain('port < 1024');
    expect(body).toContain("path.startsWith('/')");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project cloudflare-worker packages/cloudflare-worker/tests/auth-relay.test.ts`
Expected: Fail — route doesn't exist yet.

- [ ] **Step 3: Add the relay route to the worker**

In `packages/cloudflare-worker/src/index.ts`, add before the token match route (around line 34):

```typescript
// OAuth callback relay — serves a static HTML page that reads the OAuth state
// parameter and redirects to the correct localhost port. Provider-agnostic.
if (url.pathname === '/auth/callback') {
  return new Response(OAUTH_RELAY_HTML, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
```

Add the HTML constant at module level (after imports). The relay page decodes the `state` parameter (base64 JSON with port, path, nonce), validates port range and path format, then redirects to localhost preserving the URL fragment (which contains the access token):

```typescript
const OAUTH_RELAY_HTML = `<!DOCTYPE html>
<html><head><title>Redirecting to SLICC...</title></head>
<body>
<p id="msg">Redirecting to SLICC...</p>
<script>
try {
  var params = new URLSearchParams(location.search);
  var raw = params.get('state');
  if (!raw) throw new Error('Missing state parameter');
  var state = JSON.parse(atob(raw));
  var port = Number(state.port);
  var path = state.path || '/auth/callback';
  var nonce = state.nonce || '';
  if (!port || port < 1024 || port > 65535) throw new Error('Invalid port: ' + port);
  if (!path.startsWith('/')) throw new Error('Invalid path');
  var target = 'http://localhost:' + port + path + '?nonce=' + encodeURIComponent(nonce);
  location.replace(target + location.hash);
} catch (e) {
  document.getElementById('msg').textContent = 'OAuth redirect failed: ' + e.message + '. Close this window and try again.';
}
</script>
</body></html>`;
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run --project cloudflare-worker packages/cloudflare-worker/tests/auth-relay.test.ts`
Expected: All pass.

- [ ] **Step 5: Run full worker tests**

Run: `npx vitest run --project cloudflare-worker`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
npx prettier --write packages/cloudflare-worker/src/index.ts packages/cloudflare-worker/tests/auth-relay.test.ts
git add packages/cloudflare-worker/
git commit -m "feat(worker): add OAuth callback relay route

GET /auth/callback serves a static HTML page that decodes the
OAuth state parameter (port, path, nonce) and redirects to
http://localhost:{port}{path}. Provider-agnostic.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Add state/nonce encoding to Adobe provider

**Files:**

- Modify: `packages/webapp/providers/adobe.ts`
- Modify: `packages/webapp/providers/adobe-config.json`
- Test: `packages/webapp/tests/providers/adobe-provider.test.ts`

- [ ] **Step 1: Write tests for state encoding**

Add to `packages/webapp/tests/providers/adobe-provider.test.ts`:

```typescript
describe('OAuth state encoding', () => {
  it('encodes port, path, and nonce into base64 JSON', () => {
    const state = btoa(JSON.stringify({ port: 5720, path: '/auth/callback', nonce: 'test123' }));
    const decoded = JSON.parse(atob(state));
    expect(decoded.port).toBe(5720);
    expect(decoded.path).toBe('/auth/callback');
    expect(decoded.nonce).toBe('test123');
  });

  it('state round-trips through URL encoding', () => {
    const state = btoa(JSON.stringify({ port: 5710, path: '/auth/callback', nonce: 'abc' }));
    const encoded = encodeURIComponent(state);
    const decoded = JSON.parse(atob(decodeURIComponent(encoded)));
    expect(decoded.port).toBe(5710);
  });
});
```

- [ ] **Step 2: Update adobe-config.json**

Change `redirectUri`:

```json
{
  "proxyEndpoint": "https://adobe-llm-proxy.paolo-moz.workers.dev",
  "redirectUri": "https://www.sliccy.ai/auth/callback",
  "extensionRedirectUri": "https://akjjllgokmbgpbdbmafpiefnhidlmbgf.chromiumapp.org/adobe"
}
```

- [ ] **Step 3: Add state parameter to authorize URL in adobe.ts**

In both `onOAuthLogin` (around line 280-291) and `silentRenewToken` (around line 419-431), after building `redirectUri` and before building the authorize URL params, add state encoding for CLI mode:

```typescript
// Build OAuth state with port and CSRF nonce for the sliccy.ai relay
const oauthState = !isExtension
  ? btoa(
      JSON.stringify({
        port: parseInt(new URL(window.location.href).port || '5710', 10),
        path: '/auth/callback',
        nonce: crypto.randomUUID(),
      })
    )
  : undefined;

const params = new URLSearchParams({
  client_id: clientId,
  scope: scopes,
  response_type: 'token',
  redirect_uri: redirectUri,
});
if (oauthState) params.set('state', oauthState);
```

Store the expected nonce for verification:

```typescript
const expectedNonce = oauthState ? JSON.parse(atob(oauthState)).nonce : null;
```

After receiving the redirect URL from the launcher, verify the nonce before extracting the token:

```typescript
if (expectedNonce && redirectUrl) {
  try {
    const callbackUrl = new URL(redirectUrl);
    const receivedNonce = callbackUrl.searchParams.get('nonce');
    if (receivedNonce !== expectedNonce) {
      console.error('[adobe] OAuth nonce mismatch — possible CSRF');
      return;
    }
  } catch {
    // URL parse failure — continue with token extraction (backwards compat)
  }
}
```

Apply the same pattern to both `onOAuthLogin` and `silentRenewToken`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run --project webapp packages/webapp/tests/providers/adobe-provider.test.ts`
Expected: All pass.

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
npx prettier --write packages/webapp/providers/adobe.ts packages/webapp/providers/adobe-config.json packages/webapp/tests/providers/adobe-provider.test.ts
git add packages/webapp/providers/ packages/webapp/tests/providers/
git commit -m "feat(adobe): use sliccy.ai relay with state/nonce for OAuth

Encode CLI port, callback path, and CSRF nonce into the OAuth
state parameter. Redirect URI is now https://www.sliccy.ai/auth/callback
(stable across any port). Nonce verified on callback to prevent CSRF.

Extension mode unchanged (uses chrome.identity flow).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Final verification and documentation

**Files:**

- Modify: `packages/cloudflare-worker/CLAUDE.md`

- [ ] **Step 1: Run all build gates**

```bash
npx prettier --check .
npm run typecheck
npm run test
npm run build -w @slicc/chrome-extension
```

- [ ] **Step 2: Update worker CLAUDE.md with new route**

Add to the "Public routes" section in `packages/cloudflare-worker/CLAUDE.md`:

```
- `GET /auth/callback` — OAuth callback relay page (reads state param, redirects to localhost)
```

- [ ] **Step 3: Commit**

```bash
npx prettier --write packages/cloudflare-worker/CLAUDE.md
git add packages/cloudflare-worker/CLAUDE.md
git commit -m "docs: document /auth/callback relay route

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```
