import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-day-separator.js';

interface DaySeparatorArgs {
  label?: string;
}

const meta: Meta<DaySeparatorArgs> = {
  title: 'Primitives/DaySeparator',
  component: 'slicc-day-separator',
  tags: ['autodocs'],
  argTypes: {
    label: { control: 'text', description: 'Uppercase caption shown between the hairlines' },
  },
  render: ({ label }) => {
    const el = document.createElement('slicc-day-separator');
    if (label) el.setAttribute('label', label);
    return el;
  },
};

export default meta;
type Story = StoryObj<DaySeparatorArgs>;

/** Day marker at the top of the cone thread. */
export const Today: Story = { args: { label: 'Today' } };

/** Header for an isolated scoop's sandboxed thread. */
export const ScoopThread: Story = { args: { label: 'researcher scoop' } };

/** Header for a thawed session pulled out of the freezer. */
export const FrozenSession: Story = { args: { label: 'hero redesign · frozen' } };

/** Slotted label content used when the `label` attribute is omitted. */
export const SlottedLabel: Story = {
  render: () => {
    const el = document.createElement('slicc-day-separator');
    el.textContent = 'designer scoop';
    return el;
  },
};
