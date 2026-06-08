// @vitest-environment jsdom
/**
 * Focused tests for the `setupElectronOverlay()` boot stage. These
 * pin the gating contract (no-op outside the overlay float) and the
 * three observable effects: initial tab, runtime style, and `set-tab`
 * postMessage handling. The \u2318; shortcut is covered by the existing
 * `electron-overlay-shortcut.test.ts` at the constants layer.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setupElectronOverlay } from '../../../src/ui/boot/setup-electron-overlay.js';
import { ELECTRON_OVERLAY_CLOSE_MESSAGE_TYPE } from '../../../src/ui/runtime-mode.js';

type FakeLayout = {
  setActiveTab: ReturnType<typeof vi.fn>;
  setShowElectronOverlayClose: ReturnType<typeof vi.fn>;
};

function makeFakeLayout(): FakeLayout {
  return {
    setActiveTab: vi.fn(),
    setShowElectronOverlayClose: vi.fn(),
  };
}

beforeEach(() => {
  document.getElementById('slicc-electron-overlay-runtime-style')?.remove();
});

describe('setupElectronOverlay', () => {
  it('is a no-op when isElectronOverlay is false', () => {
    const layout = makeFakeLayout();
    const addListener = vi.spyOn(window, 'addEventListener');

    setupElectronOverlay({
      layout: layout as unknown as Parameters<typeof setupElectronOverlay>[0]['layout'],
      isElectronOverlay: false,
      window,
      document,
    });

    expect(layout.setActiveTab).not.toHaveBeenCalled();
    expect(document.getElementById('slicc-electron-overlay-runtime-style')).toBeNull();
    expect(addListener).not.toHaveBeenCalled();
  });

  it('sets initial tab from URL hash and injects the runtime style', () => {
    const layout = makeFakeLayout();
    window.history.replaceState({}, '', '/?tab=terminal');

    setupElectronOverlay({
      layout: layout as unknown as Parameters<typeof setupElectronOverlay>[0]['layout'],
      isElectronOverlay: true,
      window,
      document,
    });

    expect(layout.setActiveTab).toHaveBeenCalledWith('terminal');
    const style = document.getElementById('slicc-electron-overlay-runtime-style');
    expect(style).not.toBeNull();
    expect(style?.textContent).toContain('.tab-bar { display: none !important; }');
  });

  it('updates the active tab when the parent posts a set-tab message', () => {
    const layout = makeFakeLayout();
    window.history.replaceState({}, '', '/');

    setupElectronOverlay({
      layout: layout as unknown as Parameters<typeof setupElectronOverlay>[0]['layout'],
      isElectronOverlay: true,
      window,
      document,
    });
    layout.setActiveTab.mockClear();

    const event = new MessageEvent('message', {
      data: { type: 'slicc-electron-overlay:set-tab', tab: 'files' },
      source: window.parent,
    });
    window.dispatchEvent(event);

    expect(layout.setActiveTab).toHaveBeenCalledWith('files');
  });

  it('ignores set-tab messages from non-parent sources', () => {
    const layout = makeFakeLayout();
    setupElectronOverlay({
      layout: layout as unknown as Parameters<typeof setupElectronOverlay>[0]['layout'],
      isElectronOverlay: true,
      window,
      document,
    });
    layout.setActiveTab.mockClear();

    const event = new MessageEvent('message', {
      data: { type: 'slicc-electron-overlay:set-tab', tab: 'files' },
      source: null,
    });
    window.dispatchEvent(event);

    expect(layout.setActiveTab).not.toHaveBeenCalled();
  });

  it('mounts an electron-overlay close button that posts a close message when embedded', () => {
    const layout = makeFakeLayout();
    // jsdom: window.parent === window by default, so use a stub window with
    // a distinct parent to model the embedded-overlay case.
    const postMessage = vi.fn();
    const fakeParent = { postMessage } as unknown as Window;
    const fakeWin = {
      parent: fakeParent,
      location: { href: 'http://localhost/?tab=chat' },
      addEventListener: vi.fn(),
    } as unknown as Window;

    setupElectronOverlay({
      layout: layout as unknown as Parameters<typeof setupElectronOverlay>[0]['layout'],
      isElectronOverlay: true,
      window: fakeWin,
      document,
    });

    expect(layout.setShowElectronOverlayClose).toHaveBeenCalledTimes(1);
    const handler = layout.setShowElectronOverlayClose.mock.calls[0][0] as () => void;
    expect(typeof handler).toBe('function');

    handler();
    expect(postMessage).toHaveBeenCalledWith({ type: ELECTRON_OVERLAY_CLOSE_MESSAGE_TYPE }, '*');
  });

  it('clears the electron-overlay close button when opened top-level (parent === self)', () => {
    const layout = makeFakeLayout();

    setupElectronOverlay({
      layout: layout as unknown as Parameters<typeof setupElectronOverlay>[0]['layout'],
      isElectronOverlay: true,
      window,
      document,
    });

    expect(layout.setShowElectronOverlayClose).toHaveBeenCalledWith(null);
  });
});
