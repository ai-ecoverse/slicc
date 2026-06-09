import type { Meta, StoryObj } from '@storybook/web-components-vite';
// Full-app showcase — compose the whole SLICC surface from its web components.
// Import every element used so it is registered when the story renders.
import '../chat/slicc-action-card.js';
import '../chat/slicc-action-row.js';
import '../chat/slicc-agent-message.js';
import '../chat/slicc-chat-thread.js';
import '../chat/slicc-delegation-line.js';
import '../chat/slicc-dip.js';
import '../chat/slicc-lick-card.js';
import '../chat/slicc-user-message.js';
import '../composer/slicc-composer.js';
import '../composer/slicc-composer-meta.js';
import '../composer/slicc-input-card.js';
import '../dock/slicc-dock.js';
import '../freezer/slicc-freezer-card.js';
import '../freezer/slicc-freezer-new.js';
import '../freezer/slicc-freezer.js';
import '../nav/slicc-nav.js';
import '../primitives/slicc-avatar.js';
import '../primitives/slicc-day-separator.js';
import '../primitives/slicc-floatbar.js';
import '../primitives/slicc-logo.js';
import '../shell/slicc-chatpane.js';
import '../shell/slicc-shell.js';
import '../switcher/slicc-scoop-switcher.js';
import '../workbench/slicc-file-tree.js';
import '../workbench/slicc-surface.js';
import '../workbench/slicc-tab-bar.js';
import '../workbench/slicc-terminal.js';
import '../workbench/slicc-workbench-body.js';
import '../workbench/slicc-workbench-header.js';
import '../workbench/slicc-workbench-pane.js';

const SCOOPS = [
  { key: 'cone', type: 'cone' as const, color: '#b07823', label: 'Sliccy', eyes: 'open' as const },
  {
    key: 'researcher',
    type: 'scoop' as const,
    color: '#06b6d4',
    label: 'researcher',
    eyes: 'open' as const,
  },
  {
    key: 'designer',
    type: 'scoop' as const,
    color: '#8b5cf6',
    label: 'designer',
    eyes: 'open' as const,
  },
  {
    key: 'tester',
    type: 'scoop' as const,
    color: '#f59e0b',
    label: 'tester',
    eyes: 'dead' as const,
  },
];

const FROZEN = [
  { title: 'warm hero redesign', meta: '2h ago · 18 turns · PR #128', slug: 'hero' },
  { title: 'freezer frost shader', meta: 'yesterday · 9 turns', slug: 'frost' },
  { title: 'extension CSP fix', meta: '2d ago · 31 turns · PR #119', slug: 'csp' },
  { title: 'palette token audit', meta: '3d ago · 12 turns', slug: 'palette' },
];

function el<T extends HTMLElement>(
  tag: string,
  attrs: Record<string, string> = {},
  html?: string
): T {
  const n = document.createElement(tag) as T;
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (html != null) n.innerHTML = html;
  return n;
}

/** A populated chat thread — a realistic multi-turn conversation. */
function thread(): HTMLElement {
  const t = el('slicc-chat-thread', { context: 'cone', accent: 'var(--waffle)' });
  const u1 = el('slicc-user-message');
  u1.textContent = 'Extract the prototype UI into a web-component library.';
  const a1 = el(
    'slicc-agent-message',
    {},
    '<p>On it — scaffolding <strong>@slicc/webcomponents</strong> and lifting each element.</p>' +
      '<ul class="plan"><li>tokens + theme</li><li>primitives</li><li>chat + shell</li></ul>'
  );
  const d1 = el('slicc-delegation-line', { kind: 'feed', scoop: 'researcher', verb: 'feed_scoop' });
  const row = el('slicc-action-row', {
    icon: 'pencil',
    label: 'edit_file slicc-pill.ts',
    result: '+42 −7',
    open: '',
  });
  row.innerHTML =
    '<div slot="body"><span class="add">+ shadow glyph builder</span>\n<span class="del">- legacy chrome</span></div>';
  const card = el('slicc-action-card', { variant: 'pr' });
  card.setAttribute('title', 'feat(webcomponents): extract prototype');
  const lick = el('slicc-lick-card', { kind: 'webhook' });
  lick.innerHTML = '<b>support@</b> inbound — “the freezer rail is gorgeous”';
  const u2 = el('slicc-user-message');
  u2.textContent = 'Wire up real icons and a gravatar avatar.';
  const a2 = el(
    'slicc-agent-message',
    {},
    '<p>Done — all icons are lucide now, and the avatar resolves your gravatar.</p>'
  );
  const dip = el('slicc-dip', { name: 'palette.shtml', hue: '#8b5cf6' });
  t.append(el('slicc-day-separator', { label: 'Today' }), u1, a1, d1, row, card, lick, u2, a2, dip);
  return t;
}

/** The left chat column: nav header + thread + composer. */
function chatpane(narrow: boolean): HTMLElement {
  const pane = el('slicc-chatpane', narrow ? { narrow: '' } : {});

  const nav = el('slicc-nav', { accent: 'var(--waffle)' });
  const logo = el('slicc-logo', { badge: 'studio' });
  const switcher = el('slicc-scoop-switcher') as HTMLElement & { scoops?: unknown };
  (switcher as { scoops?: unknown }).scoops = SCOOPS;
  const floatbar = el('slicc-floatbar', {
    label: 'CLI · tray · 1 follower',
    spent: '2.41',
    online: '',
  });
  const toggle = el('slicc-theme-toggle');
  const avatar = el('slicc-avatar', { email: 'beau@dodds.net', name: 'Lars Trieloff' });
  nav.append(logo, switcher, floatbar, toggle, avatar);

  const composer = el('slicc-composer', narrow ? { open: '' } : {});
  const card = el('slicc-input-card');
  card.setAttribute('placeholder', 'Ask sliccy, or describe a change…');
  const meta = el('slicc-composer-meta', {
    model: 'Opus 4.8',
    thinking: 'bombastica',
    ...(narrow ? { narrow: '' } : {}),
  });
  composer.append(card, meta);

  pane.append(nav, thread(), composer);
  return pane;
}

/** The right workbench: tab bar + a file-tree / terminal surface. */
function workbench(open: boolean): HTMLElement {
  const wb = el('slicc-workbench-pane', open ? { open: '' } : {});
  const header = el('slicc-workbench-header');
  const tabs = el('slicc-tab-bar') as HTMLElement & { tabs?: unknown };
  (tabs as { tabs?: unknown }).tabs = [
    { id: 'files', label: 'files', kind: 'tool' },
    { id: 'term', label: 'terminal', kind: 'tool' },
    { id: 'hero', label: 'Hero studio', kind: 'sprinkle', closable: true },
  ];
  (tabs as { active?: string }).active = 'term';
  header.append(tabs);

  const body = el('slicc-workbench-body', { active: 'term' });
  const fileSurface = el('slicc-surface', { 'surface-id': 'files', layout: 'flex' });
  const tree = el('slicc-file-tree') as HTMLElement & { items?: unknown };
  (tree as { items?: unknown }).items = [
    { kind: 'group', id: 'g1', label: 'workspace/' },
    { kind: 'file', id: 'hero.tsx', label: 'hero.tsx' },
    { kind: 'file', id: 'app.ts', label: 'app.ts' },
    { kind: 'group', id: 'g2', label: 'skills/' },
    { kind: 'file', id: 'sprinkles.md', label: 'sprinkles/SKILL.md' },
  ];
  (tree as { selected?: string }).selected = 'hero.tsx';
  fileSurface.append(tree);

  const termSurface = el('slicc-surface', { 'surface-id': 'term', layout: 'flex', active: '' });
  const term = el('slicc-terminal') as HTMLElement & { writeln?: (s: string) => void };
  // Pre-populate after connect (xterm needs to be in the DOM first).
  queueMicrotask(() => {
    const t = term as { writeln?: (s: string) => void };
    t.writeln?.('\x1b[2m$\x1b[0m npm run test -w @slicc/webcomponents');
    t.writeln?.('\x1b[32m ✓\x1b[0m  Test Files  55 passed (55)');
    t.writeln?.('\x1b[32m ✓\x1b[0m       Tests  1016 passed (1016)');
  });
  termSurface.append(term);

  body.append(fileSurface, termSurface);
  wb.append(header, body);
  return wb;
}

/** The full app: a freezer rail beside the split shell. */
function app(open: boolean): HTMLElement {
  const frame = el('div');
  frame.style.cssText =
    'display:flex;height:680px;width:1180px;background:var(--bg);border:1px solid var(--line);border-radius:14px;overflow:hidden;font-family:var(--ui);';

  // Freezer rail stays open (260px) so the frozen-session text is reviewable;
  // its [open] CSS expands the cards/new-chat label.
  const freezer = el('slicc-freezer', { open: '' });
  freezer.append(el('slicc-freezer-new', { expanded: '' }));
  for (const f of FROZEN) {
    freezer.append(el('slicc-freezer-card', { title: f.title, meta: f.meta, slug: f.slug }));
  }

  const shell = el('slicc-shell', open ? { open: '' } : {});
  shell.append(chatpane(open), workbench(open), el('slicc-dock'));

  frame.append(freezer, shell);
  return frame;
}

const meta: Meta = {
  title: 'Showcase/Full App',
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
};
export default meta;
type Story = StoryObj;

/** The collapsed app: chat full-width, workbench closed, freezer rail open. */
export const Collapsed: Story = { render: () => app(false) };

/** The open app: workbench expanded (file tree + live terminal), chat narrowed. */
export const Open: Story = { render: () => app(true) };
