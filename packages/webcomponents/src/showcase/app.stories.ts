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
import '../freezer/slicc-shader.js';
import '../nav/slicc-avatar-menu.js';
import '../nav/slicc-nav.js';
import '../overlay/slicc-dialog.js';
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

// Eye-state matrix demonstrating the nav rule: ONLY the cone's eyes track the
// cursor. The scoops below render `open` (idle — static open eyes, not tracking),
// `dead` (the failed look), or `none` — none of them follow the pointer.
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

/**
 * The full-width top bar (the prototype's `.nav`): logo + scoop switcher (pills)
 * + a flexible spacer + floatbar + theme toggle + avatar. A SIBLING above the
 * shell — NOT inside the chat column — so the switcher gets the whole row width
 * and its pills never collapse into the chat pane when the workbench opens.
 */
function topnav(): HTMLElement {
  const nav = el('slicc-nav', { accent: 'var(--waffle)' });
  const logo = el('slicc-logo', { badge: 'studio' });
  // No active chip: the cone renders in its "open idle" configuration (white
  // background, dark text) rather than the accent color-fill — the resting
  // leader look (matches the Pill/Pill ConeOpenIdle story).
  const switcher = el('slicc-scoop-switcher') as HTMLElement & {
    scoops?: unknown;
  };
  (switcher as { scoops?: unknown }).scoops = SCOOPS;
  const floatbar = el('slicc-floatbar', {
    label: 'CLI · tray · 1 follower',
    spent: '2.41',
    online: '',
  });
  const toggle = el('slicc-theme-toggle');
  const avatar = el('slicc-avatar', { email: 'beau@dodds.net', name: 'Lars Trieloff' });
  // The avatar is the trigger of the account dropdown (real-app feature).
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
  nav.append(logo, switcher, floatbar, toggle, menu);
  return nav;
}

/** A labelled text field for the settings dialog body. */
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

/** The account-settings sub-dialog opened from the avatar menu (real-app feature). */
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

/** The left chat column: scrollable thread + a pinned composer (no nav). */
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
  // A multi-provider list — rows show model + provider, and the long list grows
  // a type-ahead search (like the composer add-menu).
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

/** Layout knobs for {@link app}: whether the workbench and the freezer rail are open. */
interface AppOpts {
  /** Workbench expanded (chat narrows to 34%); mirrors the prototype `.shell.open`. */
  workbench: boolean;
  /** Freezer rail expanded to 260px; mirrors the prototype `body.freezer-open`. */
  freezer: boolean;
}

/**
 * The full app, assembled exactly like the prototype `<body>`: a full-bleed,
 * viewport-filling frame holding the cone shader, the fixed freezer rail, and a
 * flex-column `.app` that stacks the FULL-WIDTH nav above the split shell. The
 * `.app` reserves the rail with `padding-left` (44px collapsed → 260px open),
 * so the nav + shell slide as the freezer expands — never overlapping it.
 */
function app(opts: AppOpts): HTMLElement {
  const railW = opts.freezer ? 260 : 44;

  const frame = el('div');
  // Fill the viewport (fullscreen story). `transform: translateZ(0)` makes the
  // frame the containing block for the freezer's `position: fixed`, so the rail
  // anchors to the frame (not the page) and the showcase stays self-contained.
  frame.style.cssText =
    'position:relative;transform:translateZ(0);width:100%;height:100vh;overflow:hidden;' +
    'background:var(--bg);font-family:var(--ui);';

  // The cone background field (the chat context's animated waffle lattice).
  const shader = el('slicc-shader', { mode: 'cone', tint: 'var(--waffle)' });
  shader.style.cssText = 'position:absolute;inset:0;z-index:0;';
  frame.append(shader);

  // The fixed left freezer rail — 44px collapsed (icon rail) / 260px open.
  const freezer = el('slicc-freezer', opts.freezer ? { open: '' } : {});
  freezer.style.zIndex = '6';
  freezer.append(el('slicc-freezer-new', opts.freezer ? { expanded: '' } : {}));
  for (const f of FROZEN) {
    freezer.append(el('slicc-freezer-card', { title: f.title, meta: f.meta, slug: f.slug }));
  }
  frame.append(freezer);

  // The `.app` column: full-width nav above the split shell, reserving the rail
  // via padding-left so both slide when the freezer opens. Layers over the shader.
  const appCol = el('div');
  appCol.className = 'sc-appcol';
  appCol.style.cssText =
    `position:relative;z-index:1;height:100%;display:flex;flex-direction:column;` +
    `box-sizing:border-box;--rail-w:${railW}px;`;
  // The rail reservation is a CSS var so a media query can clamp it: at narrow /
  // extension-sidebar widths the open freezer overlays as a drawer (padding stays
  // 44px) instead of shoving the whole app off-screen.
  const responsive = el('style');
  responsive.textContent =
    '.sc-appcol{padding-left:var(--rail-w,44px);transition:padding-left .4s cubic-bezier(.4,0,.2,1);}' +
    '@media (max-width:560px){.sc-appcol{padding-left:44px;}}';
  frame.append(responsive);

  const shell = el('slicc-shell', opts.workbench ? { open: '' } : {});
  const pane = chatpane(opts.workbench);
  pane.style.background = 'transparent';
  // Dock rail: sprinkles at the top, the Browser/Files/Terminal/Memory system
  // tools pinned at the BOTTOM (system-tools) — the prototype/legacy placement.
  const dock = el('slicc-dock', {
    'system-tools': '',
    active: opts.workbench ? 'term' : '',
  }) as HTMLElement & { items?: unknown };
  (dock as { items?: unknown }).items = [
    { id: 'hero', icon: 'sparkles', label: 'Hero studio', kind: 'sprinkle', hue: 'var(--violet)' },
    { id: 'palette', icon: 'palette', label: 'palette', kind: 'sprinkle', hue: 'var(--cyan)' },
  ];
  shell.append(pane, workbench(opts.workbench), dock);

  appCol.append(topnav(), shell);
  frame.append(appCol);

  // The account-settings sub-dialog — opened from the avatar menu's settings item.
  const dialog = settingsDialog();
  frame.append(dialog);
  frame.addEventListener('slicc-avatar-action', (e) => {
    if ((e as CustomEvent<{ id: string }>).detail.id === 'settings') {
      (dialog as HTMLElement & { show?: () => void }).show?.();
    }
  });
  return frame;
}

const meta: Meta = {
  title: 'Showcase/Full App',
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
};
export default meta;
type Story = StoryObj;

/**
 * The default app: chat full-width with a pinned composer, the workbench closed,
 * and the freezer collapsed to its 44px icon rail — the prototype's resting view.
 */
export const Collapsed: Story = { render: () => app({ workbench: false, freezer: false }) };

/** The open app: workbench expanded (file tree + live terminal) and freezer rail open. */
export const Open: Story = { render: () => app({ workbench: true, freezer: true }) };

/** Just the freezer rail expanded to 260px — chat full-width, workbench closed. */
export const FreezerOpen: Story = { render: () => app({ workbench: false, freezer: true }) };

/**
 * Workbench open with the freezer collapsed — at desktop a side-by-side split,
 * but at narrow / extension-sidebar widths the workbench overlays the chat
 * full-bleed (dock rail stays exposed to toggle it closed). The clean mobile
 * "open a tool" state.
 */
export const Workbench: Story = { render: () => app({ workbench: true, freezer: false }) };

/**
 * Narrow / mobile viewport — rails collapse to their icon widths, the switcher
 * overflows gracefully, and the single chat column + composer fill the screen.
 */
export const Mobile: Story = {
  render: () => app({ workbench: false, freezer: false }),
  parameters: { viewport: { defaultViewport: 'mobile1' } },
};
