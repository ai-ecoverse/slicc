import type { Meta, StoryObj } from '@storybook/web-components-vite';
import '../add-menu/slicc-add-menu.js';
import '../primitives/slicc-send-button.js';
import './slicc-input-card.js';

interface InputCardArgs {
  value?: string;
  placeholder?: string;
  suggestion?: string;
  disabled?: boolean;
}

function inComposer(card: HTMLElement): HTMLElement {
  const band = document.createElement('div');
  band.style.background = 'var(--bg)';
  band.style.padding = '14px 16px';
  const inner = document.createElement('div');
  inner.style.maxWidth = '680px';
  inner.style.margin = '0 auto';
  inner.appendChild(card);
  band.appendChild(inner);
  return band;
}

function buildCard({ value, placeholder, suggestion, disabled }: InputCardArgs): HTMLElement {
  const el = document.createElement('slicc-input-card');
  if (value != null) el.setAttribute('value', value);
  if (placeholder != null) el.setAttribute('placeholder', placeholder);
  if (suggestion != null) el.setAttribute('suggestion', suggestion);
  if (disabled) el.setAttribute('disabled', '');
  return el;
}

const meta: Meta<InputCardArgs> = {
  title: 'Composer/InputCard',
  component: 'slicc-input-card',
  tags: ['autodocs'],
  argTypes: {
    value: { control: 'text', description: 'Textarea contents' },
    placeholder: { control: 'text', description: 'Textarea placeholder' },
    suggestion: {
      control: 'text',
      description: 'Suggested follow-up shown as the placeholder; Tab accepts it',
    },
    disabled: { control: 'boolean', description: 'Disable the textarea' },
  },
  render: (args) => inComposer(buildCard(args)),
};

export default meta;
type Story = StoryObj<InputCardArgs>;

export const Idle: Story = { args: {} };

export const FocusWithin: Story = {
  args: {},
  render: (args) => {
    const band = inComposer(buildCard(args));
    requestAnimationFrame(() => band.querySelector('slicc-input-card')?.focus());
    return band;
  },
};

export const SingleLine: Story = {
  args: { value: 'Make the hero headline warmer and bump the CTA contrast.' },
};

export const MultiLine: Story = {
  args: {
    value:
      'Audit the cold hero section.\n' +
      'Redesign it in a live sprinkle.\n' +
      'Verify before/after in the browser.\n' +
      'Open a PR and file a tracking ticket.\n' +
      'Then triage the support lick that just came in.',
  },
};

export const CustomPlaceholder: Story = {
  args: { placeholder: 'Describe the change you want…' },
};

export const SuggestedFollowUp: Story = {
  args: { suggestion: 'Now add dark mode to the hero?' },
};

export const Disabled: Story = { args: { disabled: true } };

export const CustomToolbar: Story = {
  args: {},
  render: (args) => {
    const card = buildCard(args);
    const send = document.createElement('slicc-send-button');
    send.setAttribute('slot', 'toolbar');
    const spacer = document.createElement('div');
    spacer.setAttribute('slot', 'toolbar');
    spacer.style.flex = '1';
    card.append(spacer, send);
    return inComposer(card);
  },
};
