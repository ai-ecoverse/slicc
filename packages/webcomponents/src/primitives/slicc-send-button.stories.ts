import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-send-button.js';

interface SendButtonArgs {
  disabled?: boolean;
  busy?: boolean;
  phase?: 'thinking' | 'tool';
  progress?: number;
  email?: string;
  src?: string;
  label?: string;
}

const meta: Meta<SendButtonArgs> = {
  title: 'Primitives/SendButton',
  component: 'slicc-send-button',
  tags: ['autodocs'],
  argTypes: {
    disabled: { control: 'boolean', description: 'Non-interactive (e.g. empty composer input)' },
    busy: { control: 'boolean', description: 'Streaming — shows a stop glyph and emits `stop`' },
    phase: {
      control: { type: 'inline-radio' },
      options: ['thinking', 'tool'],
      description: 'Busy treatment: `thinking` (LLM-wait pulse/fill) or `tool` (spinning ring)',
    },
    progress: {
      control: { type: 'range', min: 0, max: 1, step: 0.01 },
      description: 'Tool-phase determinate fraction (0–1); omit for an indeterminate spin',
    },
    email: {
      control: 'text',
      description: 'User email; a gravatar face (SHA-256) becomes the circular ground',
    },
    src: {
      control: 'text',
      description: 'Explicit image URL painted as the face (wins over email)',
    },
    label: { control: 'text', description: 'Accessible label / tooltip' },
  },
  render: ({ disabled, busy, phase, progress, email, src, label }) => {
    const el = document.createElement('slicc-send-button');
    if (disabled) el.setAttribute('disabled', '');
    if (busy) el.setAttribute('busy', '');
    if (phase) el.setAttribute('phase', phase);
    if (progress != null) el.setAttribute('progress', String(progress));
    if (email) el.setAttribute('email', email);
    if (src) el.setAttribute('src', src);
    if (label) el.setAttribute('label', label);
    return el;
  },
};

export default meta;
type Story = StoryObj<SendButtonArgs>;

export const Idle: Story = { args: {} };

export const WithGravatar: Story = { args: { email: 'pat.mercury@example.com' } };

export const WithAvatarSrc: Story = {
  args: { src: 'https://avatars.githubusercontent.com/u/9919?s=72&v=4' },
};

export const BusyThinking: Story = { args: { busy: true, phase: 'thinking' } };

export const BusyTool: Story = { args: { busy: true, phase: 'tool' } };

export const BusyToolProgress: Story = { args: { busy: true, phase: 'tool', progress: 0.6 } };

export const Disabled: Story = { args: { disabled: true } };
