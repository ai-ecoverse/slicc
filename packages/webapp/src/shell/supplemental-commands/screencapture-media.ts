/**
 * Page-realm display capture helpers for `screencapture`.
 *
 * Still frames go through a canvas; video clips go through MediaRecorder.
 * Both paths always stop every track in `finally` so a cancelled picker or
 * a short clip does not leave the browser's display-capture slot held
 * (see issue #3233).
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
const MIN_VIDEO_DURATION_MS = 100;

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

/**
 * Capture a still frame or a timed video clip via `getDisplayMedia`.
 * Waits briefly for the document to be visible/focused before requesting
 * the picker — calling getDisplayMedia while hidden is a common source of
 * permanent-looking `InvalidStateError` failures.
 */
export async function captureDisplayMedia(
  req: DisplayCaptureRequest
): Promise<DisplayCaptureResult> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error('screen capture is not supported in this browser');
  }

  await whenDisplayCaptureReady();

  const wantAudio = req.mode === 'video' && !!req.audio;
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: wantAudio,
    });
  } catch (err) {
    throw new Error(describeDisplayCaptureError(err));
  }

  try {
    if (req.mode === 'video') {
      return await recordDisplayVideo(stream, req);
    }
    return await grabDisplayStill(stream, req);
  } finally {
    for (const t of stream.getTracks()) {
      try {
        t.stop();
      } catch {
        /* best-effort */
      }
    }
  }
}

async function grabDisplayStill(
  stream: MediaStream,
  req: DisplayStillRequest
): Promise<DisplayCaptureResult> {
  const video = await attachVideoElement(stream);
  try {
    await new Promise<void>((r) => setTimeout(r, 100));
    const width = video.videoWidth;
    const height = video.videoHeight;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get canvas context');
    ctx.drawImage(video, 0, 0, width, height);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('Failed to create image blob'))),
        req.mimeType,
        req.quality
      );
    });
    return {
      bytes: new Uint8Array(await blob.arrayBuffer()),
      mimeType: blob.type || req.mimeType,
      width,
      height,
    };
  } finally {
    video.srcObject = null;
  }
}

async function recordDisplayVideo(
  stream: MediaStream,
  req: DisplayVideoRequest
): Promise<DisplayCaptureResult> {
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('MediaRecorder is not supported in this browser');
  }
  const video = await attachVideoElement(stream);
  const width = video.videoWidth;
  const height = video.videoHeight;
  const durationMs = clampVideoDurationMs(req.durationMs);
  const mimeType = pickRecorderMime(req.mimeType);

  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0) chunks.push(ev.data);
  };
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });
  // Prefer ending early if the user clicks Stop sharing in the browser chrome.
  const trackEnded = new Promise<void>((resolve) => {
    const tracks = stream.getTracks();
    let remaining = tracks.length;
    if (remaining === 0) {
      resolve();
      return;
    }
    for (const t of tracks) {
      t.addEventListener(
        'ended',
        () => {
          remaining -= 1;
          if (remaining <= 0) resolve();
        },
        { once: true }
      );
    }
  });

  recorder.start();
  await Promise.race([new Promise<void>((r) => setTimeout(r, durationMs)), trackEnded]);
  if (recorder.state !== 'inactive') recorder.stop();
  await stopped;

  video.srcObject = null;
  const blob = new Blob(chunks, { type: mimeType });
  if (blob.size === 0) {
    throw new Error('video capture produced no data (was sharing stopped immediately?)');
  }
  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    mimeType: blob.type || mimeType,
    width,
    height,
    durationMs,
  };
}

function pickRecorderMime(preferred: string): string {
  if (MediaRecorder.isTypeSupported(preferred)) return preferred;
  for (const candidate of [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ]) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return 'video/webm';
}

async function attachVideoElement(stream: MediaStream): Promise<HTMLVideoElement> {
  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () =>
      video
        .play()
        .then(() => resolve())
        .catch(reject);
    video.onerror = () => reject(new Error('Failed to load video stream'));
  });
  return video;
}

/**
 * Prefer a visible, focused document before opening the OS picker.
 * A short bound (not the clipboard's multi-minute wait) so a backgrounded
 * SLICC tab fails fast with a clear message instead of hanging.
 */
async function whenDisplayCaptureReady(timeoutMs = 5_000): Promise<void> {
  if (typeof document === 'undefined') return;
  const visible = () =>
    typeof document.visibilityState !== 'string' || document.visibilityState === 'visible';
  const focused = typeof document.hasFocus !== 'function' ? () => true : () => document.hasFocus();

  if (visible() && focused()) return;

  await new Promise<void>((resolve) => {
    const cleanup = () => {
      window.removeEventListener('focus', onChange);
      document.removeEventListener('visibilitychange', onChange);
      clearTimeout(timer);
    };
    const onChange = () => {
      if (visible() && focused()) {
        cleanup();
        resolve();
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      // Proceed anyway — some floats never report focus correctly; the
      // subsequent getDisplayMedia will still surface InvalidStateError
      // with our clearer message if the browser refuses.
      resolve();
    }, timeoutMs);
    window.addEventListener('focus', onChange);
    document.addEventListener('visibilitychange', onChange);
    // If already ok by the time listeners attach, resolve immediately.
    onChange();
  });
}
