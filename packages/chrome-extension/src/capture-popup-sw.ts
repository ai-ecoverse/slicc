/**
 * Media-capture popup window.
 *
 * Media capture (`getUserMedia` / `getDisplayMedia`) needs a *visible* surface
 * so Chrome can show its permission prompt / screen picker. Callers ask the
 * service worker to open the capture popup here (they can't call
 * `chrome.windows.create` themselves). The popup performs the capture and
 * broadcasts the bytes back over `chrome.runtime` messaging, which the
 * requesting context picks up directly (no SW relay needed for the result).
 * See `capture-popup.html` / `capture-popup.js`.
 *
 * Chrome extension API types provided by ./chrome.d.ts
 */

import type { SwMessageOutcome } from './sw-message-router.js';

interface CaptureOpenWindowMsg {
  type: 'capture-open-window';
  url: string;
  requestId?: string;
}

function isCaptureOpenWindowMsg(msg: unknown): msg is CaptureOpenWindowMsg {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'type' in msg &&
    (msg as { type?: unknown }).type === 'capture-open-window' &&
    typeof (msg as { url?: unknown }).url === 'string'
  );
}

/**
 * `chrome.runtime.onMessage` branch for `capture-open-window`. The popup posts
 * its result directly to the requester, so the reply channel is never used.
 */
export function handleCapturePopupMessage(message: unknown): SwMessageOutcome {
  if (!isCaptureOpenWindowMsg(message)) return 'not-handled';
  const requestId = message.requestId;
  chrome.windows
    .create({ url: message.url, type: 'popup', width: 360, height: 220, focused: true })
    .catch((err) => {
      console.error('[slicc-sw] Failed to open capture popup window:', err);
      // Surface the failure to the requesting context so captureViaPopup
      // rejects promptly instead of waiting out its ~5-minute timeout. The
      // success path never reaches this branch, so there is no double-send.
      if (requestId) {
        chrome.runtime
          .sendMessage({
            source: 'capture-popup',
            requestId,
            ok: false,
            error: `failed to open capture window: ${err?.message || String(err)}`,
          })
          .catch(() => {
            // Requesting context may not be listening — best effort.
          });
      }
    });
  return 'handled';
}
