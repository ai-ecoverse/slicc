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

  decorators: [
    (story) => {
      const wrap = document.createElement('div');
      wrap.style.width = '420px';
      wrap.style.maxWidth = '100%';
      wrap.style.padding = '8px 16px';
      wrap.style.background = 'var(--bg)';
      wrap.style.borderRadius = '8px';
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

export const Today: Story = { args: { label: 'Today' } };

export const ScoopThread: Story = { args: { label: 'researcher scoop' } };

export const FrozenSession: Story = { args: { label: 'hero redesign · frozen' } };

export const SlottedLabel: Story = {
  render: () => {
    const el = document.createElement('slicc-day-separator');
    el.textContent = 'designer scoop';
    return el;
  },
};

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
