import { describe, expect, it } from 'vitest';
import { TRAY_JOIN_STORAGE_KEY } from '../../src/scoops/tray-runtime-config.js';
import {
  getLickWebSocketUrl,
  getTrayWebhookUrl,
  getWebhookUrl,
  resolveUiRuntimeMode,
  shouldUseRuntimeModeTrayDefaults,
  type UiRuntimeMode,
} from '../../src/ui/runtime-mode.js';

function memStorage(entries: Record<string, string> = {}) {
  const map = new Map(Object.entries(entries));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

describe('runtime-mode', () => {
  it('prefers extension mode when chrome runtime is present', () => {
    expect(resolveUiRuntimeMode('http://localhost:5710/electron', true)).toBe('extension');
  });

  it('returns extension-detached when isExtension and ?detached=1 is set', () => {
    expect(resolveUiRuntimeMode('chrome-extension://abc/index.html?detached=1', true)).toBe(
      'extension-detached'
    );
  });

  it('returns extension when isExtension and ?detached is missing or wrong value', () => {
    expect(resolveUiRuntimeMode('chrome-extension://abc/index.html', true)).toBe('extension');
    expect(resolveUiRuntimeMode('chrome-extension://abc/index.html?detached=0', true)).toBe(
      'extension'
    );
    expect(resolveUiRuntimeMode('chrome-extension://abc/index.html?other=1', true)).toBe(
      'extension'
    );
  });

  it('ignores ?detached=1 when not an extension context', () => {
    // ?detached=1 alone (no isExtension) must not flip standalone to detached.
    expect(resolveUiRuntimeMode('http://localhost:5710/?detached=1', false)).toBe('standalone');
  });

  it('classifies extension-detached the same as extension for tray defaults', () => {
    expect(shouldUseRuntimeModeTrayDefaults('extension-detached', false)).toBe(false);
    expect(shouldUseRuntimeModeTrayDefaults('extension-detached', true)).toBe(false);
  });

  it('detects electron overlay mode from the path and legacy query param', () => {
    expect(resolveUiRuntimeMode('http://localhost:5710/electron', false)).toBe('electron-overlay');
    expect(resolveUiRuntimeMode('http://localhost:5710/electron/', false)).toBe('electron-overlay');
    expect(resolveUiRuntimeMode('http://localhost:5710/?runtime=electron-overlay', false)).toBe(
      'electron-overlay'
    );
    expect(resolveUiRuntimeMode('http://localhost:5710/', false)).toBe('standalone');
  });

  it('uses runtime-mode tray defaults only for CLI-served standalone and electron overlay', () => {
    expect(shouldUseRuntimeModeTrayDefaults('standalone', false)).toBe(false);
    expect(shouldUseRuntimeModeTrayDefaults('standalone', true)).toBe(true);
    expect(shouldUseRuntimeModeTrayDefaults('electron-overlay', false)).toBe(true);
    expect(shouldUseRuntimeModeTrayDefaults('extension', true)).toBe(false);
  });

  it('builds lick websocket and webhook urls from the current origin', () => {
    expect(getLickWebSocketUrl('http://localhost:5710/app')).toBe('ws://localhost:5710/licks-ws');
    expect(getLickWebSocketUrl('https://example.com/app')).toBe('wss://example.com/licks-ws');
    expect(getWebhookUrl('https://example.com/app?x=1', 'wh-123')).toBe(
      'https://example.com/webhooks/wh-123'
    );
  });

  it('constructs tray webhook urls by appending the webhook ID', () => {
    expect(getTrayWebhookUrl('https://worker.example.com/webhook/tray-id.secret', 'wh123')).toBe(
      'https://worker.example.com/webhook/tray-id.secret/wh123'
    );
    expect(getTrayWebhookUrl('https://hub.slicc.dev/webhook/abc.def', 'my-webhook')).toBe(
      'https://hub.slicc.dev/webhook/abc.def/my-webhook'
    );
    expect(getTrayWebhookUrl('https://hub.slicc.dev/webhook/abc.def/', '/my-webhook')).toBe(
      'https://hub.slicc.dev/webhook/abc.def/my-webhook'
    );
  });
});

describe('runtime-mode — hosted-leader', () => {
  it('resolves ?runtime=hosted-leader to hosted-leader (non-extension)', () => {
    const mode = resolveUiRuntimeMode(
      'http://localhost:5710/?runtime=hosted-leader',
      /* isExtension */ false
    );
    expect(mode).toBe<UiRuntimeMode>('hosted-leader');
  });

  it('extension context never returns hosted-leader', () => {
    const mode = resolveUiRuntimeMode(
      'chrome-extension://abc/index.html?runtime=hosted-leader',
      true
    );
    expect(mode).not.toBe('hosted-leader');
  });

  it('shouldUseRuntimeModeTrayDefaults is true for hosted-leader', () => {
    expect(shouldUseRuntimeModeTrayDefaults('hosted-leader', true)).toBe(true);
    expect(shouldUseRuntimeModeTrayDefaults('hosted-leader', false)).toBe(true);
  });

  it('falls back to standalone for missing runtime param', () => {
    expect(resolveUiRuntimeMode('http://localhost:5710/', false)).toBe('standalone');
  });
});

describe('cherry runtime mode', () => {
  it('detects cherry from ?cherry=1 in standalone (non-extension)', () => {
    expect(resolveUiRuntimeMode('https://app.example/?cherry=1', false)).toBe('cherry');
  });
  it('does not treat a bare URL as cherry', () => {
    expect(resolveUiRuntimeMode('https://app.example/', false)).not.toBe('cherry');
  });
  it('extension flag wins over ?cherry=1', () => {
    expect(resolveUiRuntimeMode('chrome-extension://abc/index.html?cherry=1', true)).toBe(
      'extension'
    );
  });
});

describe('resolveUiRuntimeMode connect mode', () => {
  it('detects ?connect=1 (non-extension)', () => {
    expect(resolveUiRuntimeMode('https://www.sliccy.ai/?connect=1', false)).toBe('connect');
  });
  it('does not treat ?connect=1 as connect in extension contexts', () => {
    expect(resolveUiRuntimeMode('https://x/?connect=1', true)).toBe('extension');
  });
});

describe('resolveUiRuntimeMode — follower', () => {
  const JOIN = 'https://www.sliccy.ai/join/tray-1.cap-token';

  it('detects a follower from a /join/ path', () => {
    expect(resolveUiRuntimeMode(JOIN, false)).toBe('follower');
  });

  it('detects a follower from a ?tray=<join> query', () => {
    expect(
      resolveUiRuntimeMode(`http://localhost:5710/?tray=${encodeURIComponent(JOIN)}`, false)
    ).toBe('follower');
  });

  it('detects a follower from a stored join URL', () => {
    expect(
      resolveUiRuntimeMode(
        'http://localhost:5710/',
        false,
        memStorage({ [TRAY_JOIN_STORAGE_KEY]: JOIN })
      )
    ).toBe('follower');
  });

  it('does NOT treat a leader /tray/<id> session URL as follower', () => {
    expect(
      resolveUiRuntimeMode(
        'http://localhost:5710/?tray=https://www.sliccy.ai/base/tray/tray-1',
        false
      )
    ).toBe('standalone');
  });

  it('keeps cherry winning over follower', () => {
    expect(resolveUiRuntimeMode(`${JOIN}?cherry=1`, false)).toBe('cherry');
  });

  it('never returns follower in an extension context', () => {
    expect(resolveUiRuntimeMode(JOIN, true)).toBe('extension');
  });

  it('is callable with no storage arg and no DOM (does not throw)', () => {
    expect(() => resolveUiRuntimeMode('http://localhost:5710/', false)).not.toThrow();
  });
});
