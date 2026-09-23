import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStandalonePanelRpcHandlers } from '../../../src/ui/panel-rpc-handlers.js';

const { mockCapture } = vi.hoisted(() => ({ mockCapture: vi.fn() }));

vi.mock('../../../src/shell/supplemental-commands/screencapture-media.js', async () => {
  const shared = await import(
    '../../../src/shell/supplemental-commands/screencapture-media-shared.js'
  );
  return {
    captureDisplayMedia: mockCapture,
    sessionCaptureRequest: shared.sessionCaptureRequest,
  };
});

describe('screencapture panel-RPC session op', () => {
  it('start returns a handle and frame/stop pass it through', async () => {
    const handlers = createStandalonePanelRpcHandlers({});
    const op = handlers.screencapture;
    expect(op).toBeTypeOf('function');

    mockCapture.mockResolvedValueOnce({
      bytes: new Uint8Array(0),
      mimeType: 'application/octet-stream',
      width: 1920,
      height: 1080,
      handle: 'screen1',
    });
    const started = await op!({
      mimeType: 'image/jpeg',
      quality: 0.7,
      mode: 'session',
      session: 'start',
    });
    expect(started.handle).toBe('screen1');
    expect(started.width).toBe(1920);
    expect(mockCapture).toHaveBeenCalledWith({ mode: 'session', action: 'start' });

    mockCapture.mockResolvedValueOnce({
      bytes: Uint8Array.of(0xff, 0xd8, 0xff, 0xd9),
      mimeType: 'image/jpeg',
      width: 768,
      height: 432,
      nativeWidth: 5120,
      nativeHeight: 2880,
    });
    const frame = await op!({
      mimeType: 'image/jpeg',
      quality: 0.7,
      mode: 'session',
      session: 'frame',
      handle: 'screen1',
      maxWidth: 768,
    });
    expect(frame.width).toBe(768);
    expect(frame).toMatchObject({ nativeWidth: 5120, nativeHeight: 2880 });
    expect(mockCapture).toHaveBeenCalledWith({
      mode: 'session',
      action: 'frame',
      handle: 'screen1',
      maxWidth: 768,
      mimeType: 'image/jpeg',
      quality: 0.7,
    });

    mockCapture.mockResolvedValueOnce({
      bytes: new Uint8Array(0),
      mimeType: 'application/octet-stream',
      width: 0,
      height: 0,
      handle: 'screen1',
    });
    const stopped = await op!({
      mimeType: 'image/jpeg',
      quality: 0.7,
      mode: 'session',
      session: 'stop',
      handle: 'screen1',
    });
    expect(stopped.handle).toBe('screen1');
    expect(mockCapture).toHaveBeenCalledWith({
      mode: 'session',
      action: 'stop',
      handle: 'screen1',
    });
  });

  it('record points MediaRecorder at the live session track', async () => {
    mockCapture.mockResolvedValueOnce({
      bytes: Uint8Array.of(1, 2, 3),
      mimeType: 'video/webm',
      width: 1280,
      height: 720,
      durationMs: 1_500,
    });
    const handlers = createStandalonePanelRpcHandlers({});
    const result = await handlers.screencapture!({
      mimeType: 'video/webm',
      quality: 0.7,
      mode: 'session',
      session: 'record',
      handle: 'screen1',
      durationMs: 1_500,
    });
    expect(result.durationMs).toBe(1_500);
    expect(mockCapture).toHaveBeenCalledWith({
      mode: 'session',
      action: 'record',
      handle: 'screen1',
      durationMs: 1_500,
      mimeType: 'video/webm',
    });
  });
});

type AnyNavigator = {
  usb?: unknown;
  hid?: unknown;
  serial?: unknown;
  mediaDevices?: unknown;
  clipboard?: unknown;
};
const setNavigator = (v: AnyNavigator) => {
  Object.defineProperty(globalThis, 'navigator', {
    value: v,
    configurable: true,
    writable: true,
  });
};
const getNavigator = (): AnyNavigator | undefined =>
  (globalThis as { navigator?: AnyNavigator }).navigator;

async function loadHandlers(emitEvent?: (channel: string, payload: unknown) => void) {
  const mod = await import('../../../src/ui/panel-rpc-handlers.js');
  return mod.createStandalonePanelRpcHandlers({ emitEvent });
}

describe('createStandalonePanelRpcHandlers — page misc', () => {
  let previousNavigator: AnyNavigator | undefined;

  beforeEach(() => {
    vi.resetModules();
    previousNavigator = getNavigator();
  });

  afterEach(() => {
    if (previousNavigator) setNavigator(previousNavigator);
    else Object.defineProperty(globalThis, 'navigator', { value: undefined, configurable: true });
  });

  it('page-info returns the page origin / href / title', async () => {
    setNavigator({});
    Object.defineProperty(globalThis, 'window', {
      value: { location: { origin: 'http://x.test', href: 'http://x.test/a' } },
      configurable: true,
    });
    Object.defineProperty(globalThis, 'document', {
      value: { title: 'Slicc' },
      configurable: true,
    });
    const handlers = await loadHandlers();
    const info = handlers['page-info']!(undefined);
    expect(info).toEqual({
      origin: 'http://x.test',
      href: 'http://x.test/a',
      title: 'Slicc',
    });
  });

  it('speak-text rejects when speechSynthesis is unavailable', async () => {
    setNavigator({});
    const original = (globalThis as { speechSynthesis?: unknown }).speechSynthesis;
    delete (globalThis as { speechSynthesis?: unknown }).speechSynthesis;
    const handlers = await loadHandlers();
    await expect(handlers['speak-text']!({ text: 'hi' })).rejects.toThrow(
      /speechSynthesis is unavailable/
    );
    if (original) (globalThis as { speechSynthesis?: unknown }).speechSynthesis = original;
  });

  it('list-voices rejects when speechSynthesis is unavailable', async () => {
    setNavigator({});
    const original = (globalThis as { speechSynthesis?: unknown }).speechSynthesis;
    delete (globalThis as { speechSynthesis?: unknown }).speechSynthesis;
    const handlers = await loadHandlers();
    await expect(handlers['list-voices']!(undefined)).rejects.toThrow(
      /speechSynthesis is unavailable/
    );
    if (original) (globalThis as { speechSynthesis?: unknown }).speechSynthesis = original;
  });

  it('play-audio / play-chime reject when AudioContext is unavailable', async () => {
    setNavigator({});
    const original = (globalThis as { AudioContext?: unknown }).AudioContext;
    delete (globalThis as { AudioContext?: unknown }).AudioContext;
    const handlers = await loadHandlers();
    await expect(handlers['play-audio']!({ bytes: new ArrayBuffer(0) })).rejects.toThrow(
      /Web Audio API is unavailable/
    );
    await expect(handlers['play-chime']!({ tone: 'success' })).rejects.toThrow(
      /Web Audio API is unavailable/
    );
    if (original) (globalThis as { AudioContext?: unknown }).AudioContext = original;
  });

  it('clipboard ops reject clearly when the clipboard API is absent', async () => {
    setNavigator({ clipboard: undefined } as AnyNavigator);
    const handlers = await loadHandlers();
    await expect(handlers['clipboard-read-text']!(undefined)).rejects.toThrow(
      /clipboard API unavailable/
    );
    await expect(handlers['clipboard-write-text']!({ text: 'x' })).rejects.toThrow(
      /clipboard API unavailable/
    );
    await expect(
      handlers['clipboard-write-image']!({
        bytes: new ArrayBuffer(0),
        mimeType: 'image/png',
      })
    ).rejects.toThrow(/clipboard image API unavailable/);
  });

  it('enumerate-media-devices rejects when mediaDevices is unavailable', async () => {
    setNavigator({});
    const handlers = await loadHandlers();
    await expect(handlers['enumerate-media-devices']!(undefined)).rejects.toThrow(
      /enumerateDevices is not supported/
    );
  });

  it('window-open posts through window.open and reports opened', async () => {
    setNavigator({});
    Object.defineProperty(globalThis, 'window', {
      value: {
        open: vi.fn(() => ({})),
        location: { origin: '', href: '' },
      },
      configurable: true,
      writable: true,
    });
    const handlers = await loadHandlers();
    const opened = await handlers['window-open']!({
      url: 'https://example.com/',
      target: '_blank',
      features: 'noopener',
    });
    expect(opened).toEqual({ opened: true });
    const closed = await handlers['window-open']!({ url: 'https://x' });
    expect(closed.opened).toBe(true);
  });

  it('enumerate-media-devices splits the kinds and trims missing groupId', async () => {
    const devs = [
      { kind: 'videoinput', deviceId: 'v1', label: 'Cam 1', groupId: 'g1' },
      { kind: 'audioinput', deviceId: 'a1', label: '', groupId: '' },
      { kind: 'audiooutput', deviceId: 'o1', label: 'Out', groupId: 'g2' },
    ];
    setNavigator({
      mediaDevices: {
        enumerateDevices: vi.fn(async () => devs),
      },
    });
    const handlers = await loadHandlers();
    const result = await handlers['enumerate-media-devices']!(undefined);
    expect(result.videoinputs).toEqual([{ deviceId: 'v1', label: 'Cam 1', groupId: 'g1' }]);
    expect(result.audioinputs).toEqual([{ deviceId: 'a1', label: '' }]);
  });

  it('clipboard-read-text returns navigator.clipboard.readText() value', async () => {
    setNavigator({
      clipboard: { readText: vi.fn(async () => 'hello'), writeText: vi.fn(async () => undefined) },
    });
    const handlers = await loadHandlers();
    expect(await handlers['clipboard-read-text']!(undefined)).toEqual({ text: 'hello' });
  });

  it('clipboard-write-text writes through and short-circuits when document is missing', async () => {
    setNavigator({
      clipboard: { readText: vi.fn(), writeText: vi.fn(async () => undefined) },
    });
    Object.defineProperty(globalThis, 'document', { value: undefined, configurable: true });
    const handlers = await loadHandlers();
    expect(await handlers['clipboard-write-text']!({ text: 'copied' })).toEqual({ done: true });
    expect(
      (
        globalThis as unknown as {
          navigator: { clipboard: { writeText: ReturnType<typeof vi.fn> } };
        }
      ).navigator.clipboard.writeText.mock.calls
    ).toEqual([['copied']]);
  });

  it('clipboard-write-text honours an already-focused document', async () => {
    setNavigator({
      clipboard: { readText: vi.fn(), writeText: vi.fn(async () => undefined) },
    });
    Object.defineProperty(globalThis, 'document', {
      value: { hasFocus: () => true },
      configurable: true,
    });
    const handlers = await loadHandlers();
    await handlers['clipboard-write-text']!({ text: 'focused' });
  });

  it('speak-text resolves on utterance end and applies the requested voice', async () => {
    setNavigator({});
    const voice = { name: 'Daniel', lang: 'en-GB', default: false };
    const utterances: Array<Record<string, unknown>> = [];
    class Utt {
      onend?: () => void;
      lang?: string;
      voice?: unknown;
      rate?: number;
      pitch?: number;
      volume?: number;
      constructor(public text: string) {
        utterances.push(this as unknown as Record<string, unknown>);
      }
    }
    Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', {
      value: Utt,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'speechSynthesis', {
      value: {
        getVoices: () => [voice],
        speak: (u: { onend?: () => void }) => setTimeout(() => u.onend?.(), 0),
      },
      configurable: true,
    });
    const handlers = await loadHandlers();
    const done = await handlers['speak-text']!({
      text: 'hi',
      lang: 'en-GB',
      voice: 'Daniel',
      rate: 1.1,
      pitch: 0.9,
      volume: 0.5,
    });
    expect(done).toEqual({ done: true });
    expect(utterances[0]).toMatchObject({
      text: 'hi',
      lang: 'en-GB',
      rate: 1.1,
      pitch: 0.9,
      volume: 0.5,
      voice,
    });
  });

  it('list-voices waits for voiceschanged and returns the loaded voices', async () => {
    setNavigator({});
    const voices = [
      { name: 'Daniel', lang: 'en-GB', default: false },
      { name: 'Karen', lang: 'en-AU', default: true },
    ];
    const listeners: Array<() => void> = [];
    let firstCall = true;
    Object.defineProperty(globalThis, 'speechSynthesis', {
      value: {
        getVoices: () => (firstCall ? [] : voices),
        addEventListener: (_t: string, l: () => void) => listeners.push(l),
        removeEventListener: (_t: string, l: () => void) => {
          const i = listeners.indexOf(l);
          if (i >= 0) listeners.splice(i, 1);
        },
      },
      configurable: true,
    });
    const handlers = await loadHandlers();
    const promise = handlers['list-voices']!(undefined);
    await Promise.resolve();
    firstCall = false;
    listeners.forEach((l) => {
      l();
    });
    const result = await promise;
    expect(result.voices.map((v) => v.name)).toEqual(['Daniel', 'Karen']);

    expect(result.voices.every((v) => v.onDevice === false)).toBe(true);
  });

  it('speak-status returns the page-side kokoro status', async () => {
    vi.doMock('../../../src/speech/speak.js', () => ({
      kokoroStatus: () => ({ state: 'loading', loaded: 2, total: 8, etaSeconds: 4 }),
      kokoroWarmup: vi.fn(),
    }));
    const handlers = await loadHandlers();
    const status = await handlers['speak-status']!(undefined);
    expect(status).toEqual({ state: 'loading', loaded: 2, total: 8, etaSeconds: 4 });
    vi.doUnmock('../../../src/speech/speak.js');
  });

  it('speak-warmup kicks the page-side warmup and returns initial status', async () => {
    const kokoroWarmup = vi.fn(() => ({ state: 'idle' as const }));
    vi.doMock('../../../src/speech/speak.js', () => ({
      kokoroStatus: () => ({ state: 'idle' }),
      kokoroWarmup,
    }));
    const handlers = await loadHandlers();
    const status = await handlers['speak-warmup']!(undefined);
    expect(kokoroWarmup).toHaveBeenCalledOnce();
    expect(status).toEqual({ state: 'idle' });
    vi.doUnmock('../../../src/speech/speak.js');
  });

  it('speak-warmup surfaces a page-side warmup failure as a rejection', async () => {
    vi.doMock('../../../src/speech/speak.js', () => ({
      kokoroStatus: () => ({ state: 'idle' }),
      kokoroWarmup: () => {
        throw new Error('speech-assets: BroadcastChannel is unavailable');
      },
    }));
    const handlers = await loadHandlers();
    await expect(handlers['speak-warmup']!(undefined)).rejects.toThrow(/BroadcastChannel/);
    vi.doUnmock('../../../src/speech/speak.js');
  });
});
