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

export function handleRelayMessage(message: unknown): SwMessageOutcome {
  if (!isExtMsg(message)) return 'not-handled';

  if (message.source === 'panel') {
    chrome.action.setBadgeText({ text: '' });

    if (message.payload.type === 'oauth-request') {
      relayOAuthRequest(message.payload as OAuthRequestMsg);
    }
    return 'handled';
  }

  if (message.source === 'offscreen') {
    console.warn('[slicc-sw] dropping offscreen message — offscreen document no longer exists');
    return 'handled';
  }

  return 'not-handled';
}
