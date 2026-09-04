/**
 * The `@slicc/webcomponents` application shell — the next-generation SLICC
 * UI, assembled exactly like the library's full-app showcase (and the
 * `proto/StellarRubySwift.html` prototype it was extracted from): a cone
 * shader background, the fixed freezer rail, and an app column stacking the
 * full-width nav above the dock-tree (permanently full-span — chat and every
 * tool panel are independent tree leaves) with the dock rail.
 *
 * `buildWcShellFrame` builds the frame and hands back element refs; the two boot
 * modes wire them differently — `mountWcUiPreview` (here) renders the
 * design-time chat fixture with a local composer echo, `wc-live.ts` binds
 * the kernel worker for real conversations.
 */

import {
  ensureGlobalTokens,
  followSystemTheme,
  type SliccAgentTabs,
  type SliccAvatarMenu,
  type SliccComposerMeta,
  type SliccDock,
  type SliccDockTree,
  type SliccFileTree,
  type SliccFreezer,
  type SliccMemoryPanel,
  type SliccMonitor,
  type SliccQueuedStack,
} from '@slicc/webcomponents';
// Adobe Clean @font-face — the library tokens reference the family but the
// declarations lived only in the (never-loaded) legacy stylesheet.
import '../styles/fonts.css';
import { createLogger } from '../../base/logger.js';
import { createChatFixture, FIXTURE_SCOOP_NAME } from '../chat-fixture.js';
import type { ChatMessage } from '../types.js';
import { buildTrustedLayers, TRUSTED_LAYER_CSS } from './trusted-layer.js';
import { buildThreadChildren, messageEls } from './wc-message-view.js';
import { wireShellKeyboard } from './wc-shortcut-surfaces.js';
import type { ShortcutHandles } from './wc-shortcuts.js';
import { wireBase64Previews } from './wire-base64-previews.js';

// Side-effect import registers every element composed below.
import '@slicc/webcomponents';

/** The prototype's ice-blue `_ctxAccent` for `freezer:` contexts. */
export const FREEZER_TINT = '#3b6cb2';

/** Agent tab descriptors consumed by `<slicc-agent-tabs>`. */
export interface SwitcherScoop {
  key: string;
  type: 'cone' | 'scoop';
  color: string;
  label: string;
  eyes: 'open' | 'dead' | 'none';
  state?: 'working' | 'broken' | 'initializing' | 'idle';
  ephemeral?: boolean;
  /** 0-100 context-window fullness forwarded to the pill (pupils dilate). */
  fill?: number;
  /**
   * What a `working` agent is busy with — shapes the tab's centre pin (square
   * for the model thinking, circle for a tool call), mirroring the composer's
   * send button. Ignored for every other state.
   */
  phase?: 'thinking' | 'tool';
  /**
   * An idle scoop whose turn just ended and whose composer is ready for you:
   * its avatar makes eye contact with the composer instead of wandering, and
   * drowses if it is kept waiting.
   *
   * Collapsed onto the wire as the `ScoopSummary.activity: 'awaiting'`
   * refinement by `wc-tray-scoops.ts` (the wire's `state` stays `idle`) and
   * expanded back here on the follower, so both sides render the same face
   * from a single derivation.
   */
  awaiting?: boolean;
}

export interface WcShellOptions {
  /** Chat history rendered into the cone thread. */
  messages: readonly ChatMessage[];
  /** Scoop chips for the nav switcher (cone first). */
  scoops: readonly SwitcherScoop[];
  /** Floatbar status label (e.g. `standalone · preview`). */
  floatLabel: string;
  /** Composer input placeholder. */
  placeholder: string;
  /**
   * Live floats opt the components into URL state sync: the thread owns
   * `ctx`/`at`, the shell owns `ws`. Each component manages its own params —
   * the host only routes `slicc-url-context` back through scoop selection.
   */
  urlState?: boolean;
}

/** Element handles the boot modes wire their behavior onto. */
export interface WcShellRefs {
  frame: HTMLElement;
  /**
   * The clamped container every layout-owned element renders inside — a CSS
   * stacking context (`isolation:isolate`), so no panel descendant can paint
   * above `trustedLayer` no matter what `z-index` it sets. See
   * `trusted-layer.ts` (H2).
   */
  panelHost: HTMLElement;
  /**
   * The spoof-proof top layer: fixed chrome (the avatar strip) and every
   * approval/permission overlay. A later sibling of `panelHost`, so it always
   * composites above it. Mount into it via `mountTrusted`, never
   * `document.body.append`.
   */
  trustedLayer: HTMLElement;
  /** The WebGL background field (`<slicc-shader>`, one of three programs). */
  shader: HTMLElement;
  /** The chat column (`<slicc-chatpane>`) — `position:relative` so it can host
   *  full-area overlays (drop zone, PTT). The compact `<slicc-composer-capture>`
   *  surface anchors against the composer band, not the chat pane. */
  chatPane: HTMLElement;
  thread: HTMLElement;
  /** The composer footer band (PTT host — live floats arm + inject speech). */
  composer: HTMLElement;
  inputCard: HTMLElement;
  composerMeta: HTMLElement;
  /**
   * The pile of pending user submissions pinned above the input card. Renders
   * nothing when empty (the component hides itself), so the idle composer is
   * unchanged. Live floats populate it when submissions queue behind a busy
   * agent; the fixture/preview keeps it empty.
   */
  queuedStack: SliccQueuedStack;
  /** Non-error sustained-event notice, kept outside the queued submission stack. */
  lickBackpressureNotice: HTMLElement;
  switcher: SliccAgentTabs;
  floatbar: HTMLElement;
  shell: HTMLElement;
  /**
   * The GUI drag-drop dock-tree layout editor — the sole layout host,
   * permanently full-span between the nav and the dock rail. Chat and every
   * fixed tool panel (files/terminal/memory/monitor) are independent,
   * always-mounted leaves composed directly into it (see `buildWorkbench`).
   */
  dockTree: SliccDockTree;
  dock: HTMLElement;
  freezer: HTMLElement;
  fileTree: SliccFileTree;
  termSurface: HTMLElement;
  memoryHost: SliccMemoryPanel;
  monitor: SliccMonitor;
  avatarMenu: SliccAvatarMenu;
  /**
   * Modal keyboard mode (Esc to enter, then bare letters). Installed here
   * rather than in a float's boot because every float mounts through this
   * function, and because the bindings need nothing a float owns: each one
   * drives its surface's OWN event — `switcher.select()`, `dock.selectItem()`,
   * `freezer.toggle()` — so every float's existing wiring stays the single
   * implementation of what selecting or opening means. Actions no shell
   * element can reach (account settings) are late-bound via `setAction`.
   */
  shortcuts: ShortcutHandles;
  /**
   * Dock surface ids claimed by a full-screen overlay launcher instead of a
   * workbench pane. `wireDockToWorkbench` consults this at click time, so a
   * float that never wires an overlay (follower, cherry, extension) keeps the
   * pane fallback — and a leader whose overlay module fails to load degrades
   * to the same fallback rather than a dead dock item.
   *
   * Claimed by the overlay's own wiring (see `wc-browser.ts`), never here:
   * hardcoding an id in the dock handler is what made the follower's Browser
   * globe inert once the leader-only overlay became its replacement.
   */
  overlaySurfaces: Set<string>;
}

const STYLE_ID = 'slicc-wcui-style';
const CSS = [
  // The shell owns the page: kill the UA body margin (the legacy reset died
  // with base.css) and suppress the manually verified root-viewport elastic
  // overscroll (not scroll chaining) so the frame stays flush to the window.
  'html,body{margin:0;padding:0;height:100%;overscroll-behavior:none;}',
  '.wcui-frame{position:relative;transform:translateZ(0);width:100%;height:100vh;',
  'overflow:hidden;background:var(--bg);font-family:var(--ui);}',
  '.wcui-shader{position:absolute;inset:0;z-index:0;}',
  // The chat column must stay transparent so the cone shader shows through
  // (the component paints an opaque background by default), and `relative`
  // so it can host any `inset:0` overlay (drop zone, PTT) without a
  // separate wrapper. The compact capture surface anchors on the composer
  // band instead — see `wc-attach.ts` `captureInline`.
  '.wcui-frame slicc-chatpane{position:relative;background:transparent;}',
  '.wcui-appcol{position:relative;z-index:1;height:100%;display:flex;flex-direction:column;',
  'box-sizing:border-box;padding-left:var(--rail-w,44px);',
  'transition:padding-left .4s cubic-bezier(.4,0,.2,1);}',
  '@media (max-width:560px){.wcui-appcol{padding-left:44px;}}',
  // Terminal surface: one uniform black — the pane matches xterm's dark
  // theme background, and the host div (whose legacy stylesheet died with
  // the old UI) flexes to fill the surface so xterm's fit gets real height.
  '.wcui-term{flex:1;min-height:0;display:flex;flex-direction:column;padding:8px 4px 8px 10px;',
  'box-sizing:border-box;background:#141414;}',
  '.wcui-term .terminal-panel__terminal-host{flex:1 1 auto;min-height:0;}',
  '.wcui-term .terminal-panel__preview{flex:0 0 auto;}',
  // The files surface is the tree: no dead second column, no divider.
  //
  // The row rules that used to live here (`.f` / `.dir` positioning and the
  // `.ft-acts` hover-button strip) are gone with the DOM they targeted: rows
  // now render inside `@pierre/trees`' shadow root, which this stylesheet
  // cannot reach, and the row actions moved into the context menu. Styling the
  // rows is done by handing CSS variables across the boundary — see `TREE_CSS`
  // in `slicc-file-tree.ts`.
  '.wcui-frame slicc-file-tree{width:100%;border-right:none;}',
  '.wcui-memory{flex:1;min-height:0;overflow:hidden;}',
  '.wcui-monitor{flex:1;min-height:0;}',
  '.wcui-placeholder{flex:1;display:flex;align-items:center;justify-content:center;',
  'padding:24px;color:var(--txt-2);font-size:13px;text-align:center;}',
  '.wcui-backpressure{align-self:flex-end;max-width:80%;box-sizing:border-box;',
  'padding:8px 12px;border:1px solid var(--line);border-radius:14px;',
  'background:var(--canvas);color:var(--txt-2);font-size:12px;line-height:1.4;}',
  '.wcui-backpressure[hidden]{display:none;}',
  // H2 — the panel host / trusted layer split. See `trusted-layer.ts` for why
  // this is a stacking context rather than a z-index.
  TRUSTED_LAYER_CSS,
].join('');

function ensureShellStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
}

/**
 * The shell has no theme toggle — light/dark always follows the OS color
 * scheme, live (a system day/night switch retints without a reload). A
 * remount replaces the previous subscription so media-query listeners never
 * stack.
 */
let systemThemeUnsubscribe: (() => void) | null = null;
function ensureSystemTheme(): void {
  systemThemeUnsubscribe?.();
  systemThemeUnsubscribe = followSystemTheme();
}

function el(tag: string, attrs: Record<string, string> = {}): HTMLElement {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function buildNav(options: WcShellOptions): {
  nav: HTMLElement;
  switcher: WcShellRefs['switcher'];
  floatbar: HTMLElement;
  avatarMenu: SliccAvatarMenu;
} {
  const nav = el('slicc-nav', { accent: 'var(--waffle)' });
  const switcher = el('slicc-agent-tabs') as WcShellRefs['switcher'];
  switcher.scoops = [...options.scoops];
  const floatbar = el('slicc-floatbar', { label: options.floatLabel, spent: '0.00' });
  const avatarMenu = document.createElement('slicc-avatar-menu');
  avatarMenu.append(el('slicc-avatar', { name: 'SLICC' }));
  // Fixture and live modes both render the same bare nav. No theme toggle
  // either — the shell follows the OS color scheme (followSystemTheme).
  nav.append(switcher, floatbar, avatarMenu);
  return { nav, switcher, floatbar, avatarMenu };
}

function buildComposer(options: WcShellOptions): {
  composer: HTMLElement;
  inputCard: HTMLElement;
  composerMeta: HTMLElement;
  queuedStack: SliccQueuedStack;
  lickBackpressureNotice: HTMLElement;
} {
  const composer = el('slicc-composer');
  const lickBackpressureNotice = el('div', {
    class: 'wcui-backpressure',
    role: 'status',
    'aria-live': 'polite',
    hidden: '',
  });
  // The queued pile sits ABOVE the input card inside the composer. Placement
  // matches the Storybook `InComposer` story: the stack's `.stack` grid is
  // positioned (so its cards can grid-overlap), which would paint atop a
  // static sibling regardless of DOM order — so the input card is lifted to
  // `z-index:1` and the stack is pinned to `z-index:0`, and the stack carries
  // the overlap margin that tucks its front card under the opaque input card.
  // The component renders nothing when empty, so an idle composer is visually
  // unchanged. `minHeight` guarantees a visible peek above the overlap even
  // for a short single-line front card: a 41px card would otherwise leave
  // only ~9px above the 32px overlap, almost entirely hidden by the textarea.
  // 76px reserves badge(~16) + gap(6) + ~22px card peek above the 32px tuck;
  // taller cards exceed the floor and keep the deeper tucked-behind look.
  const queuedStack = el('slicc-queued-stack') as SliccQueuedStack;
  queuedStack.style.position = 'relative';
  queuedStack.style.zIndex = '0';
  queuedStack.style.marginBottom = '-32px';
  queuedStack.style.minHeight = '76px';
  const inputCard = el('slicc-input-card', { placeholder: options.placeholder });
  inputCard.style.position = 'relative';
  inputCard.style.zIndex = '1';
  const composerMeta = el('slicc-composer-meta', { model: 'Preview', thinking: 'off' });
  composer.append(lickBackpressureNotice, queuedStack, inputCard, composerMeta);
  return { composer, inputCard, composerMeta, queuedStack, lickBackpressureNotice };
}

/**
 * Build the 4 fixed tool panels (files/terminal/memory/monitor) as
 * independent `<slicc-surface>` leaves, plus the browser-follower fallback
 * pane — every one composed directly into the dock-tree at boot, exactly
 * like a sprinkle. There is no shared "workbench body" anymore: each panel
 * is its own permanently-mounted, independently draggable/resizable/closable
 * tree leaf.
 */
function buildWorkbench(): {
  dockTree: WcShellRefs['dockTree'];
  tree: WcShellRefs['fileTree'];
  termSurface: HTMLElement;
  memoryHost: WcShellRefs['memoryHost'];
  monitor: SliccMonitor;
} {
  const dockTree = el('slicc-dock-tree') as WcShellRefs['dockTree'];

  const filesSurface = el('slicc-surface', { 'surface-id': 'files', layout: 'flex' });
  const tree = el('slicc-file-tree') as WcShellRefs['fileTree'];
  filesSurface.append(tree);

  const termSurfaceHost = el('slicc-surface', { 'surface-id': 'term', layout: 'flex' });
  const termSurface = el('div', { class: 'wcui-term' });
  termSurfaceHost.append(termSurface);

  const memorySurfaceHost = el('slicc-surface', { 'surface-id': 'memory', layout: 'flex' });
  const memoryHost = el('slicc-memory-panel', { class: 'wcui-memory' }) as SliccMemoryPanel;
  memorySurfaceHost.append(memoryHost);

  const monitorSurfaceHost = el('slicc-surface', { 'surface-id': 'monitor', layout: 'flex' });
  const monitor = el('slicc-monitor', { class: 'wcui-monitor' }) as SliccMonitor;
  monitorSurfaceHost.append(monitor);

  // The dock's system tools include a Browser entry. Floats that wire the
  // full-screen tab switcher claim the surface (see `WcShellRefs.overlaySurfaces`)
  // and never reach this pane; the rest — followers above all — land here.
  const browserSurface = el('slicc-surface', { 'surface-id': 'browser', layout: 'flex' });
  const browserNote = el('div', { class: 'wcui-placeholder' });
  browserNote.textContent =
    'The tab switcher runs on the leader. This float has no browser of its own to show — ask the leader to open, focus, or close tabs through chat.';
  browserSurface.append(browserNote);

  dockTree.append(
    filesSurface,
    termSurfaceHost,
    memorySurfaceHost,
    monitorSurfaceHost,
    browserSurface
  );

  return { dockTree, tree, termSurface, memoryHost, monitor };
}

/**
 * Overlay-launched dock items (see `WcShellRefs.overlaySurfaces`) open a
 * full-screen view instead of a dock-tree leaf; everything else (tool panels
 * and sprinkles) is owned entirely by `wireWcSprinkles`' own
 * `slicc-dock-select`/`slicc-dock-collapse`/`slicc-dock-longpress` listeners,
 * which compose leaves directly into the dock-tree (the long-press activates
 * through the select path and then fullscreens the placed surface — sprinkle
 * or tool panel — via `requestPlacedSurfaceFullscreen`; fullscreen on an
 * unplaced surface rejects, the element is `display:none` in parking). This
 * listener only defends the overlay carve-out.
 */
function wireDockToWorkbench(dock: HTMLElement, overlaySurfaces: ReadonlySet<string>): void {
  dock.addEventListener('slicc-dock-select', (event) => {
    const id = (event as CustomEvent<{ id: string }>).detail?.id;
    // Nothing to do here for a non-overlay id — `wireWcSprinkles` handles
    // it. Read `overlaySurfaces` at click time, not mount time — the overlay
    // wiring runs after `buildWcShellFrame`. An overlay id never reaches the
    // dock-tree, so there's nothing to suppress beyond not acting on it.
    if (!id || !overlaySurfaces.has(id)) return;
  });
}

/**
 * Bridge a `pointerdown` on a sprinkle launcher chip to
 * `beginExternalDrag(surfaceId, pointerId)` so the same gesture that would
 * otherwise just click-open the sprinkle can instead be dragged straight into
 * a zone. `<slicc-dock-item>` is shadow-DOM but its native pointer events are
 * `composed`, so a listener on the light-DOM `<slicc-dock>` rail still sees
 * them (retargeted to the dock-item host, which carries `item-id`).
 *
 * A plain click still degrades cleanly: `beginExternalDrag` only arms the
 * dock-tree's drag state machine — it never calls `preventDefault` or
 * `stopPropagation`, so the dock-item's own click-driven `select` event (the
 * existing click-to-open path wired in `wireWcSprinkles`) still fires
 * unmodified. If no `pointermove` ever lands on a drop target before
 * `pointerup` (the case for an ordinary click), the dock-tree's own guard
 * cancels the drag with no mutation and no event.
 */
function wireDockExternalDragToTree(dock: HTMLElement, dockTree: WcShellRefs['dockTree']): void {
  dock.addEventListener('pointerdown', (event) => {
    const target = event.target as HTMLElement | null;
    const item = target?.closest?.('slicc-dock-item');
    const id = item?.getAttribute('item-id');
    if (!id?.startsWith('sprinkle:') || !dockTree.tilesMovable) return;
    dockTree.beginExternalDrag(id, (event as PointerEvent).pointerId);
  });
}

/** Build the full WC app frame into `root` and return the wiring refs. */
export function buildWcShellFrame(root: HTMLElement, options: WcShellOptions): WcShellRefs {
  ensureGlobalTokens(document);
  ensureShellStyles(document);
  ensureSystemTheme();

  const frame = el('div', { class: 'wcui-frame' });
  const shader = el('slicc-shader', { mode: 'cone', class: 'wcui-shader' });

  const freezer = el('slicc-freezer');
  freezer.append(el('slicc-freezer-new'));

  const appCol = el('div', { class: 'wcui-appcol' });
  const urlState: Record<string, string> = options.urlState ? { 'url-state': '' } : {};
  const shell = el('slicc-shell', urlState);
  const pane = el('slicc-chatpane');
  const thread = el('slicc-chat-thread', {
    context: 'cone',
    accent: 'var(--waffle)',
    ...urlState,
  });
  thread.append(...buildThreadChildren(options.messages));
  const { composer, inputCard, composerMeta, queuedStack, lickBackpressureNotice } =
    buildComposer(options);
  pane.append(thread, composer);

  const { dockTree, tree, termSurface, memoryHost, monitor } = buildWorkbench();
  // Chat is a reserved, non-closable dock-tree leaf (`CHAT_SURFACE_ID` in
  // `wc-sprinkles.ts`) — the live `<slicc-chatpane>` is composed directly
  // into the tree, never a separate shell region, so it can be dragged and
  // resized like any other panel while remaining un-removable.
  const chatSurface = el('slicc-surface', { 'surface-id': 'chat', layout: 'flex' });
  chatSurface.append(pane);
  dockTree.append(chatSurface);
  const dockTreeApi = dockTree as unknown as {
    setPinned(ids: string[]): void;
    placeSurface(surfaceId: string, zone: string): void;
  };
  dockTreeApi.setPinned(['chat']);
  // Default placement for hosts that never call `wireDockTreePersistence`
  // (the design-time preview). Live floats immediately overwrite this via
  // `setTree` (restored-or-default tree, which already seats chat), so this
  // is a no-op there — `placeSurface` never displaces an existing position.
  dockTreeApi.placeSurface('chat', 'left');
  const dock = el('slicc-dock', { 'system-tools': '' });
  // `dockTree` is a shell-level region, permanently full-span alongside the
  // dock rail — see `WcShellRefs.dockTree`.
  shell.append(dockTree, dock);
  const overlaySurfaces = new Set<string>();
  wireDockToWorkbench(dock, overlaySurfaces);
  wireDockExternalDragToTree(dock, dockTree);

  // The freezer rail reserves its width via `--rail-w` on the app column so
  // the nav + shell slide (not overlap) when the rail expands. Only meaningful
  // while the rail is a viewport-fixed overlay; as a docked panel it occupies
  // real layout space and the engine sizes it (see `panelizeShell`).
  freezer.addEventListener('freezer-toggle', (event) => {
    const open = (event as CustomEvent<{ open?: boolean }>).detail?.open === true;
    appCol.style.setProperty('--rail-w', open ? '260px' : '44px');
  });

  // The shader field pans with the conversation: thread scroll feeds the
  // shader's `scroll` attribute (rAF-throttled — scroll events fire fast).
  let scrollRaf = 0;
  thread.addEventListener(
    'scroll',
    () => {
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = 0;
        shader.setAttribute('scroll', String(Math.round(thread.scrollTop)));
      });
    },
    { passive: true }
  );

  const { nav, switcher, floatbar, avatarMenu } = buildNav(options);
  appCol.append(nav, shell);
  // Keyboard mode over the mounted shell. The elements it drives that are not
  // a component method — the send button's `stop`, the copy row's gestures,
  // the add menu, an approval card, the open panel, the chord lists — are
  // reached in `wc-shortcut-surfaces.ts`, so this file hands over the elements
  // and nothing else. `WcShellRefs` types the rails and the model pill as bare
  // `HTMLElement` (they carry no shell-specific API); the mode needs their
  // component surface, and the custom elements are registered by the
  // side-effect import above.
  const shortcuts = wireShellKeyboard({
    switcher,
    dock: dock as unknown as SliccDock,
    freezer: freezer as unknown as SliccFreezer & HTMLElement,
    composerMeta: composerMeta as unknown as SliccComposerMeta,
    composer,
    chatPane: pane,
    inputCard,
    thread,
    frame,
    dockTree,
    fileTree: tree,
    memoryHost,
  });

  // H2 — everything layout-owned goes inside `panelHost` (a stacking context,
  // so no descendant can paint above it); `trustedLayer` is a LATER sibling and
  // therefore always composites on top. Approval/consent chrome mounts there
  // via `mountTrusted`. The layer is empty at this point: the fixed avatar
  // strip moves into it when the nav is panelized (Phase 3) — establishing the
  // split now means approval surfaces have somewhere trustworthy to land, and
  // panels are already clamped before any dynamic panel can register.
  const { panelHost, trustedLayer } = buildTrustedLayers(document);
  panelHost.append(shader, freezer, appCol);
  frame.append(panelHost, trustedLayer);
  root.replaceChildren(frame);

  // Base64 payload previews: a pasted blob — a screenshot as a `data:` URL,
  // the output of `base64 < report.pdf` — collapses to a chip that opens it in
  // Quick Look. Wired HERE, at the mount, rather than in `wc-live`'s
  // `attachWcClient`, because it needs no VFS and this is the one seam every
  // surface that renders a transcript passes through: the live float, the
  // extension popout, and the three that deliberately never attach a client
  // (Cherry, the tray follower, the extension side panel — see
  // `wc-follower.ts`). File mentions genuinely belong in the client phase;
  // they need a VFS reader a follower has no worker for.
  wireBase64Previews({ thread, log: createLogger('base64-preview') });

  return {
    frame,
    panelHost,
    trustedLayer,
    shader,
    chatPane: pane,
    thread,
    composer,
    inputCard,
    composerMeta,
    queuedStack,
    lickBackpressureNotice,
    switcher,
    floatbar,
    shell,
    dockTree,
    dock,
    freezer,
    fileTree: tree,
    termSurface,
    memoryHost,
    monitor,
    avatarMenu,
    shortcuts,
    overlaySurfaces,
  };
}

/** The three UI contexts, each with its own shader program + accent. */
export type ShellContext =
  | { kind: 'cone' }
  | { kind: 'scoop'; accent: string }
  | { kind: 'freezer' };

/**
 * Flip the whole frame between its three moods: cone (Caramel Sugar Glass),
 * scoop (swirling ice-cream pastels, the scoop's accent), freezer
 * (frost crystallizing, ice blue). Swaps the WebGL program via the shader's
 * `mode`, washes its `tint`, and drives the inherited `--ctx` context accent
 * so every token-driven surface (freezer chrome, composer band, badges)
 * tints along. The freezer rail's `ctx` attribute mirrors the freezer mood.
 */
export function applyShellContext(refs: WcShellRefs, context: ShellContext): void {
  const { shader, frame, freezer } = refs;
  if (context.kind === 'cone') {
    shader.removeAttribute('tint');
    frame.style.removeProperty('--ctx');
    freezer.removeAttribute('ctx');
    shader.setAttribute('mode', 'cone');
  } else if (context.kind === 'scoop') {
    shader.setAttribute('tint', context.accent);
    frame.style.setProperty('--ctx', context.accent);
    freezer.removeAttribute('ctx');
    shader.setAttribute('mode', 'scoop');
  } else {
    shader.setAttribute('mode', 'freezer');
    shader.setAttribute('tint', FREEZER_TINT);
    frame.style.setProperty('--ctx', FREEZER_TINT);
    freezer.setAttribute('ctx', '');
  }
}

/**
 * Mount or unmount the interactive composer region for the selected unit.
 *
 * Users never talk to a scoop (#2312): a read-only unit hides the whole
 * `<slicc-composer>` band — input card, queued pile, model picker and
 * thinking pill, dictation and attachments all live inside it — so the
 * transcript is the only thing left. `slicc-composer[hidden]` is
 * `display:none`, so nothing is reserved and the thread simply grows into
 * the freed band; the shell mood (shader/accent) is untouched.
 *
 * Re-enabling is deliberately NOT symmetric: the caller owns `disabled`
 * (a disconnected follower keeps its composer disabled with the connection
 * placeholder), so this only ever ADDS the read-only lock.
 */
export function applyComposerAvailability(refs: WcShellRefs, readOnly: boolean): void {
  refs.composer.toggleAttribute('hidden', readOnly);
  if (readOnly) refs.inputCard.setAttribute('disabled', '');
}

/** Submitted composer text, from the input card's `submit` CustomEvent. */
export function submittedText(event: Event): string | undefined {
  // `<slicc-input-card>` dispatches a CustomEvent named `submit` (not the
  // native form SubmitEvent), so widen rather than convert.
  return (event as Event & { detail?: { value?: string } }).detail?.value;
}

/**
 * Whether the submit was a steering send (Ctrl/Cmd+Enter), from the input
 * card's `submit` CustomEvent. A steering send interrupts a running turn
 * instead of queueing behind it; a plain Enter enqueues as before.
 */
export function submittedSteer(event: Event): boolean {
  return (event as Event & { detail?: { steer?: boolean } }).detail?.steer === true;
}

/** Mount the design-time preview: the WC shell over the chat fixture. */
export function mountWcUiPreview(root: HTMLElement): void {
  const refs = buildWcShellFrame(root, {
    messages: createChatFixture(),
    scoops: [
      {
        key: 'cone',
        type: 'cone',
        color: '#b07823',
        label: 'sliccy',
        eyes: 'open',
        state: 'working',
      },
      {
        key: FIXTURE_SCOOP_NAME,
        type: 'scoop',
        color: '#06b6d4',
        label: FIXTURE_SCOOP_NAME,
        eyes: 'open',
        state: 'broken',
      },
    ],
    floatLabel: 'standalone · preview',
    placeholder: 'Preview harness — submissions echo into the thread…',
  });

  refs.fileTree.items = [
    {
      kind: 'dir',
      id: '/workspace',
      label: 'workspace',
      open: true,
      children: [{ kind: 'file', id: '/workspace/CLAUDE.md', label: 'CLAUDE.md', size: 3200 }],
    },
    {
      kind: 'dir',
      id: '/shared',
      label: 'shared',
      open: true,
      children: [{ kind: 'file', id: '/shared/CLAUDE.md', label: 'CLAUDE.md', size: 1800 }],
    },
  ];

  // Keep attention on the working cone so the focused avatar and its live state agree.
  refs.switcher.setAttribute('attention', 'cone');

  refs.inputCard.addEventListener('submit', (event) => {
    const text = submittedText(event)?.trim();
    if (!text) return;
    const echo: ChatMessage = {
      id: `wc-echo-${refs.thread.childElementCount}`,
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };
    refs.thread.append(...messageEls(echo));
  });
}
