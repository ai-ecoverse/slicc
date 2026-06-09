import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-shader.js';

interface ShaderArgs {
  mode: 'cone' | 'scoop' | 'freezer';
  tint: string;
  coverage: number;
}

const meta: Meta<ShaderArgs> = {
  title: 'Freezer/Shader',
  component: 'slicc-shader',
  tags: ['autodocs'],
  argTypes: {
    mode: { control: 'inline-radio', options: ['cone', 'scoop', 'freezer'] },
    tint: { control: 'color' },
    coverage: { control: { type: 'range', min: 0, max: 1, step: 0.05 } },
  },
  render: ({ mode, tint, coverage }) => {
    const box = document.createElement('div');
    box.style.cssText =
      'position:relative;width:520px;height:320px;border-radius:14px;overflow:hidden;border:1px solid var(--line);background:var(--bg);';
    const s = document.createElement('slicc-shader');
    s.style.cssText = 'position:absolute;inset:0;';
    s.setAttribute('mode', mode);
    if (tint) s.setAttribute('tint', tint);
    if (coverage != null) s.setAttribute('coverage', String(coverage));
    box.appendChild(s);
    return box;
  },
};

export default meta;
type Story = StoryObj<ShaderArgs>;

/** Cone — the sheared waffle lattice behind the cone/chat context. */
export const Cone: Story = { args: { mode: 'cone', tint: '#b07823', coverage: 0.66 } };
/** Scoop — the flowing ice-cream swirl, tinted to the active scoop accent. */
export const Scoop: Story = { args: { mode: 'scoop', tint: '#f43f5e', coverage: 0.66 } };
/** Freezer — frost crystallizing from the corner. */
export const Freezer: Story = { args: { mode: 'freezer', tint: '#3b6cb2', coverage: 0.85 } };
