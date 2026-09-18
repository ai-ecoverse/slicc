import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { h } from '../internal/dom.js';

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
import '../freezer/slicc-shader.js';
import '../nav/slicc-avatar-menu.js';
import '../nav/slicc-nav.js';
import '../overlay/slicc-dialog.js';
import '../primitives/slicc-avatar.js';
import '../primitives/slicc-day-separator.js';
import '../primitives/slicc-floatbar.js';
import '../shell/slicc-chatpane.js';
import '../shell/slicc-shell.js';
import '../switcher/slicc-agent-tabs.js';
import '../workbench/slicc-dock-tree.js';
import '../workbench/slicc-file-tree.js';
import '../workbench/slicc-surface.js';
import '../workbench/slicc-terminal.js';
import type { SliccDockTree } from '../workbench/slicc-dock-tree.js';

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
  {
    key: 'triage',
    type: 'scoop' as const,
    color: '#10b981',
    label: 'triage',
    eyes: 'none' as const,
    ephemeral: true,
  },
];

const FROZEN = [
  { title: 'warm hero redesign', meta: '2h ago · 18 turns · PR #128', slug: 'hero' },
  { title: 'freezer frost shader', meta: 'yesterday · 9 turns', slug: 'frost' },
  { title: 'extension CSP fix', meta: '2d ago · 31 turns · PR #119', slug: 'csp' },
  { title: 'palette token audit', meta: '3d ago · 12 turns', slug: 'palette' },
];

const FREEZER_TINT = '#3b6cb2';

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
    icon: '✎',
    label: 'edit slicc-pill.ts',
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

function scoopThread(key: string, color: string, label: string): HTMLElement {
  const t = el('slicc-chat-thread', { context: `scoop:${key}`, accent: color, 'data-scoop': key });
  const a = el('slicc-agent-message');
  a.append(
    h(
      'p',
      null,
      `Isolated ${label} scoop — its own sandboxed VFS and conversation. Switch back to sliccy · cone to see the orchestration.`
    )
  );
  t.append(el('slicc-day-separator', { label: `${label} scoop` }), a);
  return t;
}

function frozenThread(slug: string, title: string, metaLine: string): HTMLElement {
  const t = el('slicc-chat-thread', {
    context: `freezer:${slug}`,
    accent: FREEZER_TINT,
    'data-frozen': slug,
  });
  const a = el('slicc-agent-message');
  a.append(
    h(
      'p',
      null,
      `Thawed: ${title}. This past session is parked in the freezer — its chat history would resume here.`
    )
  );
  t.append(el('slicc-day-separator', { label: metaLine }), a);
  return t;
}

function topnav(): HTMLElement {
  const nav = el('slicc-nav', { accent: 'var(--waffle)' });

  const switcher = el('slicc-agent-tabs') as HTMLElement & {
    scoops?: unknown;
  };
  (switcher as { scoops?: unknown }).scoops = SCOOPS;

  switcher.setAttribute('attention', 'cone');
  const floatbar = el('slicc-floatbar', {
    label: 'CLI · tray · 1 follower',
    spent: '2.41',
    online: '',
  });
  const toggle = el('slicc-theme-toggle');
  const avatar = el('slicc-avatar', { email: 'beau@dodds.net', name: 'Lars Trieloff' });

  const menu = el('slicc-avatar-menu') as HTMLElement & { user?: unknown; items?: unknown };
  menu.append(avatar);
  (menu as { user?: unknown }).user = { name: 'Lars Trieloff', provider: 'Anthropic' };
  (menu as { items?: unknown }).items = [
    { id: 'sync', label: 'Enable multi-browser sync', icon: 'radio' },
    { kind: 'separator' },
    { id: 'new-session', label: 'New session', icon: 'plus' },
    { id: 'settings', label: 'Account settings…', icon: 'settings' },
    { kind: 'separator' },
    { id: 'signout', label: 'Sign out', icon: 'log-out', danger: true },
  ];
  nav.append(switcher, floatbar, toggle, menu);
  return nav;
}

function dialogField(label: string, value: string, mono = false): HTMLElement {
  const wrap = el('label');
  wrap.style.cssText = 'display:block;margin-bottom:14px;';
  const lb = el('div');
  lb.textContent = label;
  lb.style.cssText = 'font-size:12px;color:var(--txt-2);margin-bottom:6px;';
  const input = el('input') as HTMLInputElement;
  input.value = value;
  input.style.cssText =
    'width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--line);' +
    `border-radius:9px;background:var(--ghost);color:var(--ink);font:inherit;${
      mono ? 'font-family:ui-monospace,monospace;' : ''
    }outline:none;`;
  wrap.append(lb, input);
  return wrap;
}

function settingsDialog(): HTMLElement {
  const dialog = el('slicc-dialog', {
    heading: 'Account settings',
    description: 'Connect an LLM provider with an API key or OAuth login.',
  });
  const save = el('button');
  save.textContent = 'Save';
  save.setAttribute('slot', 'footer');
  save.style.cssText =
    'padding:9px 16px;border:none;border-radius:9999px;background:var(--accent,#3b63fb);color:#fff;font:inherit;font-weight:600;cursor:pointer;';
  dialog.append(
    dialogField('Provider', 'Anthropic'),
    dialogField('API key', 'sk-ant-••••••••••••••••', true),
    save
  );
  return dialog;
}

function chatpane(narrow: boolean): HTMLElement {
  const pane = el('slicc-chatpane', narrow ? { narrow: '' } : {});

  const composer = el('slicc-composer', narrow ? { open: '' } : {});
  const card = el('slicc-input-card');
  card.setAttribute('placeholder', 'Ask sliccy, or describe a change…');
  const meta = el('slicc-composer-meta', {
    model: 'Opus 4.8',
    thinking: 'max',
    ...(narrow ? { narrow: '' } : {}),
  }) as HTMLElement & { models?: unknown };

  (meta as { models?: unknown }).models = [
    { name: 'Opus 4.8', provider: 'Anthropic', id: 'claude-opus-4-8' },
    { name: 'Sonnet 4.6', provider: 'Anthropic', id: 'claude-sonnet-4-6' },
    { name: 'Haiku 4.5', provider: 'Anthropic', id: 'claude-haiku-4-5' },
    { name: 'GPT-5', provider: 'OpenAI', id: 'gpt-5' },
    { name: 'GPT-5 mini', provider: 'OpenAI', id: 'gpt-5-mini' },
    { name: 'o4', provider: 'OpenAI', id: 'o4' },
    { name: 'Gemini 2.5 Pro', provider: 'Google', id: 'gemini-2.5-pro' },
    { name: 'Gemini 2.5 Flash', provider: 'Google', id: 'gemini-2.5-flash' },
    { name: 'Firefly Image 4', provider: 'Adobe', id: 'firefly-image-4' },
  ];
  composer.append(card, meta);

  pane.append(thread(), composer);
  return pane;
}

function workbenchTree(open: boolean): SliccDockTree {
  const dockTree = el('slicc-dock-tree') as SliccDockTree;

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

  const termSurface = el('slicc-surface', { 'surface-id': 'term', layout: 'flex' });
  const term = el('slicc-terminal') as HTMLElement & { writeln?: (s: string) => void };

  queueMicrotask(() => {
    const t = term as { writeln?: (s: string) => void };
    t.writeln?.('\x1b[2m$\x1b[0m npm run test -w @slicc/webcomponents');
    t.writeln?.('\x1b[32m ✓\x1b[0m  Test Files  55 passed (55)');
    t.writeln?.('\x1b[32m ✓\x1b[0m       Tests  1016 passed (1016)');
  });
  termSurface.append(term);

  dockTree.append(fileSurface, termSurface);
  if (open) {
    queueMicrotask(() => {
      dockTree.placeSurface('term', 'right');
    });
  }
  return dockTree;
}

type AppPreview = { kind: 'scoop'; key: string } | { kind: 'freezer'; slug: string };

interface AppOpts {
  workbench: boolean;

  freezer: boolean;

  preview?: AppPreview;
}

function buildShell(workbenchOpen: boolean): { shell: HTMLElement; pane: HTMLElement } {
  const shell = el('slicc-shell');
  const pane = chatpane(workbenchOpen);
  pane.style.background = 'transparent';
  const dockTree = workbenchTree(workbenchOpen);

  const chatSurface = el('slicc-surface', { 'surface-id': 'chat', layout: 'flex' });
  chatSurface.append(pane);
  dockTree.append(chatSurface);
  dockTree.setPinned(['chat']);
  dockTree.placeSurface('chat', 'left');

  const dock = el('slicc-dock', {
    'system-tools': '',
    active: workbenchOpen ? 'term' : '',
  }) as HTMLElement & { items?: unknown };
  (dock as { items?: unknown }).items = [
    { id: 'hero', icon: 'sparkles', label: 'Hero studio', kind: 'sprinkle', hue: 'var(--violet)' },
    { id: 'palette', icon: 'palette', label: 'palette', kind: 'sprinkle', hue: 'var(--cyan)' },
  ];
  shell.append(dockTree, dock);
  return { shell, pane };
}

function app(opts: AppOpts): HTMLElement {
  const railW = opts.freezer ? 260 : 44;

  const frame = el('div');

  frame.style.cssText =
    'position:relative;transform:translateZ(0);width:100%;height:100vh;overflow:hidden;' +
    'background:var(--bg);font-family:var(--ui);';

  const shader = el('slicc-shader', { mode: 'cone' });
  shader.style.cssText = 'position:absolute;inset:0;z-index:0;';
  frame.append(shader);

  const freezer = el('slicc-freezer', opts.freezer ? { open: '' } : {});
  freezer.style.zIndex = '6';
  freezer.append(el('slicc-freezer-new', opts.freezer ? { expanded: '' } : {}));
  for (const f of FROZEN) {
    freezer.append(el('slicc-freezer-card', { title: f.title, meta: f.meta, slug: f.slug }));
  }
  frame.append(freezer);

  const appCol = el('div');
  appCol.className = 'sc-appcol';
  appCol.style.cssText =
    `position:relative;z-index:1;height:100%;display:flex;flex-direction:column;` +
    `box-sizing:border-box;--rail-w:${railW}px;`;

  const responsive = el('style');
  responsive.textContent =
    '.sc-appcol{padding-left:var(--rail-w,44px);transition:padding-left .4s cubic-bezier(.4,0,.2,1);}' +
    '@media (max-width:560px){.sc-appcol{padding-left:44px;}}';
  frame.append(responsive);

  const { shell, pane } = buildShell(opts.workbench);

  appCol.append(topnav(), shell);
  frame.append(appCol);

  const tintWash = el('div');
  tintWash.className = 'sc-tint';
  tintWash.setAttribute('aria-hidden', 'true');
  tintWash.style.cssText =
    'position:absolute;inset:0;z-index:2;pointer-events:none;opacity:0;' +
    'transition:opacity .4s cubic-bezier(.4,0,.2,1);';
  frame.append(tintWash);

  const coneThread = pane.querySelector(':scope > slicc-chat-thread') as HTMLElement;

  function setThread(next: HTMLElement): void {
    const current = pane.querySelector(':scope > slicc-chat-thread');
    if (current && current !== next) current.replaceWith(next);
  }

  function setActiveChip(key: string | null): void {
    const sw = frame.querySelector('slicc-agent-tabs');
    if (key == null) sw?.removeAttribute('active');
    else sw?.setAttribute('active', key);
  }

  function setComposerHidden(hidden: boolean): void {
    const composer = pane.querySelector(':scope > slicc-composer');
    composer?.toggleAttribute('hidden', hidden);
  }

  function toLive(): void {
    frame.removeAttribute('data-preview');
    tintWash.style.opacity = '0';
    frame.style.removeProperty('--ctx');
    shader.setAttribute('mode', 'cone');
    shader.setAttribute('tint', 'var(--waffle)');
    freezer.removeAttribute('ctx');
    setComposerHidden(false);
    setThread(coneThread);
    setActiveChip(null);
  }

  function toScoop(key: string): void {
    const s = SCOOPS.find((x) => x.key === key);
    if (!s) return;
    frame.setAttribute('data-preview', 'scoop');
    frame.style.setProperty('--ctx', s.color);
    tintWash.style.backgroundColor = s.color;
    tintWash.style.opacity = '0.16';

    shader.setAttribute('mode', 'scoop');
    shader.setAttribute('tint', s.color);
    freezer.removeAttribute('ctx');
    setComposerHidden(true);
    setThread(scoopThread(s.key, s.color, s.label));
    setActiveChip(s.key);
  }

  function toFreezer(slug: string): void {
    const f = FROZEN.find((x) => x.slug === slug);
    frame.setAttribute('data-preview', 'freezer');
    frame.style.setProperty('--ctx', FREEZER_TINT);
    tintWash.style.backgroundColor = FREEZER_TINT;
    tintWash.style.opacity = '0.16';
    shader.setAttribute('mode', 'freezer');
    shader.setAttribute('tint', FREEZER_TINT);
    freezer.setAttribute('ctx', '');
    setComposerHidden(true);
    setThread(frozenThread(slug, f?.title ?? slug, f?.meta ?? 'frozen session'));
    setActiveChip(null);
  }

  frame.addEventListener('slicc-scoop-select', (e) => {
    const key = (e as CustomEvent<{ key?: string }>).detail?.key;
    if (!key) return;
    if (key === 'cone') toLive();
    else toScoop(key);
  });
  frame.addEventListener('freezer-card-select', (e) => {
    const slug = (e as CustomEvent<{ slug?: string }>).detail?.slug;
    if (slug) toFreezer(slug);
  });

  const dialog = settingsDialog();
  frame.append(dialog);
  frame.addEventListener('slicc-avatar-action', (e) => {
    if ((e as CustomEvent<{ id: string }>).detail.id === 'settings') {
      (dialog as HTMLElement & { show?: () => void }).show?.();
    }
  });

  if (opts.preview?.kind === 'scoop') toScoop(opts.preview.key);
  else if (opts.preview?.kind === 'freezer') toFreezer(opts.preview.slug);

  return frame;
}

const meta: Meta = {
  title: 'Showcase/Full App',
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
};
export default meta;
type Story = StoryObj;

export const Collapsed: Story = { render: () => app({ workbench: false, freezer: false }) };

export const Open: Story = { render: () => app({ workbench: true, freezer: true }) };

export const FreezerOpen: Story = { render: () => app({ workbench: false, freezer: true }) };

export const ScoopPreview: Story = {
  render: () =>
    app({ workbench: false, freezer: false, preview: { kind: 'scoop', key: 'researcher' } }),
};

export const FreezerPreview: Story = {
  render: () =>
    app({ workbench: false, freezer: true, preview: { kind: 'freezer', slug: 'hero' } }),
};

export const Workbench: Story = { render: () => app({ workbench: true, freezer: false }) };

export const Mobile: Story = {
  render: () => app({ workbench: false, freezer: false }),
  parameters: { viewport: { defaultViewport: 'mobile1' } },
};
