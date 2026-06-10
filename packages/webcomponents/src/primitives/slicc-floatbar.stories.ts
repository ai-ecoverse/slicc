import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-floatbar.js';

interface FloatbarArgs {
  label?: string;
  linked?: boolean;
  online?: boolean;
  spent?: string;
}

const meta: Meta<FloatbarArgs> = {
  title: 'Primitives/Floatbar',
  component: 'slicc-floatbar',
  tags: ['autodocs'],
  argTypes: {
    label: { control: 'text', description: 'Runtime label text' },
    linked: { control: 'boolean', description: 'Rose-tinted border (linked runtime)' },
    online: { control: 'boolean', description: 'Show the green status dot' },
    spent: { control: 'text', description: '$ spent — number/string, renders a coin + $amount' },
  },
  render: ({ label, linked, online, spent }) => {
    const el = document.createElement('slicc-floatbar');
    if (label != null) el.setAttribute('label', label);
    if (linked) el.toggleAttribute('linked', true);
    if (online) el.toggleAttribute('online', true);
    if (spent != null && spent !== '') el.setAttribute('spent', spent);
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

/** With a `$ SPENT` cost segment — coin icon + `$2.41` after a thin divider. */
export const WithSpent: Story = {
  args: { label: 'CLI float', spent: '2.41' },
};

/** Online + spent — green dot, label, divider, and the cost segment together. */
export const OnlineSpent: Story = {
  args: { label: 'CLI · tray · 1 follower', online: true, spent: '12.07' },
};

/**
 * Narrow / mobile viewport — the label, divider, and cost segment drop and the
 * host collapses to a square (width == height) round badge carrying just the
 * status light, rather than an elongated upright pill. Select the mobile
 * viewport from the toolbar to see the square form.
 */
export const NarrowMobile: Story = {
  args: { label: 'CLI · tray · 1 follower', online: true, spent: '2.41' },
  parameters: { viewport: { defaultViewport: 'mobile1' } },
};
