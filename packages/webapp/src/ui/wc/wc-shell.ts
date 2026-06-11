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

import { ensureGlobalTokens, type SliccFileTree } from '@slicc/webcomponents';
import { createChatFixture, FIXTURE_SCOOP_NAME } from '../chat-fixture.js';
import type { ChatMessage } from '../types.js';
import { buildThreadChildren, messageEls } from './wc-message-view.js';

// Side-effect import registers every element composed below.
import '@slicc/webcomponents';

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
  /** Invoked when dock/tab selection activates a workbench surface. */
  onSurfaceActivate?: (surfaceId: string) => void;
}

/** Element handles the boot modes wire their behavior onto. */
export interface WcShellRefs {
  frame: HTMLElement;
  thread: HTMLElement;
  inputCard: HTMLElement;
  composerMeta: HTMLElement;
  switcher: HTMLElement & { scoops: SwitcherScoop[] };
  floatbar: HTMLElement;
  shell: HTMLElement;
  workbenchBody: HTMLElement;
  dock: HTMLElement;
  freezer: HTMLElement;
  fileTree: SliccFileTree;
  termSurface: HTMLElement;
  memoryHost: HTMLElement;
  tabBar: HTMLElement & { tabs?: unknown };
}

const STYLE_ID = 'slicc-wcui-style';
const CSS = [
  '.wcui-frame{position:relative;transform:translateZ(0);width:100%;height:100vh;',
  'overflow:hidden;background:var(--bg);font-family:var(--ui);}',
  '.wcui-shader{position:absolute;inset:0;z-index:0;}',
  '.wcui-appcol{position:relative;z-index:1;height:100%;display:flex;flex-direction:column;',
  'box-sizing:border-box;padding-left:var(--rail-w,44px);',
  'transition:padding-left .4s cubic-bezier(.4,0,.2,1);}',
  '@media (max-width:560px){.wcui-appcol{padding-left:44px;}}',
  '.wcui-term{flex:1;min-height:0;display:flex;flex-direction:column;}',
  '.wcui-memory{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;',
  'gap:8px;padding:10px;}',
].join('');

function ensureShellStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
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
} {
  const nav = el('slicc-nav', { accent: 'var(--waffle)' });
  const switcher = el('slicc-scoop-switcher') as WcShellRefs['switcher'];
  switcher.scoops = [...options.scoops];
  const floatbar = el('slicc-floatbar', { label: options.floatLabel, spent: '0.00' });
  nav.append(
    el('slicc-logo', { badge: 'preview' }),
    switcher,
    floatbar,
    el('slicc-theme-toggle'),
    el('slicc-avatar', { name: 'SLICC Preview' })
  );
  return { nav, switcher, floatbar };
}

function buildComposer(options: WcShellOptions): {
  composer: HTMLElement;
  inputCard: HTMLElement;
  composerMeta: HTMLElement;
} {
  const composer = el('slicc-composer');
  const inputCard = el('slicc-input-card', { placeholder: options.placeholder });
  const composerMeta = el('slicc-composer-meta', { model: 'Preview', thinking: 'off' });
  composer.append(inputCard, composerMeta);
  return { composer, inputCard, composerMeta };
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
  const header = el('slicc-workbench-header');
  const tabs = el('slicc-tab-bar', { active: 'files' }) as HTMLElement & { tabs?: unknown };
  tabs.tabs = [
    { id: 'files', label: 'files', kind: 'tool' },
    { id: 'term', label: 'terminal', kind: 'tool' },
    { id: 'memory', label: 'memory', kind: 'tool' },
  ];
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

  body.append(filesSurface, termSurfaceHost, memorySurfaceHost);
  workbench.append(header, body);
  return { workbench, body, header, tree, termSurface, memoryHost, tabBar: tabs };
}

/** Dock clicks open/close the workbench and select the matching surface. */
function wireDockToWorkbench(
  dock: HTMLElement,
  shell: HTMLElement,
  body: HTMLElement,
  onSurfaceActivate?: (surfaceId: string) => void
): void {
  dock.addEventListener('slicc-dock-select', (event) => {
    const id = (event as CustomEvent<{ id: string }>).detail?.id;
    if (!id) return;
    const alreadyActive = shell.hasAttribute('open') && body.getAttribute('active') === id;
    if (alreadyActive) {
      shell.removeAttribute('open');
      dock.removeAttribute('active');
      return;
    }
    shell.setAttribute('open', '');
    body.setAttribute('active', id);
    dock.setAttribute('active', id);
    onSurfaceActivate?.(id);
  });
}

/** Tab selection switches the active workbench surface. */
function wireTabsToBody(
  header: HTMLElement,
  body: HTMLElement,
  onSurfaceActivate?: (surfaceId: string) => void
): void {
  header.addEventListener('tab-select', (event) => {
    const tabId = (event as CustomEvent<{ tabId: string }>).detail?.tabId;
    if (!tabId) return;
    body.setAttribute('active', tabId);
    onSurfaceActivate?.(tabId);
  });
}

/** Build the full WC app frame into `root` and return the wiring refs. */
export function mountWcShell(root: HTMLElement, options: WcShellOptions): WcShellRefs {
  ensureGlobalTokens(document);
  ensureShellStyles(document);

  const frame = el('div', { class: 'wcui-frame' });
  const shader = el('slicc-shader', { mode: 'cone', tint: 'var(--waffle)', class: 'wcui-shader' });

  const freezer = el('slicc-freezer');
  freezer.append(el('slicc-freezer-new'));

  const appCol = el('div', { class: 'wcui-appcol' });
  const shell = el('slicc-shell');
  const pane = el('slicc-chatpane');
  const thread = el('slicc-chat-thread', { context: 'cone', accent: 'var(--waffle)' });
  thread.append(...buildThreadChildren(options.messages));
  const { composer, inputCard, composerMeta } = buildComposer(options);
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

  const { nav, switcher, floatbar } = buildNav(options);
  appCol.append(nav, shell);
  frame.append(shader, freezer, appCol);
  root.replaceChildren(frame);

  return {
    frame,
    thread,
    inputCard,
    composerMeta,
    switcher,
    floatbar,
    shell,
    workbenchBody: body,
    dock,
    freezer,
    fileTree: tree,
    termSurface,
    memoryHost,
    tabBar,
  };
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
  });

  refs.fileTree.items = [
    { kind: 'group', label: 'workspace/' },
    { kind: 'file', id: '/workspace/CLAUDE.md', label: 'CLAUDE.md' },
    { kind: 'group', label: 'shared/' },
    { kind: 'file', id: '/shared/CLAUDE.md', label: 'CLAUDE.md' },
  ];

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
