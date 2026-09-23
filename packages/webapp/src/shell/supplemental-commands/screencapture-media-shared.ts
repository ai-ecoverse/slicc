export type DisplayCaptureMode = 'image' | 'video' | 'session';

export interface DisplayStillRequest {
  mode: 'image';
  mimeType: string;
  quality: number;
}

export interface DisplayVideoRequest {
  mode: 'video';

  mimeType: string;
  durationMs: number;

  audio?: boolean;
}

export interface DisplaySessionStartRequest {
  mode: 'session';
  action: 'start';
}

export interface DisplaySessionFrameRequest {
  mode: 'session';
  action: 'frame';
  handle: string;
  maxWidth?: number;
  mimeType?: string;
  quality?: number;
}

export interface DisplaySessionStopRequest {
  mode: 'session';
  action: 'stop';
  handle: string;
}

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

  nativeWidth?: number;
  nativeHeight?: number;
  durationMs?: number;

  handle?: string;
}

const DEFAULT_VIDEO_DURATION_MS = 5_000;
const MAX_VIDEO_DURATION_MS = 60_000;
export const MIN_VIDEO_DURATION_MS = 100;

export function clampVideoDurationMs(ms: number | undefined): number {
  const raw = ms ?? DEFAULT_VIDEO_DURATION_MS;
  return Math.max(MIN_VIDEO_DURATION_MS, Math.min(raw, MAX_VIDEO_DURATION_MS));
}

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

export const SCREENCAPTURE_SESSION_ENDED_CHANNEL = 'screencapture-session-ended';
