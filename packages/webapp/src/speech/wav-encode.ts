export interface PcmChunk {
  audio: Float32Array;
  sampleRate: number;
}

const WAV_HEADER_BYTES = 44;
const BITS_PER_SAMPLE = 16;
const NUM_CHANNELS = 1;
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

function floatToInt16(sample: number): number {
  const s = Math.max(-1, Math.min(1, sample));
  return s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
}

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

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');

  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, NUM_CHANNELS, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * NUM_CHANNELS * BYTES_PER_SAMPLE, true);
  view.setUint16(32, NUM_CHANNELS * BYTES_PER_SAMPLE, true);
  view.setUint16(34, BITS_PER_SAMPLE, true);

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
