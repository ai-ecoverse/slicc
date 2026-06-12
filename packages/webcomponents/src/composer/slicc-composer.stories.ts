import type { Meta, StoryObj } from '@storybook/web-components-vite';
// Compose the footer by tag from real library siblings — importing each module
// registers its custom element so the markup below upgrades on mount. The input
// card itself composes the add-menu + send-button; we still import those leaves
// directly so the custom send-button (with a gravatar `email`) we slot in is
// registered too, and so the meta row's model/thinking pills are available.
import '../add-menu/slicc-add-menu.js';
import '../primitives/slicc-send-button.js';
import './slicc-composer-meta.js';
import './slicc-composer.js';
import './slicc-input-card.js';
import type { SliccComposer } from './slicc-composer.js';

interface ComposerArgs {
  open?: boolean;
}

const meta: Meta<ComposerArgs> = {
  title: 'Composer/Composer',
  component: 'slicc-composer',
  tags: ['autodocs'],
  argTypes: {
    open: {
      control: 'boolean',
      description: 'Narrow-chat variant (hides the meta keyboard hint); mirrors .shell.open',
    },
  },
};

export default meta;
type Story = StoryObj<ComposerArgs>;

/**
 * A realistic gravatar seed for the send button's face. The send button hashes
 * this with SHA-256 and paints the resolved gravatar as the circular ground
 * (falling back to the rainbow gradient until/unless it resolves).
 */
const DEMO_EMAIL = 'lars@trieloff.net';

/** Realistic, prototype-flavored placeholder copy for the composer textarea. */
const PLACEHOLDER = 'Ask sliccy, or describe a change — e.g. “make the landing hero feel warmer”…';

/**
 * Build the fully-populated `<slicc-input-card>`: a real card composing, via its
 * `toolbar` slot, the `<slicc-add-menu>` (which slides its searchbox in next to
 * the +/× trigger) and a `<slicc-send-button>` carrying a gravatar `email` so it
 * paints a real face. A flex spacer pushes the send button to the right edge,
 * matching the prototype `.toolbar` (`add-menu · spacer · send`).
 */
function inputCard(): HTMLElement {
  const card = document.createElement('slicc-input-card');
  card.setAttribute('placeholder', PLACEHOLDER);
  card.setAttribute(
    'value',
    'Audit the cold landing hero, then redesign it in a live sprinkle. ' +
      'Verify the before/after in the browser and open a PR.'
  );

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

/** Build the populated `<slicc-composer-meta>` row (model + thinking + hint). */
function metaRow(narrow: boolean): HTMLElement {
  const row = document.createElement('slicc-composer-meta');
  row.setAttribute('model', 'Opus 4.8');
  row.setAttribute('thinking', 'max');
  // Narrow-chat: the composer's own [open] CSS hides any `.slicc-composer__hint`
  // / `[data-composer-hint]`, but the meta row keeps its hint inside a shadow
  // root — so also flag the row `narrow` to drop its hint in the tight column.
  if (narrow) row.setAttribute('narrow', '');
  return row;
}

/**
 * Build a fully-populated composer mounted in a chat-column shell, so the
 * frosted footer band reads against a chat-thread-like surface above it (the
 * prototype layout). The footer is composed entirely from real library
 * components: `<slicc-input-card>` (add-menu + gravatar send button) + a
 * `<slicc-composer-meta>` row. Light/dark is driven by the global theme toolbar.
 */
function composer({ open }: ComposerArgs): HTMLElement {
  // A chat-column shell: faux thread above, composer footer pinned below.
  const shell = document.createElement('div');
  shell.style.cssText =
    'display:flex;flex-direction:column;height:460px;width:100%;background:var(--bg);overflow:hidden;font-family:var(--ui);';

  const thread = document.createElement('div');
  thread.style.cssText =
    'flex:1 1 auto;overflow:hidden;padding:28px 24px;color:var(--txt-2);font-size:14px;line-height:1.5;';
  thread.innerHTML =
    '<p style="margin:0 0 12px;color:var(--ink);">Make the landing hero feel warmer.</p>' +
    '<p style="margin:0 0 12px;">On it — auditing the cold hero, then redesigning in a live sprinkle. I will verify before/after in the browser and open a PR.</p>' +
    '<p style="margin:0;">The composer footer below frosts over this thread; opening the add-menu pops a results panel <b>up and over</b> these lines (z-index:2) without growing the band.</p>';

  const el = document.createElement('slicc-composer') as SliccComposer;
  if (open) el.setAttribute('open', '');
  el.append(inputCard(), metaRow(Boolean(open)));

  shell.append(thread, el);
  return shell;
}

/**
 * Default — full-width chat. The frosted footer band composes a real
 * `<slicc-input-card>` (its `<slicc-add-menu>` toolbar + a gravatar
 * `<slicc-send-button>`) over a `<slicc-composer-meta>` row whose keyboard hint
 * (Enter to send, Shift+Enter for a newline) stays
 * visible. Every glyph is a real lucide `<svg>` from the composed components —
 * never an emoji. Flip the global theme toolbar for dark mode; widen via the
 * viewport toolbar.
 */
export const Default: Story = {
  args: {},
  render: composer,
};

/**
 * Narrow / shell-open — the 34% chat pane. The composer's `open` attribute (plus
 * the meta row's `narrow` flag) hides the keyboard hint, keeping just the model
 * pill and the thinking pill. Mirrors the prototype's `.shell.open .meta .hint`.
 */
export const Narrow: Story = {
  args: { open: true },
  render: composer,
};

/**
 * Build a tall, scrollable faux chat thread so the composer's frosted-glass band
 * has real content to scroll *under* it. Each turn is a plain paragraph; the
 * container scrolls, and a generous bottom padding lets the last lines slide
 * beneath the pinned composer rather than ending above it.
 */
function tallThread(): HTMLElement {
  const thread = document.createElement('div');
  // The scroll surface fills the shell; bottom padding clears the overlaid band
  // so the final lines can scroll fully underneath the frosted pane.
  thread.style.cssText =
    'position:absolute;inset:0;overflow-y:auto;padding:28px 24px 220px;' +
    'color:var(--txt-2);font-size:14px;line-height:1.5;';

  const turns = [
    ['user', 'Make the landing hero feel warmer.'],
    ['agent', 'On it — auditing the cold hero, then redesigning in a live sprinkle.'],
    ['user', 'Keep the headline, just shift the palette and the imagery mood.'],
    [
      'agent',
      'Pulling the current tokens; the hero leans on a flat slate background with no accent warmth.',
    ],
    ['user', 'Right. Warmer, but still calm — not a sunset gradient.'],
    [
      'agent',
      'Drafting a muted amber wash over the existing canvas, then verifying contrast for the CTA.',
    ],
    ['user', 'Scroll down — does the rest of the page still read against it?'],
    [
      'agent',
      'Checking the fold below: cards keep their surface, the warm wash only tints the hero band.',
    ],
    ['user', 'Good. Notice how these lines slide under the composer as they scroll.'],
    [
      'agent',
      'Exactly — the frosted band stays pinned; the thread blurs faintly beneath it (backdrop-filter).',
    ],
    ['user', 'Ship it once the before/after looks right.'],
    ['agent', 'Opening the PR with the before/after screenshots attached.'],
  ];

  for (const [role, text] of turns) {
    const p = document.createElement('p');
    p.textContent = text;
    p.style.cssText = role === 'user' ? 'margin:0 0 14px;color:var(--ink);' : 'margin:0 0 14px;';
    thread.appendChild(p);
  }
  return thread;
}

/**
 * Build a composer overlaid at the bottom of a scrollable thread, so the frosted
 * band actually sits *over* the scrolling chat content. As the thread scrolls,
 * its lines pass beneath the semi-transparent composer and read through the
 * `backdrop-filter` blur — the layered "scroll-under" look from the prototype.
 */
function scrollUnder({ open }: ComposerArgs): HTMLElement {
  const shell = document.createElement('div');
  shell.style.cssText =
    'position:relative;height:460px;width:100%;background:var(--bg);overflow:hidden;font-family:var(--ui);';

  const el = document.createElement('slicc-composer') as SliccComposer;
  // Pin the band to the bottom edge so the thread scrolls underneath it.
  el.style.cssText = 'position:absolute;left:0;right:0;bottom:0;';
  if (open) el.setAttribute('open', '');
  el.append(inputCard(), metaRow(Boolean(open)));

  shell.append(tallThread(), el);
  return shell;
}

/**
 * Scroll-under — the frosted-glass layering. The chat thread is a real scroll
 * surface; the composer is pinned over its bottom edge. Scroll the thread and
 * its lines pass *beneath* the semi-transparent band, blurred + tinted by the
 * composer's `backdrop-filter`. Flip the theme toolbar to confirm the frosted
 * tint recomputes from `--ctx`/`--bg` in both light and dark.
 */
export const ScrollUnder: Story = {
  args: {},
  render: scrollUnder,
};

/**
 * Build a composer and arm its push-to-talk gesture after mount so the story
 * shows the held "walkie-talkie" state: the band turns into a big active push
 * button with a centered mic, the "Keep mouse pressed to dictate" prompt, and
 * the simulated model-load progress bar sweeping to its listening affordance.
 * The press is synthesized (a real mousedown) since Storybook renders a static
 * frame; clicking anywhere releases it, tearing the overlay down and populating
 * the textarea with a representative transcript. `prefers-reduced-motion` shows
 * the static ready state instead of the sweep.
 */
function pushToTalk({ open }: ComposerArgs): HTMLElement {
  const shell = document.createElement('div');
  shell.style.cssText =
    'display:flex;flex-direction:column;height:300px;width:100%;background:var(--bg);overflow:hidden;font-family:var(--ui);';

  const thread = document.createElement('div');
  thread.style.cssText = 'flex:1 1 auto;padding:24px;color:var(--txt-2);font-size:14px;';
  thread.textContent = 'Press and hold the input below to dictate; release to drop the transcript.';

  const el = document.createElement('slicc-composer') as SliccComposer;
  // The dictation simulation is opt-in (production hosts leave it unset).
  el.setAttribute('ptt', '');
  if (open) el.setAttribute('open', '');
  el.append(inputCard(), metaRow(Boolean(open)));

  shell.append(thread, el);

  // Arm the gesture once the input card has upgraded and built its textarea.
  requestAnimationFrame(() => {
    const ta = el.querySelector('textarea');
    ta?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
  });
  return shell;
}

/**
 * Push-to-talk — the walkie-talkie dictation gesture. The story arms the press
 * on mount so the big active push button (mic + prompt + simulated model-load
 * progress bar) is visible. Click anywhere to release and watch the transcript
 * populate the textarea. Flip the theme + reduced-motion toolbars to confirm
 * the frosted tint and the no-sweep static-ready path.
 */
export const PushToTalk: Story = {
  args: {},
  render: pushToTalk,
};
