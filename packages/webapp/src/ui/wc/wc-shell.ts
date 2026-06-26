/**
 * The `@slicc/webcomponents` application shell — the next-generation SLICC
 * UI, assembled exactly like the library's full-app showcase (and the
 * `proto/StellarRubySwift.html` prototype it was extracted from): a cone
 * shader background, the fixed freezer rail, and an app column stacking the
 * full-width nav above the chat | workbench split with the dock rail.
 *
 * `mountWcShell` builds the frame and hands back element refs; the two boot
 * modes wire them differently — `mountWcUiPreview` (here) renders the
 * design-time chat fixture with a local composer echo, `wc-live.ts` binds
 * the kernel worker for real conversations.
 */

import {
  ensureGlobalTokens,
  followSystemTheme,
  type SliccAvatarMenu,
  type SliccFileTree,
  type SliccQueuedStack,
} from '@slicc/webcomponents';
// Adobe Clean @font-face — the library tokens reference the family but the
// declarations lived only in the (never-loaded) legacy stylesheet.
import '../styles/fonts.css';
import { createChatFixture, FIXTURE_SCOOP_NAME } from '../chat-fixture.js';
import type { ChatMessage } from '../types.js';
import { buildThreadChildren, messageEls } from './wc-message-view.js';

// Side-effect import registers every element composed below.
import '@slicc/webcomponents';

/** The prototype's ice-blue `_ctxAccent` for `freezer:` contexts. */
export const FREEZER_TINT = '#3b6cb2';

/** Scoop chip descriptors consumed by `<slicc-scoop-switcher>`. */
export interface SwitcherScoop {
  key: string;
  type: 'cone' | 'scoop';
  color: string;
  label: string;
  eyes: 'open' | 'dead' | 'none';
  ephemeral?: boolean;
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
  /** Logo badge text (fixture mode tags itself; live floats go bare). */
  badge?: string;
  /** Invoked when dock/tab selection activates a workbench surface. */
  onSurfaceActivate?: (surfaceId: string) => void;
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
  switcher: HTMLElement & { scoops: SwitcherScoop[] };
  floatbar: HTMLElement;
  shell: HTMLElement;
  workbenchBody: HTMLElement;
  /** Hidden while the tab bar has nothing to render (tool tabs never show). */
  workbenchHeader: HTMLElement;
  dock: HTMLElement;
  freezer: HTMLElement;
  fileTree: SliccFileTree;
  termSurface: HTMLElement;
  memoryHost: HTMLElement;
  tabBar: HTMLElement & { tabs?: unknown };
  avatarMenu: SliccAvatarMenu;
}

const STYLE_ID = 'slicc-wcui-style';
const CSS = [
  // The shell owns the page: kill the UA body margin (the legacy reset died
  // with base.css) so the frame sits flush against the window edges.
  'html,body{margin:0;padding:0;height:100%;}',
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
  '.wcui-frame slicc-file-tree{width:100%;border-right:none;}',
  // Rows need a positioning context so the absolute button never shifts row height.
  'slicc-file-tree .f,slicc-file-tree .dir{position:relative;}',
  // Hover action button container — absolutely positioned at the row's right edge.
  'slicc-file-tree .ft-acts{position:absolute;right:8px;top:50%;transform:translateY(-50%);',
  'display:flex;gap:3px;}',
  // Individual action buttons inside .ft-acts.
  'slicc-file-tree .ft-act{padding:0 5px;font-size:10px;line-height:16px;height:16px;',
  'box-sizing:border-box;font-family:var(--ui);border-radius:3px;border:1px solid var(--line);',
  'background:var(--canvas);color:var(--txt-2);cursor:pointer;}',
  'slicc-file-tree .ft-act:hover{background:var(--ghost);}',
  // 300ms green flash on Cmd+C copy-path.
  'slicc-file-tree .ft-copy-flash{background:color-mix(in srgb,#22c55e 18%,var(--canvas))!important;}',
  '.wcui-memory{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;',
  'gap:8px;padding:10px;}',
  '.wcui-placeholder{flex:1;display:flex;align-items:center;justify-content:center;',
  'padding:24px;color:var(--txt-2);font-size:13px;text-align:center;}',
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
  const switcher = el('slicc-scoop-switcher') as WcShellRefs['switcher'];
  switcher.scoops = [...options.scoops];
  const floatbar = el('slicc-floatbar', { label: options.floatLabel, spent: '0.00' });
  const avatarMenu = document.createElement('slicc-avatar-menu');
  avatarMenu.append(el('slicc-avatar', { name: 'SLICC' }));
  // No logo: the cone chip in the switcher IS the brand mark. Fixture mode
  // keeps its tag badge so screenshots stay distinguishable. No theme toggle
  // either — the shell follows the OS color scheme (followSystemTheme).
  nav.append(
    ...(options.badge ? [el('slicc-logo', { badge: options.badge })] : []),
    switcher,
    floatbar,
    avatarMenu
  );
  return { nav, switcher, floatbar, avatarMenu };
}

function buildComposer(options: WcShellOptions): {
  composer: HTMLElement;
  inputCard: HTMLElement;
  composerMeta: HTMLElement;
  queuedStack: SliccQueuedStack;
} {
  const composer = el('slicc-composer');
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
  composer.append(queuedStack, inputCard, composerMeta);
  return { composer, inputCard, composerMeta, queuedStack };
}

function buildWorkbench(): {
  workbench: HTMLElement;
  body: HTMLElement;
  header: HTMLElement;
  tree: WcShellRefs['fileTree'];
  termSurface: HTMLElement;
  memoryHost: HTMLElement;
  tabBar: WcShellRefs['tabBar'];
} {
  const workbench = el('slicc-workbench-pane');
  // The documented composition contract: the header is pinned via
  // `slot="header"` so the pane keeps it above the scrollable body region.
  // The tab bar never renders `tool` tabs (the dock owns tools), so the
  // header starts hidden — the sprinkle zone reveals it when sprinkle tabs
  // exist; an always-empty title strip is dead chrome.
  const header = el('slicc-workbench-header', { slot: 'header', hidden: '' });
  const tabs = el('slicc-tab-bar', { active: 'files' }) as HTMLElement & { tabs?: unknown };
  header.append(tabs);

  const body = el('slicc-workbench-body', { active: 'files' });
  const filesSurface = el('slicc-surface', { 'surface-id': 'files', layout: 'flex', active: '' });
  const tree = el('slicc-file-tree') as WcShellRefs['fileTree'];
  filesSurface.append(tree);

  const termSurfaceHost = el('slicc-surface', { 'surface-id': 'term', layout: 'flex' });
  const termSurface = el('div', { class: 'wcui-term' });
  termSurfaceHost.append(termSurface);

  const memorySurfaceHost = el('slicc-surface', { 'surface-id': 'memory', layout: 'flex' });
  const memoryHost = el('div', { class: 'wcui-memory' });
  memorySurfaceHost.append(memoryHost);

  // The dock's system tools include a Browser entry; its CDP pane is not
  // built for the WC shell yet — a placeholder beats an empty void.
  const browserSurface = el('slicc-surface', { 'surface-id': 'browser', layout: 'flex' });
  const browserNote = el('div', { class: 'wcui-placeholder' });
  browserNote.textContent =
    'The Browser dock item opens the full-screen tab switcher: every open tab — local and tray followers — with live screenshot thumbnails. Click a card to focus it, ✕ to close it.';
  browserSurface.append(browserNote);

  body.append(filesSurface, termSurfaceHost, memorySurfaceHost, browserSurface);
  workbench.append(header, body);
  return { workbench, body, header, tree, termSurface, memoryHost, tabBar: tabs };
}

/**
 * Dock clicks open the workbench on the matching surface. The dock owns the
 * toggle semantics: clicking the active item emits `slicc-dock-collapse`
 * (NOT a second select) — that collapses the workbench.
 */
function wireDockToWorkbench(
  dock: HTMLElement,
  shell: HTMLElement,
  body: HTMLElement,
  onSurfaceActivate?: (surfaceId: string) => void
): void {
  dock.addEventListener('slicc-dock-select', (event) => {
    const id = (event as CustomEvent<{ id: string }>).detail?.id;
    if (!id) return;
    // The Browser globe opens the FULL-SCREEN tab overlay (wc-browser.ts) —
    // a workspace pane underneath it would just be dead chrome.
    if (id === 'browser') return;
    shell.setAttribute('open', '');
    body.setAttribute('active', id);
    onSurfaceActivate?.(id);
  });
  dock.addEventListener('slicc-dock-collapse', () => {
    shell.removeAttribute('open');
  });
  // Click-and-hold on a sprinkle launcher: open its surface in BROWSER
  // fullscreen (the real Fullscreen API — the long-press release is the user
  // gesture that authorizes it). Esc / the UA chrome exits natively.
  dock.addEventListener('slicc-dock-longpress', (event) => {
    const id = (event as CustomEvent<{ id: string }>).detail?.id;
    if (!id?.startsWith('sprinkle:')) return;
    shell.setAttribute('open', '');
    body.setAttribute('active', id);
    onSurfaceActivate?.(id);
    // Escape for a double-quoted attribute selector (CSS.escape is for
    // identifiers, and jsdom lacks it).
    const quoted = id.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const surface = body.querySelector<HTMLElement>(`[surface-id="${quoted}"]`);
    surface?.requestFullscreen?.().catch(() => {
      // Denied / unsupported (e.g. iframe without allowfullscreen) — the
      // surface is still open in the workbench, just not fullscreen.
    });
  });
}

/** Tab selection switches the active workbench surface. */
function wireTabsToBody(
  header: HTMLElement,
  body: HTMLElement,
  onSurfaceActivate?: (surfaceId: string) => void
): void {
  header.addEventListener('tab-select', (event) => {
    // The library's canonical `tab-select` detail field is `id`
    // (TabEventDetail) — NOT `tabId`, which is the child tab's raw event.
    const tabId = (event as CustomEvent<{ id?: string }>).detail?.id;
    if (!tabId) return;
    body.setAttribute('active', tabId);
    onSurfaceActivate?.(tabId);
  });
}

/** Build the full WC app frame into `root` and return the wiring refs. */
export function mountWcShell(root: HTMLElement, options: WcShellOptions): WcShellRefs {
  ensureGlobalTokens(document);
  ensureShellStyles(document);
  ensureSystemTheme();

  const frame = el('div', { class: 'wcui-frame' });
  const shader = el('slicc-shader', { mode: 'cone', tint: 'var(--waffle)', class: 'wcui-shader' });

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
  const { composer, inputCard, composerMeta, queuedStack } = buildComposer(options);
  pane.append(thread, composer);

  const { workbench, body, header, tree, termSurface, memoryHost, tabBar } = buildWorkbench();
  const dock = el('slicc-dock', { 'system-tools': '' });
  shell.append(pane, workbench, dock);
  wireDockToWorkbench(dock, shell, body, options.onSurfaceActivate);
  wireTabsToBody(header, body, options.onSurfaceActivate);

  // The freezer rail reserves its width via `--rail-w` on the app column so
  // the nav + shell slide (not overlap) when the rail expands.
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
  frame.append(shader, freezer, appCol);
  root.replaceChildren(frame);

  return {
    frame,
    shader,
    chatPane: pane,
    thread,
    composer,
    inputCard,
    composerMeta,
    queuedStack,
    switcher,
    floatbar,
    shell,
    workbenchBody: body,
    workbenchHeader: header,
    dock,
    freezer,
    fileTree: tree,
    termSurface,
    memoryHost,
    tabBar,
    avatarMenu,
  };
}

/** The three UI contexts, each with its own shader program + accent. */
export type ShellContext =
  | { kind: 'cone' }
  | { kind: 'scoop'; accent: string }
  | { kind: 'freezer' };

/**
 * Flip the whole frame between its three moods: cone (waffle lattice, warm
 * amber), scoop (swirling ice-cream pastels, the scoop's accent), freezer
 * (frost crystallizing, ice blue). Swaps the WebGL program via the shader's
 * `mode`, washes its `tint`, and drives the inherited `--ctx` context accent
 * so every token-driven surface (freezer chrome, composer band, badges)
 * tints along. The freezer rail's `ctx` attribute mirrors the freezer mood.
 */
export function applyShellContext(refs: WcShellRefs, context: ShellContext): void {
  const { shader, frame, freezer } = refs;
  if (context.kind === 'cone') {
    shader.setAttribute('mode', 'cone');
    shader.setAttribute('tint', 'var(--waffle)');
    frame.style.removeProperty('--ctx');
    freezer.removeAttribute('ctx');
  } else if (context.kind === 'scoop') {
    shader.setAttribute('mode', 'scoop');
    shader.setAttribute('tint', context.accent);
    frame.style.setProperty('--ctx', context.accent);
    freezer.removeAttribute('ctx');
  } else {
    shader.setAttribute('mode', 'freezer');
    shader.setAttribute('tint', FREEZER_TINT);
    frame.style.setProperty('--ctx', FREEZER_TINT);
    freezer.setAttribute('ctx', '');
  }
}

/** Submitted composer text, from the input card's `submit` CustomEvent. */
export function submittedText(event: Event): string | undefined {
  // `<slicc-input-card>` dispatches a CustomEvent named `submit` (not the
  // native form SubmitEvent), so widen rather than convert.
  return (event as Event & { detail?: { value?: string } }).detail?.value;
}

/** Mount the design-time preview: the WC shell over the chat fixture. */
export function mountWcUiPreview(root: HTMLElement): void {
  const refs = mountWcShell(root, {
    messages: createChatFixture(),
    scoops: [
      { key: 'cone', type: 'cone', color: '#b07823', label: 'sliccy', eyes: 'open' },
      {
        key: FIXTURE_SCOOP_NAME,
        type: 'scoop',
        color: '#06b6d4',
        label: FIXTURE_SCOOP_NAME,
        eyes: 'open',
      },
    ],
    floatLabel: 'standalone · preview',
    placeholder: 'Preview harness — submissions echo into the thread…',
    badge: 'fixture',
  });

  refs.fileTree.items = [
    { kind: 'group', label: 'workspace/' },
    { kind: 'file', id: '/workspace/CLAUDE.md', label: 'CLAUDE.md' },
    { kind: 'group', label: 'shared/' },
    { kind: 'file', id: '/shared/CLAUDE.md', label: 'CLAUDE.md' },
  ];

  // Eyes show one-pair-at-a-time (hover > attention); give the fixture's cone
  // the blinking pair so the preview demos the resting state.
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
