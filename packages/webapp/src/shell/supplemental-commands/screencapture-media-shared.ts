/**
 * Pure helpers + wire types for `screencapture`. Kept free of DOM capture
 * APIs so the kernel worker can import them without pulling MediaRecorder /
 * getDisplayMedia into its eager first-load closure (bundle-size gate).
 */

export type DisplayCaptureMode = 'image' | 'video' | 'session';

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

/** Open a persistent getDisplayMedia session; tracks stay alive until `stop`. */
export interface DisplaySessionStartRequest {
  mode: 'session';
  action: 'start';
}

/** Grab a still off a live session track, honouring `maxWidth`. */
export interface DisplaySessionFrameRequest {
  mode: 'session';
  action: 'frame';
  handle: string;
  maxWidth?: number;
  mimeType?: string;
  quality?: number;
}

/** End a live session and stop every track. */
export interface DisplaySessionStopRequest {
  mode: 'session';
  action: 'stop';
  handle: string;
}

/**
 * Record a timed clip from an existing session's track (no fresh picker).
 * Used by `computer record` on the `screen` kind.
 */
export interface DisplaySessionRecordRequest {
  mode: 'session';
  action: 'record';
  handle: string;
  durationMs: number;
  mimeType?: string;
}

export type DisplayCaptureRequest =
  | DisplayStillRequest
  | DisplayVideoRequest
  | DisplaySessionStartRequest
  | DisplaySessionFrameRequest
  | DisplaySessionStopRequest
  | DisplaySessionRecordRequest;

export interface DisplayCaptureResult {
  bytes: Uint8Array;
  mimeType: string;
  width: number;
  height: number;
  durationMs?: number;
  /** Session handle returned by `action: 'start'` (and echoed by stop). */
  handle?: string;
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
      "`computer ls` lists a live `screen` computer if one holds this page's " +
      'display slot — `computer rm` it to stop the tracks. Otherwise stop ' +
      'other getDisplayMedia captures, focus the SLICC window, and retry; ' +
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

/** Fit a native capture size into `maxWidth`, preserving aspect ratio. */
export function fitDisplaySize(
  width: number,
  height: number,
  maxWidth?: number
): { width: number; height: number } {
  if (!maxWidth || width <= maxWidth || width <= 0) return { width, height };
  const scale = maxWidth / width;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export interface DisplayCaptureRpcPayload {
  mimeType: string;
  quality: number;
  durationMs?: number;
  session?: 'start' | 'frame' | 'stop' | 'record';
  handle?: string;
  maxWidth?: number;
}

/**
 * Build a `session` DisplayCaptureRequest from the panel-RPC payload.
 * Throws when `session` is missing or a handle is required but absent.
 */
export function sessionCaptureRequest(
  payload: DisplayCaptureRpcPayload
):
  | DisplaySessionStartRequest
  | DisplaySessionFrameRequest
  | DisplaySessionStopRequest
  | DisplaySessionRecordRequest {
  const action = payload.session;
  if (action === 'start') return { mode: 'session', action: 'start' };
  if (action !== 'frame' && action !== 'stop' && action !== 'record') {
    throw new Error('screencapture session requires action start|frame|stop|record');
  }
  if (!payload.handle) {
    throw new Error(`screencapture session ${action} requires handle`);
  }
  if (action === 'frame') {
    return {
      mode: 'session',
      action: 'frame',
      handle: payload.handle,
      maxWidth: payload.maxWidth,
      mimeType: payload.mimeType,
      quality: payload.quality,
    };
  }
  if (action === 'stop') return { mode: 'session', action: 'stop', handle: payload.handle };
  if (action === 'record') {
    return {
      mode: 'session',
      action: 'record',
      handle: payload.handle,
      durationMs: payload.durationMs ?? 5_000,
      mimeType: payload.mimeType,
    };
  }
  throw new Error('screencapture session requires action start|frame|stop|record');
}

/** Page → worker channel when a display-share session ends (Stop sharing / rm). */
export const SCREENCAPTURE_SESSION_ENDED_CHANNEL = 'screencapture-session-ended';
