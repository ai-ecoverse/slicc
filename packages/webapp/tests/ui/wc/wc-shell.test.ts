// @vitest-environment jsdom
/**
 * Shell-composition tests for the `?ui=wc` preview mount: structure of the
 * frame (shader / freezer / nav / shell / dock-tree / dock), dock→dock-tree
 * wiring, and the composer's local echo loop.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import { uint8ToBase64 } from '@slicc/shared-ts';
import { BLOB_CHIP_TAG } from '../../../src/ui/base64-preview-linker.js';
import { buildWcShellFrame, mountWcUiPreview } from '../../../src/ui/wc/wc-shell.js';

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

  it('suppresses root-viewport elastic overscroll in the shell document', () => {
    mount();
    const css = document.getElementById('slicc-wcui-style')?.textContent ?? '';
    const rootRule = css.match(/html,body\{([^}]*)\}/)?.[1] ?? '';
    expect(rootRule).toContain('overscroll-behavior:none;');
  });

  it('replaces prior root content (idempotent mount)', () => {
    const root = mount();
    mountWcUiPreview(root);
    expect(root.children.length).toBe(1);
  });

  it('assembles nav, freezer, shader, shell, dock-tree, and dock', () => {
    const root = mount();
    const nav = root.querySelector('slicc-nav');
    expect(nav).toBeTruthy();
    for (const tag of ['slicc-agent-tabs', 'slicc-floatbar', 'slicc-avatar']) {
      expect(nav?.querySelector(tag), tag).toBeTruthy();
    }
    expect(nav?.firstElementChild?.tagName).toBe('SLICC-AGENT-TABS');
    const states = (
      nav?.querySelector('slicc-agent-tabs') as HTMLElement & {
        scoops: Array<{ state?: string }>;
      }
    ).scoops.map((scoop) => scoop.state);
    expect(states).toEqual(['working', 'broken']);
    // No theme toggle: the shell follows the OS color scheme instead.
    expect(nav?.querySelector('slicc-theme-toggle')).toBeNull();
    expect(root.querySelector('slicc-shader')).toBeTruthy();
    expect(root.querySelector('slicc-freezer slicc-freezer-new')).toBeTruthy();
    // Chat is a pinned dock-tree leaf, not a separate shell region.
    expect(root.querySelector('slicc-shell slicc-dock-tree slicc-chatpane')).toBeTruthy();
    expect(root.querySelector('slicc-dock')?.hasAttribute('system-tools')).toBe(true);
  });

  it('mounts the memory panel with an empty state', () => {
    const panel = mount().querySelector('slicc-memory-panel');
    expect(panel?.hasAttribute('variant')).toBe(false);
    expect(panel?.textContent).toContain('No memories yet');
  });

  it('populates the cone thread from the chat fixture', () => {
    const root = mount();
    const thread = root.querySelector('slicc-chat-thread');
    expect(thread?.getAttribute('context')).toBe('cone');
    expect(thread?.querySelectorAll('slicc-user-message').length).toBeGreaterThan(2);
    expect(thread?.querySelectorAll('slicc-agent-message').length).toBeGreaterThan(2);
    expect(thread?.querySelectorAll('slicc-lick-card').length).toBeGreaterThan(5);
  });

  it('mounts the dock-tree as the sole, permanently full-span layout host', () => {
    const root = mount();
    const dockTree = root.querySelector('slicc-dock-tree') as HTMLElement;
    const shell = root.querySelector('slicc-shell') as HTMLElement;
    expect(dockTree).toBeTruthy();
    // Never hidden — no separate mode to toggle it against.
    expect(dockTree.hasAttribute('hidden')).toBe(false);
    expect(dockTree.parentElement).toBe(shell);
  });

  it('composes chat as a pinned dock-tree leaf, left zone', async () => {
    const { CHAT_SURFACE_ID } = await import('../../../src/ui/wc/wc-sprinkles.js');
    const root = mount();
    const dockTree = root.querySelector('slicc-dock-tree') as HTMLElement & {
      getSurfaceIds(): string[];
      getTree(): { zones: Record<string, unknown> };
    };
    expect(dockTree.getSurfaceIds()).toContain(CHAT_SURFACE_ID);
    expect(dockTree.getTree().zones.left).toEqual({ type: 'leaf', surfaceId: CHAT_SURFACE_ID });
    const surface = dockTree.querySelector(`[surface-id="${CHAT_SURFACE_ID}"]`);
    expect(surface?.querySelector('slicc-chatpane')).toBeTruthy();
  });

  it('opens a tool panel into the dock-tree on dock select, closes it on collapse (real end-to-end wiring via wireWcSprinkles)', async () => {
    const { wireWcSprinkles } = await import('../../../src/ui/wc/wc-sprinkles.js');
    const { buildWcShellFrame } = await import('../../../src/ui/wc/wc-shell.js');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const refs = buildWcShellFrame(host, {
      messages: [],
      scoops: [],
      floatLabel: 'live',
      placeholder: 'p',
    });
    // No sprinkle roots exist, so discovery never reaches readDir.
    const fs = {
      exists: async () => false,
      readDir: async () => [],
      readFile: async () => '',
    } as unknown as import('../../../src/fs/virtual-fs.js').VirtualFS;
    const client = {
      sendSprinkleLick: () => {},
      getScoops: () => [],
      stopScoop: () => {},
    } as unknown as import('../../../src/ui/offscreen-client.js').OffscreenClient;
    const log = {
      info() {},
      warn() {},
      error() {},
      debug() {},
    } as unknown as import('../../../src/ui/boot/types.js').BootStageLogger;
    await wireWcSprinkles({ refs, client, fs, getUnits: () => [], log });

    const dockTree = refs.dockTree as unknown as HTMLElement & { getSurfaceIds(): string[] };
    refs.dock.dispatchEvent(
      new CustomEvent('slicc-dock-select', { bubbles: true, detail: { id: 'files' } })
    );
    expect(dockTree.getSurfaceIds()).toContain('files');

    refs.dock.dispatchEvent(
      new CustomEvent('slicc-dock-collapse', { bubbles: true, detail: { id: 'files' } })
    );
    expect(dockTree.getSurfaceIds()).not.toContain('files');
  });

  it('live floats also mount the bare nav', async () => {
    const { buildWcShellFrame } = await import('../../../src/ui/wc/wc-shell.js');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const refs = buildWcShellFrame(host, {
      messages: [],
      scoops: [],
      floatLabel: 'live',
      placeholder: 'p',
    });
    expect(host.querySelector('slicc-nav')?.firstElementChild).toBe(refs.switcher);
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

  it('urlState option opts the thread into URL state sync (off by default)', async () => {
    const { buildWcShellFrame } = await import('../../../src/ui/wc/wc-shell.js');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const live = buildWcShellFrame(host, {
      messages: [],
      scoops: [],
      floatLabel: 'live',
      placeholder: 'p',
      urlState: true,
    });
    expect(live.thread.hasAttribute('url-state')).toBe(true);

    // The fixture/preview mount stays URL-clean.
    const fixture = buildWcShellFrame(host, {
      messages: [],
      scoops: [],
      floatLabel: 'fixture',
      placeholder: 'p',
    });
    expect(fixture.thread.hasAttribute('url-state')).toBe(false);
  });

  it('kills the UA body margin so the frame sits flush', () => {
    mount();
    const css = document.getElementById('slicc-wcui-style')?.textContent ?? '';
    expect(css).toContain('html,body{margin:0');
  });

  it('an UNCLAIMED browser dock item opens its surface in the dock-tree (follower fallback)', async () => {
    const { buildWcShellFrame } = await import('../../../src/ui/wc/wc-shell.js');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const refs = buildWcShellFrame(host, {
      messages: [],
      scoops: [],
      floatLabel: 'follower',
      placeholder: 'p',
    });

    // Browser isn't a tool-panel id (handled separately via overlaySurfaces),
    // so wireDockToWorkbench's overlay-only listener leaves it untouched —
    // the surface is already permanently composed by `buildWorkbench`.
    const surface = (refs.dockTree as unknown as HTMLElement).querySelector(
      '[surface-id="browser"]'
    );
    expect(surface).not.toBeNull();
  });

  it('a claimed browser id is ignored by the overlay listener (no dock-tree interaction)', async () => {
    const { buildWcShellFrame } = await import('../../../src/ui/wc/wc-shell.js');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const refs = buildWcShellFrame(host, {
      messages: [],
      scoops: [],
      floatLabel: 'leader',
      placeholder: 'p',
    });
    refs.overlaySurfaces.add('browser'); // what wireWcBrowser does

    // Selecting a claimed id must not throw and must not place/remove anything
    // in the tree — the overlay owns it entirely.
    expect(() =>
      refs.dock.dispatchEvent(
        new CustomEvent('slicc-dock-select', { bubbles: true, detail: { id: 'browser' } })
      )
    ).not.toThrow();
  });

  it('a pointerdown on a sprinkle dock launcher arms beginExternalDrag when tiles are movable', async () => {
    const { buildWcShellFrame } = await import('../../../src/ui/wc/wc-shell.js');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const refs = buildWcShellFrame(host, {
      messages: [],
      scoops: [],
      floatLabel: 't',
      placeholder: 'p',
    });
    const beginExternalDrag = vi.fn();
    refs.dockTree.tilesMovable = true;
    (
      refs.dockTree as unknown as { beginExternalDrag: typeof beginExternalDrag }
    ).beginExternalDrag = beginExternalDrag;
    const item = document.createElement('slicc-dock-item');
    item.setAttribute('item-id', 'sprinkle:hero');
    refs.dock.appendChild(item);

    item.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, composed: true, pointerId: 7 })
    );
    expect(beginExternalDrag).toHaveBeenCalledWith('sprinkle:hero', 7);
  });

  it('does not arm an external sprinkle drag when tiles are not movable', async () => {
    const { buildWcShellFrame } = await import('../../../src/ui/wc/wc-shell.js');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const refs = buildWcShellFrame(host, {
      messages: [],
      scoops: [],
      floatLabel: 't',
      placeholder: 'p',
    });
    const beginExternalDrag = vi.fn();
    refs.dockTree.tilesMovable = false;
    (
      refs.dockTree as unknown as { beginExternalDrag: typeof beginExternalDrag }
    ).beginExternalDrag = beginExternalDrag;
    const item = document.createElement('slicc-dock-item');
    item.setAttribute('item-id', 'sprinkle:hero');
    refs.dock.appendChild(item);

    item.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, composed: true, pointerId: 7 })
    );

    expect(beginExternalDrag).not.toHaveBeenCalled();
  });

  it('does not arm a drag for a non-sprinkle (tool) dock item', async () => {
    const { buildWcShellFrame } = await import('../../../src/ui/wc/wc-shell.js');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const refs = buildWcShellFrame(host, {
      messages: [],
      scoops: [],
      floatLabel: 't',
      placeholder: 'p',
    });
    const beginExternalDrag = vi.fn();
    (
      refs.dockTree as unknown as { beginExternalDrag: typeof beginExternalDrag }
    ).beginExternalDrag = beginExternalDrag;
    const item = document.createElement('slicc-dock-item');
    item.setAttribute('item-id', 'term');
    refs.dock.appendChild(item);

    item.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, composed: true, pointerId: 1 })
    );

    expect(beginExternalDrag).not.toHaveBeenCalled();
  });

  it('the browser surface describes the fallback, not the switcher it lacks', () => {
    const root = mount();
    const text = root.querySelector('[surface-id="browser"]')?.textContent ?? '';
    expect(text).toContain('runs on the leader');
    expect(text).not.toMatch(/click a card/i);
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

  it('the shell itself does NOT fullscreen on long-press — that gesture is wireWcSprinkles business', () => {
    // The old shell-owned handler fullscreened whatever surface was already
    // in the tree, without activating it first — against the usual parked
    // (display:none) surface the call rejected and the gesture did nothing.
    // The working flow (activate through the manager, then fullscreen) lives
    // in wc-sprinkles.ts; the shell must not double-handle the event.
    const root = mount();
    const dock = root.querySelector('slicc-dock') as HTMLElement;
    const dockTree = root.querySelector('slicc-dock-tree') as HTMLElement;

    const surface = document.createElement('slicc-surface');
    surface.setAttribute('surface-id', 'sprinkle:hero');
    const requestFullscreen = vi.fn(() => Promise.resolve());
    (surface as HTMLElement & { requestFullscreen: () => Promise<void> }).requestFullscreen =
      requestFullscreen;
    dockTree.append(surface);

    dock.dispatchEvent(
      new CustomEvent('slicc-dock-longpress', { bubbles: true, detail: { id: 'sprinkle:hero' } })
    );
    expect(requestFullscreen).not.toHaveBeenCalled();
  });

  it('applyShellContext swaps the shader program and the --ctx accent per mood', async () => {
    const { applyShellContext, FREEZER_TINT, buildWcShellFrame } = await import(
      '../../../src/ui/wc/wc-shell.js'
    );
    const host = document.createElement('div');
    document.body.appendChild(host);
    const refs = buildWcShellFrame(host, {
      messages: [],
      scoops: [],
      floatLabel: 't',
      placeholder: 'p',
    });

    // Cone (boot default): Caramel Sugar Glass, default tint, no --ctx override.
    expect(refs.shader.getAttribute('mode')).toBe('cone');
    expect(refs.shader.getAttribute('tint')).toBeNull();

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
    expect(refs.shader.getAttribute('tint')).toBeNull();
    expect(refs.frame.style.getPropertyValue('--ctx')).toBe('');
    expect(refs.freezer.hasAttribute('ctx')).toBe(false);
  });

  it('writes the cone and scoop tint before swapping the shader mode', async () => {
    const { applyShellContext, buildWcShellFrame } = await import('../../../src/ui/wc/wc-shell.js');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const refs = buildWcShellFrame(host, {
      messages: [],
      scoops: [],
      floatLabel: 't',
      placeholder: 'p',
    });
    const writes: string[] = [];
    const shaderSetAttribute = refs.shader.setAttribute.bind(refs.shader);
    const shaderRemoveAttribute = refs.shader.removeAttribute.bind(refs.shader);
    const frameSetProperty = refs.frame.style.setProperty.bind(refs.frame.style);
    const frameRemoveProperty = refs.frame.style.removeProperty.bind(refs.frame.style);
    vi.spyOn(refs.shader, 'setAttribute').mockImplementation((name, value) => {
      if (name === 'mode' || name === 'tint') writes.push(`shader.${name}=${value}`);
      shaderSetAttribute(name, value);
    });
    vi.spyOn(refs.shader, 'removeAttribute').mockImplementation((name) => {
      if (name === 'tint') writes.push('shader.tint removed');
      shaderRemoveAttribute(name);
    });
    vi.spyOn(refs.frame.style, 'setProperty').mockImplementation((name, value, priority) => {
      if (name === '--ctx') writes.push(`frame.${name}=${value}`);
      frameSetProperty(name, value, priority);
    });
    vi.spyOn(refs.frame.style, 'removeProperty').mockImplementation((name) => {
      if (name === '--ctx') writes.push('frame.--ctx removed');
      return frameRemoveProperty(name);
    });

    applyShellContext(refs, { kind: 'scoop', accent: '#06b6d4' });
    expect
      .soft(writes)
      .toEqual(['shader.tint=#06b6d4', 'frame.--ctx=#06b6d4', 'shader.mode=scoop']);

    writes.length = 0;
    applyShellContext(refs, { kind: 'cone' });
    expect.soft(writes).toEqual(['shader.tint removed', 'frame.--ctx removed', 'shader.mode=cone']);
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
    const { buildWcShellFrame } = await import('../../../src/ui/wc/wc-shell.js');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const refs = buildWcShellFrame(host, {
      messages: [],
      scoops: [],
      floatLabel: 'live',
      placeholder: 'p',
    });
    const composer = host.querySelector('slicc-composer');
    const backpressure = composer?.querySelector('.wcui-backpressure');
    const stack = composer?.querySelector('slicc-queued-stack');
    const inputCard = composer?.querySelector('slicc-input-card');
    expect(backpressure).toBeTruthy();
    expect(backpressure?.getAttribute('role')).toBe('status');
    expect(backpressure?.hasAttribute('hidden')).toBe(true);
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
    expect(refs.lickBackpressureNotice).toBe(backpressure);
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

/**
 * Base64 previews are wired at the MOUNT, not in `attachWcClient`.
 *
 * That is what puts them on the surfaces which deliberately never attach a
 * client — Cherry, the tray follower, the extension side panel all call
 * `prepareWcShell` and stop (`wc-follower.ts`). Wiring them in the client
 * phase, next to file mentions, left every one of those rendering raw payload
 * text. File mentions genuinely belong there; they need a VFS reader a
 * follower has no worker for, and a decode needs nothing.
 */
describe('buildWcShellFrame — base64 previews', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    document.getElementById('slicc-tokens')?.remove();
  });

  function mountWith(content: string): HTMLElement {
    const root = document.createElement('div');
    document.body.appendChild(root);
    buildWcShellFrame(root, {
      messages: [{ id: 'm1', role: 'user', content, timestamp: 0 }],
      scoops: [],
      floatLabel: 'test',
      placeholder: '',
    });
    return root;
  }

  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it('elides a payload in a transcript mounted with no client', async () => {
    const png = new Uint8Array(200);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const root = mountWith(`here it is: ${uint8ToBase64(png)}`);
    await flush();

    const bubble = root.querySelector('slicc-user-message');
    expect(bubble).not.toBeNull();
    expect(bubble?.shadowRoot?.querySelectorAll(BLOB_CHIP_TAG)).toHaveLength(1);
  });

  it('leaves a transcript with no payload untouched', async () => {
    const root = mountWith('Rewrote the watcher in check.js.');
    await flush();

    const bubble = root.querySelector('slicc-user-message');
    expect(bubble?.shadowRoot?.querySelectorAll(BLOB_CHIP_TAG)).toHaveLength(0);
  });
});
