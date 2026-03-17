import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSampleRUM = vi.fn();

vi.mock('@adobe/helix-rum-js', () => ({
  sampleRUM: mockSampleRUM,
}));

// Mock localStorage for Node environment
const localStorageMock: Record<string, string> = {};
const mockLocalStorage = {
  getItem: (key: string) => localStorageMock[key] ?? null,
  setItem: (key: string, value: string) => { localStorageMock[key] = value; },
  removeItem: (key: string) => { delete localStorageMock[key]; },
  clear: () => { Object.keys(localStorageMock).forEach(k => delete localStorageMock[k]); },
};

vi.stubGlobal('localStorage', mockLocalStorage);

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
    const { initTelemetry } = await import('./telemetry.js');
    await initTelemetry();
    expect(mockSampleRUM).toHaveBeenCalledWith('navigate', expect.objectContaining({
      target: expect.stringMatching(/^(cli|extension|electron)$/),
    }));
  });

  it('respects telemetry-disabled flag', async () => {
    mockLocalStorage.setItem('telemetry-disabled', 'true');
    const { initTelemetry, trackChatSend } = await import('./telemetry.js');
    await initTelemetry();
    trackChatSend('cone', 'claude');
    expect(mockSampleRUM).not.toHaveBeenCalled();
  });

  it('trackChatSend emits formsubmit', async () => {
    const { initTelemetry, trackChatSend } = await import('./telemetry.js');
    await initTelemetry();
    mockSampleRUM.mockClear();
    
    trackChatSend('cone', 'claude-sonnet');
    expect(mockSampleRUM).toHaveBeenCalledWith('formsubmit', { source: 'cone', target: 'claude-sonnet' });
  });

  it('trackShellCommand emits fill', async () => {
    const { initTelemetry, trackShellCommand } = await import('./telemetry.js');
    await initTelemetry();
    mockSampleRUM.mockClear();
    
    trackShellCommand('git');
    expect(mockSampleRUM).toHaveBeenCalledWith('fill', { source: 'git' });
  });

  it('trackSprinkleView emits viewblock', async () => {
    const { initTelemetry, trackSprinkleView } = await import('./telemetry.js');
    await initTelemetry();
    mockSampleRUM.mockClear();
    
    trackSprinkleView('welcome');
    expect(mockSampleRUM).toHaveBeenCalledWith('viewblock', { source: 'welcome' });
  });

  it('trackError emits error', async () => {
    const { initTelemetry, trackError } = await import('./telemetry.js');
    await initTelemetry();
    mockSampleRUM.mockClear();
    
    trackError('llm', 'rate_limit');
    expect(mockSampleRUM).toHaveBeenCalledWith('error', { source: 'llm', target: 'rate_limit' });
  });

  it('track functions are no-op before init', async () => {
    const { trackChatSend, trackShellCommand } = await import('./telemetry.js');
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
    const { isTelemetryEnabled } = await import('./telemetry.js');
    expect(isTelemetryEnabled()).toBe(true);
  });

  it('returns false when disabled', async () => {
    mockLocalStorage.setItem('telemetry-disabled', 'true');
    const { isTelemetryEnabled } = await import('./telemetry.js');
    expect(isTelemetryEnabled()).toBe(false);
  });

  it('setTelemetryEnabled toggles the flag', async () => {
    const { isTelemetryEnabled, setTelemetryEnabled } = await import('./telemetry.js');
    expect(isTelemetryEnabled()).toBe(true);
    
    setTelemetryEnabled(false);
    expect(mockLocalStorage.getItem('telemetry-disabled')).toBe('true');
    
    setTelemetryEnabled(true);
    expect(mockLocalStorage.getItem('telemetry-disabled')).toBeNull();
  });
});
