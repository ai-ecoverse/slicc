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

import '../styles/fonts.css';
import { createLogger } from '../../base/logger.js';
import { createChatFixture, FIXTURE_SCOOP_NAME } from '../chat-fixture.js';
import type { ChatMessage } from '../types.js';
import { buildTrustedLayers, TRUSTED_LAYER_CSS } from './trusted-layer.js';
import { buildThreadChildren, messageEls } from './wc-message-view.js';
import { wireShellKeyboard } from './wc-shortcut-surfaces.js';
import type { ShortcutHandles } from './wc-shortcuts.js';
import { wireBase64Previews } from './wire-base64-previews.js';
import { wireMentionPreviews } from './wire-mention-previews.js';

import '@slicc/webcomponents';

export const FREEZER_TINT = '#3b6cb2';

export interface SwitcherScoop {
  key: string;
  type: 'cone' | 'scoop';
  color: string;
  label: string;
  eyes: 'open' | 'dead' | 'none';
  state?: 'working' | 'broken' | 'initializing' | 'idle';
  ephemeral?: boolean;

  fill?: number;

  phase?: 'thinking' | 'tool';

  awaiting?: boolean;
}

export interface WcShellOptions {
  messages: readonly ChatMessage[];

  scoops: readonly SwitcherScoop[];

  floatLabel: string;

  placeholder: string;

  urlState?: boolean;
}

export interface WcShellRefs {
  frame: HTMLElement;

  panelHost: HTMLElement;

  trustedLayer: HTMLElement;

  shader: HTMLElement;

  chatPane: HTMLElement;
  thread: HTMLElement;

  composer: HTMLElement;
  inputCard: HTMLElement;
  composerMeta: HTMLElement;

  queuedStack: SliccQueuedStack;

  lickBackpressureNotice: HTMLElement;
  switcher: SliccAgentTabs;
  floatbar: HTMLElement;
  shell: HTMLElement;

  dockTree: SliccDockTree;
  dock: HTMLElement;
  freezer: HTMLElement;
  fileTree: SliccFileTree;
  termSurface: HTMLElement;
  memoryHost: SliccMemoryPanel;
  monitor: SliccMonitor;
  avatarMenu: SliccAvatarMenu;

  shortcuts: ShortcutHandles;

  overlaySurfaces: Set<string>;
}

const STYLE_ID = 'slicc-wcui-style';
const CSS = [
  'html,body{margin:0;padding:0;height:100%;overscroll-behavior:none;}',
  '.wcui-frame{position:relative;transform:translateZ(0);width:100%;height:100vh;',
  'overflow:hidden;background:var(--bg);font-family:var(--ui);}',
  '.wcui-shader{position:absolute;inset:0;z-index:0;}',

  '.wcui-frame slicc-chatpane{position:relative;background:transparent;}',
  '.wcui-appcol{position:relative;z-index:1;height:100%;display:flex;flex-direction:column;',
  'box-sizing:border-box;padding-left:var(--rail-w,44px);',
  'transition:padding-left .4s cubic-bezier(.4,0,.2,1);}',
  '@media (max-width:560px){.wcui-appcol{padding-left:44px;}}',

  '.wcui-term{flex:1;min-height:0;display:flex;flex-direction:column;padding:8px 4px 8px 10px;',
  'box-sizing:border-box;background:var(--term-bg,#0c0c0e);}',
  '.wcui-term .terminal-panel__terminal-host{flex:1 1 auto;min-height:0;}',
  '.wcui-term .terminal-panel__terminal-host slicc-terminal{display:block;border-radius:0;}',
  '.wcui-term .terminal-panel__preview{flex:0 0 auto;}',
  '.wcui-term .terminal-panel__preview-label{color:var(--term-fg,#e7e7ea);font:11px var(--ui,ui-sans-serif,system-ui,sans-serif);padding:4px 0;}',

  '.wcui-frame slicc-file-tree{width:100%;border-right:none;}',
  '.wcui-memory{flex:1;min-height:0;overflow:hidden;}',
  '.wcui-monitor{flex:1;min-height:0;}',
  '.wcui-placeholder{flex:1;display:flex;align-items:center;justify-content:center;',
  'padding:24px;color:var(--txt-2);font-size:13px;text-align:center;}',
  '.wcui-backpressure{align-self:flex-end;max-width:80%;box-sizing:border-box;',
  'padding:8px 12px;border:1px solid var(--line);border-radius:14px;',
  'background:var(--canvas);color:var(--txt-2);font-size:12px;line-height:1.4;}',
  '.wcui-backpressure[hidden]{display:none;}',

  TRUSTED_LAYER_CSS,
].join('');

function ensureShellStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
}

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

function wireDockToWorkbench(dock: HTMLElement, overlaySurfaces: ReadonlySet<string>): void {
  dock.addEventListener('slicc-dock-select', (event) => {
    const id = (event as CustomEvent<{ id: string }>).detail?.id;

    if (!id || !overlaySurfaces.has(id)) return;
  });
}

function wireDockExternalDragToTree(dock: HTMLElement, dockTree: WcShellRefs['dockTree']): void {
  dock.addEventListener('pointerdown', (event) => {
    const target = event.target as HTMLElement | null;
    const item = target?.closest?.('slicc-dock-item');
    const id = item?.getAttribute('item-id');
    if (!id?.startsWith('sprinkle:') || !dockTree.tilesMovable) return;
    dockTree.beginExternalDrag(id, (event as PointerEvent).pointerId);
  });
}

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

  const chatSurface = el('slicc-surface', { 'surface-id': 'chat', layout: 'flex' });
  chatSurface.append(pane);
  dockTree.append(chatSurface);
  const dockTreeApi = dockTree as unknown as {
    setPinned(ids: string[]): void;
    placeSurface(surfaceId: string, zone: string): void;
  };
  dockTreeApi.setPinned(['chat']);

  dockTreeApi.placeSurface('chat', 'left');
  const dock = el('slicc-dock', { 'system-tools': '' });

  shell.append(dockTree, dock);
  const overlaySurfaces = new Set<string>();
  wireDockToWorkbench(dock, overlaySurfaces);
  wireDockExternalDragToTree(dock, dockTree);

  freezer.addEventListener('freezer-toggle', (event) => {
    const open = (event as CustomEvent<{ open?: boolean }>).detail?.open === true;
    appCol.style.setProperty('--rail-w', open ? '260px' : '44px');
  });

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

  const { panelHost, trustedLayer } = buildTrustedLayers(document);
  panelHost.append(shader, freezer, appCol);
  frame.append(panelHost, trustedLayer);
  root.replaceChildren(frame);

  wireBase64Previews({ thread, log: createLogger('base64-preview') });

  wireMentionPreviews({
    thread,
    isReadOnly: () => composer.hasAttribute('hidden'),
    log: createLogger('mention-preview'),
  });

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

export type ShellContext =
  | { kind: 'cone' }
  | { kind: 'scoop'; accent: string }
  | { kind: 'freezer' };

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

export function applyComposerAvailability(refs: WcShellRefs, readOnly: boolean): void {
  refs.composer.toggleAttribute('hidden', readOnly);
  if (readOnly) refs.inputCard.setAttribute('disabled', '');
}

export function submittedText(event: Event): string | undefined {
  return (event as Event & { detail?: { value?: string } }).detail?.value;
}

export function submittedSteer(event: Event): boolean {
  return (event as Event & { detail?: { steer?: boolean } }).detail?.steer === true;
}

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
