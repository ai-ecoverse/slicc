/**
 * Tiny PCM → WAV encoder for the `say -o <file>` path.
 *
 * Encodes one or more Float32 mono PCM chunks (the shape `kokoro-engine.ts`
 * yields from `synthesizeStream`) into a single RIFF/WAVE byte buffer with
 * 16-bit signed little-endian samples. All chunks must share a sample rate;
 * the caller (the kokoro stream consumer) clamps that contract upstream.
 *
 * Pure — no DOM, no audio APIs — so it runs in any realm. The `say` command
 * uses this on both the local-realm and worker-via-panel-RPC paths.
 */

/** A mono PCM chunk in the kokoro shape. */
export interface PcmChunk {
  audio: Float32Array;
  sampleRate: number;
}

/** Standard mono 16-bit PCM WAV header is 44 bytes. */
const WAV_HEADER_BYTES = 44;
const BITS_PER_SAMPLE = 16;
const NUM_CHANNELS = 1;
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/** Clamp a Float32 sample to int16 with mid-tread rounding. */
function floatToInt16(sample: number): number {
  const s = Math.max(-1, Math.min(1, sample));
  return s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
}

/**
 * Encode mono Float32 PCM chunks (sharing one sample rate) into a single
 * 16-bit PCM WAV byte buffer. Returns a fresh `Uint8Array` whose underlying
 * `ArrayBuffer` is exactly the encoded length (safe to hand to `writeFile` or
 * post across panel-RPC without slicing).
 *
 * Throws if `chunks` is empty or chunks disagree on sample rate — the kokoro
 * stream is the only producer today and always emits one sample rate.
 */
export function encodePcmChunksToWav(chunks: readonly PcmChunk[]): Uint8Array {
  if (chunks.length === 0) {
    throw new Error('wav-encode: at least one PCM chunk is required');
  }
  const sampleRate = chunks[0].sampleRate;
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error(`wav-encode: invalid sample rate ${sampleRate}`);
  }
  let totalSamples = 0;
  for (const chunk of chunks) {
    if (chunk.sampleRate !== sampleRate) {
      throw new Error(
        `wav-encode: mixed sample rates (${chunk.sampleRate} vs ${sampleRate}) — resample upstream`
      );
    }
    totalSamples += chunk.audio.length;
  }

  const dataBytes = totalSamples * NUM_CHANNELS * BYTES_PER_SAMPLE;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  // RIFF header
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true); // chunk size = file size - 8
  writeAscii(view, 8, 'WAVE');

  // fmt subchunk (PCM, 16 bytes)
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // subchunk1Size
  view.setUint16(20, 1, true); // audioFormat = PCM
  view.setUint16(22, NUM_CHANNELS, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * NUM_CHANNELS * BYTES_PER_SAMPLE, true); // byteRate
  view.setUint16(32, NUM_CHANNELS * BYTES_PER_SAMPLE, true); // blockAlign
  view.setUint16(34, BITS_PER_SAMPLE, true);

  // data subchunk
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = WAV_HEADER_BYTES;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.audio.length; i++) {
      view.setInt16(offset, floatToInt16(chunk.audio[i]), true);
      offset += BYTES_PER_SAMPLE;
    }
  }

  return new Uint8Array(buffer);
}
