import {
  clampVideoDurationMs,
  type DisplayCaptureRequest,
  type DisplayCaptureResult,
  type DisplaySessionFrameRequest,
  type DisplaySessionRecordRequest,
  type DisplaySessionStartRequest,
  type DisplaySessionStopRequest,
  type DisplayStillRequest,
  type DisplayVideoRequest,
  describeDisplayCaptureError,
  fitDisplaySize,
  MIN_VIDEO_DURATION_MS,
} from './screencapture-media-shared.js';

export type {
  DisplayCaptureMode,
  DisplayCaptureRequest,
  DisplayCaptureResult,
  DisplaySessionFrameRequest,
  DisplaySessionRecordRequest,
  DisplaySessionStartRequest,
  DisplaySessionStopRequest,
  DisplayStillRequest,
  DisplayVideoRequest,
} from './screencapture-media-shared.js';
export {
  clampVideoDurationMs,
  describeDisplayCaptureError,
  fitDisplaySize,
  MIN_VIDEO_DURATION_MS,
  SCREENCAPTURE_SESSION_ENDED_CHANNEL,
  sessionCaptureRequest,
} from './screencapture-media-shared.js';

interface LiveDisplaySession {
  handle: string;
  stream: MediaStream;
  video: HTMLVideoElement;
}

export class DisplaySessionStore {
  private readonly sessions = new Map<string, LiveDisplaySession>();
  private readonly endedListeners = new Set<(handle: string) => void>();
  private nextId = 1;
  private unloadHooked = false;

  ids(): string[] {
    return [...this.sessions.keys()];
  }

  get(handle: string): LiveDisplaySession | undefined {
    return this.sessions.get(handle);
  }

  add(stream: MediaStream, video: HTMLVideoElement): string {
    const handle = `screen${this.nextId++}`;
    this.sessions.set(handle, { handle, stream, video });
    this.hookUnload();
    for (const track of stream.getTracks()) {
      track.addEventListener(
        'ended',
        () => {
          this.stop(handle);
        },
        { once: true }
      );
    }
    return handle;
  }

  stop(handle: string): boolean {
    const session = this.sessions.get(handle);
    if (!session) return false;
    this.sessions.delete(handle);
    session.video.srcObject = null;
    stopMediaStreamTracks(session.stream);
    this.notifyEnded(handle);
    return true;
  }

  onEnded(listener: (handle: string) => void): () => void {
    this.endedListeners.add(listener);
    return () => {
      this.endedListeners.delete(listener);
    };
  }

  stopAll(): void {
    for (const handle of [...this.sessions.keys()]) this.stop(handle);
  }

  private hookUnload(): void {
    if (this.unloadHooked || typeof window === 'undefined') return;
    this.unloadHooked = true;
    window.addEventListener('pagehide', () => {
      this.stopAll();
    });
  }

  private notifyEnded(handle: string): void {
    for (const listener of [...this.endedListeners]) {
      try {
        listener(handle);
      } catch {}
    }
  }
}

export const displaySessions = new DisplaySessionStore();

export function stopMediaStreamTracks(stream: { getTracks(): Array<{ stop(): void }> }): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {}
  }
}

export async function captureDisplayMedia(
  req: DisplayCaptureRequest
): Promise<DisplayCaptureResult> {
  if (req.mode === 'session') {
    return runDisplaySession(req);
  }
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
    stopMediaStreamTracks(stream);
  }
}

async function runDisplaySession(
  req:
    | DisplaySessionStartRequest
    | DisplaySessionFrameRequest
    | DisplaySessionStopRequest
    | DisplaySessionRecordRequest
): Promise<DisplayCaptureResult> {
  if (req.action === 'start') return startDisplaySession();
  if (req.action === 'frame') return frameDisplaySession(req);
  if (req.action === 'record') return recordDisplaySession(req);
  const stopped = displaySessions.stop(req.handle);
  if (!stopped) throw new Error(`no screen-share session '${req.handle}'`);
  return {
    bytes: new Uint8Array(0),
    mimeType: 'application/octet-stream',
    width: 0,
    height: 0,
    handle: req.handle,
  };
}

async function startDisplaySession(): Promise<DisplayCaptureResult> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error('screen capture is not supported in this browser');
  }
  await whenDisplayCaptureReady();
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false,
    });
  } catch (err) {
    throw new Error(describeDisplayCaptureError(err));
  }
  return adoptDisplayStream(stream);
}

export async function adoptDisplayStream(stream: MediaStream): Promise<DisplayCaptureResult> {
  let video: HTMLVideoElement;
  try {
    video = await attachVideoElement(stream);
    await new Promise<void>((r) => setTimeout(r, 100));
  } catch (err) {
    stopMediaStreamTracks(stream);
    throw err;
  }
  const handle = displaySessions.add(stream, video);
  return {
    bytes: new Uint8Array(0),
    mimeType: 'application/octet-stream',
    width: video.videoWidth,
    height: video.videoHeight,
    handle,
  };
}

async function frameDisplaySession(req: DisplaySessionFrameRequest): Promise<DisplayCaptureResult> {
  const session = displaySessions.get(req.handle);
  if (!session) throw new Error(`no screen-share session '${req.handle}'`);
  return grabStillFromVideo(session.video, {
    mimeType: req.mimeType ?? 'image/jpeg',
    quality: req.quality ?? 0.7,
    maxWidth: req.maxWidth,
  });
}

async function recordDisplaySession(
  req: DisplaySessionRecordRequest
): Promise<DisplayCaptureResult> {
  const session = displaySessions.get(req.handle);
  if (!session) throw new Error(`no screen-share session '${req.handle}'`);
  return recordDisplayVideo(session.stream, {
    mode: 'video',
    mimeType: req.mimeType ?? 'video/webm',
    durationMs: req.durationMs,
  });
}

async function grabDisplayStill(
  stream: MediaStream,
  req: DisplayStillRequest
): Promise<DisplayCaptureResult> {
  const video = await attachVideoElement(stream);
  try {
    await new Promise<void>((r) => setTimeout(r, 100));
    return await grabStillFromVideo(video, {
      mimeType: req.mimeType,
      quality: req.quality,
    });
  } finally {
    video.srcObject = null;
  }
}

async function grabStillFromVideo(
  video: HTMLVideoElement,
  opts: { mimeType: string; quality: number; maxWidth?: number }
): Promise<DisplayCaptureResult> {
  const nativeW = video.videoWidth;
  const nativeH = video.videoHeight;
  const { width, height } = fitDisplaySize(nativeW, nativeH, opts.maxWidth);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get canvas context');
  ctx.drawImage(video, 0, 0, width, height);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Failed to create image blob'))),
      opts.mimeType,
      opts.quality
    );
  });
  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    mimeType: blob.type || opts.mimeType,
    width,
    height,
    nativeWidth: nativeW,
    nativeHeight: nativeH,
  };
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

  const startedAt = Date.now();
  recorder.start();
  await Promise.race([new Promise<void>((r) => setTimeout(r, durationMs)), trackEnded]);
  if (recorder.state !== 'inactive') recorder.stop();
  await stopped;

  const elapsedMs = Math.max(MIN_VIDEO_DURATION_MS, Date.now() - startedAt);

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
    durationMs: Math.min(elapsedMs, durationMs),
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

      resolve();
    }, timeoutMs);
    window.addEventListener('focus', onChange);
    document.addEventListener('visibilitychange', onChange);

    onChange();
  });
}
