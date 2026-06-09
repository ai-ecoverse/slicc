import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-floatbar.js';

interface FloatbarArgs {
  label?: string;
  linked?: boolean;
  online?: boolean;
}

const meta: Meta<FloatbarArgs> = {
  title: 'Primitives/Floatbar',
  component: 'slicc-floatbar',
  tags: ['autodocs'],
  argTypes: {
    label: { control: 'text', description: 'Runtime label text' },
    linked: { control: 'boolean', description: 'Rose-tinted border (linked runtime)' },
    online: { control: 'boolean', description: 'Show the green status dot' },
  },
  render: ({ label, linked, online }) => {
    const el = document.createElement('slicc-floatbar');
    if (label != null) el.setAttribute('label', label);
    if (linked) el.toggleAttribute('linked', true);
    if (online) el.toggleAttribute('online', true);
    return el;
  },
};

export default meta;
type Story = StoryObj<FloatbarArgs>;

/** Unlinked, offline runtime — neutral border, no status dot. */
export const Default: Story = { args: { label: 'CLI float' } };

/** Linked runtime — rose-tinted border. */
export const Linked: Story = {
  args: { label: 'CLI · tray · 1 follower', linked: true },
};

/** Online — green status dot, unlinked. */
export const Online: Story = {
  args: { label: 'CLI float', online: true },
};

/** The prototype nav state: linked, online, full label. */
export const LinkedOnline: Story = {
  args: { label: 'CLI · tray · 1 follower', linked: true, online: true },
};
