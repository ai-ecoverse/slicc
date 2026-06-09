import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-frost-shader.js';

interface FrostArgs {
  coverage: number;
  intensity: number;
}

const meta: Meta<FrostArgs> = {
  title: 'Freezer/Frost Shader',
  component: 'slicc-frost-shader',
  tags: ['autodocs'],
  argTypes: {
    coverage: { control: { type: 'range', min: 0, max: 1, step: 0.05 } },
    intensity: { control: { type: 'range', min: 0, max: 4, step: 0.1 } },
  },
  render: ({ coverage, intensity }) => {
    // The shader is a background; frame it in a sized card so it is visible.
    const box = document.createElement('div');
    box.style.cssText =
      'position:relative;width:420px;height:280px;border-radius:14px;overflow:hidden;border:1px solid var(--line);background:var(--bg);';
    const frost = document.createElement('slicc-frost-shader');
    frost.style.cssText = 'position:absolute;inset:0;';
    if (coverage != null) frost.setAttribute('coverage', String(coverage));
    if (intensity != null) frost.setAttribute('intensity', String(intensity));
    box.appendChild(frost);
    return box;
  },
};

export default meta;
type Story = StoryObj<FrostArgs>;

export const Growing: Story = { args: { coverage: 0.55, intensity: 1 } };
export const EarlyFrost: Story = { args: { coverage: 0.3, intensity: 1 } };
export const FullyFrozen: Story = { args: { coverage: 1, intensity: 1.4 } };
