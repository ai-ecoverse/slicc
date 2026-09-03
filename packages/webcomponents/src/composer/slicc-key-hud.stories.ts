import type { Meta, StoryObj } from '@storybook/web-components-vite';
import '../add-menu/slicc-add-menu.js';
import '../primitives/slicc-send-button.js';
import './slicc-composer-meta.js';
import './slicc-composer.js';
import './slicc-input-card.js';
import type { KeyPress, SliccKeyHud } from './slicc-key-hud.js';
import './slicc-key-hud.js';

interface HudArgs {
  /** Narrow-chat variant of the composer band (the 34% chat pane). */
  open?: boolean;
  /** A draft in the composer — what the strip must never cover. */
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

/** The composer's real input card: add-menu + gravatar send button. */
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

/**
 * A chat column with a real composer footer — `<slicc-chatpane>` in the shell,
 * a positioned div here. The strip mounts on the COLUMN, not the band, and
 * pins itself to its bottom edge; with a composer there that edge is the band's.
 *
 * `keys` on the composer is what the shell sets while the mode is up: the card
 * and the meta row recede, so the one thing at full contrast is the one thing
 * the keyboard is talking to.
 */
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

/**
 * **At rest.** The lucide keyboard glyph names the mode; the hint names both
 * ways back to typing — `i` for the caret and Enter for the same — since "how
 * do I type again?" is the question a resting mode has to answer (Escape is
 * not the answer: it ENTERS the mode). Keys are drawn as caps in the hint too,
 * so the instruction and the answer wear the same chrome.
 */
export const StripResting: Story = {
  args: {},
  render: ({ open, draft }) => column({ open, draft, strip: hud() }),
};

/**
 * One press. The hint gives way to the cap — showing both would put a stale
 * instruction next to the key answering it — and the bar does NOT change
 * height, because it is up for as long as the mode is.
 */
export const StripOnePress: Story = {
  args: {},
  render: ({ open, draft }) => column({ open, draft, strip: hud({ presses: [{ caps: ['3'] }] }) }),
};

/**
 * A run of presses: everything but the newest is history and dims, so the cap
 * being answered is always the bright one. Past `depth` the oldest falls off
 * the front.
 */
export const StripRun: Story = {
  args: {},
  render: ({ open, draft }) =>
    column({
      open,
      draft,
      strip: hud({ presses: [{ caps: ['f'] }, { caps: ['3'] }, { caps: ['j'] }, { caps: ['⏎'] }] }),
    }),
};

/**
 * A press that ran nothing is SHOWN dimmed rather than dropped — a blank HUD
 * reads as a dead keyboard, which is the one thing the mode cannot afford.
 * Here `q` is unbound and `9` walked past the end of the strip.
 */
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

/**
 * Modifiers are caps of their own, so a chord is one press with several. `⌘`
 * and `⇧` stay as characters — that is what the keys are printed with — while
 * a key that is a SHAPE (Enter, the arrows) is drawn as its lucide glyph.
 */
export const StripModifiers: Story = {
  args: {},
  render: ({ open, draft }) =>
    column({
      open,
      draft,
      strip: hud({ presses: [{ caps: ['⌘', '⇧', 'P'], bound: false }, { caps: ['←'] }] }),
    }),
};

/**
 * **A draft underneath.** The reason the full-band takeover was dropped: the
 * mode can be up for minutes, and the text you are coming back to has to stay
 * on screen. It recedes — it does not disappear.
 */
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

/** The 34% chat pane — the tightest column the band gets. */
export const StripNarrow: Story = {
  args: { open: true },
  render: ({ open, draft }) => column({ open, draft, strip: hud({ presses: [{ caps: ['←'] }] }) }),
};

/**
 * **No composer.** A selected scoop is read-only and its band is hidden
 * (#2312) — the strip pins to the chat COLUMN, not the band, so the mode keeps
 * its one sign of life exactly where the keyboard is all you have.
 */
export const NoComposer: Story = {
  args: {},
  render: ({ open }) => {
    const shell = column({ open, strip: hud({ presses: [{ caps: ['f'] }, { caps: ['3'] }] }) });
    // What `applyComposerAvailability` does for a read-only unit. The strip is
    // on the column, so it survives the band going away.
    shell.querySelector('slicc-composer')?.setAttribute('hidden', '');
    return shell;
  },
};

/**
 * **Live** — click the story and type. Bound keys land bright, unbound land
 * dimmed, older caps grey out, and the hint comes back after `linger` of
 * quiet. The bound set here is the shipped navigation half of the keymap.
 */
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
    // Storybook renders a fresh canvas per story, so the listener dies with the
    // node — no teardown hook needed.
    queueMicrotask(() => shell.focus());
    return shell;
  },
};
