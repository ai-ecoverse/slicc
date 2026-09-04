// @vitest-environment jsdom
/**
 * Phase 3 — panelizing the shell.
 *
 * The load-bearing property is that panelization RE-PARENTS the elements
 * `buildWcShellFrame` built rather than recreating them, so `WcShellRefs` stays valid
 * for its five consumer modules (`wc-live`, `wc-nav`, `wc-sprinkles`, `wc-tray`,
 * `wc-browser`). These tests assert element IDENTITY across the move, plus the
 * structural invariants (avatar in the trusted layer, rail switched to in-flow).
 *
 * Geometry lives in the webcomponents browser suite; jsdom can't lay out.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import { LAYOUT_SCHEMA_VERSION } from '@slicc/webcomponents';
import { PANEL_IDS } from '../../../src/ui/wc/builtin-panels.js';
import {
  DEFAULT_LAYOUT_DOC,
  getLayoutDoc,
  layoutDocNames,
} from '../../../src/ui/wc/default-layouts.js';
import { PANEL_LAYOUT_STORAGE_KEY, panelizeShell } from '../../../src/ui/wc/panelize-shell.js';
import { buildTrustedLayers } from '../../../src/ui/wc/trusted-layer.js';
import type { WcShellRefs } from '../../../src/ui/wc/wc-shell.js';

/**
 * A minimal stand-in for a mounted shell: the elements panelization moves, in
 * the same nesting `buildWcShellFrame` produces. Built by hand rather than by calling
 * `buildWcShellFrame` so the test isolates the panelization step (and doesn't need the
 * whole component barrel to upgrade in jsdom).
 */
function makeShellRefs(): WcShellRefs {
  const frame = document.createElement('div');
  frame.className = 'wcui-frame';

  const { panelHost, trustedLayer } = buildTrustedLayers(document);
  const shader = document.createElement('slicc-shader');
  const appCol = document.createElement('div');
  appCol.className = 'wcui-appcol';

  const nav = document.createElement('slicc-nav');
  const switcher = document.createElement('slicc-scoop-switcher');
  const floatbar = document.createElement('slicc-floatbar');
  const avatarMenu = document.createElement('slicc-avatar-menu');
  nav.append(switcher, floatbar, avatarMenu);

  const shell = document.createElement('slicc-shell');
  const dockTree = document.createElement('slicc-dock-tree');
  const chatPane = document.createElement('slicc-chatpane');
  const chatSurface = document.createElement('slicc-surface');
  chatSurface.setAttribute('surface-id', 'chat');
  chatSurface.append(chatPane);
  dockTree.append(chatSurface);
  for (const id of ['files', 'term', 'memory', 'monitor', 'browser']) {
    const surface = document.createElement('slicc-surface');
    surface.setAttribute('surface-id', id);
    const marker = document.createElement('div');
    marker.dataset.inner = id;
    surface.append(marker);
    dockTree.append(surface);
  }
  const dock = document.createElement('slicc-dock');
  shell.append(dockTree, dock);

  const freezer = document.createElement('slicc-freezer');

  appCol.append(nav, shell);
  panelHost.append(shader, freezer, appCol);
  frame.append(panelHost, trustedLayer);
  document.body.append(frame);

  return {
    frame,
    panelHost,
    trustedLayer,
    shader,
    chatPane,
    thread: document.createElement('slicc-chat-thread'),
    composer: document.createElement('slicc-composer'),
    inputCard: document.createElement('slicc-input-card'),
    composerMeta: document.createElement('slicc-composer-meta'),
    queuedStack: document.createElement('slicc-queued-stack'),
    switcher,
    floatbar,
    shell,
    dockTree,
    dock,
    freezer,
    fileTree: document.createElement('slicc-file-tree'),
    termSurface: document.createElement('div'),
    memoryHost: document.createElement('slicc-memory-panel'),
    monitor: document.createElement('slicc-monitor'),
    avatarMenu,
    overlaySurfaces: new Set<string>(),
  } as unknown as WcShellRefs;
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe('panelizeShell', () => {
  it('creates a layout holding a panel per built-in', () => {
    const refs = makeShellRefs();
    const result = panelizeShell(refs);

    expect(result).not.toBeNull();
    for (const id of Object.values(PANEL_IDS)) {
      expect(result?.panels.has(id)).toBe(true);
    }
  });

  it('RE-PARENTS the existing elements — every ref stays the same instance', () => {
    // This is the whole point: five other modules hold these refs and call
    // component APIs on them. Recreating any of them would silently break those
    // callers (their listeners would be attached to an orphan).
    const refs = makeShellRefs();
    const before = {
      switcher: refs.switcher,
      floatbar: refs.floatbar,
      freezer: refs.freezer,
      dock: refs.dock,
      chatPane: refs.chatPane,
      avatarMenu: refs.avatarMenu,
    };

    panelizeShell(refs);

    expect(refs.switcher).toBe(before.switcher);
    expect(refs.floatbar).toBe(before.floatbar);
    expect(refs.freezer).toBe(before.freezer);
    expect(refs.dock).toBe(before.dock);
    expect(refs.chatPane).toBe(before.chatPane);
    expect(refs.avatarMenu).toBe(before.avatarMenu);
    // …and each is still connected, inside its panel.
    for (const el of Object.values(before)) expect(el.isConnected).toBe(true);
  });

  it('preserves listeners attached before panelization', () => {
    // A moved element keeps its listeners; a recreated one would not. This is
    // the observable consequence of the identity guarantee above.
    //
    // Uses a SPRINKLE id, not a tool id: panelization installs a capture-phase
    // dock listener that calls `stopImmediatePropagation` for tool panels (so the
    // stale dock-tree handler can't fight it), which would legitimately suppress
    // this listener. Sprinkle events pass straight through.
    const refs = makeShellRefs();
    const onClick = vi.fn();
    refs.dock.addEventListener('slicc-dock-select', onClick);

    panelizeShell(refs);
    refs.dock.dispatchEvent(
      new CustomEvent('slicc-dock-select', { detail: { id: 'sprinkle:weather' } })
    );

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('intercepts TOOL-panel dock events so the stale dock-tree handler never sees them', () => {
    // The dock-tree those events used to drive is gone; letting the old listener
    // also run would place a surface into a detached element (and previously left
    // the terminal open-but-sessionless).
    const refs = makeShellRefs();
    const stale = vi.fn();
    refs.dock.addEventListener('slicc-dock-select', stale);

    const result = panelizeShell(refs);
    refs.dock.dispatchEvent(new CustomEvent('slicc-dock-select', { detail: { id: 'files' } }));

    expect(stale).not.toHaveBeenCalled();
    // …and the panel really did get placed by the new handler.
    expect(result?.layout.getLayout().panels?.files?.visible).toBe(true);
  });

  it('lets an overlay-claimed surface through instead of parking a placeholder panel', () => {
    // The leader's full-screen tab switcher is a one-shot launcher, not a
    // panel. Without this the panelized leader's globe opened an empty
    // "runs on the leader" placeholder and the overlay never showed.
    const refs = makeShellRefs();
    const overlayHandler = vi.fn();
    refs.dock.addEventListener('slicc-dock-select', overlayHandler);

    const result = panelizeShell(refs);
    // Claimed AFTER panelization — wc-browser wires itself later in boot.
    refs.overlaySurfaces.add('browser');
    refs.dock.dispatchEvent(new CustomEvent('slicc-dock-select', { detail: { id: 'browser' } }));

    expect(overlayHandler).toHaveBeenCalledTimes(1);
    expect(result?.layout.getLayout().panels?.browser?.visible).not.toBe(true);
  });

  it('still panelizes an unclaimed browser surface (follower floats have no overlay)', () => {
    const refs = makeShellRefs();
    const result = panelizeShell(refs);
    refs.dock.dispatchEvent(new CustomEvent('slicc-dock-select', { detail: { id: 'browser' } }));

    expect(result?.layout.getLayout().panels?.browser?.visible).toBe(true);
  });

  it('fires the tool-panel activation hook so an opened panel starts its poller', () => {
    // Without this the terminal opens with no session and the file tree with no
    // rows — the exact regression that surfaced when the dock rail was first
    // re-pointed at the layout.
    const refs = makeShellRefs();
    const onToolPanelActivate = vi.fn();
    const onToolPanelDeactivate = vi.fn();
    panelizeShell(refs, undefined, undefined, { onToolPanelActivate, onToolPanelDeactivate });

    refs.dock.dispatchEvent(new CustomEvent('slicc-dock-select', { detail: { id: 'term' } }));
    expect(onToolPanelActivate).toHaveBeenCalledWith('term');

    refs.dock.dispatchEvent(new CustomEvent('slicc-dock-collapse', { detail: { id: 'term' } }));
    expect(onToolPanelDeactivate).toHaveBeenCalledWith('term');
  });

  it('reveals each tool surface, since a slicc-surface is display:none without [active]', () => {
    // A surface was built for the show-one workbench; inside a panel it rendered
    // an empty 0px box with a mounted-but-invisible xterm that swallowed input.
    const refs = makeShellRefs();
    panelizeShell(refs);

    for (const id of ['files', 'term', 'memory', 'monitor']) {
      const surface = refs.frame.querySelector(`slicc-surface[surface-id="${id}"]`) as HTMLElement;
      expect(surface.hasAttribute('active')).toBe(true);
      // `display` is set inline because the reveal rule and the base rule have
      // equal specificity — see the comment on `activateSurface`.
      expect(surface.style.display).toBe('flex');
      expect(surface.style.position).toBe('relative');
    }
  });

  it('wraps each element in a slicc-panel carrying its id', () => {
    const refs = makeShellRefs();
    const result = panelizeShell(refs);

    const chatPanel = result?.panels.get(PANEL_IDS.chat);
    expect(chatPanel?.getAttribute('panel-id')).toBe(PANEL_IDS.chat);
    expect(chatPanel?.contains(refs.chatPane)).toBe(true);
    expect(result?.panels.get(PANEL_IDS.dockRail)?.contains(refs.dock)).toBe(true);
  });

  it('moves the tool surfaces (with their content) into panels', () => {
    const refs = makeShellRefs();
    const result = panelizeShell(refs);

    for (const id of ['files', 'term', 'memory', 'monitor']) {
      const panel = result?.panels.get(id);
      expect(panel).toBeDefined();
      // The inner marker travelled with the surface, so panel content — a live
      // terminal session, a loaded file tree — is preserved by the move.
      expect(panel?.querySelector(`[data-inner="${id}"]`)).not.toBeNull();
    }
  });

  describe('the fixed avatar strip', () => {
    it('mounts the avatar into the TRUSTED layer, not the layout', () => {
      // The avatar is the one piece of fixed chrome; putting it in the trusted
      // layer is what stops a panel from occluding or spoofing it (H2).
      const refs = makeShellRefs();
      const result = panelizeShell(refs);

      expect(result?.avatarStrip.closest('.wcui-trusted-layer')).toBe(refs.trustedLayer);
      expect(refs.avatarMenu.closest('.wcui-trusted-layer')).toBe(refs.trustedLayer);
      // And explicitly NOT inside the panel host.
      expect(refs.avatarMenu.closest('.wcui-panel-host')).toBeNull();
    });

    it('throws rather than silently misplacing the avatar when no trusted layer exists', () => {
      // A shell built without the layer must fail loudly: a body-mounted avatar
      // strip would be occludable, which defeats the point.
      const refs = makeShellRefs();
      refs.trustedLayer.remove();
      expect(() => panelizeShell(refs)).toThrow(/trusted layer not found/);
    });
  });

  describe('the sessions rail going in-flow', () => {
    it('switches the rail to docked so it occupies real layout space', () => {
      // The rail is `position:fixed` by default (it predates panels). As a
      // docked panel it must be in-flow or the layout cannot size it.
      const refs = makeShellRefs();
      panelizeShell(refs);
      expect(refs.freezer.hasAttribute('docked')).toBe(true);
    });

    it('clears the --rail-w reservation that existed for the fixed overlay', () => {
      // Leaving it would double-count: the panel occupies space AND the app
      // column would still pad for it.
      const refs = makeShellRefs();
      const appCol = refs.frame.querySelector('.wcui-appcol') as HTMLElement;
      appCol.style.setProperty('--rail-w', '44px');

      panelizeShell(refs);

      expect(appCol.style.getPropertyValue('--rail-w')).toBe('0px');
    });
  });

  describe('chat pane sizing (scrolling + pinned composer)', () => {
    // The chat pane predates panels: as a `<slicc-shell>` child it was
    // `flex: 0 0 auto` so it wouldn't grow past its explicit width, and
    // `width: calc(100% - 48px)` to reserve room for the dock rail beside it.
    // Inside a panel both are wrong, and the first BREAKS SCROLLING — refusing to
    // shrink, the pane grew to its full content height (4230px inside a 1747px
    // panel), so the thread never overflowed (nothing to scroll) and the composer
    // was pushed off the bottom of the screen.
    //
    // jsdom can't lay out, so these assert the CSS contract rather than geometry;
    // the fix was verified by measurement in a real browser.
    function panelizeCss(): string {
      const style = document.getElementById('slicc-panelize-style');
      return style?.textContent ?? '';
    }

    it('lets the pane SHRINK to the panel, so the thread can overflow and scroll', () => {
      panelizeShell(makeShellRefs());
      const css = panelizeCss();
      expect(css).toContain(
        'slicc-panel[panel-id="chat"] slicc-chatpane{flex:1 1 0;width:100%;min-height:0;}'
      );
      // The pre-panel rule must not survive for a panelized pane.
      expect(css).not.toContain('slicc-chatpane{flex:0 0 auto');
    });

    it('makes the thread the scroll container', () => {
      panelizeShell(makeShellRefs());
      expect(panelizeCss()).toContain(
        'slicc-panel[panel-id="chat"] slicc-chat-thread{flex:1 1 0;min-height:0;overflow-y:auto;}'
      );
    });

    it('pins the composer: it never shrinks, so it stays at the bottom', () => {
      panelizeShell(makeShellRefs());
      expect(panelizeCss()).toContain(
        'slicc-panel[panel-id="chat"] slicc-composer{flex:0 0 auto;}'
      );
    });

    it('does not reserve dock-rail width — the rail is its own panel now', () => {
      // `calc(100% - 48px)` would double-count: the layout already sizes the rail.
      panelizeShell(makeShellRefs());
      expect(panelizeCss()).not.toContain('calc(100% - 48px)');
    });
  });

  describe('sprinkle hosting', () => {
    // `WcSprinkleZone` appends new sprinkle surfaces to `refs.dockTree`, which
    // panelization REMOVES — so without these hooks every sprinkle was created
    // into a detached element and could never render. That was the reported
    // "I cannot see the sprinkles".
    it('hosts a sprinkle surface as a placed, visible panel', () => {
      const refs = makeShellRefs();
      const result = panelizeShell(refs);

      const surface = document.createElement('slicc-surface');
      surface.setAttribute('surface-id', 'sprinkle:weather');
      result?.hostSprinkleSurface('sprinkle:weather', surface);

      const panel = result?.panels.get('sprinkle:weather');
      expect(panel?.getAttribute('panel-id')).toBe('sprinkle:weather');
      expect(panel?.contains(surface)).toBe(true);
      // Placed in the document, not merely appended.
      expect(result?.layout.getLayout().panels?.['sprinkle:weather']?.visible).toBe(true);
    });

    it('activates the surface, which is display:none until [active]', () => {
      const refs = makeShellRefs();
      const result = panelizeShell(refs);
      const surface = document.createElement('slicc-surface');
      surface.setAttribute('surface-id', 'sprinkle:weather');

      result?.hostSprinkleSurface('sprinkle:weather', surface);

      expect(surface.hasAttribute('active')).toBe(true);
      expect(surface.style.display).toBe('flex');
    });

    it('registers it so the add-panel menu lists it, titled without the prefix', async () => {
      const refs = makeShellRefs();
      const result = panelizeShell(refs);
      result?.hostSprinkleSurface('sprinkle:weather', document.createElement('slicc-surface'));

      const { getPanel } = await import('@slicc/webcomponents/panel/registry');
      const entry = getPanel('sprinkle:weather');
      expect(entry?.origin).toBe('sprinkle');
      expect(entry?.meta.title).toBe('weather');
    });

    it('removing a sprinkle drops its panel and unregisters it', async () => {
      const refs = makeShellRefs();
      const result = panelizeShell(refs);
      result?.hostSprinkleSurface('sprinkle:weather', document.createElement('slicc-surface'));

      result?.removeSprinkleSurface('sprinkle:weather');

      const { getPanel } = await import('@slicc/webcomponents/panel/registry');
      expect(getPanel('sprinkle:weather')).toBeUndefined();
      expect(result?.panels.has('sprinkle:weather')).toBe(false);
    });
  });

  describe('fixed chrome: rails and top bar are not resizable', () => {
    // A rail is a strip of icons at one intrinsic width and the top bar a
    // fixed-height row; stretching either can only produce a broken gap. They are
    // visible or not, and nothing else.
    function panelizeCss(): string {
      return document.getElementById('slicc-panelize-style')?.textContent ?? '';
    }

    it('pins the rail width on the PANEL, so no document size can stretch it', () => {
      // Marking the dock `locked` only stops a USER drag — a preset, saved layout
      // or Cherry push could still set `size: '400px'`, which measurably widened
      // the icon strip into an empty band before this.
      panelizeShell(makeShellRefs());
      expect(panelizeCss()).toContain('slicc-panel[panel-id="dock-rail"]{width:48px;}');
      expect(panelizeCss()).toContain(
        'slicc-layout .slicc-layout__dock--right{flex:0 0 auto!important;width:auto!important;}'
      );
    });

    it('makes both rails full height of the center row', () => {
      panelizeShell(makeShellRefs());
      expect(panelizeCss()).toContain(
        'flex:0 0 auto;height:100%;align-self:stretch;overflow:hidden;}'
      );
    });

    it('pins the top bar to --barh', () => {
      panelizeShell(makeShellRefs());
      expect(panelizeCss()).toContain(
        'height:var(--barh,36px);min-height:var(--barh,36px);max-height:var(--barh,36px);}'
      );
    });

    it('locks the three standard docks in the DEFAULT DOCUMENT, not just in CSS', () => {
      // So a saved or pushed layout carries the intent too.
      for (const dock of DEFAULT_LAYOUT_DOC.base.docks ?? []) {
        expect(dock.locked).toBe(true);
      }
    });
  });

  describe('persisting a hand-arranged layout', () => {
    // Rearranging by hand and losing it on reload is worse than not being able to
    // rearrange at all, so the drag has to survive a boot.
    beforeEach(() => localStorage.removeItem(PANEL_LAYOUT_STORAGE_KEY));

    it('restores a stored layout INSTEAD of the boot document', () => {
      localStorage.setItem(
        PANEL_LAYOUT_STORAGE_KEY,
        JSON.stringify({ version: 1, id: 'mine', base: { center: { panel: 'chat' } } })
      );
      const result = panelizeShell(makeShellRefs());
      expect(result?.layout.getLayout().id).toBe('mine');
    });

    it('writes on a user REARRANGE', () => {
      const result = panelizeShell(makeShellRefs());
      result?.layout.dispatchEvent(
        new CustomEvent('slicc-layout-change', { detail: { reason: 'rearrange' } })
      );
      expect(localStorage.getItem(PANEL_LAYOUT_STORAGE_KEY)).toContain('"id"');
    });

    it('writes on a user RESIZE', () => {
      const result = panelizeShell(makeShellRefs());
      result?.layout.dispatchEvent(
        new CustomEvent('slicc-layout-change', { detail: { reason: 'resize' } })
      );
      expect(localStorage.getItem(PANEL_LAYOUT_STORAGE_KEY)).not.toBeNull();
    });

    it('does NOT write for a breakpoint change — that would freeze a transient variant', () => {
      // Narrow the window once and the narrow arrangement would otherwise become
      // the user's layout forever.
      const result = panelizeShell(makeShellRefs());
      for (const reason of ['set', 'viewport', 'environment']) {
        result?.layout.dispatchEvent(
          new CustomEvent('slicc-layout-change', { detail: { reason } })
        );
      }
      expect(localStorage.getItem(PANEL_LAYOUT_STORAGE_KEY)).toBeNull();
    });

    it('falls back to the default when the stored entry is corrupt', () => {
      localStorage.setItem(PANEL_LAYOUT_STORAGE_KEY, '{not json');
      const result = panelizeShell(makeShellRefs());
      expect(result?.layout.getLayout().id).toBe(DEFAULT_LAYOUT_DOC.id);
    });

    it('falls back to the default when the stored entry fails validation', () => {
      // Written by an older version, or hand-edited — must not fail the boot.
      localStorage.setItem(PANEL_LAYOUT_STORAGE_KEY, JSON.stringify({ id: '', base: {} }));
      const result = panelizeShell(makeShellRefs());
      expect(result?.layout.getLayout().id).toBe(DEFAULT_LAYOUT_DOC.id);
    });
  });

  it('removes the old shell row and nav, replacing them with the layout', () => {
    const refs = makeShellRefs();
    const result = panelizeShell(refs);

    expect(refs.shell.isConnected).toBe(false);
    expect(refs.frame.querySelector('slicc-nav')).toBeNull();
    expect(result?.layout.isConnected).toBe(true);
    // The layout lives inside the panel host, so panels stay clamped below the
    // trusted layer.
    expect(result?.layout.closest('.wcui-panel-host')).toBe(refs.panelHost);
  });

  it('loads the default document, which reproduces today’s arrangement', () => {
    const refs = makeShellRefs();
    const result = panelizeShell(refs);
    expect(result?.layout.getLayout().id).toBe(DEFAULT_LAYOUT_DOC.id);
  });

  it('accepts an explicit document', () => {
    // Built here rather than pulled from the shipped set: `default` is the only
    // document SLICC ships, so there is no second preset to pass.
    const refs = makeShellRefs();
    const custom = {
      version: LAYOUT_SCHEMA_VERSION,
      id: 'from-a-skill',
      base: { zones: { center: [PANEL_IDS.chat] } },
    };
    const result = panelizeShell(refs, custom);
    expect(result?.layout.getLayout().id).toBe('from-a-skill');
  });

  it('ships exactly ONE layout — canned arrangements are the user’s to save', () => {
    expect(layoutDocNames()).toEqual(['default']);
    expect(getLayoutDoc('dev')).toBeNull();
    expect(getLayoutDoc('dashboard')).toBeNull();
  });

  it('refuses to run twice on the same frame', () => {
    // Re-wrapping already-wrapped elements would nest panels inside panels.
    const refs = makeShellRefs();
    expect(panelizeShell(refs)).not.toBeNull();
    expect(panelizeShell(refs)).toBeNull();
  });
});
