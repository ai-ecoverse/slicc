import { describe, expect, it } from 'vitest';

import {
  ELECTRON_OVERLAY_SET_TAB_MESSAGE_TYPE,
  getElectronOverlayInitialTab,
  getLickWebSocketUrl,
  getTrayWebhookUrl,
  getWebhookUrl,
  isElectronOverlaySetTabMessage,
  resolveUiRuntimeMode,
  shouldUseRuntimeModeTrayDefaults,
} from '../../src/ui/runtime-mode.js';

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

  it('normalizes the initial overlay tab from the URL', () => {
    expect(getElectronOverlayInitialTab('http://localhost:5710/electron?tab=memory')).toBe(
      'memory'
    );
    expect(getElectronOverlayInitialTab('http://localhost:5710/electron')).toBe('chat');
    expect(getElectronOverlayInitialTab('http://localhost:5710/electron?tab=nope')).toBe('chat');
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

  it('recognizes overlay tab messages', () => {
    expect(
      isElectronOverlaySetTabMessage({ type: ELECTRON_OVERLAY_SET_TAB_MESSAGE_TYPE, tab: 'files' })
    ).toBe(true);
    expect(isElectronOverlaySetTabMessage({ type: 'something-else' })).toBe(false);
    expect(isElectronOverlaySetTabMessage(null)).toBe(false);
  });
});
