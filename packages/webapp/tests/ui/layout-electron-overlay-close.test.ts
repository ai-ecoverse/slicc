// @vitest-environment jsdom
/**
 * Tests for the electron-overlay close button mounted in the inner
 * webapp's thread header (`Layout.setShowElectronOverlayClose`) and
 * for the close-message round-trip on `SliccElectronOverlayElement`.
 *
 * The button is mounted only in electron-overlay mode (see `main.ts`),
 * sits to the LEFT of the scoop switcher in the thread header, and
 * posts `ELECTRON_OVERLAY_CLOSE_MESSAGE_TYPE` to `window.parent`. The
 * outer overlay shell forwards that message to
 * `SliccElectronOverlayElement.hideSidebar()`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ELECTRON_OVERLAY_TAG_NAME,
  registerElectronOverlayElements,
  type SliccElectronOverlayElement,
} from '../../src/ui/electron-overlay.js';
import { Layout } from '../../src/ui/layout.js';
import { ELECTRON_OVERLAY_CLOSE_MESSAGE_TYPE } from '../../src/ui/runtime-mode.js';

/**
 * Build a Layout shell stub that bypasses the heavy constructor.
 * `setShowElectronOverlayClose` only reads `this.threadHeaderEl` and
 * writes `this.electronOverlayCloseBtnEl`; both are TS `private` (not
 * `#private`), so prototype-attached methods operate on a hand-rolled
 * fixture without booting ChatPanel/TerminalPanel/RailZone.
 */
function makeLayoutFixture(): {
  layout: Layout;
  threadHeaderEl: HTMLElement;
  titleEl: HTMLElement;
  switcherEl: HTMLElement;
} {
  const layout = Object.create(Layout.prototype) as Layout;
  const threadHeaderEl = document.createElement('div');
  threadHeaderEl.className = 'thread-header';
  const titleEl = document.createElement('div');
  titleEl.className = 'thread-header__title';
  // Stand-in for the scoop-switcher dropdown so we can prove the new
  // close button lands to the LEFT of it (first child of the title).
  const switcherEl = document.createElement('div');
  switcherEl.className = 'scoop-switcher';
  titleEl.appendChild(switcherEl);
  threadHeaderEl.appendChild(titleEl);
  document.body.appendChild(threadHeaderEl);
  (layout as unknown as { threadHeaderEl: HTMLElement }).threadHeaderEl = threadHeaderEl;
  return { layout, threadHeaderEl, titleEl, switcherEl };
}

const BTN_SEL = 'button.thread-header__electron-overlay-close';

describe('Layout.setShowElectronOverlayClose — DOM mount/unmount', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('mounts a button with the expected attributes when given a handler', () => {
    const { layout, titleEl } = makeLayoutFixture();
    layout.setShowElectronOverlayClose(() => {});

    const btn = titleEl.querySelector<HTMLButtonElement>(BTN_SEL);
    expect(btn).not.toBeNull();
    expect(btn!.type).toBe('button');
    expect(btn!.title).toBe('Close SLICC');
    expect(btn!.getAttribute('aria-label')).toBe('Close SLICC');
    // Inlined ✕ glyph — assert the svg renders so a future icon change
    // doesn't silently ship an empty button.
    expect(btn!.querySelector('svg')).not.toBeNull();
  });

  it('inserts the button as the first child of the title (left of the switcher)', () => {
    const { layout, titleEl, switcherEl } = makeLayoutFixture();
    layout.setShowElectronOverlayClose(() => {});

    expect(
      titleEl.firstElementChild?.classList.contains('thread-header__electron-overlay-close')
    ).toBe(true);
    expect(titleEl.children).toHaveLength(2);
    expect(titleEl.children[1]).toBe(switcherEl);
  });

  it('routes click events to the provided handler', () => {
    const { layout, titleEl } = makeLayoutFixture();
    const handler = vi.fn();
    layout.setShowElectronOverlayClose(handler);

    const btn = titleEl.querySelector<HTMLButtonElement>(BTN_SEL)!;
    btn.click();
    btn.click();
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('is idempotent — repeat calls with a handler do not duplicate the button', () => {
    const { layout, titleEl } = makeLayoutFixture();
    layout.setShowElectronOverlayClose(() => {});
    layout.setShowElectronOverlayClose(() => {});

    expect(titleEl.querySelectorAll(BTN_SEL)).toHaveLength(1);
  });

  it('is absent by default — no button until setShowElectronOverlayClose runs', () => {
    const { titleEl } = makeLayoutFixture();
    expect(titleEl.querySelector(BTN_SEL)).toBeNull();
  });

  it('removes the button when called with null', () => {
    const { layout, titleEl } = makeLayoutFixture();
    layout.setShowElectronOverlayClose(() => {});
    expect(titleEl.querySelector(BTN_SEL)).not.toBeNull();

    layout.setShowElectronOverlayClose(null);
    expect(titleEl.querySelector(BTN_SEL)).toBeNull();
  });

  it('is a no-op when the thread header has no `.thread-header__title`', () => {
    const layout = Object.create(Layout.prototype) as Layout;
    const threadHeaderEl = document.createElement('div');
    threadHeaderEl.className = 'thread-header';
    document.body.appendChild(threadHeaderEl);
    (layout as unknown as { threadHeaderEl: HTMLElement }).threadHeaderEl = threadHeaderEl;

    expect(() => layout.setShowElectronOverlayClose(() => {})).not.toThrow();
    expect(threadHeaderEl.querySelector(BTN_SEL)).toBeNull();
  });
});

describe('SliccElectronOverlayElement — close-message round-trip', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    registerElectronOverlayElements();
  });

  function mountOverlay(appUrl?: string): SliccElectronOverlayElement {
    const overlay = document.createElement(
      ELECTRON_OVERLAY_TAG_NAME
    ) as SliccElectronOverlayElement;
    overlay.setAttribute('open', '');
    if (appUrl !== undefined) overlay.setAttribute('app-url', appUrl);
    document.body.appendChild(overlay);
    return overlay;
  }

  /**
   * Synthesize a MessageEvent with caller-controlled `source` and `origin`
   * so we can prove the source/origin guards reject hostile cases. The
   * `window.postMessage` self-post path in jsdom leaves `source` null, so
   * we dispatch the event directly to exercise the source==window branch.
   */
  function dispatchMessage(detail: {
    data: unknown;
    source?: MessageEventSource | null;
    origin?: string;
  }): void {
    const event = new MessageEvent('message', {
      data: detail.data,
      source: detail.source ?? null,
      origin: detail.origin ?? '',
    });
    window.dispatchEvent(event);
  }

  it('hides the sidebar when ELECTRON_OVERLAY_CLOSE_MESSAGE_TYPE is posted', async () => {
    const overlay = mountOverlay();
    expect(overlay.open).toBe(true);

    window.postMessage({ type: ELECTRON_OVERLAY_CLOSE_MESSAGE_TYPE }, '*');
    await vi.waitFor(() => expect(overlay.open).toBe(false));
  });

  it('ignores foreign message types', async () => {
    const overlay = mountOverlay();

    window.postMessage({ type: 'slicc-electron-overlay:other' }, '*');
    await new Promise((r) => setTimeout(r, 10));
    expect(overlay.open).toBe(true);
  });

  it('rejects messages whose source is the host window itself', () => {
    const overlay = mountOverlay();

    dispatchMessage({
      data: { type: ELECTRON_OVERLAY_CLOSE_MESSAGE_TYPE },
      source: window,
      origin: window.location.origin,
    });
    expect(overlay.open).toBe(true);

    dispatchMessage({
      data: { type: 'slicc-electron-overlay:toggle' },
      source: window,
      origin: window.location.origin,
    });
    expect(overlay.open).toBe(true);
  });

  it('rejects messages whose origin does not match the iframe app origin', () => {
    const overlay = mountOverlay('https://app.example.com/electron');

    dispatchMessage({
      data: { type: ELECTRON_OVERLAY_CLOSE_MESSAGE_TYPE },
      source: { postMessage: () => {} } as unknown as MessageEventSource,
      origin: 'https://evil.example.com',
    });
    expect(overlay.open).toBe(true);
  });

  it('accepts messages whose origin matches the iframe app origin', () => {
    const overlay = mountOverlay('https://app.example.com/electron');

    dispatchMessage({
      data: { type: ELECTRON_OVERLAY_CLOSE_MESSAGE_TYPE },
      source: { postMessage: () => {} } as unknown as MessageEventSource,
      origin: 'https://app.example.com',
    });
    expect(overlay.open).toBe(false);
  });

  it('skips origin validation when appUrl is empty (relies on source guard alone)', () => {
    const overlay = mountOverlay();

    dispatchMessage({
      data: { type: ELECTRON_OVERLAY_CLOSE_MESSAGE_TYPE },
      source: { postMessage: () => {} } as unknown as MessageEventSource,
      origin: 'https://anywhere.example.com',
    });
    expect(overlay.open).toBe(false);
  });
});

describe('main.ts electron-overlay close-button gating — embedded vs top-level', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  /**
   * Mirrors the gating in `main.ts`: when `/electron` is opened top-level,
   * `window.parent === window`, so `setShowElectronOverlayClose(null)` is
   * called and no button must be mounted — otherwise the button would post
   * a close message to itself and close nothing.
   */
  it('top-level frame branch (null) does not mount a close button', () => {
    const { layout, titleEl } = makeLayoutFixture();
    const isEmbedded = window.parent !== window;
    // jsdom default: `window.parent === window`, so we exercise the same
    // branch main.ts takes for top-level `/electron`.
    expect(isEmbedded).toBe(false);
    if (isEmbedded) {
      layout.setShowElectronOverlayClose(() => {});
    } else {
      layout.setShowElectronOverlayClose(null);
    }
    expect(titleEl.querySelector(BTN_SEL)).toBeNull();
  });

  /**
   * Mirrors the gating in `main.ts`: when actually embedded in the overlay
   * shell, `window.parent !== window`, so a handler is passed and the
   * button IS mounted. We cannot make jsdom satisfy that predicate without
   * a real iframe, so we exercise the embedded branch directly.
   */
  it('embedded frame branch (handler) mounts a close button that posts to parent', () => {
    const { layout, titleEl } = makeLayoutFixture();
    const postSpy = vi.fn();
    // Same closure shape as the production code path.
    layout.setShowElectronOverlayClose(() => {
      postSpy({ type: ELECTRON_OVERLAY_CLOSE_MESSAGE_TYPE });
    });
    const btn = titleEl.querySelector<HTMLButtonElement>(BTN_SEL);
    expect(btn).not.toBeNull();
    btn!.click();
    expect(postSpy).toHaveBeenCalledWith({ type: ELECTRON_OVERLAY_CLOSE_MESSAGE_TYPE });
  });
});
