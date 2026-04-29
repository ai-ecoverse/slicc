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

  it('trackImageView emits viewmedia', async () => {
    const { initTelemetry, trackImageView } = await import('../../src/ui/telemetry.js');
    await initTelemetry();
    mockSampleRUM.mockClear();

    trackImageView('chat');
    expect(mockSampleRUM).toHaveBeenCalledWith('viewmedia', { source: 'chat' });
  });

  it('trackSettingsOpen emits signup', async () => {
    const { initTelemetry, trackSettingsOpen } = await import('../../src/ui/telemetry.js');
    await initTelemetry();
    mockSampleRUM.mockClear();

    trackSettingsOpen('button');
    expect(mockSampleRUM).toHaveBeenCalledWith('signup', { source: 'button' });
  });

  it('trackError forwards source/target as-is (sanitization happens at the listener)', async () => {
    const { initTelemetry, trackError } = await import('../../src/ui/telemetry.js');
    await initTelemetry();
    mockSampleRUM.mockClear();

    const long = 'x'.repeat(250);
    trackError('js', long);
    expect(mockSampleRUM).toHaveBeenCalledWith('error', { source: 'js', target: long });
  });

  it('track functions are no-op before init', async () => {
    const { trackChatSend, trackShellCommand } = await import('../../src/ui/telemetry.js');
    trackChatSend('cone', 'claude');
    trackShellCommand('ls');
    expect(mockSampleRUM).not.toHaveBeenCalled();
  });

  it('initTelemetry is idempotent — second call is a no-op', async () => {
    const { initTelemetry } = await import('../../src/ui/telemetry.js');
    await initTelemetry();
    const callsAfterFirst = mockSampleRUM.mock.calls.length;

    await initTelemetry();
    expect(mockSampleRUM.mock.calls.length).toBe(callsAfterFirst);
  });

  it('does NOT register window error listeners in CLI branch', async () => {
    const { initTelemetry } = await import('../../src/ui/telemetry.js');
    await initTelemetry();

    const before = mockSampleRUM.mock.calls.length;
    const errorEvent = new Event('error') as ErrorEvent;
    Object.defineProperty(errorEvent, 'message', { value: 'oops' });
    window.dispatchEvent(errorEvent);

    // SLICC's listener would emit `{source:'js', target:'oops'}`. Helix's mock
    // is a stub and won't auto-listen. So no SLICC-shape error call should appear.
    const sliccShape = mockSampleRUM.mock.calls
      .slice(before)
      .filter(([cp, data]) => cp === 'error' && data?.source === 'js');
    expect(sliccShape).toHaveLength(0);
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

  it('registers window error listeners that call trackError("js", sanitized)', async () => {
    const { initTelemetry } = await import('../../src/ui/telemetry.js');
    await initTelemetry();
    mockSampleRumJs.mockClear();

    const errorEvent = new Event('error') as ErrorEvent;
    Object.defineProperty(errorEvent, 'message', {
      value: 'TypeError: x is not a function at /workspace/skills/foo/bar.ts:10',
    });
    window.dispatchEvent(errorEvent);

    expect(mockSampleRumJs).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({
        source: 'js',
        target: expect.stringContaining('/workspace/.../'),
      })
    );
    expect(mockSampleRumJs.mock.calls[0][1].target).not.toContain('/foo/bar.ts');
  });

  it('registers unhandledrejection listener that calls trackError("js", sanitized)', async () => {
    const { initTelemetry } = await import('../../src/ui/telemetry.js');
    await initTelemetry();
    mockSampleRumJs.mockClear();

    const rejection = new Event('unhandledrejection') as PromiseRejectionEvent;
    Object.defineProperty(rejection, 'reason', { value: new Error('boom') });
    window.dispatchEvent(rejection);

    expect(mockSampleRumJs).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ source: 'js', target: expect.stringContaining('boom') })
    );
  });

  // sanitizeError contract — exercised via the extension-branch error listener.
  // sanitizeError is private to telemetry.ts; the listener is its only invocation
  // path, so these tests pin its behavior with varied inputs.

  it('sanitizeError truncates messages over 200 characters', async () => {
    const { initTelemetry } = await import('../../src/ui/telemetry.js');
    await initTelemetry();
    mockSampleRumJs.mockClear();

    const long = 'x'.repeat(250);
    const errorEvent = new Event('error') as ErrorEvent;
    Object.defineProperty(errorEvent, 'message', { value: long });
    window.dispatchEvent(errorEvent);

    const target = mockSampleRumJs.mock.calls[0][1].target as string;
    expect(target.length).toBeLessThanOrEqual(200);
  });

  it('sanitizeError collapses multiple VFS paths in one message', async () => {
    const { initTelemetry } = await import('../../src/ui/telemetry.js');
    await initTelemetry();
    mockSampleRumJs.mockClear();

    const errorEvent = new Event('error') as ErrorEvent;
    Object.defineProperty(errorEvent, 'message', {
      value: 'failed at /workspace/skills/a/b.ts and again at /shared/notes/c/d.md',
    });
    window.dispatchEvent(errorEvent);

    const target = mockSampleRumJs.mock.calls[0][1].target as string;
    expect(target).toContain('/workspace/.../');
    expect(target).toContain('/shared/.../');
    expect(target).not.toContain('/a/b.ts');
    expect(target).not.toContain('/c/d.md');
  });

  it('sanitizeError handles a null/empty message without throwing', async () => {
    const { initTelemetry } = await import('../../src/ui/telemetry.js');
    await initTelemetry();
    mockSampleRumJs.mockClear();

    const errorEvent = new Event('error') as ErrorEvent;
    Object.defineProperty(errorEvent, 'message', { value: undefined });
    expect(() => window.dispatchEvent(errorEvent)).not.toThrow();
    expect(mockSampleRumJs).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ source: 'js', target: '' })
    );
  });

  it('unhandledrejection with a non-Error reason stringifies it', async () => {
    const { initTelemetry } = await import('../../src/ui/telemetry.js');
    await initTelemetry();
    mockSampleRumJs.mockClear();

    const rejection = new Event('unhandledrejection') as PromiseRejectionEvent;
    Object.defineProperty(rejection, 'reason', { value: 'plain string reason' });
    window.dispatchEvent(rejection);

    expect(mockSampleRumJs).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ source: 'js', target: 'plain string reason' })
    );
  });

  it('sanitizeError collapses uppercase VFS paths (regex i flag)', async () => {
    const { initTelemetry } = await import('../../src/ui/telemetry.js');
    await initTelemetry();
    mockSampleRumJs.mockClear();

    const errorEvent = new Event('error') as ErrorEvent;
    Object.defineProperty(errorEvent, 'message', {
      value: 'failed at /WORKSPACE/Skills/Foo/Bar.ts',
    });
    window.dispatchEvent(errorEvent);

    const target = mockSampleRumJs.mock.calls[0][1].target as string;
    expect(target).toContain('/WORKSPACE/.../');
    expect(target).not.toContain('/Foo/Bar.ts');
  });
});

// ---------------------------------------------------------------------------
// Electron branch — covers the third arm of the dispatcher (overlay attribute).
// CLI/Electron share the helix-rum-js code path; the only branch difference
// from CLI is the mode label that drives RUM_GENERATION.
// ---------------------------------------------------------------------------

describe('telemetry — electron branch', () => {
  const mockSampleRumJs = vi.fn();

  beforeEach(() => {
    mockLocalStorage.clear();
    mockSampleRUM.mockClear();
    mockSampleRumJs.mockClear();
    vi.resetModules();
    document.documentElement.dataset.electronOverlay = 'true';
    // Mock rum.js so we can prove it was NOT used in the electron branch
    // — a refactor that accidentally routed electron through rum.js would
    // call this mock instead of mockSampleRUM, which the negative assertion
    // below catches.
    vi.doMock('../../src/ui/rum.js', () => ({ default: mockSampleRumJs }));
  });

  afterEach(() => {
    delete document.documentElement.dataset.electronOverlay;
    vi.doUnmock('../../src/ui/rum.js');
    vi.resetModules();
  });

  it('sets RUM_GENERATION=slicc-electron and uses helix-rum-js with SAMPLE_PAGEVIEWS_AT_RATE=high', async () => {
    const { initTelemetry } = await import('../../src/ui/telemetry.js');
    await initTelemetry();

    expect(window.RUM_GENERATION).toBe('slicc-electron');
    expect(window.SAMPLE_PAGEVIEWS_AT_RATE).toBe('high');
    expect(mockSampleRUM).toHaveBeenCalledWith(
      'navigate',
      expect.objectContaining({ target: 'electron' })
    );
    // Negative: the inlined rum.js must NOT be the active sampler in this branch.
    expect(mockSampleRumJs).not.toHaveBeenCalled();
  });
});
