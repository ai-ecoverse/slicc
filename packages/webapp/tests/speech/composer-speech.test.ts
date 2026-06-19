import type {
  ComposerSpeech,
  SpeechEngineStatus,
  SpeechSession,
} from '@slicc/webcomponents/composer/speech';
import { describe, expect, it, vi } from 'vitest';
import {
  createComposerSpeech,
  type MicPermissionSurface,
} from '../../src/speech/composer-speech.js';
import type { WhisperAsr, WhisperProgress } from '../../src/speech/whisper-engine.js';

/** Build a fake `<slicc-permissions>` slice that hands back a stub stream. */
function fakeSurface(
  grant: { kind: 'microphone'; stream: MediaStream } | null = {
    kind: 'microphone',
    stream: fakeStream(),
  }
) {
  const surface = {
    request: vi.fn(async (_kind: 'microphone', _opts?: unknown) => grant),
  } satisfies MicPermissionSurface;
  return surface;
}

/** A pretend `MediaStream` carrying one stoppable audio track. */
function fakeStream(): MediaStream {
  const stop = vi.fn();
  const track = { stop, kind: 'audio' } as unknown as MediaStreamTrack;
  return {
    getTracks: () => [track],
    // Cast: tests only touch getTracks; rest of MediaStream is irrelevant.
  } as unknown as MediaStream;
}

function stubSession(transcript: string): SpeechSession {
  return { stop: async () => transcript, cancel: () => {} };
}

function stubBuiltin(): ComposerSpeech & { startCalls: number } {
  const stub = {
    startCalls: 0,
    permission: vi.fn().mockResolvedValue('granted' as PermissionState),
    requestPermission: vi.fn().mockResolvedValue(true),
    microphones: vi.fn().mockResolvedValue([{ deviceId: 'default', label: 'Mic' }]),
    start: vi.fn(async () => {
      stub.startCalls++;
      return stubSession('builtin words');
    }),
    status: (): SpeechEngineStatus => ({ engine: 'builtin', state: 'idle' }),
    onStatus: (cb: (s: SpeechEngineStatus) => void) => {
      cb({ engine: 'builtin', state: 'idle' });
      return () => {};
    },
    warmup: () => {},
  };
  return stub;
}

/** A manually-resolvable whisper loader that exposes its progress callback. */
function deferredLoader() {
  let resolve!: (asr: WhisperAsr) => void;
  let reject!: (err: Error) => void;
  let progress: WhisperProgress | null = null;
  const promise = new Promise<WhisperAsr>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const load = vi.fn((onProgress: WhisperProgress) => {
    progress = onProgress;
    return promise;
  });
  return {
    load,
    resolve,
    reject,
    emitProgress: (loaded: number, total: number, etaSeconds: number | null) =>
      progress?.({ loaded, total, etaSeconds }),
  };
}

const fakeAsr: WhisperAsr = { transcribe: async () => 'whisper words' };

describe('createComposerSpeech', () => {
  it('delegates permission, requestPermission and microphones to the builtin engine', async () => {
    const builtin = stubBuiltin();
    const speech = createComposerSpeech({ builtin, loadWhisper: deferredLoader().load });

    await expect(speech.permission()).resolves.toBe('granted');
    await expect(speech.requestPermission()).resolves.toBe(true);
    await expect(speech.microphones()).resolves.toEqual([{ deviceId: 'default', label: 'Mic' }]);
    expect(builtin.permission).toHaveBeenCalled();
  });

  it('starts on the builtin engine before the enhanced model is ready', async () => {
    const builtin = stubBuiltin();
    const speech = createComposerSpeech({ builtin, loadWhisper: deferredLoader().load });

    const session = await speech.start({});
    await expect(session.stop()).resolves.toBe('builtin words');
    expect(builtin.startCalls).toBe(1);
  });

  it('warmup() streams downloading status (with progress) and flips to enhanced/ready', async () => {
    const builtin = stubBuiltin();
    const loader = deferredLoader();
    const speech = createComposerSpeech({ builtin, loadWhisper: loader.load });

    const seen: SpeechEngineStatus[] = [];
    speech.onStatus((s) => seen.push(s));
    expect(seen.at(-1)).toMatchObject({ engine: 'builtin', state: 'idle' });

    speech.warmup();
    expect(seen.at(-1)).toMatchObject({ engine: 'builtin', state: 'downloading' });

    loader.emitProgress(50, 150, 12);
    expect(seen.at(-1)).toMatchObject({
      state: 'downloading',
      download: { loaded: 50, total: 150, etaSeconds: 12 },
    });

    loader.resolve(fakeAsr);
    await vi.waitFor(() => {
      expect(seen.at(-1)).toMatchObject({ engine: 'enhanced', state: 'ready' });
    });
  });

  it('warmup() is idempotent while a load is in flight', () => {
    const builtin = stubBuiltin();
    const loader = deferredLoader();
    const speech = createComposerSpeech({ builtin, loadWhisper: loader.load });

    speech.warmup();
    speech.warmup();
    speech.warmup();
    expect(loader.load).toHaveBeenCalledTimes(1);
  });

  it('a failed load reports unavailable, keeps builtin working, and allows a retry', async () => {
    const builtin = stubBuiltin();
    const loader = deferredLoader();
    const speech = createComposerSpeech({ builtin, loadWhisper: loader.load });

    speech.warmup();
    loader.reject(new Error('offline'));
    await vi.waitFor(() => {
      expect(speech.status()).toMatchObject({ engine: 'builtin', state: 'unavailable' });
    });

    // Dictation still works on the builtin engine…
    const session = await speech.start({});
    await expect(session.stop()).resolves.toBe('builtin words');

    // …and a later warmup retries the download.
    speech.warmup();
    expect(loader.load).toHaveBeenCalledTimes(2);
  });

  it('starts whisper sessions once ready, threading device/lang/partial options', async () => {
    const builtin = stubBuiltin();
    const loader = deferredLoader();
    const startSession = vi.fn(async () => stubSession('whisper transcript'));
    const speech = createComposerSpeech({
      builtin,
      loadWhisper: loader.load,
      startSession: startSession as never,
    });

    speech.warmup();
    loader.resolve(fakeAsr);
    await vi.waitFor(() => expect(speech.status().state).toBe('ready'));

    const onPartial = vi.fn();
    const session = await speech.start({ deviceId: 'usb', lang: 'de-DE', onPartial });
    await expect(session.stop()).resolves.toBe('whisper transcript');
    expect(startSession).toHaveBeenCalledWith(
      fakeAsr,
      expect.objectContaining({ deviceId: 'usb', lang: 'de-DE', onPartial })
    );
    expect(builtin.startCalls).toBe(0);
  });

  it('falls back to the builtin engine when the whisper session fails to start', async () => {
    const builtin = stubBuiltin();
    const loader = deferredLoader();
    const startSession = vi.fn(async () => {
      throw new Error('mic unplugged');
    });
    const speech = createComposerSpeech({
      builtin,
      loadWhisper: loader.load,
      startSession: startSession as never,
    });

    speech.warmup();
    loader.resolve(fakeAsr);
    await vi.waitFor(() => expect(speech.status().state).toBe('ready'));

    const session = await speech.start({});
    await expect(session.stop()).resolves.toBe('builtin words');
    expect(builtin.startCalls).toBe(1);
  });

  it('routes requestPermission through the leader permission surface and probes-and-releases', async () => {
    const builtin = stubBuiltin();
    const stream = fakeStream();
    const surface = fakeSurface({ kind: 'microphone', stream });
    const speech = createComposerSpeech({
      builtin,
      loadWhisper: deferredLoader().load,
      getPermissionSurface: () => surface,
    });

    await expect(speech.requestPermission()).resolves.toBe(true);
    expect(surface.request).toHaveBeenCalledWith('microphone');
    // Probe-and-release: the track captured from the grant is stopped so the
    // real dictation session in `start()` re-acquires a fresh stream.
    const [track] = stream.getTracks();
    expect(track.stop).toHaveBeenCalledTimes(1);
    // Builtin's requestPermission is bypassed when the surface owns the gesture.
    expect(builtin.requestPermission).not.toHaveBeenCalled();
  });

  it('treats a surface denial as denied without touching the builtin engine', async () => {
    const builtin = stubBuiltin();
    const surface = fakeSurface(null);
    const speech = createComposerSpeech({
      builtin,
      loadWhisper: deferredLoader().load,
      getPermissionSurface: () => surface,
    });

    await expect(speech.requestPermission()).resolves.toBe(false);
    expect(surface.request).toHaveBeenCalledWith('microphone');
    expect(builtin.requestPermission).not.toHaveBeenCalled();
  });

  it('falls back to the builtin requestPermission when no surface is mounted', async () => {
    const builtin = stubBuiltin();
    const speech = createComposerSpeech({
      builtin,
      loadWhisper: deferredLoader().load,
      getPermissionSurface: () => null,
    });

    await expect(speech.requestPermission()).resolves.toBe(true);
    expect(builtin.requestPermission).toHaveBeenCalledTimes(1);
  });

  it('acquires the whisper session stream through the surface and threads it through', async () => {
    const builtin = stubBuiltin();
    const loader = deferredLoader();
    const stream = fakeStream();
    const surface = fakeSurface({ kind: 'microphone', stream });
    const startSession = vi.fn(async () => stubSession('whisper transcript'));
    const speech = createComposerSpeech({
      builtin,
      loadWhisper: loader.load,
      startSession: startSession as never,
      getPermissionSurface: () => surface,
    });

    speech.warmup();
    loader.resolve(fakeAsr);
    await vi.waitFor(() => expect(speech.status().state).toBe('ready'));

    const session = await speech.start({ deviceId: 'usb' });
    await expect(session.stop()).resolves.toBe('whisper transcript');
    expect(surface.request).toHaveBeenCalledWith('microphone', {
      constraints: { audio: { deviceId: { exact: 'usb' } } },
    });
    expect(startSession).toHaveBeenCalledWith(
      fakeAsr,
      expect.objectContaining({ deviceId: 'usb', stream })
    );
    // The surface-acquired stream is owned by the whisper session — the
    // probe-and-release path that runs in requestPermission must NOT fire
    // here (otherwise capture starts on a dead track).
    expect(stream.getTracks()[0].stop).not.toHaveBeenCalled();
  });

  it('falls back to direct getUserMedia inside the whisper session when no surface is mounted', async () => {
    const builtin = stubBuiltin();
    const loader = deferredLoader();
    const startSession = vi.fn(async () => stubSession('whisper transcript'));
    const speech = createComposerSpeech({
      builtin,
      loadWhisper: loader.load,
      startSession: startSession as never,
      getPermissionSurface: () => null,
    });

    speech.warmup();
    loader.resolve(fakeAsr);
    await vi.waitFor(() => expect(speech.status().state).toBe('ready'));

    await speech.start({ deviceId: 'usb' });
    expect(startSession).toHaveBeenCalledWith(
      fakeAsr,
      expect.objectContaining({ deviceId: 'usb', stream: undefined })
    );
  });
});
