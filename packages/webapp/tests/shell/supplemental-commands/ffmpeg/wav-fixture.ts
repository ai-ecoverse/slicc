/**
 * Synthetic 16-bit PCM WAV files for media tests. PCM is the one codec
 * mediabunny decodes and encodes without WebCodecs, so a WAV round trip
 * exercises the whole read → convert → write pipeline under Node.
 */

export interface WavSpec {
  sampleRate?: number;
  channels?: number;
  seconds?: number;
  frequencyHz?: number;
}

export function makeWav(spec: WavSpec = {}): Uint8Array<ArrayBuffer> {
  const sampleRate = spec.sampleRate ?? 44100;
  const channels = spec.channels ?? 2;
  const seconds = spec.seconds ?? 0.25;
  const frequency = spec.frequencyHz ?? 440;
  const frames = Math.round(sampleRate * seconds);
  const dataBytes = frames * channels * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    const sample = Math.round(Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 12000);
    for (let c = 0; c < channels; c++) {
      view.setInt16(offset, sample, true);
      offset += 2;
    }
  }
  return new Uint8Array(buf);
}

/** Header fields of a 16-bit PCM WAV produced by mediabunny or ffmpeg. */
export function readWavHeader(bytes: Uint8Array): {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataBytes: number;
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(...bytes.subarray(o, o + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV');
  let offset = 12;
  let fmt: { channels: number; sampleRate: number; bitsPerSample: number } | null = null;
  let dataBytes = -1;
  while (offset + 8 <= bytes.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ') {
      fmt = {
        channels: view.getUint16(offset + 10, true),
        sampleRate: view.getUint32(offset + 12, true),
        bitsPerSample: view.getUint16(offset + 22, true),
      };
    } else if (id === 'data') {
      dataBytes = size;
    }
    offset += 8 + size + (size % 2);
  }
  if (!fmt || dataBytes < 0) throw new Error('WAV without fmt/data chunks');
  return { ...fmt, dataBytes };
}
