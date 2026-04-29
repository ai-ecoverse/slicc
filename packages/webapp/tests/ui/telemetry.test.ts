// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

const mockSampleRUM = vi.fn();

vi.mock('@adobe/helix-rum-js', () => ({
  sampleRUM: mockSampleRUM,
}));

// Mock localStorage for Node environment
const localStorageMock: Record<string, string> = {};
const mockLocalStorage = {
  getItem: (key: string) => localStorageMock[key] ?? null,
  setItem: (key: string, value: string) => {
    localStorageMock[key] = value;
  },
  removeItem: (key: string) => {
    delete localStorageMock[key];
  },
  clear: () => {
    Object.keys(localStorageMock).forEach((k) => delete localStorageMock[k]);
  },
};

vi.stubGlobal('localStorage', mockLocalStorage);

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('telemetry', () => {
  beforeEach(() => {
    mockLocalStorage.clear();
    mockSampleRUM.mockClear();
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('initializes and emits navigate checkpoint', async () => {
    const { initTelemetry } = await import('../../src/ui/telemetry.js');
    await initTelemetry();
    expect(mockSampleRUM).toHaveBeenCalledWith(
      'navigate',
      expect.objectContaining({
        target: expect.stringMatching(/^(cli|extension|electron)$/),
      })
    );
  });

  it('sets RUM_GENERATION=slicc-cli in the CLI branch', async () => {
    const { initTelemetry } = await import('../../src/ui/telemetry.js');
    await initTelemetry();
    expect((globalThis as any).window?.RUM_GENERATION).toBe('slicc-cli');
  });

  it('respects telemetry-disabled flag', async () => {
    mockLocalStorage.setItem('telemetry-disabled', 'true');
    const { initTelemetry, trackChatSend } = await import('../../src/ui/telemetry.js');
    await initTelemetry();
    trackChatSend('cone', 'claude');
    expect(mockSampleRUM).not.toHaveBeenCalled();
  });

  it('trackChatSend emits formsubmit', async () => {
    const { initTelemetry, trackChatSend } = await import('../../src/ui/telemetry.js');
    await initTelemetry();
    mockSampleRUM.mockClear();

    trackChatSend('cone', 'claude-sonnet');
    expect(mockSampleRUM).toHaveBeenCalledWith('formsubmit', {
      source: 'cone',
      target: 'claude-sonnet',
    });
  });

  it('trackShellCommand emits fill', async () => {
    const { initTelemetry, trackShellCommand } = await import('../../src/ui/telemetry.js');
    await initTelemetry();
    mockSampleRUM.mockClear();

    trackShellCommand('git');
    expect(mockSampleRUM).toHaveBeenCalledWith('fill', { source: 'git' });
  });

  it('trackSprinkleView emits viewblock', async () => {
    const { initTelemetry, trackSprinkleView } = await import('../../src/ui/telemetry.js');
    await initTelemetry();
    mockSampleRUM.mockClear();

    trackSprinkleView('welcome');
    expect(mockSampleRUM).toHaveBeenCalledWith('viewblock', { source: 'welcome' });
  });

  it('trackError emits error', async () => {
    const { initTelemetry, trackError } = await import('../../src/ui/telemetry.js');
    await initTelemetry();
    mockSampleRUM.mockClear();

    trackError('llm', 'rate_limit');
    expect(mockSampleRUM).toHaveBeenCalledWith('error', { source: 'llm', target: 'rate_limit' });
  });

  it('track functions are no-op before init', async () => {
    const { trackChatSend, trackShellCommand } = await import('../../src/ui/telemetry.js');
    trackChatSend('cone', 'claude');
    trackShellCommand('ls');
    expect(mockSampleRUM).not.toHaveBeenCalled();
  });
});

describe('isTelemetryEnabled / setTelemetryEnabled', () => {
  beforeEach(() => {
    mockLocalStorage.clear();
    vi.resetModules();
  });

  it('returns true by default', async () => {
    const { isTelemetryEnabled } = await import('../../src/ui/telemetry.js');
    expect(isTelemetryEnabled()).toBe(true);
  });

  it('returns false when disabled', async () => {
    mockLocalStorage.setItem('telemetry-disabled', 'true');
    const { isTelemetryEnabled } = await import('../../src/ui/telemetry.js');
    expect(isTelemetryEnabled()).toBe(false);
  });

  it('setTelemetryEnabled toggles the flag', async () => {
    const { isTelemetryEnabled, setTelemetryEnabled } = await import('../../src/ui/telemetry.js');
    expect(isTelemetryEnabled()).toBe(true);

    setTelemetryEnabled(false);
    expect(mockLocalStorage.getItem('telemetry-disabled')).toBe('true');

    setTelemetryEnabled(true);
    expect(mockLocalStorage.getItem('telemetry-disabled')).toBeNull();
  });
});

describe('telemetry — extension branch', () => {
  const mockSampleRumJs = vi.fn();

  beforeEach(() => {
    mockLocalStorage.clear();
    mockSampleRUM.mockClear();
    mockSampleRumJs.mockClear();
    vi.resetModules();
    vi.stubGlobal('chrome', { runtime: { id: 'test-extension' } });
    vi.doMock('../../src/ui/rum.js', () => ({ default: mockSampleRumJs }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('../../src/ui/rum.js');
    vi.resetModules();
  });

  it('uses the inlined rum.js (default export) and sets RUM_GENERATION=slicc-extension', async () => {
    const { initTelemetry } = await import('../../src/ui/telemetry.js');
    await initTelemetry();
    expect(mockSampleRumJs).toHaveBeenCalledWith(
      'navigate',
      expect.objectContaining({ target: 'extension' })
    );
    expect(mockSampleRUM).not.toHaveBeenCalled();
    expect((globalThis as any).window?.RUM_GENERATION).toBe('slicc-extension');
  });

  it('does NOT set SAMPLE_PAGEVIEWS_AT_RATE in the extension branch', async () => {
    const { initTelemetry } = await import('../../src/ui/telemetry.js');
    if ((globalThis as any).window) {
      delete (globalThis as any).window.SAMPLE_PAGEVIEWS_AT_RATE;
    }
    await initTelemetry();
    expect((globalThis as any).window?.SAMPLE_PAGEVIEWS_AT_RATE).toBeUndefined();
  });

  it('forwards trackChatSend through the extension sampleRUM', async () => {
    const { initTelemetry, trackChatSend } = await import('../../src/ui/telemetry.js');
    await initTelemetry();
    mockSampleRumJs.mockClear();

    trackChatSend('cone', 'claude-sonnet');
    expect(mockSampleRumJs).toHaveBeenCalledWith('formsubmit', {
      source: 'cone',
      target: 'claude-sonnet',
    });
  });
});
