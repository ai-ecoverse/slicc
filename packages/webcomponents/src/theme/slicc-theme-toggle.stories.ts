import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-theme-toggle.js';

interface ThemeToggleArgs {
  theme: 'light' | 'dark';
}

const meta: Meta<ThemeToggleArgs> = {
  title: 'Theme/ThemeToggle',
  component: 'slicc-theme-toggle',
  tags: ['autodocs'],
  argTypes: {
    theme: {
      control: { type: 'inline-radio' },
      options: ['light', 'dark'],
      description: 'Initial resolved theme (the control then owns body.dark on click)',
    },
  },
  render: ({ theme }) => {
    const el = document.createElement('slicc-theme-toggle');
    if (theme) el.setAttribute('theme', theme);
    return el;
  },
};

export default meta;
type Story = StoryObj<ThemeToggleArgs>;

export const Light: Story = { args: { theme: 'light' } };

export const Dark: Story = { args: { theme: 'dark' } };

export const BothStates: Story = {
  render: () => {
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.gap = '16px';
    row.style.alignItems = 'center';
    for (const theme of ['light', 'dark'] as const) {
      const wrap = document.createElement('div');
      wrap.style.display = 'flex';
      wrap.style.flexDirection = 'column';
      wrap.style.alignItems = 'center';
      wrap.style.gap = '6px';
      wrap.style.font = '12px ui-sans-serif, system-ui, sans-serif';
      const el = document.createElement('slicc-theme-toggle');
      el.setAttribute('theme', theme);
      const caption = document.createElement('span');
      caption.textContent = theme === 'light' ? 'light → moon' : 'dark → sun';
      wrap.append(el, caption);
      row.appendChild(wrap);
    }
    return row;
  },
};
