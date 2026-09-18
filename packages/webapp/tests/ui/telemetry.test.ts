// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSampleRUM = vi.fn();

vi.mock('@adobe/helix-rum-js', () => ({
  sampleRUM: mockSampleRUM,
}));

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
    Object.keys(localStorageMock).forEach((k) => {
      delete localStorageMock[k];
    });
  },
};

function stubLocalStorage() {
  vi.stubGlobal('localStorage', mockLocalStorage);
}

describe('telemetry', () => {
  beforeEach(() => {
    mockLocalStorage.clear();
    mockSampleRUM.mockClear();
    vi.resetModules();
    stubLocalStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('initializes and emits navigate checkpoint', async () => {
    const { initTelemetry } = await import('../../src/kernel/telemetry.js');
    await initTelemetry();
    expect(mockSampleRUM).toHaveBeenCalledWith(
      'navigate',
      expect.objectContaining({
        target: expect.stringMatching(/^(cli|extension|electron)$/),
      })
    );
  });

  it('sets RUM_GENERATION=slicc-cli in the CLI branch', async () => {
    const { initTelemetry } = await import('../../src/kernel/telemetry.js');
    await initTelemetry();
    expect((globalThis as any).window?.RUM_GENERATION).toBe('slicc-cli');
  });

  it('respects telemetry-disabled flag', async () => {
    mockLocalStorage.setItem('telemetry-disabled', 'true');
    const { initTelemetry, trackChatSend } = await import('../../src/kernel/telemetry.js');
    await initTelemetry();
    trackChatSend('cone', 'claude');
    expect(mockSampleRUM).not.toHaveBeenCalled();
  });

  it('trackChatSend emits formsubmit', async () => {
    const { initTelemetry, trackChatSend } = await import('../../src/kernel/telemetry.js');
    await initTelemetry();
    mockSampleRUM.mockClear();

    trackChatSend('cone', 'claude-sonnet');
    expect(mockSampleRUM).toHaveBeenCalledWith('formsubmit', {
      source: 'cone',
      target: 'claude-sonnet',
    });
  });

  it('trackShellCommand emits fill', async () => {
    const { initTelemetry, trackShellCommand } = await import('../../src/kernel/telemetry.js');
    await initTelemetry();
    mockSampleRUM.mockClear();

    trackShellCommand('git');
    expect(mockSampleRUM).toHaveBeenCalledWith('fill', { source: 'git' });
  });

  it('initTelemetry registers the shell telemetry sink so emitShellCommand reaches RUM', async () => {
    const { initTelemetry } = await import('../../src/kernel/telemetry.js');
    const { emitShellCommand } = await import('../../src/shell/telemetry-hook.js');
    await initTelemetry();
    mockSampleRUM.mockClear();

    emitShellCommand('node');
    expect(mockSampleRUM).toHaveBeenCalledWith('fill', { source: 'node' });
  });

  it('trackScoopLifecycle emits enter/convert/leave for spawn/feed/complete', async () => {
    const { initTelemetry, trackScoopLifecycle } = await import('../../src/kernel/telemetry.js');
    await initTelemetry();
    mockSampleRUM.mockClear();

    trackScoopLifecycle('spawn', 'researcher');
    trackScoopLifecycle('feed', 'researcher');
    trackScoopLifecycle('complete', 'researcher');

    expect(mockSampleRUM).toHaveBeenNthCalledWith(1, 'enter', {
      source: 'researcher',
      target: 'scoop-spawn',
    });
    expect(mockSampleRUM).toHaveBeenNthCalledWith(2, 'convert', {
      source: 'researcher',
      target: 'scoop-feed',
    });
    expect(mockSampleRUM).toHaveBeenNthCalledWith(3, 'leave', {
      source: 'researcher',
      target: 'scoop-complete',
    });
  });

  it('trackScoopLifecycle error namespaces source and sanitizes target', async () => {
    const { initTelemetry, trackScoopLifecycle } = await import('../../src/kernel/telemetry.js');
    await initTelemetry();
    mockSampleRUM.mockClear();

    trackScoopLifecycle('error', 'planner', 'rate_limit');
    expect(mockSampleRUM).toHaveBeenCalledWith('error', {
      source: 'scoop:planner',
      target: 'rate_limit',
    });
  });

  it('trackScoopLifecycle drops error entirely on pure Vite-noise details', async () => {
    const { initTelemetry, trackScoopLifecycle } = await import('../../src/kernel/telemetry.js');
    await initTelemetry();
    mockSampleRUM.mockClear();

    trackScoopLifecycle('error', 'planner', '[vite] hot updated: /src/foo.ts');
    const errorCalls = mockSampleRUM.mock.calls.filter(([cp]) => cp === 'error');
    expect(errorCalls).toHaveLength(0);
  });

  it('trackScoopLifecycle drops error for user-fixable error families (no-api-key, invalid-model, auth-expired)', async () => {
    const { initTelemetry, trackScoopLifecycle } = await import('../../src/kernel/telemetry.js');
    await initTelemetry();
    mockSampleRUM.mockClear();

    trackScoopLifecycle(
      'error',
      'cone',
      'No API key configured for provider "anthropic". Open Settings to add one.'
    );
    trackScoopLifecycle(
      'error',
      'cone',
      'Validation error: Bedrock CAMP API error (400): The provided model identifier is invalid.'
    );
    trackScoopLifecycle(
      'error',
      'cone',
      'Scoop cone failed with unrecoverable error: session expired, please log in again'
    );

    const errorCalls = mockSampleRUM.mock.calls.filter(([cp]) => cp === 'error');
    expect(errorCalls).toHaveLength(0);
  });

  it('trackScoopLifecycle drops error for the Adobe "Model not allowed" 403 family', async () => {
    const { initTelemetry, trackScoopLifecycle } = await import('../../src/kernel/telemetry.js');
    await initTelemetry();
    mockSampleRUM.mockClear();

    trackScoopLifecycle(
      'error',
      'strategy-digest-scoop',
      'Scoop "strategy-digest" failed with unrecoverable error: 403 {"error":{"type":"forbidden","message":"Model not allowed: claude-sonnet-4-6"}}'
    );

    const errorCalls = mockSampleRUM.mock.calls.filter(([cp]) => cp === 'error');
    expect(errorCalls).toHaveLength(0);
  });

  it('trackError drops user-fixable error families before sampling (llm/tool/js beacons)', async () => {
    const { initTelemetry, trackError } = await import('../../src/kernel/telemetry.js');
    await initTelemetry();
    mockSampleRUM.mockClear();

    trackError(
      'llm',
      '403 {"error":{"type":"forbidden","message":"Model not allowed: claude-sonnet-4-6"}}'
    );
    trackError('llm', 'No API key configured for provider "anthropic". Open Settings to add one.');
    trackError(
      'llm',
      'Validation error: Bedrock CAMP API error (400): The provided model identifier is invalid.'
    );
    trackError('llm', 'Adobe session expired — please log in again');

    trackError(
      'llm',
      '429 {"error":{"type":"quota_exceeded","message":"Weekly budget has been fully used. Resets on 2026-09-14.","resets_at":"2026-09-14T00:00:00.000Z"}}'
    );
    trackError(
      'llm',
      '403 {"error":"You have either run out of available resources or do not have an active Grok subscription."}'
    );

    const errorCalls = mockSampleRUM.mock.calls.filter(([cp]) => cp === 'error');
    expect(errorCalls).toHaveLength(0);
  });

  it('trackScoopLifecycle drops user-fixable error even when a long prefix pushes the family substring past the 200-char truncation', async () => {
    const { initTelemetry, trackScoopLifecycle } = await import('../../src/kernel/telemetry.js');
    await initTelemetry();
    mockSampleRUM.mockClear();

    const longPrefix = `Scoop "${'a'.repeat(220)}" failed with unrecoverable error: session expired, please log in again`;
    trackScoopLifecycle('error', 'cone', longPrefix);

    const errorCalls = mockSampleRUM.mock.calls.filter(([cp]) => cp === 'error');
    expect(errorCalls).toHaveLength(0);
  });

  it('initTelemetry registers the scoop telemetry sink so emitScoopLifecycle reaches RUM', async () => {
    const { initTelemetry } = await import('../../src/kernel/telemetry.js');
    const { emitScoopLifecycle } = await import('../../src/scoops/scoop-telemetry-hook.js');
    await initTelemetry();
    mockSampleRUM.mockClear();

    emitScoopLifecycle('spawn', 'researcher');
    expect(mockSampleRUM).toHaveBeenCalledWith('enter', {
      source: 'researcher',
      target: 'scoop-spawn',
    });
  });

  it('initTelemetry registers the agent-error sink so emitAgentError reaches RUM with typed source', async () => {
    const { initTelemetry } = await import('../../src/kernel/telemetry.js');
    const { emitAgentError } = await import('../../src/core/telemetry-hook.js');
    await initTelemetry();
    mockSampleRUM.mockClear();

    emitAgentError('llm', 'rate_limit');
    emitAgentError('tool', 'bash: command failed');

    expect(mockSampleRUM).toHaveBeenNthCalledWith(1, 'error', {
      source: 'llm',
      target: 'rate_limit',
    });
    expect(mockSampleRUM).toHaveBeenNthCalledWith(2, 'error', {
      source: 'tool',
      target: 'bash: command failed',
    });
  });

  it('trackSprinkleView emits viewblock', async () => {
    const { initTelemetry, trackSprinkleView } = await import('../../src/kernel/telemetry.js');
    await initTelemetry();
    mockSampleRUM.mockClear();

    trackSprinkleView('welcome');
    expect(mockSampleRUM).toHaveBeenCalledWith('viewblock', { source: 'welcome' });
  });

  it('trackError emits error', async () => {
    const { initTelemetry, trackError } = await import('../../src/kernel/telemetry.js');
    await initTelemetry();
    mockSampleRUM.mockClear();

    trackError('llm', 'rate_limit');
    expect(mockSampleRUM).toHaveBeenCalledWith('error', { source: 'llm', target: 'rate_limit' });
  });

  it('trackLickBackpressure emits a dedicated non-error checkpoint', async () => {
    const { initTelemetry, trackLickBackpressure } = await import('../../src/kernel/telemetry.js');
    await initTelemetry();
    mockSampleRUM.mockClear();

    trackLickBackpressure('researcher', 300_000);
    expect(mockSampleRUM).toHaveBeenCalledWith('lick-backpressure', {
      source: 'researcher',
      target: '300000',
    });
    expect(mockSampleRUM.mock.calls.some(([checkpoint]) => checkpoint === 'error')).toBe(false);
  });

  it('trackImageView emits viewmedia', async () => {
    const { initTelemetry, trackImageView } = await import('../../src/kernel/telemetry.js');
    await initTelemetry();
    mockSampleRUM.mockClear();

    trackImageView('chat');
    expect(mockSampleRUM).toHaveBeenCalledWith('viewmedia', { source: 'chat' });
  });

  it('trackSettingsOpen emits signup', async () => {
    const { initTelemetry, trackSettingsOpen } = await import('../../src/kernel/telemetry.js');
    await initTelemetry();
    mockSampleRUM.mockClear();

    trackSettingsOpen('button');
    expect(mockSampleRUM).toHaveBeenCalledWith('signup', { source: 'button' });
  });

  it('trackError sanitizes target (truncates to 200 chars)', async () => {
    const { initTelemetry, trackError } = await import('../../src/kernel/telemetry.js');
    await initTelemetry();
    mockSampleRUM.mockClear();

    const long = 'x'.repeat(250);
    trackError('js', long);
    const target = mockSampleRUM.mock.calls[0][1].target as string;
    expect(target.length).toBeLessThanOrEqual(200);
    expect(target.length).toBe(200);
  });

  it('trackError drops errors that are entirely Vite dev-server noise', async () => {
    const { initTelemetry, trackError } = await import('../../src/kernel/telemetry.js');
    await initTelemetry();
    mockSampleRUM.mockClear();

    trackError(
      'js',
      'Failed to fetch dynamically imported module: http://localhost:5710/@vite/client'
    );
    const errorCalls = mockSampleRUM.mock.calls.filter(([cp]) => cp === 'error');
    expect(errorCalls).toHaveLength(0);
  });

  it('trackError drops [vite] HMR overlay noise entirely', async () => {
    const { initTelemetry, trackError } = await import('../../src/kernel/telemetry.js');
    await initTelemetry();
    mockSampleRUM.mockClear();

    trackError('js', '[vite] hot updated: /src/foo.ts');
    const errorCalls = mockSampleRUM.mock.calls.filter(([cp]) => cp === 'error');
    expect(errorCalls).toHaveLength(0);
  });

  it('trackError strips Vite frames from real app errors but keeps the rest', async () => {
    const { initTelemetry, trackError } = await import('../../src/kernel/telemetry.js');
    await initTelemetry();
    mockSampleRUM.mockClear();

    const mixed = [
      'TypeError: cannot read property x of undefined',
      '  at handler (/workspace/skills/foo.ts:10:5)',
      '  at http://localhost:5710/@vite/client.js:42:1',
    ].join('\n');
    trackError('js', mixed);

    const target = mockSampleRUM.mock.calls[0][1].target as string;
    expect(target).toContain('TypeError');
    expect(target).not.toContain('@vite/client');
    expect(target).not.toContain('localhost:5710');
  });

  it('trackError preserves real errors unchanged (no Vite content)', async () => {
    const { initTelemetry, trackError } = await import('../../src/kernel/telemetry.js');
    await initTelemetry();
    mockSampleRUM.mockClear();

    trackError('llm', 'rate_limit');
    expect(mockSampleRUM).toHaveBeenCalledWith('error', { source: 'llm', target: 'rate_limit' });
  });

  it('trackError beacons Error and object details as a message, not [object Object]', async () => {
    const { initTelemetry, trackError } = await import('../../src/kernel/telemetry.js');
    await initTelemetry();
    mockSampleRUM.mockClear();

    trackError('error-card', new TypeError('cannot read x'));
    trackError('error-card', { message: 'The system encountered an unexpected error' });
    trackError('llm', {
      type: 'error',
      error: { type: 'upstream_error', message: 'bedrock returned 400' },
    });

    const errorCalls = mockSampleRUM.mock.calls.filter(([cp]) => cp === 'error');
    expect(errorCalls).toHaveLength(3);
    expect(errorCalls[0][1]).toEqual({
      source: 'error-card',
      target: 'TypeError: cannot read x',
    });
    expect(errorCalls[1][1]).toEqual({
      source: 'error-card',
      target: 'The system encountered an unexpected error',
    });
    expect(errorCalls[2][1]).toEqual({ source: 'llm', target: 'bedrock returned 400' });
    for (const [, data] of errorCalls) {
      expect(data.target).not.toBe('[object Object]');
      expect(typeof data.target).toBe('string');
    }
  });

  it('trackError unwraps JSON-blob string details to the inner message', async () => {
    const { initTelemetry, trackError } = await import('../../src/kernel/telemetry.js');
    await initTelemetry();
    mockSampleRUM.mockClear();

    trackError(
      'error-card',
      '{"type":"error","error":{"type":"upstream_error","message":"bedrock returned 400"}}'
    );
    expect(mockSampleRUM).toHaveBeenCalledWith('error', {
      source: 'error-card',
      target: 'bedrock returned 400',
    });
  });

  it('trackError drops unknown object bags instead of serializing them', async () => {
    const { initTelemetry, trackError } = await import('../../src/kernel/telemetry.js');
    await initTelemetry();
    mockSampleRUM.mockClear();

    trackError('js', { token: 'secret', request: { url: '/join/abc' } });
    const errorCalls = mockSampleRUM.mock.calls.filter(([cp]) => cp === 'error');
    expect(errorCalls).toHaveLength(0);
  });

  it('trackError still drops user-fixable families when details is a structured object', async () => {
    const { initTelemetry, trackError } = await import('../../src/kernel/telemetry.js');
    await initTelemetry();
    mockSampleRUM.mockClear();

    trackError('llm', {
      error: { type: 'quota_exceeded', message: 'Weekly budget has been fully used.' },
    });
    trackError('llm', {
      error:
        'You have either run out of available resources or do not have an active Grok subscription.',
    });
    trackError('llm', { message: 'No API key configured for provider "anthropic".' });
    const errorCalls = mockSampleRUM.mock.calls.filter(([cp]) => cp === 'error');
    expect(errorCalls).toHaveLength(0);
  });

  it('trackError still truncates long string details after coercion', async () => {
    const { initTelemetry, trackError } = await import('../../src/kernel/telemetry.js');
    await initTelemetry();
    mockSampleRUM.mockClear();

    trackError('js', { message: 'x'.repeat(250) });
    const target = mockSampleRUM.mock.calls[0][1].target as string;
    expect(target.length).toBeLessThanOrEqual(200);
  });

  it('CLI capture interceptor drops a thrown bag with no message field', async () => {
    const { initTelemetry } = await import('../../src/kernel/telemetry.js');
    await initTelemetry();
    mockSampleRUM.mockClear();

    const errorEvent = new Event('error') as ErrorEvent;
    Object.defineProperty(errorEvent, 'error', {
      value: { token: 'secret', request: { url: '/join/abc' } },
    });
    window.dispatchEvent(errorEvent);

    const errorCalls = mockSampleRUM.mock.calls.filter(([cp]) => cp === 'error');
    expect(errorCalls).toHaveLength(0);
  });

  it('CLI capture interceptor beacons a thrown POJO via trackError, not [object Object]', async () => {
    const { initTelemetry } = await import('../../src/kernel/telemetry.js');
    await initTelemetry();
    mockSampleRUM.mockClear();

    const errorEvent = new Event('error') as ErrorEvent;
    Object.defineProperty(errorEvent, 'error', {
      value: { message: 'bedrock returned 400' },
    });
    window.dispatchEvent(errorEvent);

    expect(mockSampleRUM).toHaveBeenCalledWith('error', {
      source: 'js',
      target: 'bedrock returned 400',
    });
  });

  it('CLI sampleRUM wrapper passes through non-error checkpoints unchanged', async () => {
    const { initTelemetry, trackChatSend } = await import('../../src/kernel/telemetry.js');
    await initTelemetry();
    mockSampleRUM.mockClear();

    trackChatSend('cone', 'claude-sonnet');
    expect(mockSampleRUM).toHaveBeenCalledWith('formsubmit', {
      source: 'cone',
      target: 'claude-sonnet',
    });
  });

  it('track functions are no-op before init', async () => {
    const { trackChatSend, trackShellCommand } = await import('../../src/kernel/telemetry.js');
    trackChatSend('cone', 'claude');
    trackShellCommand('ls');
    expect(mockSampleRUM).not.toHaveBeenCalled();
  });

  it('initTelemetry is idempotent — second call is a no-op', async () => {
    const { initTelemetry } = await import('../../src/kernel/telemetry.js');
    await initTelemetry();
    const callsAfterFirst = mockSampleRUM.mock.calls.length;

    await initTelemetry();
    expect(mockSampleRUM.mock.calls.length).toBe(callsAfterFirst);
  });

  it('does NOT register window error listeners in CLI branch', async () => {
    const { initTelemetry } = await import('../../src/kernel/telemetry.js');
    await initTelemetry();

    const before = mockSampleRUM.mock.calls.length;
    const errorEvent = new Event('error') as ErrorEvent;
    Object.defineProperty(errorEvent, 'message', { value: 'oops' });
    window.dispatchEvent(errorEvent);

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
    stubLocalStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns true by default', async () => {
    const { isTelemetryEnabled } = await import('../../src/kernel/telemetry.js');
    expect(isTelemetryEnabled()).toBe(true);
  });

  it('returns false when disabled', async () => {
    mockLocalStorage.setItem('telemetry-disabled', 'true');
    const { isTelemetryEnabled } = await import('../../src/kernel/telemetry.js');
    expect(isTelemetryEnabled()).toBe(false);
  });

  it('setTelemetryEnabled toggles the flag', async () => {
    const { isTelemetryEnabled, setTelemetryEnabled } = await import(
      '../../src/kernel/telemetry.js'
    );
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
    stubLocalStorage();
    vi.stubGlobal('chrome', { runtime: { id: 'test-extension' } });
    vi.doMock('../../src/kernel/rum.js', () => ({ default: mockSampleRumJs }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('../../src/kernel/rum.js');
    vi.resetModules();
  });

  it('uses the inlined rum.js (default export) and sets RUM_GENERATION=slicc-extension', async () => {
    const { initTelemetry } = await import('../../src/kernel/telemetry.js');
    await initTelemetry({ isExtensionRealm: true });
    expect(mockSampleRumJs).toHaveBeenCalledWith(
      'navigate',
      expect.objectContaining({ target: 'extension' })
    );
    expect(mockSampleRUM).not.toHaveBeenCalled();
    expect((globalThis as any).window?.RUM_GENERATION).toBe('slicc-extension');
  });

  it('does NOT set SAMPLE_PAGEVIEWS_AT_RATE in the extension branch', async () => {
    const { initTelemetry } = await import('../../src/kernel/telemetry.js');
    if ((globalThis as any).window) {
      delete (globalThis as any).window.SAMPLE_PAGEVIEWS_AT_RATE;
    }
    await initTelemetry({ isExtensionRealm: true });
    expect((globalThis as any).window?.SAMPLE_PAGEVIEWS_AT_RATE).toBeUndefined();
  });

  it('forwards trackChatSend through the extension sampleRUM', async () => {
    const { initTelemetry, trackChatSend } = await import('../../src/kernel/telemetry.js');
    await initTelemetry({ isExtensionRealm: true });
    mockSampleRumJs.mockClear();

    trackChatSend('cone', 'claude-sonnet');
    expect(mockSampleRumJs).toHaveBeenCalledWith('formsubmit', {
      source: 'cone',
      target: 'claude-sonnet',
    });
  });

  it('registers window error listeners that call trackError("js", sanitized)', async () => {
    const { initTelemetry } = await import('../../src/kernel/telemetry.js');
    await initTelemetry({ isExtensionRealm: true });
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

  it('error listener falls back to error.message when event.message is empty', async () => {
    const { initTelemetry } = await import('../../src/kernel/telemetry.js');
    await initTelemetry({ isExtensionRealm: true });
    mockSampleRumJs.mockClear();

    const errorEvent = new Event('error') as ErrorEvent;
    Object.defineProperty(errorEvent, 'message', { value: '' });
    Object.defineProperty(errorEvent, 'error', {
      value: new Error('nested error context'),
    });
    window.dispatchEvent(errorEvent);

    expect(mockSampleRumJs).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({
        source: 'js',
        target: expect.stringContaining('nested error context'),
      })
    );
  });

  it('registers unhandledrejection listener that calls trackError("js", sanitized)', async () => {
    const { initTelemetry } = await import('../../src/kernel/telemetry.js');
    await initTelemetry({ isExtensionRealm: true });
    mockSampleRumJs.mockClear();

    const rejection = new Event('unhandledrejection') as PromiseRejectionEvent;
    Object.defineProperty(rejection, 'reason', { value: new Error('boom') });
    window.dispatchEvent(rejection);

    expect(mockSampleRumJs).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ source: 'js', target: expect.stringContaining('boom') })
    );
  });

  it('sanitizeError truncates messages over 200 characters', async () => {
    const { initTelemetry } = await import('../../src/kernel/telemetry.js');
    await initTelemetry({ isExtensionRealm: true });
    mockSampleRumJs.mockClear();

    const long = 'x'.repeat(250);
    const errorEvent = new Event('error') as ErrorEvent;
    Object.defineProperty(errorEvent, 'message', { value: long });
    window.dispatchEvent(errorEvent);

    const target = mockSampleRumJs.mock.calls[0][1].target as string;
    expect(target.length).toBeLessThanOrEqual(200);
  });

  it('sanitizeError collapses multiple VFS paths in one message', async () => {
    const { initTelemetry } = await import('../../src/kernel/telemetry.js');
    await initTelemetry({ isExtensionRealm: true });
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
    const { initTelemetry } = await import('../../src/kernel/telemetry.js');
    await initTelemetry({ isExtensionRealm: true });
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
    const { initTelemetry } = await import('../../src/kernel/telemetry.js');
    await initTelemetry({ isExtensionRealm: true });
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
    const { initTelemetry } = await import('../../src/kernel/telemetry.js');
    await initTelemetry({ isExtensionRealm: true });
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

describe('telemetry — CLI sendBeacon wrapper', () => {
  let savedSendBeacon: typeof navigator.sendBeacon | undefined;

  beforeEach(() => {
    mockLocalStorage.clear();
    mockSampleRUM.mockClear();
    vi.resetModules();
    stubLocalStorage();
    savedSendBeacon = (navigator as Navigator).sendBeacon;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    if (savedSendBeacon) {
      Object.defineProperty(navigator, 'sendBeacon', {
        value: savedSendBeacon,
        writable: true,
        configurable: true,
      });
    } else {
      delete (navigator as unknown as { sendBeacon?: unknown }).sendBeacon;
    }
  });

  function installUnderlyingBeacon(): ReturnType<typeof vi.fn> {
    const underlying = vi.fn(() => true);
    Object.defineProperty(navigator, 'sendBeacon', {
      value: underlying,
      writable: true,
      configurable: true,
    });
    return underlying;
  }

  it('drops error beacons whose target is entirely Vite noise', async () => {
    const underlying = installUnderlyingBeacon();
    const { initTelemetry } = await import('../../src/kernel/telemetry.js');
    await initTelemetry();
    expect(navigator.sendBeacon).not.toBe(underlying);

    const body = JSON.stringify({
      checkpoint: 'error',
      target: 'http://localhost:5710/@vite/client',
    });
    const result = navigator.sendBeacon('https://rum.hlx.page/.rum/100', body);
    expect(result).toBe(true);
    expect(underlying).not.toHaveBeenCalled();
  });

  it('drops error beacons whose source AND target are both pure Vite noise', async () => {
    const underlying = installUnderlyingBeacon();
    const { initTelemetry } = await import('../../src/kernel/telemetry.js');
    await initTelemetry();

    const body = JSON.stringify({
      checkpoint: 'error',
      source: 'http://localhost:5710/@vite/client',
      target: 'http://localhost:5710/@vite/client.js',
    });
    const result = navigator.sendBeacon('https://rum.hlx.page/.rum/100', body);
    expect(result).toBe(true);
    expect(underlying).not.toHaveBeenCalled();
  });

  it('blanks a noisy source but keeps the beacon when the target survives', async () => {
    const underlying = installUnderlyingBeacon();
    const { initTelemetry } = await import('../../src/kernel/telemetry.js');
    await initTelemetry();

    const body = JSON.stringify({
      checkpoint: 'error',
      source: 'http://localhost:5710/@vite/client',
      target: 'TypeError: real app failure',
    });
    navigator.sendBeacon('https://rum.hlx.page/.rum/100', body);
    expect(underlying).toHaveBeenCalledOnce();
    const sent = JSON.parse(underlying.mock.calls[0][1] as string);
    expect(sent.source).toBe('');
    expect(sent.target).toContain('TypeError');
    expect(sent.checkpoint).toBe('error');
  });

  it('blanks a noisy target but keeps the beacon when the source survives', async () => {
    const underlying = installUnderlyingBeacon();
    const { initTelemetry } = await import('../../src/kernel/telemetry.js');
    await initTelemetry();

    const body = JSON.stringify({
      checkpoint: 'error',
      source: 'https://example.com/app.js',
      target: 'http://localhost:5710/@vite/client',
    });
    navigator.sendBeacon('https://rum.hlx.page/.rum/100', body);
    expect(underlying).toHaveBeenCalledOnce();
    const sent = JSON.parse(underlying.mock.calls[0][1] as string);
    expect(sent.source).toBe('https://example.com/app.js');
    expect(sent.target).toBe('');
  });

  it('drops helix leftover [object Object] under source undefined error', async () => {
    const underlying = installUnderlyingBeacon();
    const { initTelemetry } = await import('../../src/kernel/telemetry.js');
    await initTelemetry();

    const body = JSON.stringify({
      checkpoint: 'error',
      source: 'undefined error',
      target: '[object Object]',
    });
    const result = navigator.sendBeacon('https://rum.hlx.page/.rum/100', body);
    expect(result).toBe(true);
    expect(underlying).not.toHaveBeenCalled();
  });

  it('unwraps a nested object target on an error beacon body', async () => {
    const underlying = installUnderlyingBeacon();
    const { initTelemetry } = await import('../../src/kernel/telemetry.js');
    await initTelemetry();

    const body = JSON.stringify({
      checkpoint: 'error',
      source: 'Unhandled Rejection',
      target: { message: 'bedrock returned 400' },
    });
    navigator.sendBeacon('https://rum.hlx.page/.rum/100', body);
    expect(underlying).toHaveBeenCalledOnce();
    const sent = JSON.parse(underlying.mock.calls[0][1] as string);
    expect(sent.target).toBe('bedrock returned 400');
    expect(sent.source).toBe('Unhandled Rejection');
  });

  it('rewrites error beacons with mixed Vite + real-app content', async () => {
    const underlying = installUnderlyingBeacon();
    const { initTelemetry } = await import('../../src/kernel/telemetry.js');
    await initTelemetry();

    const body = JSON.stringify({
      checkpoint: 'error',
      source: 'undefined error',
      target: 'TypeError: oops\n  at http://localhost:5710/@vite/client.js:1:1',
    });
    navigator.sendBeacon('https://rum.hlx.page/.rum/100', body);
    expect(underlying).toHaveBeenCalledOnce();
    const sent = JSON.parse(underlying.mock.calls[0][1] as string);
    expect(sent.target).toContain('TypeError');
    expect(sent.target).not.toContain('@vite/client');
    expect(sent.checkpoint).toBe('error');
  });

  it('passes through non-error beacons unchanged', async () => {
    const underlying = installUnderlyingBeacon();
    const { initTelemetry } = await import('../../src/kernel/telemetry.js');
    await initTelemetry();
    const body = JSON.stringify({ checkpoint: 'navigate', target: 'cli' });
    navigator.sendBeacon('https://rum.hlx.page/.rum/100', body);
    expect(underlying).toHaveBeenCalledOnce();
    expect(underlying.mock.calls[0][1]).toBe(body);
  });

  it('falls through opaque (Blob) bodies without throwing', async () => {
    const underlying = installUnderlyingBeacon();
    const { initTelemetry } = await import('../../src/kernel/telemetry.js');
    await initTelemetry();
    const blob = new Blob(['{"checkpoint":"error","target":"x"}'], {
      type: 'application/json',
    });
    navigator.sendBeacon('https://rum.hlx.page/.rum/100', blob);
    expect(underlying).toHaveBeenCalledOnce();
    expect(underlying.mock.calls[0][1]).toBe(blob);
  });

  it('does not re-wrap an already-wrapped sendBeacon on re-init', async () => {
    const underlying = installUnderlyingBeacon();
    const { initTelemetry } = await import('../../src/kernel/telemetry.js');
    await initTelemetry();
    const wrappedOnce = navigator.sendBeacon;

    vi.resetModules();
    const reloaded = await import('../../src/kernel/telemetry.js');
    await reloaded.initTelemetry();
    expect(navigator.sendBeacon).toBe(wrappedOnce);

    const viteBody = JSON.stringify({
      checkpoint: 'error',
      target: 'http://localhost:5710/@vite/client',
    });
    navigator.sendBeacon('https://rum.hlx.page/.rum/100', viteBody);
    expect(underlying).not.toHaveBeenCalled();
  });
});

describe('telemetry — electron branch', () => {
  const mockSampleRumJs = vi.fn();

  beforeEach(() => {
    mockLocalStorage.clear();
    mockSampleRUM.mockClear();
    mockSampleRumJs.mockClear();
    vi.resetModules();
    stubLocalStorage();
    document.documentElement.dataset.electronOverlay = 'true';

    vi.doMock('../../src/kernel/rum.js', () => ({ default: mockSampleRumJs }));
  });

  afterEach(() => {
    delete document.documentElement.dataset.electronOverlay;
    vi.doUnmock('../../src/kernel/rum.js');
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('sets RUM_GENERATION=slicc-electron and uses helix-rum-js with SAMPLE_PAGEVIEWS_AT_RATE=high', async () => {
    const { initTelemetry } = await import('../../src/kernel/telemetry.js');
    await initTelemetry();

    expect(window.RUM_GENERATION).toBe('slicc-electron');
    expect(window.SAMPLE_PAGEVIEWS_AT_RATE).toBe('high');
    expect(mockSampleRUM).toHaveBeenCalledWith(
      'navigate',
      expect.objectContaining({ target: 'electron' })
    );

    expect(mockSampleRumJs).not.toHaveBeenCalled();
  });
});
