/**
 * Audio decode/resample helpers for the speech stack. Whisper consumes
 * 16 kHz mono Float32 PCM; the browser hands us encoded containers (webm
 * from MediaRecorder, wav/mp3/ogg from `hear -i` files). Page-realm only —
 * decoding needs `AudioContext` / `OfflineAudioContext`.
 */

/** The sample rate whisper models expect. */
export const WHISPER_SAMPLE_RATE = 16000;

/**
 * Decode an encoded audio container to 16 kHz mono Float32 PCM. Channel
 * downmix and resampling both happen in one `OfflineAudioContext` render.
 */
export async function decodeToMono16k(bytes: ArrayBuffer): Promise<Float32Array> {
  if (typeof AudioContext === 'undefined' || typeof OfflineAudioContext === 'undefined') {
    throw new Error('audio decoding requires a window/page realm (AudioContext unavailable)');
  }
  const probe = new AudioContext();
  let decoded: AudioBuffer;
  try {
    // decodeAudioData detaches the buffer — hand it a private copy.
    decoded = await probe.decodeAudioData(bytes.slice(0));
  } finally {
    await probe.close().catch(() => {});
  }

  const frames = Math.max(1, Math.ceil(decoded.duration * WHISPER_SAMPLE_RATE));
  const offline = new OfflineAudioContext(1, frames, WHISPER_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  // Copy out of the rendering context's buffer so it can be GC'd.
  return rendered.getChannelData(0).slice(0);
}
