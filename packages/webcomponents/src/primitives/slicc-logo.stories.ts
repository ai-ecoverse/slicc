import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-logo.js';

interface LogoArgs {
  badge?: string;
}

const meta: Meta<LogoArgs> = {
  title: 'Primitives/Logo',
  component: 'slicc-logo',
  tags: ['autodocs'],
  argTypes: {
    badge: { control: 'text', description: 'Optional rainbow-gradient suffix badge' },
  },
  render: ({ badge }) => {
    const el = document.createElement('slicc-logo');
    if (badge) el.setAttribute('badge', badge);
    return el;
  },
};

export default meta;
type Story = StoryObj<LogoArgs>;

export const Default: Story = { args: {} };
export const WithBadge: Story = { args: { badge: 'beta' } };
