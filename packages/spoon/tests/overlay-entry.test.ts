// `window.__SLICC_ELECTRON_OVERLAY__` — the API surface node-server
// (`electron-runtime.ts`) and swift-server (`ElectronLauncher.swift`) call by
// string through CDP:
//
//   window.__SLICC_ELECTRON_OVERLAY__?.inject({appUrl:"…"});
//
// Nothing type-checks those call sites against this module, so the shape (and
// its swallow-and-log error handling, which keeps a failed injection from
// breaking the host page's own scripts) is pinned here.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../src/overlay-entry.js';
import { SLICC_LAUNCHER_HOST_ID } from '../src/inject.js';
import { SliccLauncher } from '../src/slicc-launcher.js';

function overlay(): NonNullable<Window['__SLICC_ELECTRON_OVERLAY__']> {
  const api = window.__SLICC_ELECTRON_OVERLAY__;
  if (!api) throw new Error('overlay entry did not install its global');
  return api;
}

describe('overlay-entry global', () => {
  beforeEach(() => {
    document.getElementById(SLICC_LAUNCHER_HOST_ID)?.remove();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('installs inject/remove on the window at import time', () => {
    expect(typeof overlay().inject).toBe('function');
    expect(typeof overlay().remove).toBe('function');
  });

  it('injects into the ambient document with the options the controller sends', () => {
    overlay().inject({ appUrl: 'https://example.test/electron', open: true, activeTab: 'files' });
    const host = document.getElementById(SLICC_LAUNCHER_HOST_ID);
    expect(host).toBeInstanceOf(SliccLauncher);
    expect((host as SliccLauncher).appUrl).toBe('https://example.test/electron');
    expect((host as SliccLauncher).open).toBe(true);
  });

  it('injects with no options at all (the bare re-attach call)', () => {
    overlay().inject();
    expect(document.getElementById(SLICC_LAUNCHER_HOST_ID)).toBeInstanceOf(SliccLauncher);
  });

  it('removes the overlay host', () => {
    overlay().inject({ appUrl: 'https://example.test/electron' });
    overlay().remove();
    expect(document.getElementById(SLICC_LAUNCHER_HOST_ID)).toBeNull();
  });

  it('logs instead of throwing when injection fails inside a hostile page', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const original = Object.getOwnPropertyDescriptor(Document.prototype, 'getElementById');
    Object.defineProperty(Document.prototype, 'getElementById', {
      configurable: true,
      writable: true,
      value: () => {
        throw new Error('page hijacked getElementById');
      },
    });
    try {
      expect(() => {
        overlay().inject({ appUrl: 'https://example.test/electron' });
      }).not.toThrow();
      expect(() => {
        overlay().remove();
      }).not.toThrow();
    } finally {
      if (original) Object.defineProperty(Document.prototype, 'getElementById', original);
    }
    expect(error).toHaveBeenCalledTimes(2);
    expect(error.mock.calls[0]?.[0]).toContain('[slicc-launcher]');
    expect(error.mock.calls[1]?.[0]).toContain('[slicc-launcher]');
  });
});
