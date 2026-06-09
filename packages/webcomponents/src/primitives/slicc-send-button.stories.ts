import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-send-button.js';

interface SendButtonArgs {
  disabled?: boolean;
  busy?: boolean;
  label?: string;
}

const meta: Meta<SendButtonArgs> = {
  title: 'Primitives/SendButton',
  component: 'slicc-send-button',
  tags: ['autodocs'],
  argTypes: {
    disabled: { control: 'boolean', description: 'Non-interactive (e.g. empty composer input)' },
    busy: { control: 'boolean', description: 'Streaming — shows a stop glyph and emits `stop`' },
    label: { control: 'text', description: 'Accessible label / tooltip' },
  },
  render: ({ disabled, busy, label }) => {
    const el = document.createElement('slicc-send-button');
    if (disabled) el.setAttribute('disabled', '');
    if (busy) el.setAttribute('busy', '');
    if (label) el.setAttribute('label', label);
    return el;
  },
};

export default meta;
type Story = StoryObj<SendButtonArgs>;

export const Default: Story = { args: {} };
export const Disabled: Story = { args: { disabled: true } };
export const Busy: Story = { args: { busy: true } };
