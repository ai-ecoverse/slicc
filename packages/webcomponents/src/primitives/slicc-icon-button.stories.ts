import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-icon-button.js';

interface IconButtonArgs {
  label?: string;
  disabled?: boolean;
  glyph?: string;
}

function build({ label, disabled, glyph }: IconButtonArgs): HTMLElement {
  const el = document.createElement('slicc-icon-button');
  if (label) el.setAttribute('label', label);
  if (disabled) el.setAttribute('disabled', '');
  el.textContent = glyph ?? '+';
  return el;
}

const meta: Meta<IconButtonArgs> = {
  title: 'Primitives/IconButton',
  component: 'slicc-icon-button',
  tags: ['autodocs'],
  argTypes: {
    label: { control: 'text', description: 'Accessible name (aria-label + title)' },
    disabled: { control: 'boolean', description: 'Non-interactive, dimmed state' },
    glyph: { control: 'text', description: 'Slotted icon glyph' },
  },
  render: build,
};

export default meta;
type Story = StoryObj<IconButtonArgs>;

export const Default: Story = { args: { label: 'Add', glyph: '+' } };

export const Disabled: Story = { args: { label: 'Add', glyph: '+', disabled: true } };

export const WithEmojiGlyph: Story = { args: { label: 'Attach', glyph: '📎' } };

export const WithSvgGlyph: Story = {
  render: ({ label }) => {
    const el = document.createElement('slicc-icon-button');
    if (label) el.setAttribute('label', label);
    el.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
    return el;
  },
  args: { label: 'Add' },
};
