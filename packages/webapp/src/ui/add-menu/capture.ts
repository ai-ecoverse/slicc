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
  prefix: 'screenshot'
): Promise<File | null> {
  try {
    const w = video.videoWidth || 1280;
    const h = video.videoHeight || 720;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, w, h);
    const blob: Blob | null = await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/png')
    );
    if (!blob) return null;
    return new File([blob], `${prefix}-${Date.now()}.png`, { type: 'image/png' });
  } finally {
    stopStream(stream);
  }
}

async function streamToFile(stream: MediaStream): Promise<File | null> {
  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  // A failed play() can still yield a blank frame below, so surface it
  // rather than swallowing silently — but don't abort the capture.
  await video.play().catch((err) => {
    log.warn('Screenshot video.play() failed; frame may be blank', { error: String(err) });
  });
  // Wait for the first decoded frame before grabbing. `loadeddata` fires once
  // readyState reaches HAVE_CURRENT_DATA (≥ 2); fall back after 2 s so a
  // stalled stream cannot hang the capture forever.
  await new Promise<void>((resolve) => {
    if (video.readyState >= 2) {
      resolve();
      return;
    }
    const done = (): void => resolve();
    video.addEventListener('loadeddata', done, { once: true });
    setTimeout(done, 2000);
  });
  await new Promise((r) => requestAnimationFrame(() => r(null)));
  return grabFrameToFile(stream, video, 'screenshot');
}

/** Capture a still of the user's screen via the native picker. Returns null
 *  on denial/cancel. MUST be called synchronously from a user gesture. */
export async function captureScreenshot(): Promise<File | null> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
  } catch (err) {
    log.info('Screenshot capture cancelled/denied', { error: String(err) });
    return null;
  }
  return streamToFile(stream);
}
