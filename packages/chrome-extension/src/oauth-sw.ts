/**
 * OAuth handler — generic `chrome.identity.launchWebAuthFlow` for any OAuth
 * provider. Only the SW has `chrome.identity`, so the panel RPCs in here.
 *
 * Chrome extension API types provided by ./chrome.d.ts
 */

// `import type` only — see the import-boundary note in
// packages/chrome-extension/CLAUDE.md.
import type { OAuthRequestMsg, OAuthResultMsg } from '../../webapp/src/kernel/messages.js';
import { buildWebAuthFlowOptions } from './oauth-flow-options.js';

export async function handleOAuthRequest(msg: OAuthRequestMsg): Promise<OAuthResultMsg> {
  const redirectUrl = await chrome.identity.launchWebAuthFlow(
    buildWebAuthFlowOptions(msg.authorizeUrl, msg.interactive ?? true)
  );

  if (!redirectUrl) {
    return {
      type: 'oauth-result',
      providerId: msg.providerId,
      error: 'OAuth flow was cancelled or returned no URL',
    };
  }

  const parsed = new URL(redirectUrl);
  const params = parsed.searchParams;
  const hashParams = new URLSearchParams(parsed.hash.slice(1));
  const error = params.get('error') || hashParams.get('error');
  if (error) {
    return {
      type: 'oauth-result',
      providerId: msg.providerId,
      error: params.get('error_description') || hashParams.get('error_description') || error,
    };
  }

  return {
    type: 'oauth-result',
    providerId: msg.providerId,
    code: params.get('code') ?? undefined,
    state: params.get('state') ?? undefined,
    redirectUrl,
  };
}
