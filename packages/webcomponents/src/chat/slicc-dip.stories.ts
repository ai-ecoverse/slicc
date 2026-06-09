import type { Meta, StoryObj } from '@storybook/web-components-vite';
import '../memory/slicc-palette-cell.js';
import './slicc-dip.js';

interface DipArgs {
  name: string;
  hue: string;
  prompt: string;
}

const meta: Meta<DipArgs> = {
  title: 'Chat/Dip',
  component: 'slicc-dip',
  tags: ['autodocs'],
  argTypes: {
    name: { control: 'text' },
    hue: { control: 'color' },
    prompt: { control: 'text' },
  },
  render: ({ name, hue, prompt }) => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'max-width:520px;';
    const dip = document.createElement('slicc-dip');
    if (name) dip.setAttribute('name', name);
    if (hue) dip.setAttribute('hue', hue);
    if (prompt) dip.setAttribute('prompt', prompt);
    wrap.appendChild(dip);
    return wrap;
  },
};

export default meta;
type Story = StoryObj<DipArgs>;

export const Default: Story = { args: { name: 'palette.shtml' } };
export const VioletHue: Story = { args: { name: 'palette.shtml', hue: '#8b5cf6' } };
export const CyanHue: Story = {
  args: { name: 'theme.shtml', hue: '#06b6d4', prompt: 'Pick a canvas and an accent:' },
};
