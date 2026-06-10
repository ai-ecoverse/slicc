import { createLogger } from '../../core/logger.js';

const log = createLogger('add-menu-capture');

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

/** Draw the current video frame to a canvas and return it as a PNG File.
 *  Always stops the stream's tracks. Exported for testing. */
export async function grabFrameToFile(
  stream: MediaStream,
  video: HTMLVideoElement,
  prefix: 'photo' | 'screenshot'
): Promise<File | null> {
  try {
    const w = video.videoWidth || 1280;
    const h = video.videoHeight || 720;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx?.drawImage(video, 0, 0, w, h);
    const blob: Blob | null = await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/png')
    );
    if (!blob) return null;
    return new File([blob], `${prefix}-${Date.now()}.png`, { type: 'image/png' });
  } finally {
    stopStream(stream);
  }
}

async function streamToFile(
  stream: MediaStream,
  prefix: 'photo' | 'screenshot'
): Promise<File | null> {
  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  await video.play().catch(() => {});
  await new Promise((r) => requestAnimationFrame(() => r(null)));
  return grabFrameToFile(stream, video, prefix);
}

/** Capture a still from the webcam. Returns null on denial/cancel. MUST be
 *  called synchronously from a user gesture. */
export async function capturePhoto(): Promise<File | null> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: true });
  } catch (err) {
    log.info('Photo capture cancelled/denied', { error: String(err) });
    return null;
  }
  return streamToFile(stream, 'photo');
}

/** Capture a still of the user's screen via the native picker. Returns null
 *  on denial/cancel. MUST be called synchronously from a user gesture. */
export async function captureScreenshot(): Promise<File | null> {
  let stream: MediaStream;
  try {
    stream = await (
      navigator.mediaDevices as MediaDevices & {
        getDisplayMedia(c?: DisplayMediaStreamOptions): Promise<MediaStream>;
      }
    ).getDisplayMedia({ video: true });
  } catch (err) {
    log.info('Screenshot capture cancelled/denied', { error: String(err) });
    return null;
  }
  return streamToFile(stream, 'screenshot');
}
