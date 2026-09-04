/**
 * `panelize-shell.ts` — turn the mounted shell into panels arranged by
 * `<slicc-layout>` (Phase 3).
 *
 * ## Why this is a separate pass rather than a rewrite of `buildWcShellFrame`
 *
 * `buildWcShellFrame` is the single boot path for every float (standalone, extension
 * side panel, follower, cherry, electron) and its `WcShellRefs` are consumed by
 * five other modules. Rewriting it to build panels directly would change all of
 * that at once, with no intermediate state that works.
 *
 * So instead: `buildWcShellFrame` builds exactly what it always did — every ref valid,
 * every consumer untouched — and this function then RE-PARENTS those same
 * elements into panel wrappers inside a `<slicc-layout>`. Nothing is recreated,
 * so `refs.freezer`, `refs.dock`, `refs.switcher` and friends keep pointing at the
 * same live elements with the same listeners already attached.
 *
 * It is also opt-in: a float that does not call this keeps the pre-panel shell.
 * That is deliberate for the migration, not indefinitely — Phase 4 makes it the
 * default path once layout documents are loading.
 *
 * ## What moves where
 *
 *   .wcui-frame
 *     ├─ .wcui-panel-host          (H2 stacking context)
 *     │    ├─ slicc-shader          — background, untouched
 *     │    └─ slicc-layout          — docks + center + floating
 *     │         ├─ slicc-panel[scoop-switcher] > slicc-scoop-switcher
 *     │         ├─ slicc-panel[floatbar]       > slicc-floatbar
 *     │         ├─ slicc-panel[sessions-rail]  > slicc-freezer[docked]
 *     │         ├─ slicc-panel[dock-rail]      > slicc-dock
 *     │         ├─ slicc-panel[chat]           > slicc-chatpane
 *     │         └─ slicc-panel[files|term|…]   > the tool surfaces
 *     └─ .wcui-trusted-layer       — the fixed avatar strip (spoof-proof)
 *
 * The avatar strip is the one piece that does NOT become a panel: it is the fixed
 * chrome, and it renders in the trusted layer so no panel can occlude or spoof it
 * (see `trusted-layer.ts`).
 */

import type { LayoutDocument, SliccLayout, SliccPanel } from '@slicc/webcomponents';
import { parseLayoutDocument } from '@slicc/webcomponents/panel/layout-schema';
import { registerPanel, unregisterPanel } from '@slicc/webcomponents/panel/registry';
import { createLogger } from '../../base/logger.js';
import type { VirtualFS } from '../../fs/index.js';
import { createAddPanelMenu } from './add-panel-menu.js';
import { applyLayoutDoc, isLayoutDocMsg } from './apply-layout-doc.js';
import {
  PANEL_IDS,
  registerBuiltinPanels,
  sprinkleNameFromPanelId,
  wrapInPanel,
} from './builtin-panels.js';
import { DEFAULT_LAYOUT_DOC, layoutDocNames } from './default-layouts.js';
import { setLayoutApplier } from './layout-apply-registry.js';
import { listLayouts } from './layout-store.js';
import { setPanelVisible } from './panel-visibility.js';
import { mountTrusted } from './trusted-layer.js';
import type { WcShellRefs } from './wc-shell.js';

const log = createLogger('panelize-shell');

/** CSS for the panelized shell: the fixed avatar strip and panel-hosted chrome. */
const STYLE_ID = 'slicc-panelize-style';
const CSS = [
  // The fixed avatar strip: the only chrome outside the layout. Pinned
  // top-right, sized to the nav bar's own height so it lines up with a top dock
  // when one exists, and `pointer-events:auto` (its parent layer is
  // click-through) so the menu stays usable.
  '.wcui-avatar-strip{position:absolute;top:0;right:0;height:var(--barh,36px);',
  // `gap:12px` + a left margin on the strip: at 8px the panels button sat almost
  // flush against the floatbar's cost pill, reading as part of it.
  'display:flex;align-items:center;gap:12px;padding:0 9px 0 14px;box-sizing:border-box;',
  'pointer-events:auto;z-index:1;}',
  // The layout fills the frame beneath the strip.
  '.wcui-frame slicc-layout{position:relative;z-index:1;}',
  // ── Fixed chrome: the two rails and the top bar ──────────────────────────
  //
  // These are NOT resizable and never share space. A rail is a strip of icons at
  // one intrinsic width; letting the layout stretch or shrink it (or letting a
  // user drag it) only ever produces a broken-looking gap. They are visible or
  // not — that is the whole of their configurability.
  //
  // So: the DOCK holding each one is pinned (`flex:0 0 <n>px`, no grow, no
  // shrink) and the panel inside fills it completely. Hiding still collapses the
  // dock entirely, because `#buildDocks` omits a dock with no visible panels.
  'slicc-layout .slicc-layout__dock--left,slicc-layout .slicc-layout__dock--right{flex:0 0 auto;}',
  'slicc-layout .slicc-layout__dock--top,slicc-layout .slicc-layout__dock--bottom{flex:0 0 auto;}',
  // Rails: exact width, full height of the center row, never resized.
  //
  // The width is pinned on the PANEL, not left to the dock's `size`. Marking the
  // dock `locked` only stops a USER dragging it; a document (a preset, a saved
  // layout, a Cherry push) could still set `size: '400px'` and stretch the icon
  // strip into a wide empty band — verified. Pinning here makes the rail's width
  // a property of the rail, so no document can get it wrong, and `--rail-w`
  // still lets the sessions rail expand itself when the user opens it.
  'slicc-layout .slicc-layout__dock--left{flex:0 0 auto!important;width:auto!important;}',
  'slicc-layout .slicc-layout__dock--right{flex:0 0 auto!important;width:auto!important;}',
  'slicc-panel[panel-id="sessions-rail"],slicc-panel[panel-id="dock-rail"]{',
  'flex:0 0 auto;height:100%;align-self:stretch;overflow:hidden;}',
  'slicc-panel[panel-id="dock-rail"]{width:48px;}',
  // The sessions rail owns its own collapsed/expanded width (44px ↔ 260px) via
  // its `open` attribute and animates between them, so follow it rather than
  // pinning a single value.
  'slicc-panel[panel-id="sessions-rail"]{width:auto;}',
  // The rail elements themselves must fill their panel rather than sizing to
  // content, or the strip's background stops short of the viewport edge.
  'slicc-panel[panel-id="sessions-rail"]>*,slicc-panel[panel-id="dock-rail"]>*{',
  'height:100%;flex:1 1 auto;min-height:0;}',
  // Top bar: exact height (`--barh`), full width, never resized.
  'slicc-panel[panel-id="scoop-switcher"],slicc-panel[panel-id="floatbar"]{',
  'height:var(--barh,36px);min-height:var(--barh,36px);max-height:var(--barh,36px);}',
  // The chat pane predates panels: as a `<slicc-shell>` child it was
  // `flex: 0 0 auto` (so it wouldn't grow past its explicit width) and
  // `width: calc(100% - 48px)` (reserving room for the dock rail beside it).
  // Both are wrong inside a panel, and the first one BREAKS SCROLLING: refusing
  // to shrink, the pane grew to its full content height (measured 4230px inside a
  // 1747px panel), so the thread never overflowed — nothing to scroll — and the
  // composer was pushed off the bottom of the screen.
  //
  // `1 1 0` + `min-height:0` makes the pane adopt the panel's height instead, so
  // the thread's own `overflow-y:auto` engages and the composer stays pinned at
  // the bottom of the column. Width is the panel's business now: the layout
  // already sizes the dock rail as its own panel, so reserving 48px here would
  // double-count it.
  'slicc-panel[panel-id="chat"] slicc-chatpane{flex:1 1 0;width:100%;min-height:0;}',
  // Belt-and-braces for the scroll container itself: the thread must be the
  // scrolling box, not something that stretches its parent.
  'slicc-panel[panel-id="chat"] slicc-chat-thread{flex:1 1 0;min-height:0;overflow-y:auto;}',
  // …and the composer must never shrink or scroll away — it is the input row.
  'slicc-panel[panel-id="chat"] slicc-composer{flex:0 0 auto;}',
  // The top-strip panels are content-sized, not grow-to-fill, so the switcher
  // and floatbar sit at their natural widths with the gap between them.
  'slicc-panel[panel-id="scoop-switcher"]{flex:0 0 auto;justify-content:center;padding-left:14px;}',
  'slicc-panel[panel-id="floatbar"]{flex:1 1 auto;align-items:center;justify-content:flex-end;',
  // Leave room for the fixed avatar strip so the floatbar never slides under it,
  // plus breathing space so the cost pill and the panels button don't crowd.
  'padding-right:var(--avatar-strip-w, 96px);}',
  'slicc-panel[panel-id="scoop-switcher"],slicc-panel[panel-id="floatbar"]{flex-direction:row;}',
].join('');

function ensurePanelizeStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/**
 * Reveal a `<slicc-surface>` and pull it in-flow so it can live inside a panel.
 *
 * A surface is `position:absolute; inset:0; display:none` until `[active]` — it
 * was built for the show-one workbench, where exactly one sibling was revealed at
 * a time. In a panel the WRAPPER owns visibility, so an inactive surface renders
 * an empty box.
 *
 * `[active]` alone is NOT enough: the reveal rule `slicc-surface[active]` has the
 * same specificity as the base `slicc-surface` rule, so which wins depends on
 * sheet order. Measured inside a panel it stayed `display:none` at 0px with a
 * mounted-but-invisible xterm whose textarea refused focus — the terminal
 * silently swallowed every keystroke. Setting `display` inline removes the race,
 * and relative positioning stops `inset:0` collapsing against a panel that has no
 * intrinsic height.
 */
function activateSurface(surface: HTMLElement): void {
  surface.setAttribute('active', '');
  surface.style.display = 'flex';
  surface.style.flexDirection = 'column';
  surface.style.position = 'relative';
  surface.style.inset = 'auto';
  surface.style.flex = '1 1 auto';
  surface.style.minHeight = '0';
}

/** Tool-panel ids the dock rail toggles. */
const TOOL_PANEL_IDS: ReadonlySet<string> = new Set<string>([
  PANEL_IDS.files,
  PANEL_IDS.term,
  PANEL_IDS.memory,
  PANEL_IDS.monitor,
  PANEL_IDS.browser,
]);

/**
 * Re-point the dock rail's clicks at the layout.
 *
 * The rail used to drive `WcSprinkleZone` → the dock-tree, which panelization
 * removes — so without this, clicking a tool icon placed a surface into a
 * detached element and the panel stayed parked (observed: the terminal appeared
 * to open but its session never mounted). Capture phase plus
 * `stopImmediatePropagation` so the dock-tree listener `wireWcSprinkles`
 * installs later never sees the event and cannot fight this one.
 */
function wireDockRailToLayout(
  dock: HTMLElement,
  layout: SliccLayout,
  overlaySurfaces: ReadonlySet<string>,
  hooks?: {
    onToolPanelActivate?: (id: string) => void;
    onToolPanelDeactivate?: (id: string) => void;
  }
): void {
  const handle = (event: Event, visible: boolean): void => {
    const id = (event as CustomEvent<{ id?: string }>).detail?.id;
    if (!id || !TOOL_PANEL_IDS.has(id)) return;
    // A surface an overlay has claimed (the leader's full-screen tab switcher)
    // is a one-shot launcher, not a panel: let the event through to its own
    // handler instead of parking an empty placeholder panel. Read at click
    // time — the overlay may wire itself after this listener is installed.
    if (overlaySurfaces.has(id)) return;
    event.stopImmediatePropagation();
    setPanelVisible(layout, id, visible);
    if (visible) hooks?.onToolPanelActivate?.(id);
    else hooks?.onToolPanelDeactivate?.(id);
  };
  dock.addEventListener('slicc-dock-select', (e) => handle(e, true), true);
  dock.addEventListener('slicc-dock-collapse', (e) => handle(e, false), true);
}

/**
 * The sprinkle-hosting half of the handle.
 *
 * `WcSprinkleZone` appends new sprinkle surfaces to `refs.dockTree`, which
 * panelization removes — so without these hooks every sprinkle was created into a
 * detached element and could never render (the reported "I can't see the
 * sprinkles"). Wrapping each surface in a panel and placing it makes them visible,
 * and registering it means the add-panel menu lists it and a saved layout can name
 * it.
 */
function sprinkleHostHooks(
  layout: SliccLayout,
  panels: Map<string, SliccPanel>
): Pick<PanelizedShell, 'hostSprinkleSurface' | 'removeSprinkleSurface'> {
  return {
    hostSprinkleSurface: (surfaceId, surface) => {
      const panel = wrapInPanel(surfaceId, surface);
      // The surface is `display:none` until `[active]` (built for the show-one
      // workbench) — the same treatment the tool panels get.
      activateSurface(surface);
      panels.set(surfaceId, panel);
      layout.appendChild(panel);
      registerPanel({
        meta: { id: surfaceId, title: sprinkleNameFromPanelId(surfaceId) ?? surfaceId },
        source: { kind: 'element', tag: 'slicc-panel' },
        origin: 'sprinkle',
      });
      setPanelVisible(layout, surfaceId, true);
      log.info('sprinkle panel hosted', { surfaceId });
    },
    removeSprinkleSurface: (surfaceId) => {
      panels.get(surfaceId)?.remove();
      panels.delete(surfaceId);
      unregisterPanel(surfaceId);
      const next = layout.getLayout();
      next.panels = { ...next.panels, [surfaceId]: { visible: false } };
      layout.setLayout(next);
    },
  };
}

/**
 * localStorage key for the user's hand-arranged panel layout. `default` stands in
 * for a future multi-profile scheme; today the browser/extension origin already
 * scopes storage to one implicit profile — the same shape as
 * `DOCK_TREE_STORAGE_KEY`.
 */
export const PANEL_LAYOUT_STORAGE_KEY = 'slicc-panel-layout:default';

/**
 * Persist a layout the USER rearranged by hand, and restore it on the next boot.
 *
 * Only `rearrange` and `resize` are written. Every other reason is the layout
 * reacting to something already reproducible from what's stored — `set` (a preset
 * or saved document was loaded), `viewport`/`environment` (a breakpoint changed).
 * Persisting those would freeze a transient variant as if the user had chosen it:
 * narrow the window once and the narrow arrangement becomes the layout forever.
 *
 * Restore is the boot document's OVERRIDE, not a merge, and deliberately silent —
 * `setLayout` fires `set`, which this ignores, so a restore cannot loop back into a
 * write. Best-effort throughout: a corrupt or rejected entry drops back to the
 * shipped default rather than failing the boot, since a layout is a convenience and
 * never load-bearing.
 */
function wireLayoutPersistence(layout: SliccLayout, doc: LayoutDocument): void {
  layout.addEventListener('slicc-layout-change', (event) => {
    const reason = event.detail?.reason;
    if (reason !== 'rearrange' && reason !== 'resize') return;
    try {
      localStorage.setItem(PANEL_LAYOUT_STORAGE_KEY, JSON.stringify(layout.getLayout()));
    } catch {
      /* best-effort — persistence is a convenience, not load-bearing */
    }
  });

  let restored: LayoutDocument | null = null;
  try {
    const raw = localStorage.getItem(PANEL_LAYOUT_STORAGE_KEY);
    if (raw) {
      const parsed = parseLayoutDocument(JSON.parse(raw));
      // Validate before trusting it: this came from storage, which a previous
      // version (or a hand-edit) may have left in a shape this engine can't read.
      if ('error' in parsed) {
        log.warn('stored layout rejected — using the default', { error: parsed.error });
      } else {
        restored = parsed;
      }
    }
  } catch (err) {
    log.warn('stored layout unreadable — using the default', err);
  }
  layout.setLayout(restored ?? doc);
}

/** Handle returned by {@link panelizeShell}, for loading layouts afterwards. */
export interface PanelizedShell {
  layout: SliccLayout;
  /** The fixed avatar strip in the trusted layer. */
  avatarStrip: HTMLElement;
  /** Panels created by the panelization, keyed by id. */
  panels: Map<string, SliccPanel>;
  /**
   * Attach the VFS once it is available, enabling the document verbs
   * (`load`/`save`/`delete`/`docs`) and the add-panel menu's saved-layout list.
   *
   * Split from `panelizeShell` because the VFS resolves asynchronously during
   * boot (`openVfs()`), while the shell must panelize on the first paint — waiting
   * would show the classic shell and then swap it out mid-boot. Everything that
   * does not need a filesystem works from the moment `panelizeShell` returns.
   */
  attachFs: (fs: VirtualFS) => void;
  /** See the implementation note — makes sprinkles visible in a panelized shell. */
  hostSprinkleSurface: (surfaceId: string, surface: HTMLElement) => void;
  /** Remove a sprinkle's panel when the sprinkle closes. */
  removeSprinkleSurface: (surfaceId: string) => void;
}

/** The most recent panelization, so late boot stages can attach their VFS. */
let current: PanelizedShell | null = null;

/** The active panelized shell, or `null` when the classic shell is running. */
export function getPanelizedShell(): PanelizedShell | null {
  return current;
}

/**
 * Re-parent the mounted shell's chrome into panels inside a `<slicc-layout>` and
 * move the avatar into the trusted layer.
 *
 * Idempotent-ish: calling it twice would re-wrap already-wrapped elements, so it
 * bails if it has already run on this frame (marked with a data attribute).
 */
export function panelizeShell(
  refs: WcShellRefs,
  doc: LayoutDocument = DEFAULT_LAYOUT_DOC,
  /**
   * VFS handle, for the add-panel menu's layout list. Optional so the design-time
   * preview and tests can panelize without one — the menu then lists panels and
   * presets but no saved documents.
   */
  initialFs?: VirtualFS,
  /**
   * Tool-panel lifecycle hooks — the same pair `wireWcSprinkles` takes. Needed
   * here because panelization owns the dock rail's clicks now, and opening a tool
   * panel has to start its poller / lazy-mount (a terminal with no session, a
   * file tree with no rows) exactly as it did before.
   */
  hooks?: {
    onToolPanelActivate?: (id: string) => void;
    onToolPanelDeactivate?: (id: string) => void;
  }
): PanelizedShell | null {
  if (refs.frame.dataset.sliccPanelized === '1') {
    log.warn('panelizeShell called twice — ignoring the second call');
    return null;
  }
  ensurePanelizeStyles(document);
  registerBuiltinPanels();

  // Mutable so `attachFs` can supply it after boot's async VFS open resolves;
  // every closure below reads it lazily rather than capturing the initial value.
  let fs: VirtualFS | undefined = initialFs;

  const layout = document.createElement('slicc-layout') as SliccLayout;
  const panels = new Map<string, SliccPanel>();

  const add = (id: string, inner: HTMLElement | null | undefined): void => {
    if (!inner) return;
    const panel = wrapInPanel(id, inner);
    panels.set(id, panel);
    layout.appendChild(panel);
  };

  // The rail is a viewport overlay by default (it predates panels); `docked`
  // switches it to in-flow so the layout can size it. See slicc-freezer.ts.
  refs.freezer.setAttribute('docked', '');
  // The `--rail-w` padding on the app column existed to reserve space for the
  // fixed rail. As a docked panel it occupies real space, so the reservation
  // would double-count — clear it.
  const appCol = refs.frame.querySelector('.wcui-appcol') as HTMLElement | null;
  appCol?.style.setProperty('--rail-w', '0px');

  add(PANEL_IDS.scoopSwitcher, refs.switcher);
  add(PANEL_IDS.floatbar, refs.floatbar);
  add(PANEL_IDS.sessionsRail, refs.freezer);
  add(PANEL_IDS.dockRail, refs.dock);
  add(PANEL_IDS.chat, refs.chatPane);

  // Tool panels: the existing `<slicc-surface>` hosts move into panel wrappers
  // wholesale, so their content (file tree, terminal host, memory, monitor)
  // travels with them and keeps its state.
  //
  // Each surface must be marked `active`. A `<slicc-surface>` is
  // `position:absolute; inset:0; display:none` until `[active]` — it was built for
  // the show-one workbench, where exactly one sibling was revealed at a time. In a
  // panel the WRAPPER owns visibility, so an inactive surface just renders an
  // empty box: measured 0px tall with a mounted-but-invisible xterm, and its
  // textarea refused focus, so the terminal silently accepted no input.
  for (const id of [
    PANEL_IDS.files,
    PANEL_IDS.term,
    PANEL_IDS.memory,
    PANEL_IDS.monitor,
    PANEL_IDS.browser,
  ]) {
    const surface = refs.dockTree.querySelector(`slicc-surface[surface-id="${id}"]`);
    if (!(surface instanceof HTMLElement)) continue;
    activateSurface(surface);
    add(id, surface);
  }
  // Chat lives in a surface too (composed by `buildWcShellFrame`), but `add` took the
  // chatpane directly — so its surface wrapper is left behind and dropped with
  // the dock-tree, which is fine: the panel wrapper replaces it.

  // The avatar is the fixed chrome: it renders in the trusted layer, where no
  // panel can paint over it (H2). `mountTrusted` throws if the layer is missing
  // rather than falling back to body, so a shell built without it fails loudly.
  const avatarStrip = document.createElement('div');
  avatarStrip.className = 'wcui-avatar-strip';
  // The add-panel menu sits in the strip, not in a panel: it has to stay
  // reachable and unspoofable even when the layout is locked or a panel
  // misbehaves, which is exactly what the trusted layer guarantees.
  avatarStrip.appendChild(
    createAddPanelMenu({
      layout,
      onToggle: (panelId, visible) => {
        void applyLayoutDoc(
          { layout, fs },
          {
            kind: visible ? 'show' : 'hide',
            panelId,
          }
        );
      },
      onLoadLayout: (name) => {
        void applyLayoutDoc({ layout, fs }, { kind: 'load', name });
      },
      // Saves to `/workspace/layouts/<name>.json` — the free root, not the
      // sudo-gated `/etc/slicc/layouts/`: this is the USER saving their own
      // arrangement, which needs no approval. See `docs/layouts.md`.
      onSaveLayout: (name) => {
        void applyLayoutDoc({ layout, fs }, { kind: 'save', name, protected: false }).then(
          (result) => {
            if (result.error) log.warn('layout save failed', { name, error: result.error });
            else log.info('layout saved', { name, output: result.output });
          }
        );
      },
      onDeleteLayout: (name) => {
        void applyLayoutDoc({ layout, fs }, { kind: 'delete', name });
      },
      listLayoutNames: async () => ({
        // No `fs` (preview/tests) still lists presets — the menu degrades rather
        // than showing nothing.
        saved: fs ? (await listLayouts(fs)).map((entry) => entry.name) : [],
        presets: layoutDocNames(),
      }),
    })
  );
  avatarStrip.appendChild(refs.avatarMenu);
  mountTrusted(avatarStrip, document);

  // The old `<slicc-shell>` row (dock-tree + dock rail) and the nav bar are
  // replaced by the layout. Insert it where the app column was, keeping the
  // shader beneath.
  const shellRow = refs.shell;
  shellRow.replaceWith(layout);
  // The nav is now empty of everything the layout took; drop it so it stops
  // reserving its 36px (the top dock supplies that instead).
  refs.frame.querySelector('slicc-nav')?.remove();

  // Restores a hand-arranged layout if there is one, else loads `doc`.
  wireLayoutPersistence(layout, doc);

  // The dock rail's clicks used to reach `WcSprinkleZone`, which drove the
  // dock-tree this function just removed — so without re-wiring, clicking a tool
  // icon would place a surface into a detached element and the panel would stay
  // parked (observed: the terminal opened visually but its session never
  // mounted). Capture-phase, and `stopImmediatePropagation` so the pre-existing
  // dock-tree listener installed later by `wireWcSprinkles` never sees the event
  // and cannot fight this one.
  wireDockRailToLayout(refs.dock, layout, refs.overlaySurfaces, hooks);

  // Route the `layout` shell command's document verbs here, replacing the
  // dock-tree applier. Registered AFTER `setLayout` so a command arriving
  // immediately finds a rendered layout rather than an empty one.
  setLayoutApplier((msg) => {
    if (isLayoutDocMsg(msg)) return applyLayoutDoc({ layout, fs }, msg);
    // The dock-tree verbs (`set`/`open`/`size`/…) have no meaning against a
    // panel layout — they address zones and surfaces this engine doesn't have.
    // Report that plainly instead of silently doing nothing.
    return {
      applied: false,
      error: `"${msg.kind}" targets the old dock-tree; with panels use: load, save, show, hide, docs, panels`,
    };
  });

  refs.frame.dataset.sliccPanelized = '1';
  log.info('shell panelized', { panels: panels.size, layout: doc.id });

  const handle: PanelizedShell = {
    layout,
    avatarStrip,
    panels,
    attachFs: (next) => {
      fs = next;
      log.info('layout store attached');
    },
    ...sprinkleHostHooks(layout, panels),
  };
  current = handle;
  return handle;
}
