import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-user-message.js';

interface UserMessageArgs {
  text?: string;
}

const meta: Meta<UserMessageArgs> = {
  title: 'Chat/UserMessage',
  component: 'slicc-user-message',
  tags: ['autodocs'],
  argTypes: {
    text: { control: 'text', description: 'Bubble message text (falls back to slotted content)' },
  },
  render: ({ text }) => {
    const el = document.createElement('slicc-user-message');
    if (text != null) el.setAttribute('text', text);
    return el;
  },
};

export default meta;
type Story = StoryObj<UserMessageArgs>;

/** Default — a right-aligned dark bubble carrying a short prompt. */
export const Default: Story = {
  args: { text: 'Warm up the landing hero and open a PR.' },
};

/** A longer prompt — the bubble wraps within its 80% max-width cap. */
export const LongPrompt: Story = {
  args: {
    text: 'Our landing hero feels cold and dev-ish. Research it, redesign it warmer, run the tests, and open a PR. Also keep an eye on the support inbox.',
  },
};

/** Short one-liner — the bubble hugs its content, still right-aligned. */
export const ShortPrompt: Story = {
  args: { text: 'ship it' },
};

/** Slotted content (no `text` attribute) — content flows through the default slot. */
export const Slotted: Story = {
  render: () => {
    const el = document.createElement('slicc-user-message');
    el.textContent = 'Slotted message body via the default slot.';
    return el;
  },
};

/** A realistic two-bubble exchange, reviewing right-alignment and stacking. */
export const Conversation: Story = {
  render: () => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'width:420px;max-width:100%;';
    for (const t of [
      'Can you audit the hero and propose warmer tokens?',
      'Great — go ahead and open the PR when the tests pass.',
    ]) {
      const el = document.createElement('slicc-user-message');
      el.setAttribute('text', t);
      wrap.appendChild(el);
    }
    return wrap;
  },
};
