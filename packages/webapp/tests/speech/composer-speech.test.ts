import type {
  ComposerSpeech,
  SpeechEngineStatus,
  SpeechSession,
} from '@slicc/webcomponents/composer/speech';
import { describe, expect, it, vi } from 'vitest';
import { createComposerSpeech } from '../../src/speech/composer-speech.js';
import type { WhisperAsr, WhisperProgress } from '../../src/speech/whisper-engine.js';

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
});
