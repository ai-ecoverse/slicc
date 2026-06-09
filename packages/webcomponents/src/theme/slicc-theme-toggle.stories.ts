import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-theme-toggle.js';

interface ThemeToggleArgs {
  /** Initial resolved theme rendered by the control. */
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

/** Light state: shows the moon glyph (🌙), `aria-pressed="false"`. */
export const Light: Story = { args: { theme: 'light' } };

/** Dark state: shows the sun glyph (☀), `aria-pressed="true"`. */
export const Dark: Story = { args: { theme: 'dark' } };
