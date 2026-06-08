import { describe, expect, it } from 'vitest';

import {
  ELECTRON_OVERLAY_CLOSE_MESSAGE_TYPE,
  ELECTRON_OVERLAY_FOLLOWER_STATUS_MESSAGE_TYPE,
  ELECTRON_OVERLAY_SET_TAB_MESSAGE_TYPE,
  getElectronOverlayInitialTab,
  getLickWebSocketUrl,
  getTrayWebhookUrl,
  getWebhookUrl,
  isElectronOverlayCloseMessage,
  isElectronOverlayFollowerStatusMessage,
  isElectronOverlaySetTabMessage,
  mapFollowerStateToOverlayStatus,
  resolveUiRuntimeMode,
  shouldUseRuntimeModeTrayDefaults,
  type UiRuntimeMode,
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

  it('exposes the dedicated overlay close message type', () => {
    expect(ELECTRON_OVERLAY_CLOSE_MESSAGE_TYPE).toBe('slicc-electron-overlay:close');
    // The close message must NOT be confused with the toggle or set-tab
    // messages — the parent shell routes each to a different action.
    expect(ELECTRON_OVERLAY_CLOSE_MESSAGE_TYPE).not.toBe(ELECTRON_OVERLAY_SET_TAB_MESSAGE_TYPE);
  });

  it('recognizes overlay close messages', () => {
    expect(isElectronOverlayCloseMessage({ type: ELECTRON_OVERLAY_CLOSE_MESSAGE_TYPE })).toBe(true);
    expect(isElectronOverlayCloseMessage({ type: ELECTRON_OVERLAY_SET_TAB_MESSAGE_TYPE })).toBe(
      false
    );
    expect(isElectronOverlayCloseMessage({ type: 'something-else' })).toBe(false);
    expect(isElectronOverlayCloseMessage(null)).toBe(false);
    expect(isElectronOverlayCloseMessage(undefined)).toBe(false);
    expect(isElectronOverlayCloseMessage({})).toBe(false);
  });

  it('exposes the dedicated overlay follower-status message type', () => {
    expect(ELECTRON_OVERLAY_FOLLOWER_STATUS_MESSAGE_TYPE).toBe(
      'slicc-electron-overlay:follower-status'
    );
    // The follower-status message must not collide with close / set-tab.
    expect(ELECTRON_OVERLAY_FOLLOWER_STATUS_MESSAGE_TYPE).not.toBe(
      ELECTRON_OVERLAY_CLOSE_MESSAGE_TYPE
    );
    expect(ELECTRON_OVERLAY_FOLLOWER_STATUS_MESSAGE_TYPE).not.toBe(
      ELECTRON_OVERLAY_SET_TAB_MESSAGE_TYPE
    );
  });

  it('recognizes overlay follower-status messages with valid status values', () => {
    expect(
      isElectronOverlayFollowerStatusMessage({
        type: ELECTRON_OVERLAY_FOLLOWER_STATUS_MESSAGE_TYPE,
        status: 'disconnected',
      })
    ).toBe(true);
    expect(
      isElectronOverlayFollowerStatusMessage({
        type: ELECTRON_OVERLAY_FOLLOWER_STATUS_MESSAGE_TYPE,
        status: 'connected',
      })
    ).toBe(true);
    expect(
      isElectronOverlayFollowerStatusMessage({
        type: ELECTRON_OVERLAY_FOLLOWER_STATUS_MESSAGE_TYPE,
        status: 'error',
      })
    ).toBe(true);
  });

  it('rejects malformed follower-status messages', () => {
    expect(isElectronOverlayFollowerStatusMessage(null)).toBe(false);
    expect(isElectronOverlayFollowerStatusMessage(undefined)).toBe(false);
    expect(isElectronOverlayFollowerStatusMessage({})).toBe(false);
    expect(
      isElectronOverlayFollowerStatusMessage({
        type: ELECTRON_OVERLAY_FOLLOWER_STATUS_MESSAGE_TYPE,
      })
    ).toBe(false);
    expect(
      isElectronOverlayFollowerStatusMessage({
        type: ELECTRON_OVERLAY_FOLLOWER_STATUS_MESSAGE_TYPE,
        status: 'bogus',
      })
    ).toBe(false);
    expect(
      isElectronOverlayFollowerStatusMessage({
        type: ELECTRON_OVERLAY_CLOSE_MESSAGE_TYPE,
        status: 'connected',
      })
    ).toBe(false);
  });

  it('maps follower runtime states down to the three launcher states', () => {
    expect(mapFollowerStateToOverlayStatus('connected')).toBe('connected');
    expect(mapFollowerStateToOverlayStatus('error')).toBe('error');
    expect(mapFollowerStateToOverlayStatus('inactive')).toBe('disconnected');
    expect(mapFollowerStateToOverlayStatus('connecting')).toBe('disconnected');
    expect(mapFollowerStateToOverlayStatus('reconnecting')).toBe('disconnected');
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
