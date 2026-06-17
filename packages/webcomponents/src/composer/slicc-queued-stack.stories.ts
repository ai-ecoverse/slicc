import type { Meta, StoryObj } from '@storybook/web-components-vite';
import '../add-menu/slicc-add-menu.js';
import '../primitives/slicc-send-button.js';
import './slicc-composer-meta.js';
import './slicc-composer.js';
import './slicc-input-card.js';
import './slicc-queued-stack.js';
import type { QueuedMessage, SliccQueuedStack } from './slicc-queued-stack.js';

interface StackArgs {
  count: number;
}

/**
 * Realistic, prototype-flavored queued lines — short enough that the front
 * card stays a single line, long enough that the line-clamp is exercised.
 */
const SAMPLES: ReadonlyArray<string> = [
  'Audit the cold landing hero and propose a warmer palette.',
  'Then redesign it in a live sprinkle and verify before/after in the browser.',
  'Open a PR with the before/after screenshots attached.',
  'Also: tighten the meta row hint so it does not wrap on narrow chat.',
  'Re-run the typecheck and the webcomponents test suite once everything is green.',
  'If the build passes, rebase onto main and request a review.',
  'And remember to update the prototype CLAUDE.md if conventions shifted.',
];

/** Pull the first `n` samples and stamp each one with a stable id. */
function buildMessages(n: number): QueuedMessage[] {
  return SAMPLES.slice(0, Math.max(0, n)).map((text, i) => ({
    id: `q-${i + 1}`,
    text,
  }));
}

/** Mount the stack inside a 680px composer-width band on the off-white `--bg`. */
function inBand(el: HTMLElement): HTMLElement {
  const band = document.createElement('div');
  band.style.background = 'var(--bg)';
  band.style.padding = '24px 16px';
  const inner = document.createElement('div');
  inner.style.maxWidth = '680px';
  inner.style.margin = '0 auto';
  inner.appendChild(el);
  band.appendChild(inner);
  return band;
}

function buildStack(count: number): SliccQueuedStack {
  const el = document.createElement('slicc-queued-stack');
  el.setMessages(buildMessages(count));
  return el;
}

const meta: Meta<StackArgs> = {
  title: 'Composer/Queued Stack',
  component: 'slicc-queued-stack',
  tags: ['autodocs'],
  argTypes: {
    count: {
      control: { type: 'number', min: 0, max: SAMPLES.length, step: 1 },
      description: 'Number of queued messages to render (newest = front card)',
    },
  },
  render: ({ count }) => inBand(buildStack(count)),
};

export default meta;
type Story = StoryObj<StackArgs>;

/** Single message — one upright card, no fan. The `×` is the only dismiss. */
export const Single: Story = {
  args: { count: 1 },
};

/** Three messages — front card upright, two cards fanned behind with ±2° tilts. */
export const Three: Story = {
  args: { count: 3 },
};

/** Deep pile — 6+ cards fanned via the alternating ±1–3° rotation table. */
export const Deep: Story = {
  args: { count: SAMPLES.length },
};

/** A short queued message paired with an attachment count, surfaced as +N on the front card. */
export const WithAttachments: Story = {
  args: { count: 2 },
  render: () => {
    const el = document.createElement('slicc-queued-stack');
    el.setMessages([
      { id: 'a-1', text: 'Use these references for the warm palette study.' },
      {
        id: 'a-2',
        text: 'Tighten the meta row hint, attaching the prototype screenshot.',
        attachments: 2,
      },
    ]);
    return inBand(el);
  },
};

/**
 * In-composer placement — the stack tucks BEHIND the `<slicc-input-card>`
 * inside a real `<slicc-composer>`: the bottom of the front card slips under
 * the opaque white input card (negative bottom margin pulls them into
 * overlap, and an explicit `position: relative; z-index: 1` on the input
 * card lifts it above the stack's positioned `.stack` grid — which would
 * otherwise paint atop a static sibling regardless of DOM order). The
 * composer's frosted band extends upward to wrap the visible top of the
 * pile, even nudging slightly into the chat thread above (small negative
 * top margin). Matches the design intent: the stack appears to grow out of
 * the composer rather than float as a separate band, with only its top
 * peeking up above the input card.
 */
export const InComposer: Story = {
  args: { count: 3 },
  render: ({ count }) => {
    const shell = document.createElement('div');
    shell.style.cssText =
      'display:flex;flex-direction:column;height:480px;width:100%;background:var(--bg);' +
      'overflow:hidden;font-family:var(--ui);';

    const thread = document.createElement('div');
    thread.style.cssText =
      'flex:1 1 auto;overflow:hidden;padding:28px 24px;color:var(--txt-2);font-size:14px;line-height:1.5;';
    const intro = document.createElement('p');
    intro.style.margin = '0 0 12px';
    intro.style.color = 'var(--ink)';
    intro.textContent = 'Make the landing hero feel warmer.';
    const reply = document.createElement('p');
    reply.style.margin = '0';
    reply.textContent =
      'Working through the queue below — these lines are pinned above the input card.';
    thread.append(intro, reply);

    const composer = document.createElement('slicc-composer');
    // Let the composer's frosted band creep up into the chat thread above so
    // it visually wraps the top of the pile rather than floating as a band.
    composer.style.marginTop = '-12px';

    const stack = buildStack(count);
    // Pull the stack down so most of the front card tucks under the input
    // card — only the top of the pile peeks above into the chat area.
    stack.style.marginBottom = '-32px';
    // The stack's `.stack` grid is `position: relative` (so its cards can
    // grid-overlap), which makes it a positioned element. Positioned
    // siblings paint above static ones regardless of DOM order, so without
    // an explicit stacking context here the stack would draw OVER the
    // input card. Pin it to z-index 0 so the input card's z-index 1 wins.
    stack.style.position = 'relative';
    stack.style.zIndex = '0';

    const card = document.createElement('slicc-input-card');
    card.setAttribute('placeholder', 'Ask sliccy…');
    // Lift the opaque white input card above the queued stack so its
    // background hides the bottom edge of the front card (and the box
    // shadow reads cleanly against the chat thread below the cut line).
    card.style.position = 'relative';
    card.style.zIndex = '1';
    const addMenu = document.createElement('slicc-add-menu');
    addMenu.setAttribute('slot', 'toolbar');
    const spacer = document.createElement('div');
    spacer.setAttribute('slot', 'toolbar');
    spacer.style.flex = '1';
    const send = document.createElement('slicc-send-button');
    send.setAttribute('slot', 'toolbar');
    card.append(addMenu, spacer, send);

    const metaRow = document.createElement('slicc-composer-meta');
    metaRow.setAttribute('model', 'Opus 4.8');
    metaRow.setAttribute('thinking', 'max');

    composer.append(stack, card, metaRow);
    shell.append(thread, composer);
    return shell;
  },
};
