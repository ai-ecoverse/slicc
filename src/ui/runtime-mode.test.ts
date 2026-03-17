import { describe, expect, it } from 'vitest';

import {
  ELECTRON_OVERLAY_SET_TAB_MESSAGE_TYPE,
  getElectronOverlayInitialTab,
  getLickWebSocketUrl,
  getWebhookUrl,
  isElectronOverlaySetTabMessage,
  resolveUiRuntimeMode,
} from './runtime-mode.js';

describe('runtime-mode', () => {
  it('prefers extension mode when chrome runtime is present', () => {
    expect(resolveUiRuntimeMode('http://localhost:5710/electron', true)).toBe('extension');
  });

  it('detects electron overlay mode from the path and legacy query param', () => {
    expect(resolveUiRuntimeMode('http://localhost:5710/electron', false)).toBe('electron-overlay');
    expect(resolveUiRuntimeMode('http://localhost:5710/electron/', false)).toBe('electron-overlay');
    expect(resolveUiRuntimeMode('http://localhost:5710/?runtime=electron-overlay', false)).toBe('electron-overlay');
    expect(resolveUiRuntimeMode('http://localhost:5710/', false)).toBe('standalone');
  });

  it('normalizes the initial overlay tab from the URL', () => {
    expect(getElectronOverlayInitialTab('http://localhost:5710/electron?tab=memory')).toBe('memory');
    expect(getElectronOverlayInitialTab('http://localhost:5710/electron')).toBe('chat');
    expect(getElectronOverlayInitialTab('http://localhost:5710/electron?tab=nope')).toBe('chat');
  });

  it('builds lick websocket and webhook urls from the current origin', () => {
    expect(getLickWebSocketUrl('http://localhost:5710/app')).toBe('ws://localhost:5710/licks-ws');
    expect(getLickWebSocketUrl('https://example.com/app')).toBe('wss://example.com/licks-ws');
    expect(getWebhookUrl('https://example.com/app?x=1', 'wh-123')).toBe('https://example.com/webhooks/wh-123');
  });

  it('recognizes overlay tab messages', () => {
    expect(isElectronOverlaySetTabMessage({ type: ELECTRON_OVERLAY_SET_TAB_MESSAGE_TYPE, tab: 'files' })).toBe(true);
    expect(isElectronOverlaySetTabMessage({ type: 'something-else' })).toBe(false);
    expect(isElectronOverlaySetTabMessage(null)).toBe(false);
  });
});