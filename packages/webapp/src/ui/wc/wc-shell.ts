/**
 * The `@slicc/webcomponents` application shell — the next-generation SLICC
 * UI, assembled exactly like the library's full-app showcase (and the
 * `proto/StellarRubySwift.html` prototype it was extracted from): a cone
 * shader background, the fixed freezer rail, and an app column stacking the
 * full-width nav above the chat | workbench split with the dock rail.
 *
 * Phase 0 of the migration: `mountWcUiPreview` renders the shell over the
 * design-time chat fixture (`?ui=wc`), standalone float only. Live
 * orchestrator wiring lands in the next phases; the composer currently
 * echoes submitted text into the thread locally so the input loop is
 * inspectable end to end.
 */

import { ensureGlobalTokens } from '@slicc/webcomponents/src/theme/tokens.js';
import { createChatFixture, FIXTURE_SCOOP_NAME } from '../chat-fixture.js';
import type { ChatMessage } from '../types.js';
import { buildThreadChildren, messageEls } from './wc-message-view.js';

// Side-effect imports register every element composed below. Per-component
// subpaths instead of the barrel — see wc-message-view.ts for the rationale
// (legacy `slicc-press-button` tag collision).
import '@slicc/webcomponents/src/chat/slicc-chat-thread.js';
import '@slicc/webcomponents/src/composer/slicc-composer.js';
import '@slicc/webcomponents/src/composer/slicc-composer-meta.js';
import '@slicc/webcomponents/src/composer/slicc-input-card.js';
import '@slicc/webcomponents/src/dock/slicc-dock.js';
import '@slicc/webcomponents/src/freezer/slicc-freezer.js';
import '@slicc/webcomponents/src/freezer/slicc-freezer-new.js';
import '@slicc/webcomponents/src/freezer/slicc-shader.js';
import '@slicc/webcomponents/src/nav/slicc-nav.js';
import '@slicc/webcomponents/src/primitives/slicc-avatar.js';
import '@slicc/webcomponents/src/primitives/slicc-floatbar.js';
import '@slicc/webcomponents/src/primitives/slicc-logo.js';
import '@slicc/webcomponents/src/shell/slicc-chatpane.js';
import '@slicc/webcomponents/src/shell/slicc-shell.js';
import '@slicc/webcomponents/src/switcher/slicc-scoop-switcher.js';
import '@slicc/webcomponents/src/theme/slicc-theme-toggle.js';
import '@slicc/webcomponents/src/workbench/slicc-file-tree.js';
import '@slicc/webcomponents/src/workbench/slicc-surface.js';
import '@slicc/webcomponents/src/workbench/slicc-tab-bar.js';
import '@slicc/webcomponents/src/workbench/slicc-workbench-body.js';
import '@slicc/webcomponents/src/workbench/slicc-workbench-header.js';
import '@slicc/webcomponents/src/workbench/slicc-workbench-pane.js';

/** Scoop chip descriptors consumed by `<slicc-scoop-switcher>`. */
interface SwitcherScoop {
  key: string;
  type: 'cone' | 'scoop';
  color: string;
  label: string;
  eyes: 'open' | 'dead' | 'none';
  ephemeral?: boolean;
}

interface WcShellOptions {
  /** Chat history rendered into the cone thread. */
  messages: readonly ChatMessage[];
  /** Scoop chips for the nav switcher (cone first). */
  scoops: readonly SwitcherScoop[];
  /** Floatbar status label (e.g. `standalone · preview`). */
  floatLabel: string;
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

function buildNav(options: WcShellOptions): HTMLElement {
  const nav = el('slicc-nav', { accent: 'var(--waffle)' });
  const switcher = el('slicc-scoop-switcher') as HTMLElement & {
    scoops?: readonly SwitcherScoop[];
  };
  switcher.scoops = options.scoops;
  const avatar = el('slicc-avatar', { name: 'SLICC Preview' });
  nav.append(
    el('slicc-logo', { badge: 'preview' }),
    switcher,
    el('slicc-floatbar', { label: options.floatLabel, spent: '0.00' }),
    el('slicc-theme-toggle'),
    avatar
  );
  return nav;
}

function buildComposer(): HTMLElement {
  const composer = el('slicc-composer');
  const card = el('slicc-input-card', {
    placeholder: 'Preview harness — submissions echo into the thread…',
  });
  const meta = el('slicc-composer-meta', { model: 'Preview', thinking: 'off' });
  composer.append(card, meta);
  return composer;
}

/** Append a locally-echoed user message when the input card submits. */
function wireComposerEcho(pane: HTMLElement, thread: HTMLElement): void {
  pane.addEventListener('submit', (event) => {
    // `<slicc-input-card>` dispatches a CustomEvent named `submit` (not the
    // native form SubmitEvent), so widen rather than convert.
    const detail = (event as Event & { detail?: { value?: string } }).detail;
    const text = detail?.value?.trim();
    if (!text) return;
    const echo: ChatMessage = {
      id: `wc-echo-${thread.childElementCount}`,
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };
    thread.append(...messageEls(echo));
  });
}

function buildChatpane(options: WcShellOptions): HTMLElement {
  const pane = el('slicc-chatpane');
  const thread = el('slicc-chat-thread', { context: 'cone', accent: 'var(--waffle)' });
  thread.append(...buildThreadChildren(options.messages));
  pane.append(thread, buildComposer());
  wireComposerEcho(pane, thread);
  return pane;
}

function buildWorkbench(): HTMLElement {
  const workbench = el('slicc-workbench-pane');
  const header = el('slicc-workbench-header');
  const tabs = el('slicc-tab-bar', { active: 'files' }) as HTMLElement & { tabs?: unknown };
  tabs.tabs = [{ id: 'files', label: 'files', kind: 'tool' }];
  header.append(tabs);

  const body = el('slicc-workbench-body', { active: 'files' });
  const filesSurface = el('slicc-surface', { 'surface-id': 'files', layout: 'flex', active: '' });
  const tree = el('slicc-file-tree') as HTMLElement & { items?: unknown };
  tree.items = [
    { kind: 'group', id: 'workspace', label: 'workspace/' },
    { kind: 'file', id: 'claude-md', label: 'CLAUDE.md' },
    { kind: 'group', id: 'shared', label: 'shared/' },
    { kind: 'file', id: 'shared-claude-md', label: 'CLAUDE.md' },
  ];
  filesSurface.append(tree);
  body.append(filesSurface);
  workbench.append(header, body);
  return workbench;
}

/** Dock clicks open/close the workbench and select the matching surface. */
function wireDockToWorkbench(dock: HTMLElement, shell: HTMLElement, body: HTMLElement): void {
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
  });
}

/** Tab selection switches the active workbench surface. */
function wireTabsToBody(header: HTMLElement, body: HTMLElement): void {
  header.addEventListener('tab-select', (event) => {
    const tabId = (event as CustomEvent<{ tabId: string }>).detail?.tabId;
    if (tabId) body.setAttribute('active', tabId);
  });
}

/** Build the full WC app frame; `mountWcUiPreview` is the boot entry. */
function buildWcShell(options: WcShellOptions): HTMLElement {
  ensureShellStyles(document);

  const frame = el('div', { class: 'wcui-frame' });
  const shader = el('slicc-shader', { mode: 'cone', tint: 'var(--waffle)', class: 'wcui-shader' });

  const freezer = el('slicc-freezer');
  freezer.append(el('slicc-freezer-new'));

  const appCol = el('div', { class: 'wcui-appcol' });
  const shell = el('slicc-shell');
  const chatpane = buildChatpane(options);
  const workbench = buildWorkbench();
  const dock = el('slicc-dock', { 'system-tools': '' });
  shell.append(chatpane, workbench, dock);

  const body = workbench.querySelector<HTMLElement>('slicc-workbench-body');
  const header = workbench.querySelector<HTMLElement>('slicc-workbench-header');
  if (body && header) {
    wireDockToWorkbench(dock, shell, body);
    wireTabsToBody(header, body);
  }

  appCol.append(buildNav(options), shell);
  frame.append(shader, freezer, appCol);
  return frame;
}

/** Mount the Phase-0 preview: the WC shell over the design-time chat fixture. */
export function mountWcUiPreview(root: HTMLElement): void {
  ensureGlobalTokens(document);
  const frame = buildWcShell({
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
  });
  root.replaceChildren(frame);
}
