import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-send-button.js';

interface SendButtonArgs {
  disabled?: boolean;
  busy?: boolean;
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
  render: ({ disabled, busy, email, src, label }) => {
    const el = document.createElement('slicc-send-button');
    if (disabled) el.setAttribute('disabled', '');
    if (busy) el.setAttribute('busy', '');
    if (email) el.setAttribute('email', email);
    if (src) el.setAttribute('src', src);
    if (label) el.setAttribute('label', label);
    return el;
  },
};

export default meta;
type Story = StoryObj<SendButtonArgs>;

/**
 * Idle: the rainbow-gradient ground with a white lucide `arrow-up` overlaid.
 * Clicking whooshes the arrow up (translate + fade, then reset) and emits `send`.
 */
export const Idle: Story = { args: {} };

/**
 * Gravatar face: an `email` is hashed (SHA-256) to a gravatar URL and painted as
 * the circular background; the white arrow rides on top over a soft scrim. With
 * no real gravatar for the address the `mp` "mystery person" silhouette shows.
 */
export const WithGravatar: Story = { args: { email: 'pat.mercury@example.com' } };

/**
 * Explicit `src` face: any image URL becomes the circular ground (wins over
 * `email`), e.g. a GitHub avatar, with the arrow overlaid.
 */
export const WithAvatarSrc: Story = {
  args: { src: 'https://avatars.githubusercontent.com/u/9919?s=72&v=4' },
};

/**
 * Busy (stop): streaming state — a white lucide `square` (stop) glyph with a
 * soft pulse; clicking emits `stop`.
 */
export const Busy: Story = { args: { busy: true } };

/** Disabled: non-interactive and dimmed; emits nothing. */
export const Disabled: Story = { args: { disabled: true } };
