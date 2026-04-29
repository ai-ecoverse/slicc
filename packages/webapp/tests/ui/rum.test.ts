import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('rum.js', () => {
  let sendBeaconSpy: ReturnType<typeof vi.fn>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let randomSpy: ReturnType<typeof vi.spyOn<any, any>>;

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).window;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).window = {
      hlx: undefined,
      location: { href: 'https://example.test/page' },
      RUM_GENERATION: 'slicc-extension',
    };
    sendBeaconSpy = vi.fn().mockReturnValue(true);
    Object.defineProperty(globalThis, 'navigator', {
      value: { sendBeacon: sendBeaconSpy },
      writable: true,
      configurable: true,
    });
    const store: Record<string, string> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).localStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
    };
    vi.resetModules();
  });

  afterEach(() => {
    randomSpy?.mockRestore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).window;
    if (Object.getOwnPropertyDescriptor(globalThis, 'navigator')?.configurable) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (globalThis as any).navigator;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).localStorage;
  });

  it('sends a beacon when isSelected (random*weight < 1)', async () => {
    randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.05);
    const { default: sampleRUM } = await import('../../src/ui/rum.js');

    sampleRUM('formsubmit', { source: 'cone', target: 'claude' });

    expect(sendBeaconSpy).toHaveBeenCalledTimes(1);
    const [url, body] = sendBeaconSpy.mock.calls[0];
    expect(url).toBe('https://rum.hlx.page/.rum/10');
    const parsed = JSON.parse(body as string);
    expect(parsed).toMatchObject({
      weight: 10,
      checkpoint: 'formsubmit',
      source: 'cone',
      target: 'claude',
      generation: 'slicc-extension',
      referer: 'https://example.test/page',
    });
    expect(typeof parsed.id).toBe('string');
  });

  it('skips beacons when not selected (random*weight >= 1)', async () => {
    randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { default: sampleRUM } = await import('../../src/ui/rum.js');

    sampleRUM('formsubmit', { source: 'cone' });

    expect(sendBeaconSpy).not.toHaveBeenCalled();
  });

  it('debug flag forces weight=1 and selection', async () => {
    (globalThis as any).localStorage.setItem('slicc-rum-debug', '1');
    randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const { default: sampleRUM } = await import('../../src/ui/rum.js');

    sampleRUM('navigate', { target: 'extension' });

    expect(sendBeaconSpy).toHaveBeenCalledTimes(1);
    const [url, body] = sendBeaconSpy.mock.calls[0];
    expect(url).toBe('https://rum.hlx.page/.rum/1');
    expect(JSON.parse(body as string)).toMatchObject({ weight: 1 });
  });

  it('caches the per-pageview decision on window.hlx.rum', async () => {
    randomSpy = vi.spyOn(Math, 'random').mockReturnValueOnce(0.05).mockReturnValueOnce(0.99);
    const { default: sampleRUM } = await import('../../src/ui/rum.js');

    sampleRUM('a');
    sampleRUM('b');

    expect(sendBeaconSpy).toHaveBeenCalledTimes(2);
    const id1 = JSON.parse(sendBeaconSpy.mock.calls[0][1] as string).id;
    const id2 = JSON.parse(sendBeaconSpy.mock.calls[1][1] as string).id;
    expect(id1).toBe(id2);
  });

  it('never throws on internal errors', async () => {
    sendBeaconSpy.mockImplementation(() => {
      throw new Error('boom');
    });
    randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.05);
    const { default: sampleRUM } = await import('../../src/ui/rum.js');

    expect(() => sampleRUM('formsubmit')).not.toThrow();
  });
});
