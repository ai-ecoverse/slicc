import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-shader.js';

interface ShaderArgs {
  mode: 'cone' | 'scoop' | 'freezer';
  tint: string;
  coverage: number;
  brightness: number;
  contrast: number;
  noise: number;
  blur: number;
}

const meta: Meta<ShaderArgs> = {
  title: 'Freezer/Shader',
  component: 'slicc-shader',
  tags: ['autodocs'],
  argTypes: {
    mode: { control: 'inline-radio', options: ['cone', 'scoop', 'freezer'] },
    tint: { control: 'color' },
    coverage: { control: { type: 'range', min: 0, max: 1, step: 0.05 } },
    brightness: { control: { type: 'range', min: 0.5, max: 1.5, step: 0.01 } },
    contrast: { control: { type: 'range', min: 0.5, max: 2, step: 0.01 } },
    noise: { control: { type: 'range', min: 0, max: 0.3, step: 0.01 } },
    blur: { control: { type: 'range', min: 0, max: 1, step: 0.01 } },
  },
  render: ({ mode, tint, coverage, brightness, contrast, noise, blur }) => {
    const box = document.createElement('div');
    box.style.cssText =
      'position:relative;width:520px;height:320px;border-radius:14px;overflow:hidden;border:1px solid var(--line);background:var(--bg);';
    const s = document.createElement('slicc-shader');
    s.style.cssText = 'position:absolute;inset:0;';
    s.setAttribute('mode', mode);
    if (tint) s.setAttribute('tint', tint);
    if (coverage != null) s.setAttribute('coverage', String(coverage));
    if (brightness != null) s.setAttribute('brightness', String(brightness));
    if (contrast != null) s.setAttribute('contrast', String(contrast));
    if (noise != null) s.setAttribute('noise', String(noise));
    if (blur != null) s.setAttribute('blur', String(blur));
    box.appendChild(s);
    return box;
  },
};

export default meta;
type Story = StoryObj<ShaderArgs>;

/** Cone — the sheared waffle lattice behind the cone/chat context. */
export const Cone: Story = {
  args: {
    mode: 'cone',
    tint: '#b07823',
    coverage: 0.66,
    brightness: 1,
    contrast: 1,
    noise: 0,
    blur: 0,
  },
};
/** Scoop — the flowing ice-cream swirl, tinted to the active scoop accent. */
export const Scoop: Story = {
  args: {
    mode: 'scoop',
    tint: '#f43f5e',
    coverage: 0.66,
    brightness: 1,
    contrast: 1,
    noise: 0,
    blur: 0,
  },
};
/** Freezer — frost crystallizing from the corner. */
export const Freezer: Story = {
  args: {
    mode: 'freezer',
    tint: '#3b6cb2',
    coverage: 0.85,
    brightness: 1,
    contrast: 1,
    noise: 0,
    blur: 0,
  },
};
