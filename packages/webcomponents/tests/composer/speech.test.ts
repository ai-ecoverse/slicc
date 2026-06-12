import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBuiltinComposerSpeech } from '../../src/composer/speech.js';

/**
 * A scriptable stand-in for Chrome's SpeechRecognition: records configuration,
 * lets tests push result/error events, and settles `end` like the real one.
 */
class FakeRecognition {
  static instances: FakeRecognition[] = [];
  continuous = false;
  interimResults = false;
  lang = '';
  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  started = 0;
  stopped = 0;
  abortCalls = 0;

  constructor() {
    FakeRecognition.instances.push(this);
  }

  start(): void {
    this.started++;
  }

  stop(): void {
    this.stopped++;
    // The real recognizer settles `end` asynchronously after stop().
    queueMicrotask(() => this.onend?.());
  }

  abort(): void {
    this.abortCalls++;
    queueMicrotask(() => this.onend?.());
  }

  /** Push a recognition event: each entry is one result (final or interim). */
  emit(results: Array<{ final: boolean; text: string }>, resultIndex = 0): void {
    const list = results.map((r) =>
      Object.assign([{ transcript: r.text }], { isFinal: r.final, length: 1 })
    );
    this.onresult?.({ resultIndex, results: Object.assign(list, { length: list.length }) });
  }

  static reset(): void {
    FakeRecognition.instances = [];
  }

  static get last(): FakeRecognition {
    const last = FakeRecognition.instances.at(-1);
    if (!last) throw new Error('no FakeRecognition constructed yet');
    return last;
  }
}

const win = window as unknown as Record<string, unknown>;
const nav = navigator as unknown as Record<string, unknown>;
const savedSpeech = win.SpeechRecognition;
const savedWebkitSpeech = win.webkitSpeechRecognition;

function installRecognition(): void {
  win.SpeechRecognition = FakeRecognition;
}

function removeRecognition(): void {
  win.SpeechRecognition = undefined;
  win.webkitSpeechRecognition = undefined;
}

function stubNavigator(name: 'permissions' | 'mediaDevices', value: unknown): void {
  Object.defineProperty(navigator, name, { value, configurable: true });
}

function restoreNavigator(name: 'permissions' | 'mediaDevices'): void {
  delete nav[name];
}

afterEach(() => {
  win.SpeechRecognition = savedSpeech;
  win.webkitSpeechRecognition = savedWebkitSpeech;
  restoreNavigator('permissions');
  restoreNavigator('mediaDevices');
  FakeRecognition.reset();
});

describe('createBuiltinComposerSpeech / permission', () => {
  it('reads the Permissions API state', async () => {
    stubNavigator('permissions', { query: async () => ({ state: 'granted' }) });
    await expect(createBuiltinComposerSpeech().permission()).resolves.toBe('granted');
  });

  it("falls back to 'prompt' when the Permissions API is unavailable or throws", async () => {
    stubNavigator('permissions', {
      query: async () => {
        throw new Error('unsupported');
      },
    });
    await expect(createBuiltinComposerSpeech().permission()).resolves.toBe('prompt');
  });

  it('requestPermission() probes getUserMedia and stops the probe tracks', async () => {
    const stop = vi.fn();
    stubNavigator('mediaDevices', {
      getUserMedia: async () => ({ getTracks: () => [{ stop }, { stop }] }),
    });
    await expect(createBuiltinComposerSpeech().requestPermission()).resolves.toBe(true);
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it('requestPermission() reports denial and missing APIs as false', async () => {
    stubNavigator('mediaDevices', {
      getUserMedia: async () => {
        throw new DOMException('denied', 'NotAllowedError');
      },
    });
    await expect(createBuiltinComposerSpeech().requestPermission()).resolves.toBe(false);

    stubNavigator('mediaDevices', {});
    await expect(createBuiltinComposerSpeech().requestPermission()).resolves.toBe(false);
  });
});

describe('createBuiltinComposerSpeech / microphones', () => {
  it('lists audio inputs with label fallbacks', async () => {
    stubNavigator('mediaDevices', {
      enumerateDevices: async () => [
        { kind: 'audioinput', deviceId: 'a', label: 'Built-in Microphone' },
        { kind: 'videoinput', deviceId: 'cam', label: 'FaceTime' },
        { kind: 'audioinput', deviceId: 'b', label: '' },
      ],
    });
    await expect(createBuiltinComposerSpeech().microphones()).resolves.toEqual([
      { deviceId: 'a', label: 'Built-in Microphone' },
      { deviceId: 'b', label: 'Microphone 2' },
    ]);
  });

  it('returns an empty list when enumeration is unavailable or throws', async () => {
    stubNavigator('mediaDevices', {});
    await expect(createBuiltinComposerSpeech().microphones()).resolves.toEqual([]);

    stubNavigator('mediaDevices', {
      enumerateDevices: async () => {
        throw new Error('nope');
      },
    });
    await expect(createBuiltinComposerSpeech().microphones()).resolves.toEqual([]);
  });
});

describe('createBuiltinComposerSpeech / sessions', () => {
  it('configures a continuous interim-results recognizer with the requested lang', async () => {
    installRecognition();
    await createBuiltinComposerSpeech().start({ lang: 'de-DE' });
    const rec = FakeRecognition.last;
    expect(rec.started).toBe(1);
    expect(rec.continuous).toBe(true);
    expect(rec.interimResults).toBe(true);
    expect(rec.lang).toBe('de-DE');
  });

  it('leaves the recognizer language untouched when none is given (auto-detect default)', async () => {
    installRecognition();
    await createBuiltinComposerSpeech().start({});
    expect(FakeRecognition.last.lang).toBe('');
  });

  it('streams partials (finals + interim) and resolves the transcript on stop', async () => {
    installRecognition();
    const partials: string[] = [];
    const session = await createBuiltinComposerSpeech().start({
      onPartial: (text) => partials.push(text),
    });
    const rec = FakeRecognition.last;

    rec.emit([{ final: false, text: 'make the' }]);
    expect(partials).toEqual(['make the']);
    rec.emit([
      { final: true, text: 'make the hero ' },
      { final: false, text: 'warmer' },
    ]);
    expect(partials.at(-1)).toBe('make the hero warmer');

    await expect(session.stop()).resolves.toBe('make the hero warmer');
    expect(rec.stopped).toBe(1);
  });

  it('stop() after the recognizer already ended resolves immediately', async () => {
    installRecognition();
    const session = await createBuiltinComposerSpeech().start({});
    const rec = FakeRecognition.last;
    rec.emit([{ final: true, text: 'done' }]);
    rec.onend?.();
    await expect(session.stop()).resolves.toBe('done');
    expect(rec.stopped).toBe(0);
  });

  it('cancel() aborts without a transcript and detaches handlers', async () => {
    installRecognition();
    const session = await createBuiltinComposerSpeech().start({});
    const rec = FakeRecognition.last;
    session.cancel();
    expect(rec.abortCalls).toBe(1);
    expect(rec.onresult).toBeNull();
    // A late stop() resolves (empty) instead of hanging.
    await expect(session.stop()).resolves.toBe('');
  });

  it('routes fatal recognizer errors to onError, staying quiet for no-speech/aborted', async () => {
    installRecognition();
    const errors: string[] = [];
    await createBuiltinComposerSpeech().start({ onError: (m) => errors.push(m) });
    const rec = FakeRecognition.last;

    rec.onerror?.({ error: 'no-speech' });
    rec.onerror?.({ error: 'aborted' });
    expect(errors).toEqual([]);
    rec.onerror?.({ error: 'network' });
    expect(errors).toEqual(['Speech recognition error: network']);
  });

  it('rejects start() when no recognizer constructor exists', async () => {
    removeRecognition();
    await expect(createBuiltinComposerSpeech().start({})).rejects.toThrow(/not supported/);
  });
});

describe('createBuiltinComposerSpeech / engine status', () => {
  it('is permanently builtin: status snapshot, immediate onStatus, no-op warmup', () => {
    const speech = createBuiltinComposerSpeech();
    expect(speech.status()).toEqual({ engine: 'builtin', state: 'idle' });

    const seen: unknown[] = [];
    const unsubscribe = speech.onStatus((s) => seen.push(s));
    expect(seen).toEqual([{ engine: 'builtin', state: 'idle' }]);
    unsubscribe();
    speech.warmup(); // no throw, no state change
    expect(speech.status().engine).toBe('builtin');
  });
});
