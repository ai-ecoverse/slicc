import type { Meta, StoryObj } from '@storybook/web-components-vite';
import '../chat/slicc-chat-thread.js';
import '../chat/slicc-user-message.js';
import '../composer/slicc-composer.js';
import '../composer/slicc-input-card.js';
import '../dock/slicc-dock.js';
import '../workbench/slicc-dock-tree.js';
import '../workbench/slicc-surface.js';
import type { DockTreeSpec, SliccDockTree } from '../workbench/slicc-dock-tree.js';
import './slicc-chatpane.js';
import type { SliccShell } from './slicc-shell.js';
import './slicc-shell.js';

/**
 * DEMO story for the layouts prototype. Drives the REAL `<slicc-dock-tree>` —
 * the sole layout system — through the webapp's named presets
 * (`packages/webapp/src/ui/wc/layout-spec.ts`, mirrored here since
 * webcomponents can't import webapp) so the direction can be seen end-to-end.
 * Not a production surface.
 */

const CHAT_LEAF = { type: 'leaf' as const, surfaceId: 'chat' };

// Mirror of packages/webapp/src/ui/wc/layout-spec.ts's LAYOUT_PRESETS.
const PRESETS: Record<string, DockTreeSpec> = {
  focus: {
    zones: { top: null, left: CHAT_LEAF, middle: null, right: null, bottom: null },
    rowFr: { top: 1, center: 1, bottom: 1 },
    colFr: { left: 3, middle: 1, right: 1 },
  },
  split: {
    zones: {
      top: null,
      left: CHAT_LEAF,
      middle: { type: 'leaf', surfaceId: 'sprinkle:metrics' },
      right: null,
      bottom: null,
    },
    rowFr: { top: 1, center: 1, bottom: 1 },
    colFr: { left: 1, middle: 1, right: 1 },
  },
  dashboard: {
    zones: {
      top: null,
      left: CHAT_LEAF,
      middle: {
        type: 'split',
        dir: 'row',
        children: [
          { type: 'leaf', surfaceId: 'sprinkle:metrics' },
          { type: 'leaf', surfaceId: 'sprinkle:form' },
        ],
        sizes: [1, 1],
      },
      right: null,
      bottom: null,
    },
    rowFr: { top: 1, center: 1, bottom: 1 },
    colFr: { left: 1, middle: 3, right: 1 },
  },
  dev: {
    zones: {
      top: null,
      left: CHAT_LEAF,
      middle: { type: 'leaf', surfaceId: 'sprinkle:chart' },
      right: null,
      bottom: {
        type: 'split',
        dir: 'row',
        children: [
          { type: 'leaf', surfaceId: 'sprinkle:logs' },
          { type: 'leaf', surfaceId: 'sprinkle:form' },
        ],
        sizes: [1, 1],
      },
    },
    rowFr: { top: 1, center: 3, bottom: 1 },
    colFr: { left: 1, middle: 2, right: 1 },
  },
  stage: {
    zones: {
      top: null,
      left: null,
      middle: { type: 'leaf', surfaceId: 'sprinkle:metrics' },
      right: CHAT_LEAF,
      bottom: null,
    },
    rowFr: { top: 1, center: 1, bottom: 1 },
    colFr: { left: 1, middle: 3, right: 1 },
  },
};

const SPRINKLES = [
  { id: 'sprinkle:metrics', label: 'Metrics', bg: '#eef2ff', ink: '#4338ca' },
  { id: 'sprinkle:form', label: 'Form', bg: '#ecfdf5', ink: '#047857' },
  { id: 'sprinkle:logs', label: 'Logs', bg: '#fef2f2', ink: '#b91c1c' },
  { id: 'sprinkle:chart', label: 'Chart', bg: '#fffbeb', ink: '#b45309' },
];

function fakeSurface(id: string, label: string, bg: string, ink: string): HTMLElement {
  const surface = document.createElement('slicc-surface');
  surface.setAttribute('surface-id', id);
  surface.setAttribute('layout', 'flex');
  const panel = document.createElement('div');
  panel.style.cssText = `flex:1;display:flex;align-items:center;justify-content:center;font-family:var(--ui);font-size:22px;font-weight:600;background:${bg};color:${ink};border-radius:10px;`;
  panel.textContent = label;
  surface.append(panel);
  return surface;
}

function demo(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:10px;';

  // Preset toolbar.
  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;font-family:var(--ui);';

  const frame = document.createElement('div');
  frame.style.cssText =
    'display:flex;flex-direction:column;height:600px;width:1100px;border:1px solid var(--line);border-radius:14px;overflow:hidden;background:var(--bg);';

  const shell = document.createElement('slicc-shell') as SliccShell;
  const dockTree = document.createElement('slicc-dock-tree') as SliccDockTree;

  // Chat is a pinned dock-tree leaf, exactly like the live shell.
  const chatSurface = document.createElement('slicc-surface');
  chatSurface.setAttribute('surface-id', 'chat');
  chatSurface.setAttribute('layout', 'flex');
  const pane = document.createElement('slicc-chatpane');
  const thread = document.createElement('slicc-chat-thread');
  const u = document.createElement('slicc-user-message');
  u.textContent = 'Show me the metrics and the form side by side.';
  thread.append(u);
  const composer = document.createElement('slicc-composer');
  const card = document.createElement('slicc-input-card');
  composer.append(card);
  pane.append(thread, composer);
  chatSurface.append(pane);
  dockTree.append(chatSurface);
  dockTree.setPinned(['chat']);

  for (const s of SPRINKLES) dockTree.append(fakeSurface(s.id, s.label, s.bg, s.ink));

  const dock = document.createElement('slicc-dock');
  shell.append(dockTree, dock);
  frame.appendChild(shell);

  for (const name of Object.keys(PRESETS)) {
    const btn = document.createElement('button');
    btn.textContent = name;
    btn.style.cssText =
      'padding:6px 14px;border:1px solid var(--line);border-radius:8px;background:var(--canvas);color:var(--ink);cursor:pointer;text-transform:capitalize;font-family:var(--ui);';
    btn.addEventListener('click', () => dockTree.setTree(PRESETS[name]));
    bar.appendChild(btn);
  }

  wrap.append(bar, frame);
  // Default view: dashboard, so the multi-sprinkle split is visible immediately.
  queueMicrotask(() => dockTree.setTree(PRESETS.dashboard));
  return wrap;
}

const meta: Meta = {
  title: 'Shell/Layouts (prototype)',
  render: () => demo(),
};

export default meta;
type Story = StoryObj;

/** Click the buttons to switch presets: focus / split / dashboard / dev / stage. */
export const Prototype: Story = {};
