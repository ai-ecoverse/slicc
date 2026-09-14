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

const SAMPLES: ReadonlyArray<string> = [
  'Audit the cold landing hero and propose a warmer palette.',
  'Then redesign it in a live sprinkle and verify before/after in the browser.',
  'Open a PR with the before/after screenshots attached.',
  'Also: tighten the meta row hint so it does not wrap on narrow chat.',
  'Re-run the typecheck and the webcomponents test suite once everything is green.',
  'If the build passes, rebase onto main and request a review.',
  'And remember to update the prototype CLAUDE.md if conventions shifted.',
];

function buildMessages(n: number): QueuedMessage[] {
  return SAMPLES.slice(0, Math.max(0, n)).map((text, i) => ({
    id: `q-${i + 1}`,
    text,
  }));
}

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

export const Single: Story = {
  args: { count: 1 },
};

export const Three: Story = {
  args: { count: 3 },
};

export const Deep: Story = {
  args: { count: SAMPLES.length },
};

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

    composer.style.marginTop = '-12px';

    const stack = buildStack(count);

    stack.style.marginBottom = '-32px';
    stack.style.minHeight = '76px';

    stack.style.position = 'relative';
    stack.style.zIndex = '0';

    const card = document.createElement('slicc-input-card');
    card.setAttribute('placeholder', 'Ask sliccy…');

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
