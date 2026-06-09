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
  parameters: {
    docs: {
      description: {
        component:
          'Thread day divider (prototype `.daylabel`): a centred uppercase caption ' +
          'flanked by 1px `--line` hairlines that fill each side. The host is a flex ' +
          'row; the `::before` / `::after` pseudo-elements draw the lines.',
      },
    },
  },
  // Give the divider room to stretch so the flanking hairlines are visible.
  decorators: [
    (story) => {
      const wrap = document.createElement('div');
      wrap.style.width = '420px';
      wrap.style.maxWidth = '100%';
      wrap.appendChild(story() as HTMLElement);
      return wrap;
    },
  ],
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

/** Header for an isolated scoop's sandboxed thread (`<scoop> scoop`). */
export const ScoopThread: Story = { args: { label: 'researcher scoop' } };

/** Header for a thawed session pulled out of the freezer (`<meta> · frozen`). */
export const FrozenSession: Story = { args: { label: 'hero redesign · frozen' } };

/** Slotted label content used when the `label` attribute is omitted. */
export const SlottedLabel: Story = {
  render: () => {
    const el = document.createElement('slicc-day-separator');
    el.textContent = 'designer scoop';
    return el;
  },
};

/** All three thread states stacked, so the hairlines are easy to eyeball at review. */
export const AllStates: Story = {
  render: () => {
    const wrap = document.createElement('div');
    wrap.style.display = 'flex';
    wrap.style.flexDirection = 'column';
    for (const label of ['Today', 'researcher scoop', 'hero redesign · frozen']) {
      const el = document.createElement('slicc-day-separator');
      el.setAttribute('label', label);
      wrap.append(el);
    }
    return wrap;
  },
};
