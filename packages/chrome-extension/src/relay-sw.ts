/**
 * Message relay for the `{ source, payload }` envelopes the side panel and
 * offscreen document exchange.
 *
 * `chrome.runtime.sendMessage` broadcasts to every extension context except the
 * sender, so panel ↔ offscreen traffic reaches its peer directly and needs no
 * relay. The SW only intercepts the payloads that require an API it alone
 * holds: `chrome.identity` (OAuth), `chrome.debugger` (CDP), and the tray
 * WebSocket.
 *
 * Chrome extension API types provided by ./chrome.d.ts
 */

// `import type` only — see the import-boundary note in
// packages/chrome-extension/CLAUDE.md.
import type {
  ExtensionMessage,
  OAuthRequestMsg,
  OAuthResultMsg,
} from '../../webapp/src/kernel/messages.js';
import { handleOAuthRequest } from './oauth-sw.js';
import { sendServiceWorkerMessage } from './sw-broadcast.js';
import type { SwMessageOutcome } from './sw-message-router.js';

function isExtMsg(msg: unknown): msg is ExtensionMessage {
  return typeof msg === 'object' && msg !== null && 'source' in msg && 'payload' in msg;
}

/** Run the OAuth flow and broadcast its result (or the failure) back. */
function relayOAuthRequest(oauthMsg: OAuthRequestMsg): void {
  handleOAuthRequest(oauthMsg)
    .then((result) => {
      sendServiceWorkerMessage(result).catch((e) => {
        console.error('[slicc-sw] Failed to send OAuth result:', e);
      });
    })
    .catch((err) => {
      sendServiceWorkerMessage({
        type: 'oauth-result',
        providerId: oauthMsg.providerId,
        error: err instanceof Error ? err.message : String(err),
      } satisfies OAuthResultMsg).catch((e) => {
        console.error('[slicc-sw] Failed to send OAuth error:', e);
      });
    });
}

/**
 * Run a CDP command and broadcast the response. The offscreen CDP proxy listens
 * for `cdp-response` via `onMessage`, not via the `sendMessage` return value.
 *
 * B24-3: REMOVED — the offscreen document no longer exists in this extension
 * (no `offscreen` permission in manifest.json). The legacy
 * `{source:'offscreen', payload:{type:'cdp-command'}}` relay had no sender
 * check and no protected-origin check, and ran secret unmasking on
 * Runtime.evaluate. It was dead code and has been removed along with its
 * tray-socket relay.
 */

/**
 * `chrome.runtime.onMessage` branch for panel/offscreen envelopes. Every path
 * replies out-of-band via broadcast, so the reply channel is never held open.
 */
export function handleRelayMessage(message: unknown): SwMessageOutcome {
  if (!isExtMsg(message)) return 'not-handled';

  if (message.source === 'panel') {
    // The panel being active means the user is attending SLICC — clear any
    // pending handoff badge.
    chrome.action.setBadgeText({ text: '' });
    // Only OAuth needs the SW; other panel messages reach the offscreen doc
    // directly via the chrome.runtime.sendMessage broadcast.
    if (message.payload.type === 'oauth-request') {
      relayOAuthRequest(message.payload as OAuthRequestMsg);
    }
    return 'handled';
  }

  if (message.source === 'offscreen') {
    // B24-3: The offscreen document was removed from this extension. Log and
    // drop any stale messages — they have no sender check and no protected
    // check, and they ran secret unmasking on Runtime.evaluate.
    console.warn('[slicc-sw] dropping offscreen message — offscreen document no longer exists');
    return 'handled';
  }

  return 'not-handled';
}
