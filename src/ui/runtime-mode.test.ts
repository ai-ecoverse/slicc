import { describe, expect, it } from 'vitest';

import {
  ELECTRON_OVERLAY_SET_TAB_MESSAGE_TYPE,
  getElectronOverlayInitialTab,
  getLickWebSocketUrl,
  getTrayWebhookUrl,
  getWebhookUrl,
  isElectronOverlaySetTabMessage,
  resolveUiRuntimeMode,
} from './runtime-mode.js';

describe('runtime-mode', () => {
  it('prefers extension mode when chrome runtime is present', () => {
    expect(resolveUiRuntimeMode('http://localhost:3000/electron', true)).toBe('extension');
  });

  it('detects electron overlay mode from the path and legacy query param', () => {
    expect(resolveUiRuntimeMode('http://localhost:3000/electron', false)).toBe('electron-overlay');
    expect(resolveUiRuntimeMode('http://localhost:3000/electron/', false)).toBe('electron-overlay');
    expect(resolveUiRuntimeMode('http://localhost:3000/?runtime=electron-overlay', false)).toBe('electron-overlay');
    expect(resolveUiRuntimeMode('http://localhost:3000/', false)).toBe('standalone');
  });

  it('normalizes the initial overlay tab from the URL', () => {
    expect(getElectronOverlayInitialTab('http://localhost:3000/electron?tab=memory')).toBe('memory');
    expect(getElectronOverlayInitialTab('http://localhost:3000/electron')).toBe('chat');
    expect(getElectronOverlayInitialTab('http://localhost:3000/electron?tab=nope')).toBe('chat');
  });

  it('builds lick websocket and webhook urls from the current origin', () => {
    expect(getLickWebSocketUrl('http://localhost:3000/app')).toBe('ws://localhost:3000/licks-ws');
    expect(getLickWebSocketUrl('https://example.com/app')).toBe('wss://example.com/licks-ws');
    expect(getWebhookUrl('https://example.com/app?x=1', 'wh-123')).toBe('https://example.com/webhooks/wh-123');
  });

  it('constructs tray webhook urls by appending the webhook ID', () => {
    expect(getTrayWebhookUrl('https://worker.example.com/webhook/tray-id.secret', 'wh123')).toBe(
      'https://worker.example.com/webhook/tray-id.secret/wh123',
    );
    expect(getTrayWebhookUrl('https://hub.slicc.dev/webhook/abc.def', 'my-webhook')).toBe(
      'https://hub.slicc.dev/webhook/abc.def/my-webhook',
    );
  });

  it('recognizes overlay tab messages', () => {
    expect(isElectronOverlaySetTabMessage({ type: ELECTRON_OVERLAY_SET_TAB_MESSAGE_TYPE, tab: 'files' })).toBe(true);
    expect(isElectronOverlaySetTabMessage({ type: 'something-else' })).toBe(false);
    expect(isElectronOverlaySetTabMessage(null)).toBe(false);
  });
});