import type {
  CdpCommandMsg,
  CdpResponseMsg,
  ExtensionMessage,
  OAuthRequestMsg,
  OAuthResultMsg,
  TraySocketCommandMessage,
  TraySocketErrorMsg,
} from '../../webapp/src/kernel/messages.js';
import { handleCdpCommand } from './cdp-proxy-sw.js';
import { handleOAuthRequest } from './oauth-sw.js';
import { postServiceWorkerMessage, sendServiceWorkerMessage } from './sw-broadcast.js';
import type { SwMessageOutcome } from './sw-message-router.js';
import { handleTraySocketCommand, isTraySocketCommand } from './tray-socket-sw.js';

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

function relayCdpCommand(command: CdpCommandMsg): void {
  handleCdpCommand(command)
    .then((response) => postServiceWorkerMessage(response))
    .catch((err) => {
      postServiceWorkerMessage({
        type: 'cdp-response',
        id: command.id,
        error: err instanceof Error ? err.message : String(err),
      } satisfies CdpResponseMsg);
    });
}

function relayTraySocketCommand(command: TraySocketCommandMessage): void {
  handleTraySocketCommand(command).catch((err) => {
    postServiceWorkerMessage({
      type: 'tray-socket-error',
      id: command.id,
      error: err instanceof Error ? err.message : String(err),
    } satisfies TraySocketErrorMsg);
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
    const payload = message.payload;
    if (payload.type === 'cdp-command') relayCdpCommand(payload as CdpCommandMsg);
    else if (isTraySocketCommand(payload)) relayTraySocketCommand(payload);

    return 'handled';
  }

  return 'not-handled';
}
