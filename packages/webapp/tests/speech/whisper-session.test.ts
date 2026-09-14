import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WhisperAsr } from '../../src/speech/whisper-engine.js';
import { startWhisperSession } from '../../src/speech/whisper-session.js';

const PARTIAL_INTERVAL_MS = 2000;
const TRANSCRIBE_TIMEOUT_MS = 30000;

vi.mock('../../src/speech/audio.js', () => ({
  decodeToMono16k: async () => new Float32Array(16000),
}));

let recorders: FakeMediaRecorder[] = [];

class FakeMediaRecorder {
  state = 'recording';
  mimeType = 'audio/webm';
  ondataavailable: ((e: { data: { size: number } }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(_stream: MediaStream) {
    recorders.push(this);
  }
  start(_ts?: number): void {}
  stop(): void {
    this.state = 'inactive';
    this.onstop?.();
  }
  emitChunk(): void {
    this.ondataavailable?.({ data: { size: 3 } });
  }
}

function fakeStream(): MediaStream {
  const track = { stop: vi.fn(), kind: 'audio' } as unknown as MediaStreamTrack;
  return { getTracks: () => [track] } as unknown as MediaStream;
}

function gatedAsr() {
  const gates: Array<(text: string) => void> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const asr = {
    transcribe: vi.fn(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const text = await new Promise<string>((resolve) => gates.push(resolve));
      inFlight--;
      return text;
    }),
  } as unknown as WhisperAsr & { transcribe: ReturnType<typeof vi.fn> };
  return {
    asr,
    releaseNext: (text = 'transcript') => gates.shift()?.(text),
    get inFlight() {
      return inFlight;
    },
    get maxInFlight() {
      return maxInFlight;
    },
  };
}

beforeEach(() => {
  recorders = [];
  vi.useFakeTimers();
  (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeMediaRecorder;
  (globalThis as unknown as { Blob: unknown }).Blob = class FakeBlob {
    constructor(_parts?: unknown[], _opts?: unknown) {}
    async arrayBuffer(): Promise<ArrayBuffer> {
      return new ArrayBuffer(0);
    }
  };
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder;
  delete (globalThis as unknown as { Blob?: unknown }).Blob;
});

describe('whisper-session', () => {
  it('does not deadlock when stop() races an in-flight partial, and never overlaps transcribe', async () => {
    const gate = gatedAsr();
    const handle = await startWhisperSession(gate.asr, { stream: fakeStream() });
    recorders[0].emitChunk();

    await vi.advanceTimersByTimeAsync(PARTIAL_INTERVAL_MS);
    expect(gate.inFlight).toBe(1);

    const stopped = handle.stop();
    await vi.advanceTimersByTimeAsync(0);
    gate.releaseNext('partial');
    await vi.advanceTimersByTimeAsync(0);
    gate.releaseNext('final');

    await expect(stopped).resolves.toBe('final');
    expect(gate.maxInFlight).toBe(1);
  });

  it('settles to "" and reports onError when the final transcribe never resolves', async () => {
    const gate = gatedAsr();
    const onError = vi.fn();
    const handle = await startWhisperSession(gate.asr, { stream: fakeStream(), onError });
    recorders[0].emitChunk();

    const stopped = handle.stop();

    await vi.advanceTimersByTimeAsync(TRANSCRIBE_TIMEOUT_MS);

    await expect(stopped).resolves.toBe('');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatch(/timed out/);
  });

  it('returns the final transcript on the happy path with chunks present', async () => {
    const gate = gatedAsr();
    const handle = await startWhisperSession(gate.asr, { stream: fakeStream() });
    recorders[0].emitChunk();

    const stopped = handle.stop();
    await vi.advanceTimersByTimeAsync(0);
    gate.releaseNext('hello world');

    await expect(stopped).resolves.toBe('hello world');
  });

  it('returns "" without transcribing when no chunks were captured', async () => {
    const gate = gatedAsr();
    const handle = await startWhisperSession(gate.asr, { stream: fakeStream() });

    await expect(handle.stop()).resolves.toBe('');
    expect(gate.asr.transcribe).not.toHaveBeenCalled();
  });

  it('normalizes the "default" deviceId to audio:true, not an exact constraint (EXT2)', async () => {
    const getUserMedia = vi.fn(async () => fakeStream());
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    try {
      const gate = gatedAsr();
      const handle = await startWhisperSession(gate.asr, { deviceId: 'default' });

      expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
      handle.cancel();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('pins an exact constraint for a real specific deviceId', async () => {
    const getUserMedia = vi.fn(async () => fakeStream());
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    try {
      const gate = gatedAsr();
      const handle = await startWhisperSession(gate.asr, { deviceId: 'usb-mic' });
      expect(getUserMedia).toHaveBeenCalledWith({ audio: { deviceId: { exact: 'usb-mic' } } });
      handle.cancel();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
