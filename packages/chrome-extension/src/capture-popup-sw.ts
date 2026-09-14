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

export function handleCapturePopupMessage(message: unknown): SwMessageOutcome {
  if (!isCaptureOpenWindowMsg(message)) return 'not-handled';
  const requestId = message.requestId;
  chrome.windows
    .create({ url: message.url, type: 'popup', width: 360, height: 220, focused: true })
    .catch((err) => {
      console.error('[slicc-sw] Failed to open capture popup window:', err);

      if (requestId) {
        chrome.runtime
          .sendMessage({
            source: 'capture-popup',
            requestId,
            ok: false,
            error: `failed to open capture window: ${err?.message || String(err)}`,
          })
          .catch(() => {});
      }
    });
  return 'handled';
}
