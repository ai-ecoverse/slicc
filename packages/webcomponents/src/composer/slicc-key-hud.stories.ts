import type { Meta, StoryObj } from '@storybook/web-components-vite';
import '../add-menu/slicc-add-menu.js';
import '../primitives/slicc-send-button.js';
import './slicc-composer-meta.js';
import './slicc-composer.js';
import './slicc-input-card.js';
import type { KeyPress, SliccKeyHud } from './slicc-key-hud.js';
import './slicc-key-hud.js';

interface HudArgs {
  open?: boolean;

  draft?: boolean;
}

const meta: Meta<HudArgs> = {
  title: 'Composer/Keyboard mode HUD',
  component: 'slicc-key-hud',
  tags: ['autodocs'],
  argTypes: {
    open: { control: 'boolean', description: 'Narrow-chat composer (mirrors .shell.open)' },
    draft: { control: 'boolean', description: 'Unsent text in the composer' },
  },
};

export default meta;
type Story = StoryObj<HudArgs>;

const DEMO_EMAIL = 'lars@trieloff.net';
const PLACEHOLDER = 'Ask sliccy, or describe a change — e.g. “make the landing hero feel warmer”…';
const DRAFT =
  'Audit the cold landing hero, then redesign it in a live sprinkle and open a PR when the before/after checks out.';

function inputCard(draft: boolean): HTMLElement {
  const card = document.createElement('slicc-input-card');
  card.setAttribute('placeholder', PLACEHOLDER);
  if (draft) card.setAttribute('value', DRAFT);

  const addMenu = document.createElement('slicc-add-menu');
  addMenu.setAttribute('slot', 'toolbar');
  const spacer = document.createElement('div');
  spacer.setAttribute('slot', 'toolbar');
  spacer.style.flex = '1';
  const send = document.createElement('slicc-send-button');
  send.setAttribute('slot', 'toolbar');
  send.setAttribute('email', DEMO_EMAIL);

  card.append(addMenu, spacer, send);
  return card;
}

function metaRow(narrow: boolean): HTMLElement {
  const row = document.createElement('slicc-composer-meta');
  row.setAttribute('model', 'Opus 4.8');
  row.setAttribute('thinking', 'max');
  if (narrow) row.setAttribute('narrow', '');
  return row;
}

function hud(options: { presses?: KeyPress[]; hint?: string; label?: string } = {}): SliccKeyHud {
  const el = document.createElement('slicc-key-hud') as SliccKeyHud;
  if (options.hint !== undefined) el.setAttribute('hint', options.hint);
  if (options.label) el.setAttribute('label', options.label);
  if (options.presses) el.presses = options.presses;
  return el;
}

function column(options: {
  open?: boolean;
  draft?: boolean;
  strip?: SliccKeyHud;
  caption?: string;
}): HTMLElement {
  const shell = document.createElement('div');
  shell.style.cssText =
    'position:relative;display:flex;flex-direction:column;height:420px;width:100%;background:var(--bg);overflow:hidden;font-family:var(--ui);';

  const thread = document.createElement('div');
  thread.style.cssText =
    'flex:1 1 auto;overflow:auto;padding:28px 24px;color:var(--txt-2);font-size:14px;line-height:1.5;';
  for (const [tone, text] of [
    ['ink', 'Make the landing hero feel warmer.'],
    [
      'mute',
      'On it — auditing the cold hero, then redesigning in a live sprinkle. I will verify before/after in the browser and open a PR.',
    ],
    [
      'mute',
      options.caption ??
        'Keyboard mode is the resting state: nothing is being typed, so the band recedes and its bottom edge says what the keyboard is doing instead.',
    ],
  ] as const) {
    const p = document.createElement('p');
    p.textContent = text;
    p.style.cssText = tone === 'ink' ? 'margin:0 0 12px;color:var(--ink);' : 'margin:0 0 12px;';
    thread.appendChild(p);
  }

  const composer = document.createElement('slicc-composer');
  if (options.open) composer.setAttribute('open', '');
  composer.append(inputCard(Boolean(options.draft)), metaRow(Boolean(options.open)));

  shell.append(thread, composer);
  if (options.strip) {
    composer.setAttribute('keys', '');
    shell.append(options.strip);
  }
  return shell;
}

export const StripResting: Story = {
  args: {},
  render: ({ open, draft }) => column({ open, draft, strip: hud() }),
};

export const StripOnePress: Story = {
  args: {},
  render: ({ open, draft }) => column({ open, draft, strip: hud({ presses: [{ caps: ['3'] }] }) }),
};

export const StripRun: Story = {
  args: {},
  render: ({ open, draft }) =>
    column({
      open,
      draft,
      strip: hud({ presses: [{ caps: ['f'] }, { caps: ['3'] }, { caps: ['j'] }, { caps: ['⏎'] }] }),
    }),
};

export const StripUnbound: Story = {
  args: {},
  render: ({ open, draft }) =>
    column({
      open,
      draft,
      strip: hud({
        presses: [{ caps: ['q'], bound: false }, { caps: ['9'], bound: false }, { caps: ['2'] }],
      }),
    }),
};

export const StripModifiers: Story = {
  args: {},
  render: ({ open, draft }) =>
    column({
      open,
      draft,
      strip: hud({ presses: [{ caps: ['⌘', '⇧', 'P'], bound: false }, { caps: ['←'] }] }),
    }),
};

export const StripOverDraft: Story = {
  args: { draft: true },
  render: ({ open, draft }) =>
    column({
      open,
      draft,
      strip: hud({ presses: [{ caps: ['f'] }, { caps: ['3'] }] }),
      caption:
        'The draft, the model pill and the send button all stay legible at half strength; only the strip is at full contrast.',
    }),
};

export const StripNarrow: Story = {
  args: { open: true },
  render: ({ open, draft }) => column({ open, draft, strip: hud({ presses: [{ caps: ['←'] }] }) }),
};

export const NoComposer: Story = {
  args: {},
  render: ({ open }) => {
    const shell = column({ open, strip: hud({ presses: [{ caps: ['f'] }, { caps: ['3'] }] }) });

    shell.querySelector('slicc-composer')?.setAttribute('hidden', '');
    return shell;
  },
};

export const StripLive: Story = {
  args: {},
  render: ({ open, draft }) => {
    const strip = hud();
    const bound = new Set([
      ...'123456789'.split(''),
      'ArrowLeft',
      'ArrowRight',
      'f',
      'j',
      'k',
      'r',
      'm',
      '?',
    ]);
    const CAP: Record<string, string> = { ArrowLeft: '←', ArrowRight: '→', Enter: '⏎', ' ': '␣' };
    const shell = column({ open, draft, strip });
    shell.tabIndex = 0;
    shell.style.outline = 'none';
    shell.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      const caps = event.shiftKey && event.key.length > 1 ? ['⇧'] : [];
      caps.push(CAP[event.key] ?? event.key);
      strip.record(caps, bound.has(event.key));
    });

    queueMicrotask(() => shell.focus());
    return shell;
  },
};
