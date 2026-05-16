# Intercepted OAuth flows

Slicc drives an instrumented Chrome target via CDP. That instrumentation
is enough to run a full OAuth Authorization Code + PKCE flow against
authorization servers whose public clients only trust loopback redirect
URIs (xAI Grok, Google Cloud Code Assist, Anthropic Codex, …) **without
ever binding a local HTTP port**. The browser navigates to the registered
loopback URL, CDP's `Fetch.requestPaused` catches the request before it
hits the network stack, slicc plucks the `?code=…&state=…` out of the
URL, and the tab closes.

This document describes the abstraction, how providers wire into it, and
how to drive it ad-hoc from the shell.

## The pieces

- `packages/webapp/src/providers/types.ts`
  - `InterceptOAuthConfig` — pure JSON shape (see below)
  - `InterceptingOAuthLauncher` — `(config) => Promise<capturedUrl | null>`
- `packages/webapp/src/providers/intercepted-oauth.ts`
  - `createInterceptingOAuthLauncher(transport)` — binds a launcher to a
    `CDPTransport`
  - `parseInterceptOAuthConfig(json)` — validates JSON / CLI-supplied
    config
  - `applyRewrites(url, rules)` — pure URL-patching helper
- `packages/webapp/src/providers/oauth-service.ts`
  - `createInterceptingOAuthLauncherForCurrentRuntime()` — picks the
    active transport (extension / CLI / worker)
- `packages/webapp/src/shell/supplemental-commands/oauth-token-command.ts`
  - `oauth-token --from-file <path>` — load a config from VFS
  - `oauth-token --intercept --authorize-url=… --redirect-pattern=…`
  - Provider dispatch: prefers `onOAuthLoginIntercepted` over
    `onOAuthLogin` when both exist

## Config schema

```ts
interface InterceptOAuthConfig {
  authorizeUrl: string; // URL the OAuth tab opens
  redirectUriPattern: string; // e.g. "http://127.0.0.1:56121/*"
  rewrite?: OAuthRequestRewrite[];
  onCapture?: 'close' | 'leave'; // default: 'close'
  timeoutMs?: number; // default: 120000
}

interface OAuthRequestRewrite {
  match: string; // substring of the outbound URL
  appendParams?: Record<string, string>; // add/override search params
  replaceUrl?: string; // full URL substitution
}
```

Everything is JSON-serializable on purpose: the same shape works as a
TypeScript object inside a provider, a `.json` file dropped into the VFS,
or a flag pack assembled by the `oauth-token` command.

## Example: xAI Grok / SuperGrok

The shipped `packages/webapp/providers/xai-grok.ts` provider uses:

```jsonc
{
  "authorizeUrl": "https://auth.x.ai/oauth2/auth?response_type=code&client_id=b1a00492-073a-47ea-816f-4c329264a828&redirect_uri=http%3A%2F%2F127.0.0.1%3A56121%2Fcallback&scope=openid%20profile%20email%20offline_access%20grok-cli%3Aaccess%20api%3Aaccess&code_challenge=…&code_challenge_method=S256&state=…&nonce=…&plan=generic&referrer=slicc",
  "redirectUriPattern": "http://127.0.0.1:56121/*",
  "onCapture": "close",
}
```

Three xAI-specific notes:

1. **Same public client_id as the Grok CLI** (`b1a00492-…`). The xAI
   OAuth server only trusts loopback redirects for this client.
2. **`plan=generic` is required.** Without it `accounts.x.ai` rejects
   loopback OAuth from clients other than the official Grok CLI. Source:
   [hermes-agent auth.py](https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/auth.py).
3. **`referrer=slicc`** is informational — xAI logs the originating tool
   server-side.

## Running a one-off interception from the shell

```bash
# From a JSON file in the VFS:
echo '{
  "authorizeUrl": "https://auth.x.ai/oauth2/auth?…",
  "redirectUriPattern": "http://127.0.0.1:56121/*"
}' > /workspace/.slicc/oauth/xai-once.json
oauth-token --from-file /workspace/.slicc/oauth/xai-once.json

# From flags (no file needed):
oauth-token --intercept \
  --authorize-url 'https://auth.x.ai/oauth2/auth?…' \
  --redirect-pattern 'http://127.0.0.1:56121/*' \
  --rewrite 'auth.x.ai=plan=generic'
```

The command prints the captured redirect URL to stdout. Code exchange
and token persistence are the caller's job — that lets you script
against arbitrary OAuth clients without writing a provider module.

## Writing a provider that uses the interceptor

```ts
import type { ProviderConfig, InterceptingOAuthLauncher } from '../src/providers/types.js';

export const config: ProviderConfig = {
  id: 'my-provider',
  name: 'My Provider',
  description: '…',
  requiresApiKey: false,
  requiresBaseUrl: false,
  isOAuth: true,
  onOAuthLoginIntercepted: async (launcher, onSuccess) => {
    const captured = await launcher({
      authorizeUrl: buildAuthorizeUrl(),
      redirectUriPattern: 'http://127.0.0.1:12345/*',
    });
    if (!captured) throw new Error('login cancelled');
    const code = new URL(captured).searchParams.get('code');
    // …exchange code, saveOAuthAccount(), onSuccess()…
  },
};
```

A provider implements **either** `onOAuthLogin` (popup /
`chrome.identity` path) **or** `onOAuthLoginIntercepted` (CDP path). The
`oauth-token` command and `/login` UI dispatch to whichever is set.
