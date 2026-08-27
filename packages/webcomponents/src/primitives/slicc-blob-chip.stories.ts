import type { Meta, StoryObj } from '@storybook/web-components-vite';
import '../chat/slicc-agent-message.js';
import '../chat/slicc-user-message.js';
import './slicc-blob-chip.js';

interface BlobChipArgs {
  label?: string;
  icon?: string;
  title?: string;
}

const meta: Meta<BlobChipArgs> = {
  title: 'Primitives/BlobChip',
  component: 'slicc-blob-chip',
  tags: ['autodocs'],
  argTypes: {
    label: { control: 'text', description: 'Chip text (type · size)' },
    icon: {
      control: 'select',
      options: ['image', 'file-text', 'file-audio', 'file-video', 'file', 'binary'],
      description: 'Lucide icon name',
    },
    title: { control: 'text', description: 'Tooltip — the full MIME type and byte count' },
  },
  render: ({ label, icon, title }) => {
    const el = document.createElement('slicc-blob-chip');
    if (label) el.setAttribute('label', label);
    if (icon) el.setAttribute('icon', icon);
    if (title) el.setAttribute('title', title);
    return el;
  },
};

export default meta;
type Story = StoryObj<BlobChipArgs>;

export const Image: Story = {
  args: { label: 'png · 12 KB', icon: 'image', title: 'image/png · 12,684 bytes' },
};
export const Document: Story = {
  args: { label: 'pdf · 148 KB', icon: 'file-text', title: 'application/pdf · 151,552 bytes' },
};
export const Text: Story = {
  args: { label: 'plain · 3 KB', icon: 'file-text', title: 'text/plain · 3,072 bytes' },
};
export const Opaque: Story = {
  args: { label: 'zip · 2 MB', icon: 'file', title: 'application/zip · 2,097,152 bytes' },
};

/**
 * The chip in situ, which is the only view that shows whether the
 * `currentColor` chrome actually holds up: the same element has to read on the
 * agent message's canvas AND inside the inverted user bubble, in both themes.
 */
export const InMessages: StoryObj = {
  render: () => {
    const wrap = document.createElement('div');
    wrap.style.maxWidth = '560px';
    // Paint the canvas explicitly: the theme toolbar flips the tokens but not
    // the page, and an agent message on an unpainted white page tells a
    // reviewer nothing about how the chip reads in dark mode.
    wrap.style.background = 'var(--canvas)';
    wrap.style.color = 'var(--ink)';
    wrap.style.padding = '16px';

    const chip = (label: string, icon: string): string =>
      `<slicc-blob-chip label="${label}" icon="${icon}"></slicc-blob-chip>`;

    const agent = document.createElement('slicc-agent-message');
    agent.setBodyHtml(
      `<p>The screenshot you sent (${chip('png · 12 KB', 'image')}) shows the overlay ` +
        `clipped at the top.</p>`
    );

    const user = document.createElement('slicc-user-message');
    user.setBodyHtml(
      `<p>here it is: ${chip('png · 12 KB', 'image')} — and the log ` +
        `${chip('plain · 3 KB', 'file-text')}</p>`
    );

    wrap.append(agent, user);
    return wrap;
  },
};
