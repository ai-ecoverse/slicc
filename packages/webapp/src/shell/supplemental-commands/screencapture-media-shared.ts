/**
 * Pure helpers + wire types for `screencapture`. Kept free of DOM capture
 * APIs so the kernel worker can import them without pulling MediaRecorder /
 * getDisplayMedia into its eager first-load closure (bundle-size gate).
 */

export type DisplayCaptureMode = 'image' | 'video';

export interface DisplayStillRequest {
  mode: 'image';
  mimeType: string;
  quality: number;
}

export interface DisplayVideoRequest {
  mode: 'video';
  /** Preferred MediaRecorder mime (usually `video/webm`). */
  mimeType: string;
  durationMs: number;
  /** Request an audio track from getDisplayMedia when the browser allows it. */
  audio?: boolean;
}

export type DisplayCaptureRequest = DisplayStillRequest | DisplayVideoRequest;

export interface DisplayCaptureResult {
  bytes: Uint8Array;
  mimeType: string;
  width: number;
  height: number;
  durationMs?: number;
}

const DEFAULT_VIDEO_DURATION_MS = 5_000;
const MAX_VIDEO_DURATION_MS = 60_000;
export const MIN_VIDEO_DURATION_MS = 100;

/** Clamp a video duration to the supported range (default 5s, max 60s). */
export function clampVideoDurationMs(ms: number | undefined): number {
  const raw = ms ?? DEFAULT_VIDEO_DURATION_MS;
  return Math.max(MIN_VIDEO_DURATION_MS, Math.min(raw, MAX_VIDEO_DURATION_MS));
}

/**
 * Map a getDisplayMedia / MediaRecorder failure into an actionable message.
 * Chrome's bare `InvalidStateError: Invalid state` is especially opaque after
 * another tab's display capture left the slot wedged (#3233).
 */
export function describeDisplayCaptureError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : undefined;
  const message = err instanceof Error ? err.message : String(err);
  if (
    name === 'InvalidStateError' ||
    /^Invalid state$/i.test(message.trim()) ||
    /InvalidStateError/i.test(message)
  ) {
    return (
      'display capture unavailable (Invalid state): another tab or page may ' +
      'still hold a screen-share session, or this page is not focused/visible. ' +
      'Stop other getDisplayMedia captures, focus the SLICC window, and retry; ' +
      'if it stays wedged, reload the session'
    );
  }
  if (name === 'NotAllowedError' || /Permission denied|NotAllowedError/i.test(message)) {
    return 'user cancelled or permission denied';
  }
  if (name === 'NotFoundError') {
    return 'no screen, window, or tab was available to capture';
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return message || name;
  }
  return message;
}
