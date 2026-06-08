// @vitest-environment jsdom
/**
 * Targeted tests for the small public setters on `Layout` that can be
 * exercised via a hand-rolled prototype fixture, mirroring the pattern
 * established by `layout-electron-overlay-close.test.ts`. We bypass
 * the heavy `Layout` constructor entirely because these setters only
 * read a few private fields each — booting the full layout would drag
 * in ChatPanel, RailZone, scoop-switcher, model lists, etc.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Layout } from '../../src/ui/layout.js';

type LayoutPrivates = {
  root: HTMLElement;
  isExtension: boolean;
  threadHeaderEl?: HTMLElement;
  threadHeaderName?: HTMLElement;
  newSessionBtn: { classList: DOMTokenList } | null;
  primaryRail?: {
    collapse: ReturnType<typeof vi.fn>;
    activateItem: ReturnType<typeof vi.fn>;
    getActiveItemId: ReturnType<typeof vi.fn>;
  };
  activeTab: string;
  popoutButtonEl?: HTMLButtonElement;
  popoutClickHandler?: () => void;
  detachedActiveOverlayEl?: HTMLDivElement;
};

function makeLayout(
  opts: { isExtension?: boolean; withRailHeader?: boolean; withThreadHeader?: boolean } = {}
): { layout: Layout; root: HTMLElement; privates: LayoutPrivates } {
  const layout = Object.create(Layout.prototype) as Layout;
  const root = document.createElement('div');
  document.body.appendChild(root);

  // Standalone mode hosts the popout button on `.header`; extension mode
  // hosts it on `.thread-header`. Render both up-front and let the test
  // toggle `isExtension` to drive the branch.
  if (opts.withRailHeader !== false) {
    const header = document.createElement('div');
    header.className = 'header';
    root.appendChild(header);
  }

  const threadHeaderEl = document.createElement('div');
  threadHeaderEl.className = 'thread-header';
  if (opts.withThreadHeader !== false) root.appendChild(threadHeaderEl);

  const threadHeaderName = document.createElement('span');
  threadHeaderName.className = 'thread-header__name';
  threadHeaderEl.appendChild(threadHeaderName);

  const privates: LayoutPrivates = {
    root,
    isExtension: opts.isExtension ?? false,
    threadHeaderEl,
    threadHeaderName,
    newSessionBtn: { classList: document.createElement('button').classList },
    primaryRail: {
      collapse: vi.fn(),
      activateItem: vi.fn(),
      getActiveItemId: vi.fn(() => 'chat'),
    },
    activeTab: 'chat',
  };
  Object.assign(layout as unknown as Record<string, unknown>, privates);
  return { layout, root, privates };
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe('Layout.setShowPopoutButton', () => {
  it('mounts a popout button under `.header` in standalone mode and routes clicks to the handler', () => {
    const { layout, root } = makeLayout();
    const handler = vi.fn();
    layout.setPopoutClickHandler(handler);
    layout.setShowPopoutButton(true);
    const btn = root.querySelector('.header__popout-btn') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.type).toBe('button');
    expect(btn.title).toBe('Open in a new tab');
    expect(btn.getAttribute('aria-label')).toBe('Pop out to a new tab');
    btn.click();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(btn.disabled).toBe(true);
  });

  it('mounts the popout button under `.thread-header` in extension mode', () => {
    const { layout, root } = makeLayout({ isExtension: true });
    layout.setPopoutClickHandler(() => {});
    layout.setShowPopoutButton(true);
    const headerBtn = root.querySelector('.header .header__popout-btn');
    const threadBtn = root.querySelector('.thread-header .header__popout-btn');
    expect(headerBtn).toBeNull();
    expect(threadBtn).not.toBeNull();
  });

  it('is idempotent — repeat true calls do not duplicate the button', () => {
    const { layout, root } = makeLayout();
    layout.setShowPopoutButton(true);
    layout.setShowPopoutButton(true);
    expect(root.querySelectorAll('.header__popout-btn')).toHaveLength(1);
  });

  it('removes the popout button when called with false', () => {
    const { layout, root } = makeLayout();
    layout.setShowPopoutButton(true);
    expect(root.querySelector('.header__popout-btn')).not.toBeNull();
    layout.setShowPopoutButton(false);
    expect(root.querySelector('.header__popout-btn')).toBeNull();
  });

  it('is a no-op when no container element exists', () => {
    const { layout, root, privates } = makeLayout({ withRailHeader: false });
    privates.isExtension = false;
    // Remove the thread-header too so neither container resolves.
    root.querySelector('.thread-header')?.remove();
    expect(() => layout.setShowPopoutButton(true)).not.toThrow();
    expect(root.querySelector('.header__popout-btn')).toBeNull();
  });

  it('resetPopoutButton re-enables a disabled button and is safe with no button', () => {
    const { layout, root } = makeLayout();
    // Safe before any button is mounted.
    expect(() => layout.resetPopoutButton()).not.toThrow();
    layout.setPopoutClickHandler(() => {});
    layout.setShowPopoutButton(true);
    const btn = root.querySelector('.header__popout-btn') as HTMLButtonElement;
    btn.disabled = true;
    layout.resetPopoutButton();
    expect(btn.disabled).toBe(false);
  });
});

describe('Layout.setThreadHeaderName', () => {
  it('updates the thread-header name text when connected', () => {
    const { layout, privates } = makeLayout();
    layout.setThreadHeaderName('Frozen archive');
    expect(privates.threadHeaderName!.textContent).toBe('Frozen archive');
  });

  it('is a no-op when the thread-header name is detached', () => {
    const { layout, privates } = makeLayout();
    privates.threadHeaderName!.remove();
    expect(() => layout.setThreadHeaderName('whatever')).not.toThrow();
    expect(privates.threadHeaderName!.textContent).toBe('');
  });
});

describe('Layout.setNewSessionGlow', () => {
  it('toggles `glow` / `glow--hot` classes based on the fill ratio', () => {
    const { layout, privates } = makeLayout();
    const cl = privates.newSessionBtn!.classList;
    layout.setNewSessionGlow(0.1);
    expect(cl.contains('glow')).toBe(false);
    expect(cl.contains('glow--hot')).toBe(false);
    layout.setNewSessionGlow(0.6);
    expect(cl.contains('glow')).toBe(true);
    expect(cl.contains('glow--hot')).toBe(false);
    layout.setNewSessionGlow(0.9);
    expect(cl.contains('glow')).toBe(true);
    expect(cl.contains('glow--hot')).toBe(true);
    layout.setNewSessionGlow(0.0);
    expect(cl.contains('glow')).toBe(false);
    expect(cl.contains('glow--hot')).toBe(false);
  });

  it('is a no-op when the new-session button has not been mounted', () => {
    const { layout, privates } = makeLayout();
    privates.newSessionBtn = null;
    expect(() => layout.setNewSessionGlow(0.9)).not.toThrow();
  });
});

describe('Layout.setActiveTab / getActiveTab', () => {
  it('collapses the rail for the chat tab', () => {
    const { layout, privates } = makeLayout();
    layout.setActiveTab('chat');
    expect(privates.primaryRail!.collapse).toHaveBeenCalledTimes(1);
    expect(privates.primaryRail!.activateItem).not.toHaveBeenCalled();
    expect(layout.getActiveTab()).toBe('chat');
  });

  it('activates the matching rail item for non-chat tabs', () => {
    const { layout, privates } = makeLayout();
    layout.setActiveTab('terminal');
    expect(privates.primaryRail!.activateItem).toHaveBeenCalledWith('terminal');
    expect(layout.getActiveTab()).toBe('terminal');
  });
});

describe('Layout.isTerminalOpen / openTerminal', () => {
  it('reports terminal-open when the rail has the terminal item active', () => {
    const { layout, privates } = makeLayout();
    privates.primaryRail!.getActiveItemId.mockReturnValue('terminal');
    expect(layout.isTerminalOpen()).toBe(true);
    privates.primaryRail!.getActiveItemId.mockReturnValue('memory');
    expect(layout.isTerminalOpen()).toBe(false);
  });

  it('openTerminal activates the terminal rail item', () => {
    const { layout, privates } = makeLayout();
    privates.primaryRail!.getActiveItemId.mockReturnValue('chat');
    layout.openTerminal();
    expect(privates.primaryRail!.activateItem).toHaveBeenCalledWith('terminal');
  });

  it('openTerminal does not steal focus from an active sprinkle', () => {
    const { layout, privates } = makeLayout();
    privates.primaryRail!.getActiveItemId.mockReturnValue('sprinkle-github');
    layout.openTerminal();
    expect(privates.primaryRail!.activateItem).not.toHaveBeenCalled();
  });
});

describe('Layout.setAgentProcessing', () => {
  it('toggles `.thread-header--processing` on the thread-header', () => {
    const { layout, privates } = makeLayout();
    layout.setAgentProcessing(true);
    expect(privates.threadHeaderEl!.classList.contains('thread-header--processing')).toBe(true);
    layout.setAgentProcessing(false);
    expect(privates.threadHeaderEl!.classList.contains('thread-header--processing')).toBe(false);
  });
});

describe('Layout.showDetachedActiveOverlay', () => {
  it('renders the alertdialog overlay and is idempotent', () => {
    const { layout, root } = makeLayout();
    layout.showDetachedActiveOverlay();
    layout.showDetachedActiveOverlay();
    const overlays = root.querySelectorAll('.layout-detached-overlay');
    expect(overlays).toHaveLength(1);
    expect(overlays[0].getAttribute('role')).toBe('alertdialog');
    expect(overlays[0].getAttribute('aria-modal')).toBe('true');
    expect(overlays[0].querySelector('p')?.textContent).toMatch(/Detached in another tab/);
    expect(overlays[0].querySelector('.layout-detached-overlay-close')).not.toBeNull();
  });
});
