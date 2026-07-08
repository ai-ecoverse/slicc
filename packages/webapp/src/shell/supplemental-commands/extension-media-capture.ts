/**
 * Extension media-capture popup bridge.
 *
 * Media capture (`getUserMedia` / `getDisplayMedia`) needs a *visible* surface
 * so Chrome can show its permission prompt / screen picker. In extension mode
 * the shell command runs in the offscreen document (or the side-panel shell);
 * the offscreen document in particular has no visible window, so capturing
 * directly there silently fails. This module routes the capture through a small
 * popup window (`capture-popup.html`, modeled on `voice-popup`) that performs
 * the capture in a real window and posts the bytes back over `chrome.runtime`
 * messaging.
 *
 * The popup is opened by the service worker (offscreen documents can't call
 * `chrome.windows.create`); the resulting bytes broadcast back to every
 * extension context, and this module's listener picks out its own request by
 * id. CLI / standalone floats never reach this code — `isExtensionFloat()`
 * gates it — so the page-served origin's auto-granted capture path is
 * unchanged.
 */

import { isExtensionRealm } from '../../core/runtime-env.js';

/** Camera / mic capture request forwarded to the popup. */
export interface PopupCameraCaptureRequest {
  kind: 'camera';
  mode: 'photo' | 'video';
  deviceId?: string;
  audioDeviceId?: string;
  captureAudio?: boolean;
  captureVideo?: boolean;
  width?: number;
  height?: number;
  frameRate?: number;
  exactSize?: boolean;
  mimeType: string;
  quality?: number;
  durationMs?: number;
  warmupMs?: number;
}

/** Screen capture request forwarded to the popup. */
export interface PopupScreenCaptureRequest {
  kind: 'screen';
  mimeType: string;
  quality: number;
}

export type PopupCaptureRequest = PopupCameraCaptureRequest | PopupScreenCaptureRequest;

export interface PopupCaptureResult {
  bytes: Uint8Array;
  mimeType: string;
  width: number;
  height: number;
  durationMs?: number;
}

interface CapturePopupResultMessage {
  source: 'capture-popup';
  requestId: string;
  ok: boolean;
  bytesBase64?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  error?: string;
}

/** True when running inside the Chrome extension runtime (panel or offscreen). */
export function isExtensionFloat(): boolean {
  return isExtensionRealm();
}

/** Parse a successful capture-popup result message into a PopupCaptureResult. */
function parseCaptureResult(msg: CapturePopupResultMessage): PopupCaptureResult {
  return {
    bytes: base64Decode(msg.bytesBase64!),
    mimeType: msg.mimeType ?? 'application/octet-stream',
    width: msg.width ?? 0,
    height: msg.height ?? 0,
    ...(typeof msg.durationMs === 'number' ? { durationMs: msg.durationMs } : {}),
  };
}

/**
 * Open the capture popup, run the requested capture there, and resolve with
 * the captured bytes. Rejects on capture error, popup failure, or timeout.
 *
 * The generous default timeout matches the camera/screencapture commands: the
 * user may take a while to click "Allow" or pick a capture target.
 */
export async function captureViaPopup(
  request: PopupCaptureRequest,
  opts: { timeoutMs?: number } = {}
): Promise<PopupCaptureResult> {
  if (!isExtensionRealm()) {
    throw new Error('media capture popup requires the extension runtime');
  }
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const requestId = newRequestId();
  const encoded = base64UrlEncode(JSON.stringify({ ...request, requestId }));
  const url = chrome.runtime.getURL(`capture-popup.html?req=${encoded}`);

  return await new Promise<PopupCaptureResult>((resolve, reject) => {
    let settled = false;

    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        chrome.runtime.onMessage.removeListener(listener);
      } catch {
        /* noop */
      }
    };

    const listener = (message: unknown): void => {
      const msg = message as CapturePopupResultMessage | undefined;
      if (msg?.source !== 'capture-popup' || msg.requestId !== requestId) return;
      cleanup();
      if (msg.ok && msg.bytesBase64 !== undefined) {
        try {
          resolve(parseCaptureResult(msg));
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      } else {
        reject(new Error(msg.error || 'media capture failed'));
      }
    };

    const timer = setTimeout(() => {
      // Ask the popup to close itself, then surface the timeout.
      try {
        chrome.runtime.sendMessage({ target: 'capture-popup', type: 'capture-abort', requestId });
      } catch {
        /* noop */
      }
      cleanup();
      reject(new Error('media capture timed out waiting for the capture window'));
    }, timeoutMs);

    chrome.runtime.onMessage.addListener(listener);

    // Offscreen documents can't open windows; ask the service worker to.
    try {
      chrome.runtime.sendMessage({ type: 'capture-open-window', url, requestId });
    } catch (err) {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function newRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `cap-${crypto.randomUUID()}`;
  }
  return `cap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function base64UrlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64Decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
