// @vitest-environment jsdom
/**
 * Shell-composition tests for the `?ui=wc` preview mount: structure of the
 * frame (shader / freezer / nav / shell / dock), dock→workbench wiring, and
 * the composer's local echo loop.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import { mountWcUiPreview } from '../../../src/ui/wc/wc-shell.js';

function mount(): HTMLElement {
  const root = document.createElement('div');
  document.body.appendChild(root);
  mountWcUiPreview(root);
  return root;
}

describe('mountWcUiPreview', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    document.getElementById('slicc-tokens')?.remove();
    document.getElementById('slicc-wcui-style')?.remove();
  });

  it('injects the library token stylesheet and the shell styles once', () => {
    const root = mount();
    expect(document.getElementById('slicc-tokens')).toBeTruthy();
    expect(document.getElementById('slicc-wcui-style')).toBeTruthy();
    mountWcUiPreview(root);
    expect(document.querySelectorAll('#slicc-tokens').length).toBe(1);
    expect(document.querySelectorAll('#slicc-wcui-style').length).toBe(1);
  });

  it('replaces prior root content (idempotent mount)', () => {
    const root = mount();
    mountWcUiPreview(root);
    expect(root.children.length).toBe(1);
  });

  it('assembles nav, freezer, shader, shell, and dock', () => {
    const root = mount();
    const nav = root.querySelector('slicc-nav');
    expect(nav).toBeTruthy();
    for (const tag of ['slicc-logo', 'slicc-scoop-switcher', 'slicc-floatbar', 'slicc-avatar']) {
      expect(nav?.querySelector(tag), tag).toBeTruthy();
    }
    // No theme toggle: the shell follows the OS color scheme instead.
    expect(nav?.querySelector('slicc-theme-toggle')).toBeNull();
    expect(root.querySelector('slicc-shader')).toBeTruthy();
    expect(root.querySelector('slicc-freezer slicc-freezer-new')).toBeTruthy();
    expect(root.querySelector('slicc-shell slicc-chatpane')).toBeTruthy();
    expect(root.querySelector('slicc-dock')?.hasAttribute('system-tools')).toBe(true);
  });

  it('populates the cone thread from the chat fixture', () => {
    const root = mount();
    const thread = root.querySelector('slicc-chat-thread');
    expect(thread?.getAttribute('context')).toBe('cone');
    expect(thread?.querySelectorAll('slicc-user-message').length).toBeGreaterThan(2);
    expect(thread?.querySelectorAll('slicc-agent-message').length).toBeGreaterThan(2);
    expect(thread?.querySelectorAll('slicc-lick-card').length).toBeGreaterThan(5);
  });

  it('opens the workbench on dock select and closes on dock collapse', () => {
    const root = mount();
    const dock = root.querySelector('slicc-dock') as HTMLElement;
    const shell = root.querySelector('slicc-shell') as HTMLElement;
    const body = root.querySelector('slicc-workbench-body') as HTMLElement;

    dock.dispatchEvent(
      new CustomEvent('slicc-dock-select', { bubbles: true, detail: { id: 'files' } })
    );
    expect(shell.hasAttribute('open')).toBe(true);
    expect(body.getAttribute('active')).toBe('files');

    // Clicking the active dock item emits `slicc-dock-collapse` (the dock
    // owns toggle semantics) — the workbench must close on it.
    dock.dispatchEvent(new CustomEvent('slicc-dock-collapse', { bubbles: true }));
    expect(shell.hasAttribute('open')).toBe(false);
  });

  it('live floats carry no logo — the cone chip is the brand mark', async () => {
    const { mountWcShell } = await import('../../../src/ui/wc/wc-shell.js');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const refs = mountWcShell(host, {
      messages: [],
      scoops: [],
      floatLabel: 'live',
      placeholder: 'p',
    });
    expect(host.querySelector('slicc-logo')).toBeNull();
    expect(refs.switcher).toBeTruthy();
  });

  it('follows the OS color scheme, live (no toggle — matchMedia drives the theme)', () => {
    let changeListener: (() => void) | null = null;
    const query = {
      matches: true,
      addEventListener: (_type: string, fn: () => void) => {
        changeListener = fn;
      },
      removeEventListener: () => {
        changeListener = null;
      },
    };
    // Only the color-scheme query gets the instrumented object — components
    // probe other media (reduced-motion, widths) and must not clobber it.
    const inert = (media: string) => ({
      matches: false,
      media,
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    const original = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', {
      value: (media: string) => (media.includes('prefers-color-scheme') ? query : inert(media)),
      configurable: true,
    });
    try {
      mount();
      expect(document.body.getAttribute('data-theme')).toBe('dark');
      // A system day/night switch retints without a reload.
      query.matches = false;
      (changeListener as unknown as () => void)?.();
      expect(document.body.getAttribute('data-theme')).toBe('light');
    } finally {
      Object.defineProperty(window, 'matchMedia', { value: original, configurable: true });
      document.body.classList.remove('dark');
      document.body.removeAttribute('data-theme');
    }
  });

  it('urlState option opts the thread and shell into URL state sync (off by default)', async () => {
    const { mountWcShell } = await import('../../../src/ui/wc/wc-shell.js');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const live = mountWcShell(host, {
      messages: [],
      scoops: [],
      floatLabel: 'live',
      placeholder: 'p',
      urlState: true,
    });
    expect(live.thread.hasAttribute('url-state')).toBe(true);
    expect(live.shell.hasAttribute('url-state')).toBe(true);

    // The fixture/preview mount stays URL-clean.
    const fixture = mountWcShell(host, {
      messages: [],
      scoops: [],
      floatLabel: 'fixture',
      placeholder: 'p',
    });
    expect(fixture.thread.hasAttribute('url-state')).toBe(false);
    expect(fixture.shell.hasAttribute('url-state')).toBe(false);
  });

  it('kills the UA body margin so the frame sits flush', () => {
    mount();
    const css = document.getElementById('slicc-wcui-style')?.textContent ?? '';
    expect(css).toContain('html,body{margin:0');
  });

  it('the browser dock item never opens a workspace pane (the overlay is the surface)', () => {
    const root = mount();
    const dock = root.querySelector('slicc-dock') as HTMLElement;
    const shell = root.querySelector('slicc-shell') as HTMLElement;
    dock.dispatchEvent(
      new CustomEvent('slicc-dock-select', { bubbles: true, detail: { id: 'browser' } })
    );
    expect(shell.hasAttribute('open')).toBe(false);
  });

  it('describes the tab switcher on the browser surface', () => {
    const root = mount();
    const surface = root.querySelector('[surface-id="browser"]');
    expect(surface?.textContent).toContain('tab switcher');
    expect(surface?.textContent).toContain('followers');
  });

  it('hides the workbench header until sprinkle tabs exist (tool tabs never render)', () => {
    const root = mount();
    const header = root.querySelector('slicc-workbench-header') as HTMLElement;
    // The tab bar refuses `tool`-kind tabs by design, so without sprinkles the
    // strip is an empty 46px title bar — it must start hidden.
    expect(header.hasAttribute('hidden')).toBe(true);
  });

  it('styles the terminal surface black and lets the file tree fill its pane', () => {
    mount();
    const css = document.getElementById('slicc-wcui-style')?.textContent ?? '';
    // One uniform black: the pane matches xterm's dark background…
    expect(css).toContain('.wcui-term{');
    expect(css).toContain('background:#141414');
    // …and the (legacy-stylesheet-less) xterm host flexes to full height.
    expect(css).toContain('.terminal-panel__terminal-host{flex:1 1 auto;min-height:0;}');
    // The files surface is just the tree — no dead preview column.
    expect(css).toContain('slicc-file-tree{width:100%;border-right:none;}');
  });

  it('long-pressing a sprinkle dock item opens its surface in browser fullscreen', () => {
    const root = mount();
    const dock = root.querySelector('slicc-dock') as HTMLElement;
    const shell = root.querySelector('slicc-shell') as HTMLElement;
    const body = root.querySelector('slicc-workbench-body') as HTMLElement;

    // A sprinkle surface, as the sprinkle zone would have mounted it.
    const surface = document.createElement('slicc-surface');
    surface.setAttribute('surface-id', 'sprinkle:hero');
    const requestFullscreen = vi.fn(() => Promise.resolve());
    (surface as HTMLElement & { requestFullscreen: () => Promise<void> }).requestFullscreen =
      requestFullscreen;
    body.append(surface);

    dock.dispatchEvent(
      new CustomEvent('slicc-dock-longpress', { bubbles: true, detail: { id: 'sprinkle:hero' } })
    );
    expect(shell.hasAttribute('open')).toBe(true);
    expect(body.getAttribute('active')).toBe('sprinkle:hero');
    expect(requestFullscreen).toHaveBeenCalledTimes(1);

    // Non-sprinkle ids (tools) are not fullscreen targets.
    dock.dispatchEvent(
      new CustomEvent('slicc-dock-longpress', { bubbles: true, detail: { id: 'term' } })
    );
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
  });

  it('switches the active surface on tab select (canonical detail field is id)', () => {
    const root = mount();
    const header = root.querySelector('slicc-workbench-header') as HTMLElement;
    const body = root.querySelector('slicc-workbench-body') as HTMLElement;
    // Drive the REAL tab bar so the event carries the library's canonical
    // `{ id }` detail — a synthetic `{ tabId }` event would mask the
    // field-name regression that broke tab clicks in the live shell.
    const tabBar = root.querySelector('slicc-tab-bar') as HTMLElement & {
      tabs: unknown;
      selectTab(id: string): void;
    };
    tabBar.tabs = [
      { id: 'sprinkle:hero', label: 'hero', kind: 'sprinkle' },
      { id: 'sprinkle:dash', label: 'dash', kind: 'sprinkle' },
    ];
    tabBar.selectTab('sprinkle:dash');
    expect(body.getAttribute('active')).toBe('sprinkle:dash');
  });

  it('applyShellContext swaps the shader program and the --ctx accent per mood', async () => {
    const { applyShellContext, FREEZER_TINT, mountWcShell } = await import(
      '../../../src/ui/wc/wc-shell.js'
    );
    const host = document.createElement('div');
    document.body.appendChild(host);
    const refs = mountWcShell(host, {
      messages: [],
      scoops: [],
      floatLabel: 't',
      placeholder: 'p',
    });

    // Cone (boot default): waffle lattice, warm amber, no --ctx override.
    expect(refs.shader.getAttribute('mode')).toBe('cone');

    applyShellContext(refs, { kind: 'scoop', accent: '#06b6d4' });
    expect(refs.shader.getAttribute('mode')).toBe('scoop');
    expect(refs.shader.getAttribute('tint')).toBe('#06b6d4');
    expect(refs.frame.style.getPropertyValue('--ctx')).toBe('#06b6d4');
    expect(refs.freezer.hasAttribute('ctx')).toBe(false);

    applyShellContext(refs, { kind: 'freezer' });
    expect(refs.shader.getAttribute('mode')).toBe('freezer');
    expect(refs.shader.getAttribute('tint')).toBe(FREEZER_TINT);
    expect(refs.frame.style.getPropertyValue('--ctx')).toBe(FREEZER_TINT);
    expect(refs.freezer.hasAttribute('ctx')).toBe(true);

    applyShellContext(refs, { kind: 'cone' });
    expect(refs.shader.getAttribute('mode')).toBe('cone');
    expect(refs.shader.getAttribute('tint')).toBe('var(--waffle)');
    expect(refs.frame.style.getPropertyValue('--ctx')).toBe('');
    expect(refs.freezer.hasAttribute('ctx')).toBe(false);
  });

  it('feeds thread scroll into the shader scroll attribute (rAF-throttled)', async () => {
    const root = mount();
    const thread = root.querySelector('slicc-chat-thread') as HTMLElement;
    const shader = root.querySelector('slicc-shader') as HTMLElement;
    Object.defineProperty(thread, 'scrollTop', { value: 240, configurable: true });
    thread.dispatchEvent(new Event('scroll'));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(shader.getAttribute('scroll')).toBe('240');
  });

  it('mounts a queued stack above the input card inside the composer (refs.queuedStack)', async () => {
    const { mountWcShell } = await import('../../../src/ui/wc/wc-shell.js');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const refs = mountWcShell(host, {
      messages: [],
      scoops: [],
      floatLabel: 'live',
      placeholder: 'p',
    });
    const composer = host.querySelector('slicc-composer');
    const stack = composer?.querySelector('slicc-queued-stack');
    const inputCard = composer?.querySelector('slicc-input-card');
    expect(stack).toBeTruthy();
    expect(inputCard).toBeTruthy();
    // The stack must sit ABOVE the input card inside the composer so its pile
    // grows out of the top of the composer band. The composer wraps its
    // children in a `.slicc-composer__inner` band, so check document order
    // via `compareDocumentPosition` rather than `composer.children` indices.
    expect(
      (stack as Element).compareDocumentPosition(inputCard as Element) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    // The InComposer placement contract: stack at z-index 0 + overlap margin,
    // input card lifted to z-index 1 so its opaque background hides the bottom
    // edge of the front card. The `minHeight` floor guarantees the badge and a
    // sliver of the front card stay visible above the overlap even when the
    // queued card is a single short line (without it, a ~41px card would leave
    // only ~9px above the 32px tuck and be obscured by the textarea).
    expect((stack as HTMLElement).style.zIndex).toBe('0');
    expect((stack as HTMLElement).style.marginBottom).toBe('-32px');
    expect((stack as HTMLElement).style.minHeight).toBe('76px');
    expect((inputCard as HTMLElement).style.zIndex).toBe('1');
    // The ref handle is the same node — controllers drive it via setMessages.
    expect(refs.queuedStack).toBe(stack);
  });

  it('echoes composer submissions into the thread', () => {
    const root = mount();
    const card = root.querySelector('slicc-input-card') as HTMLElement;
    const thread = root.querySelector('slicc-chat-thread') as HTMLElement;
    const before = thread.querySelectorAll('slicc-user-message').length;

    card.dispatchEvent(
      new CustomEvent('submit', { bubbles: true, detail: { value: 'hello from the preview' } })
    );
    const bubbles = thread.querySelectorAll('slicc-user-message');
    expect(bubbles.length).toBe(before + 1);
    // The bubble body renders into the component's shadow root.
    expect(bubbles[bubbles.length - 1].shadowRoot?.textContent).toContain('hello from the preview');

    card.dispatchEvent(new CustomEvent('submit', { bubbles: true, detail: { value: '   ' } }));
    expect(thread.querySelectorAll('slicc-user-message').length).toBe(before + 1);
  });
});
