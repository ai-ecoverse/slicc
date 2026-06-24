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
import type {
  SpeechAssetProgress,
  SpeechAssetProgressFn,
} from '../../src/speech/ensure-speech-assets.js';
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

/** A manually-resolvable asset-staging seam that exposes its progress callback. */
function deferredEnsure() {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  let progress: SpeechAssetProgressFn | null = null;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const ensure = vi.fn((onProgress: SpeechAssetProgressFn) => {
    progress = onProgress;
    return promise;
  });
  return {
    ensure,
    resolve,
    reject,
    emit: (p: SpeechAssetProgress) => progress?.(p),
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
    const speech = createComposerSpeech({
      builtin,
      loadWhisper: loader.load,
      ensureAssets: async () => {},
    });

    const seen: SpeechEngineStatus[] = [];
    speech.onStatus((s) => seen.push(s));
    expect(seen.at(-1)).toMatchObject({ engine: 'builtin', state: 'idle' });

    speech.warmup();
    expect(seen.at(-1)).toMatchObject({ engine: 'builtin', state: 'downloading' });

    // Staging (the no-op seam) resolves first, then the model load starts.
    await vi.waitFor(() => expect(loader.load).toHaveBeenCalledTimes(1));
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

  it('warmup() is idempotent while a load is in flight', async () => {
    const builtin = stubBuiltin();
    const loader = deferredLoader();
    const ensure = deferredEnsure();
    const speech = createComposerSpeech({
      builtin,
      loadWhisper: loader.load,
      ensureAssets: ensure.ensure,
    });

    speech.warmup();
    speech.warmup();
    speech.warmup();
    // The `#warmupStarted` guard short-circuits repeat holds synchronously, so
    // only one staging pass runs (and, once it resolves, one model load).
    expect(ensure.ensure).toHaveBeenCalledTimes(1);
    ensure.resolve();
    await vi.waitFor(() => expect(loader.load).toHaveBeenCalledTimes(1));
  });

  it('a failed load reports unavailable, keeps builtin working, and allows a retry', async () => {
    const builtin = stubBuiltin();
    const loader = deferredLoader();
    const speech = createComposerSpeech({
      builtin,
      loadWhisper: loader.load,
      ensureAssets: async () => {},
    });

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
    await vi.waitFor(() => expect(loader.load).toHaveBeenCalledTimes(2));
  });

  it('stages assets before loading whisper and maps staging progress to the download snapshot', async () => {
    const builtin = stubBuiltin();
    const loader = deferredLoader();
    const ensure = deferredEnsure();
    const speech = createComposerSpeech({
      builtin,
      loadWhisper: loader.load,
      ensureAssets: ensure.ensure,
    });

    const seen: SpeechEngineStatus[] = [];
    speech.onStatus((s) => seen.push(s));

    speech.warmup();
    // Staging runs first; the model load hasn't been kicked yet.
    expect(ensure.ensure).toHaveBeenCalledTimes(1);
    expect(loader.load).not.toHaveBeenCalled();
    // No byte totals yet → the composer shows its "preparing" line (no download).
    expect(seen.at(-1)).toMatchObject({ engine: 'builtin', state: 'downloading' });
    expect(seen.at(-1)?.download).toBeUndefined();

    // A listed repo carries byte totals → mapped into the download snapshot.
    ensure.emit({ asset: 'onnx-community/whisper-tiny', phase: 'listing', bytesTotal: 200 });
    expect(seen.at(-1)).toMatchObject({
      state: 'downloading',
      download: { loaded: 0, total: 200 },
    });

    ensure.resolve();
    await vi.waitFor(() => expect(loader.load).toHaveBeenCalledTimes(1));
    loader.resolve(fakeAsr);
    await vi.waitFor(() => {
      expect(seen.at(-1)).toMatchObject({ engine: 'enhanced', state: 'ready' });
    });
  });

  it('stays ready when staging fails but the assets are already present', async () => {
    const builtin = stubBuiltin();
    const loader = deferredLoader();
    const ensure = deferredEnsure();
    const speech = createComposerSpeech({
      builtin,
      loadWhisper: loader.load,
      ensureAssets: ensure.ensure,
    });

    speech.warmup();
    // Staging fails (e.g. listing hiccup) but the VFS-direct load still works.
    ensure.reject(new Error('HF unreachable'));
    await vi.waitFor(() => expect(loader.load).toHaveBeenCalledTimes(1));
    loader.resolve(fakeAsr);
    await vi.waitFor(() => expect(speech.status()).toMatchObject({ state: 'ready' }));
  });

  it('reports unavailable with an actionable message when staging and load both fail', async () => {
    const builtin = stubBuiltin();
    const loader = deferredLoader();
    const ensure = deferredEnsure();
    const speech = createComposerSpeech({
      builtin,
      loadWhisper: loader.load,
      ensureAssets: ensure.ensure,
    });

    speech.warmup();
    ensure.reject(new Error('offline'));
    await vi.waitFor(() => expect(loader.load).toHaveBeenCalledTimes(1));
    loader.reject(new Error('whisper assets not found'));

    await vi.waitFor(() => {
      const status = speech.status();
      expect(status).toMatchObject({ engine: 'builtin', state: 'unavailable' });
      // The staging error wins the message — it's the actionable one.
      expect(status.message).toContain('offline');
    });

    // Builtin dictation still works, and a later hold retries staging + load.
    const session = await speech.start({});
    await expect(session.stop()).resolves.toBe('builtin words');
    speech.warmup();
    expect(ensure.ensure).toHaveBeenCalledTimes(2);
  });

  it('starts whisper sessions once ready, threading device/lang/partial options', async () => {
    const builtin = stubBuiltin();
    const loader = deferredLoader();
    const startSession = vi.fn(async () => stubSession('whisper transcript'));
    const speech = createComposerSpeech({
      builtin,
      ensureAssets: async () => {},
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
      ensureAssets: async () => {},
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

  it('routes requestPermission through the leader permission surface and HOLDS the grant', async () => {
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
    // The grant's stream is HELD alive (no probe-and-release) so the dictation
    // session that follows in the same gesture can reuse it.
    const [track] = stream.getTracks();
    expect(track.stop).not.toHaveBeenCalled();
    // Builtin's requestPermission is bypassed when the surface owns the gesture.
    expect(builtin.requestPermission).not.toHaveBeenCalled();
  });

  it('reuses the held grant stream in start() with no second surface round-trip', async () => {
    const builtin = stubBuiltin();
    const loader = deferredLoader();
    const stream = fakeStream();
    const surface = fakeSurface({ kind: 'microphone', stream });
    const startSession = vi.fn(async () => stubSession('whisper transcript'));
    const speech = createComposerSpeech({
      builtin,
      ensureAssets: async () => {},
      loadWhisper: loader.load,
      startSession: startSession as never,
      getPermissionSurface: () => surface,
    });

    speech.warmup();
    loader.resolve(fakeAsr);
    await vi.waitFor(() => expect(speech.status().state).toBe('ready'));

    // Granted hold: the stream is acquired + held here…
    await expect(speech.requestPermission()).resolves.toBe(true);
    expect(surface.request).toHaveBeenCalledTimes(1);

    // …and reused by the dictation start() — NO second surface request.
    const session = await speech.start({});
    await session.stop();
    expect(surface.request).toHaveBeenCalledTimes(1);
    expect(startSession).toHaveBeenCalledWith(fakeAsr, expect.objectContaining({ stream }));
    // The whisper session owns the held stream now — requestPermission never
    // probe-released it.
    expect(stream.getTracks()[0].stop).not.toHaveBeenCalled();
  });

  it('reuses the held grant stream when start() requests the "default" device (EXT2)', async () => {
    const builtin = stubBuiltin();
    const loader = deferredLoader();
    const stream = fakeStream();
    const surface = fakeSurface({ kind: 'microphone', stream });
    const startSession = vi.fn(async () => stubSession('whisper transcript'));
    const speech = createComposerSpeech({
      builtin,
      ensureAssets: async () => {},
      loadWhisper: loader.load,
      startSession: startSession as never,
      getPermissionSurface: () => surface,
    });

    speech.warmup();
    loader.resolve(fakeAsr);
    await vi.waitFor(() => expect(speech.status().state).toBe('ready'));

    await expect(speech.requestPermission()).resolves.toBe(true);
    expect(surface.request).toHaveBeenCalledTimes(1);

    // The persisted deviceId is the literal 'default' sentinel — it must be
    // treated as "no specific device" so the held stream is reused and NO second
    // (potentially-hanging) getUserMedia is issued.
    const session = await speech.start({ deviceId: 'default' });
    await session.stop();
    expect(surface.request).toHaveBeenCalledTimes(1);
    expect(startSession).toHaveBeenCalledWith(fakeAsr, expect.objectContaining({ stream }));
    expect(stream.getTracks()[0].stop).not.toHaveBeenCalled();
  });

  it('bounds a stalled fresh capture, degrading start() to the builtin engine (EXT2)', async () => {
    const builtin = stubBuiltin();
    const loader = deferredLoader();
    // The surface grant never settles — the bounded capture must time out.
    const surface = {
      request: vi.fn(() => new Promise<{ kind: 'microphone'; stream: MediaStream }>(() => {})),
    } satisfies MicPermissionSurface;
    const startSession = vi.fn(async () => stubSession('whisper transcript'));
    const speech = createComposerSpeech({
      builtin,
      ensureAssets: async () => {},
      loadWhisper: loader.load,
      startSession: startSession as never,
      getPermissionSurface: () => surface,
    });

    speech.warmup();
    loader.resolve(fakeAsr);
    await vi.waitFor(() => expect(speech.status().state).toBe('ready'));

    vi.useFakeTimers();
    try {
      // No held stream + a specific device → a fresh capture that stalls; the
      // CAPTURE_TIMEOUT_MS bound throws, so start() falls back to the builtin.
      const startPromise = speech.start({ deviceId: 'usb' });
      await vi.advanceTimersByTimeAsync(5000);
      const session = await startPromise;
      await expect(session.stop()).resolves.toBe('builtin words');
      expect(startSession).not.toHaveBeenCalled();
      expect(builtin.startCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a held default-device stream and re-acquires when a specific device is requested', async () => {
    const builtin = stubBuiltin();
    const loader = deferredLoader();
    const held = fakeStream();
    const fresh = fakeStream();
    let call = 0;
    const surface = {
      request: vi.fn(async () => ({
        kind: 'microphone' as const,
        stream: call++ === 0 ? held : fresh,
      })),
    } satisfies MicPermissionSurface;
    const startSession = vi.fn(async () => stubSession('whisper transcript'));
    const speech = createComposerSpeech({
      builtin,
      ensureAssets: async () => {},
      loadWhisper: loader.load,
      startSession: startSession as never,
      getPermissionSurface: () => surface,
    });

    speech.warmup();
    loader.resolve(fakeAsr);
    await vi.waitFor(() => expect(speech.status().state).toBe('ready'));

    await speech.requestPermission(); // holds `held` (default device)
    await speech.start({ deviceId: 'usb' }); // wants 'usb' → drop held, acquire fresh
    expect(held.getTracks()[0].stop).toHaveBeenCalledTimes(1);
    expect(startSession).toHaveBeenCalledWith(fakeAsr, expect.objectContaining({ stream: fresh }));
    expect(surface.request).toHaveBeenCalledTimes(2);
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
      ensureAssets: async () => {},
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
      ensureAssets: async () => {},
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
