import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-floatbar.js';

interface FloatbarArgs {
  label?: string;
  linked?: boolean;
  online?: boolean;
  rate?: string;
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
    rate: { control: 'text', description: 'Active-session hourly rate shown in the pill' },
    spent: { control: 'text', description: 'Cumulative cost shown in the overlay total' },
  },
  render: ({ label, linked, online, rate, spent }) => {
    const el = document.createElement('slicc-floatbar');
    if (label != null) el.setAttribute('label', label);
    if (linked) el.toggleAttribute('linked', true);
    if (online) el.toggleAttribute('online', true);
    if (rate != null && rate !== '') el.setAttribute('rate', rate);
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

/** With an hourly rate segment — coin icon + `$2.41/h` after a thin divider. */
export const WithSpent: Story = {
  args: { label: 'CLI float', rate: '2.41', spent: '2.41' },
};

/** Online + spent — green dot, label, divider, and the cost segment together. */
export const OnlineSpent: Story = {
  args: { label: 'CLI · tray · 1 follower', online: true, rate: '12.07', spent: '18.42' },
};

/** Live burn-rate headline while the cumulative total remains available to the overlay. */
export const RateHeadline: Story = {
  args: { label: 'CLI · tray · 1 follower', online: true, rate: '23.10', spent: '23.19' },
};

/**
 * Narrow / mobile viewport — the label, divider, and cost segment drop and the
 * host collapses to a square (width == height) round badge carrying just the
 * status light, rather than an elongated upright pill. Because the verbose
 * label is hidden, hovering or focusing the badge reveals a dark `::part(tip)`
 * tooltip (and a matching native `title`) re-surfacing the label, spend, and
 * connection state. Select the mobile viewport from the toolbar to see the
 * square form, then hover the badge for the tooltip.
 */
export const NarrowMobile: Story = {
  args: { label: 'CLI · tray · 1 follower', online: true, rate: '2.41', spent: '12.07' },
  parameters: { viewport: { defaultViewport: 'mobile1' } },
};
