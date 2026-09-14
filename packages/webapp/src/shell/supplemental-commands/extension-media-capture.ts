import { uint8ToBase64 } from '@slicc/shared-ts';
import { isExtensionRealm } from '../../base/runtime-env.js';

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

export function isExtensionFloat(): boolean {
  return isExtensionRealm();
}

function parseCaptureResult(msg: CapturePopupResultMessage): PopupCaptureResult {
  return {
    bytes: base64Decode(msg.bytesBase64!),
    mimeType: msg.mimeType ?? 'application/octet-stream',
    width: msg.width ?? 0,
    height: msg.height ?? 0,
    ...(typeof msg.durationMs === 'number' ? { durationMs: msg.durationMs } : {}),
  };
}

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
      } catch {}
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
      try {
        chrome.runtime.sendMessage({ target: 'capture-popup', type: 'capture-abort', requestId });
      } catch {}
      cleanup();
      reject(new Error('media capture timed out waiting for the capture window'));
    }, timeoutMs);

    chrome.runtime.onMessage.addListener(listener);

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
  return uint8ToBase64(new TextEncoder().encode(s))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64Decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
