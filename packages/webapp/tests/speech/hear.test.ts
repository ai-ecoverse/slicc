/**
 * Page-side `hear` module — microphone acquisition must funnel through the
 * leader `<slicc-permissions>` surface so every voice input shares one
 * prompt. The unit-tested seam is `setHearDepsForTests`; the real wiring
 * resolves the surface through `wc-permissions-registry`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type HearPermissionSurface,
  hearCapture,
  resetHearDepsForTests,
  setHearDepsForTests,
} from '../../src/speech/hear.js';

interface FakeRecognitionEvents {
  onresult?: (event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void;
  onerror?: (event: { error: string }) => void;
  onend?: () => void;
}

let recognitionInstances: Array<{ instance: FakeRecognitionEvents; started: boolean }> = [];
let mediaRecorderInstances: Array<{ stop: () => void; state: string }> = [];

function fakeStream(): MediaStream {
  const track = { stop: vi.fn(), kind: 'audio' } as unknown as MediaStreamTrack;
  return {
    getTracks: () => [track],
  } as unknown as MediaStream;
}

function installRecognitionShim(transcript: string) {
  class FakeRecognition implements FakeRecognitionEvents {
    continuous = false;
    interimResults = false;
    lang = '';
    onresult: FakeRecognitionEvents['onresult'] = undefined;
    onerror: FakeRecognitionEvents['onerror'] = undefined;
    onend: FakeRecognitionEvents['onend'] = undefined;
    start(): void {
      recognitionInstances[recognitionInstances.length - 1].started = true;
      // Simulate one final result then a natural end.
      queueMicrotask(() => {
        this.onresult?.({ results: [[{ transcript }]] });
        this.onend?.();
      });
    }
    stop(): void {
      this.onend?.();
    }
    constructor() {
      recognitionInstances.push({ instance: this, started: false });
    }
  }
  (globalThis as unknown as { webkitSpeechRecognition: unknown }).webkitSpeechRecognition =
    FakeRecognition;
  (globalThis as unknown as { window: unknown }).window = globalThis;
}

function installMediaRecorderShim(): void {
  class FakeMediaRecorder {
    state = 'recording';
    mimeType = 'audio/webm';
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    constructor(_stream: MediaStream) {
      mediaRecorderInstances.push(this);
    }
    start(_ts?: number): void {
      queueMicrotask(() => {
        this.ondataavailable?.({
          data: new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }),
        });
      });
    }
    stop(): void {
      this.state = 'inactive';
      this.onstop?.();
    }
  }
  (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeMediaRecorder;
  (globalThis as unknown as { Blob: unknown }).Blob ??= class FakeBlob {
    constructor(_parts?: unknown[], _opts?: unknown) {}
  };
}

function makeSurface(
  result: Awaited<ReturnType<HearPermissionSurface['prompt']>>
): HearPermissionSurface & { prompt: ReturnType<typeof vi.fn> } {
  const prompt = vi.fn(async () => result);
  return { prompt } as HearPermissionSurface & { prompt: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  recognitionInstances = [];
  mediaRecorderInstances = [];
});

afterEach(() => {
  resetHearDepsForTests();
  delete (globalThis as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
  delete (globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder;
});

describe('hearCapture', () => {
  it('drives the leader <slicc-permissions> prompt on the builtin path (acquire-and-release)', async () => {
    installRecognitionShim('hello world');
    const stream = fakeStream();
    const surface = makeSurface({
      status: 'granted',
      grants: [{ kind: 'microphone', stream }],
    });
    setHearDepsForTests({ getPermissionSurface: () => surface });

    const result = await hearCapture({ engine: 'builtin' });

    expect(result).toEqual({ transcript: 'hello world', engine: 'builtin' });
    expect(surface.prompt).toHaveBeenCalledTimes(1);
    const call = surface.prompt.mock.calls[0][0] as {
      kinds: ReadonlyArray<string>;
      description?: string;
      requestOptions?: { microphone?: { constraints?: MediaStreamConstraints } };
    };
    expect(call.kinds).toEqual(['microphone']);
    expect(call.description).toMatch(/microphone/i);
    // Probe-and-release: the prime-permission path stops the granted tracks
    // so the builtin recognizer opens its own (now permission-cleared) mic.
    expect(stream.getTracks()[0].stop).toHaveBeenCalledTimes(1);
  });

  it('threads deviceId into the prompt request options', async () => {
    installRecognitionShim('words');
    const surface = makeSurface({
      status: 'granted',
      grants: [{ kind: 'microphone', stream: fakeStream() }],
    });
    setHearDepsForTests({ getPermissionSurface: () => surface });

    await hearCapture({ engine: 'builtin', deviceId: 'usb-mic' });

    const call = surface.prompt.mock.calls[0][0] as {
      requestOptions?: { microphone?: { constraints?: MediaStreamConstraints } };
    };
    expect(call.requestOptions?.microphone?.constraints).toEqual({
      audio: { deviceId: { exact: 'usb-mic' } },
    });
  });

  it('rejects cleanly when the surface denies the prompt (no hang)', async () => {
    installRecognitionShim('never reached');
    const surface = makeSurface({
      status: 'cancelled',
      grants: [],
      reason: 'cancelled',
    });
    setHearDepsForTests({ getPermissionSurface: () => surface });

    await expect(hearCapture({ engine: 'builtin' })).rejects.toThrow(/permission cancelled/);
    // The recognizer must NOT start on a denied prompt.
    expect(recognitionInstances.length).toBe(0);
  });

  it('skips the prime-permission step when no leader surface is mounted', async () => {
    installRecognitionShim('legacy words');
    setHearDepsForTests({ getPermissionSurface: () => null });

    // Without a surface the builtin path lets the recognizer drive its own
    // browser-level prompt (legacy / headless realm compatibility): hearCapture
    // must NOT throw at the prime step just because there's no surface.
    const result = await hearCapture({ engine: 'builtin' });
    expect(result.engine).toBe('builtin');
    expect(result.transcript).toBe('legacy words');
  });
});
