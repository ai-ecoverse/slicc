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

/**
 * Idle: the rainbow-gradient ground with a white lucide `arrow-up` overlaid.
 * Micro-interactions reward the pointer — hover makes the arrow wiggle in
 * anticipation, pressing dips it down a couple px (preparing to leap), and
 * releasing whooshes it up (translate + fade, then reset) while emitting `send`.
 * All motion is suppressed under `prefers-reduced-motion`.
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
 * Busy · thinking (LLM-wait): the default busy treatment — a white lucide
 * `square` (stop) glyph that breathes with a soft pulse while a solid fill runs
 * twelve alternating phases: six directional fills (inside-out, left-to-right,
 * top-to-bottom, right-to-left, bottom-to-top, top-left corner), each immediately
 * followed by a clear that drains the square back to empty along the inverse
 * direction — 6 fills + 6 clears, 10s each, a 120s loop. Clicking emits `stop`.
 * Under `prefers-reduced-motion` the square is statically filled.
 */
export const BusyThinking: Story = { args: { busy: true, phase: 'thinking' } };

/**
 * Busy · tool (indeterminate): the 'running a tool' treatment — the static stop
 * square ringed by a spinner that rotates while the duration is unknown. Clicking
 * still emits `stop`. Under `prefers-reduced-motion` the ring holds a static arc.
 */
export const BusyTool: Story = { args: { busy: true, phase: 'tool' } };

/**
 * Busy · tool (determinate): with a `progress` fraction (0–1) the ring becomes a
 * held-still arc encoding how far the tool run has got — here 60%.
 */
export const BusyToolProgress: Story = { args: { busy: true, phase: 'tool', progress: 0.6 } };

/** Disabled: non-interactive and dimmed; emits nothing. */
export const Disabled: Story = { args: { disabled: true } };
