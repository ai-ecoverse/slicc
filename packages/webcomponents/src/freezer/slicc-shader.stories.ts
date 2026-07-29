import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { type ShaderMode, SUGAR_GLASS_PRESETS, type SugarGlassPresetName } from './slicc-shader.js';

interface ShaderArgs {
  mode: ShaderMode;
  tint: string;
  coverage: number;
  brightness: number;
  contrast: number;
  noise: number;
  blur: number;
}

const WAFFLE_CURRENT = {
  mode: 'cone',
  tint: '#b07823',
  coverage: 0.66,
  brightness: 1.2,
  contrast: 0.75,
  noise: 0.04,
  blur: 0.09,
} as const satisfies Readonly<ShaderArgs>;

const PRESET_LABELS: Readonly<Record<SugarGlassPresetName, string>> = {
  caramel: 'Caramel',
  frosted: 'Frosted',
  brittle: 'Brittle',
  'waffle-glass': 'Waffle-glass',
};

const CHAT_HEADING = 'Reviewing the assistant’s plan';
const CHAT_PARAGRAPHS = [
  'I traced the request through the current shell and found the smallest safe change. The existing conversation layout can stay in place while the background treatment is reviewed.',
  'Next I would verify the result in both themes, read the final diff, and call out any remaining risk before asking you to choose a direction.',
] as const;

function applyShaderAttributes(shader: HTMLElement, args: Readonly<ShaderArgs>): void {
  for (const [name, value] of Object.entries(args)) shader.setAttribute(name, String(value));
}

function createShader(args: Readonly<ShaderArgs>): HTMLElement {
  const shader = document.createElement('slicc-shader');
  shader.style.cssText = 'position:absolute;inset:0;';
  applyShaderAttributes(shader, args);
  return shader;
}

function attributeCaption(args: Readonly<ShaderArgs>): string {
  return Object.entries(args)
    .map(([name, value]) => `${name}=${value}`)
    .join(' · ');
}

function createStoryboardPanel(label: string, args: Readonly<ShaderArgs>): HTMLElement {
  const panel = document.createElement('article');
  panel.className = 'storyboard-panel';
  panel.appendChild(createShader(args));

  const caption = document.createElement('header');
  caption.className = 'storyboard-caption';
  const title = document.createElement('h3');
  title.textContent = label;
  const attributes = document.createElement('p');
  attributes.textContent = attributeCaption(args);
  caption.append(title, attributes);

  const prose = document.createElement('section');
  prose.className = 'storyboard-prose';
  const heading = document.createElement('h4');
  heading.textContent = CHAT_HEADING;
  prose.appendChild(heading);
  for (const copy of CHAT_PARAGRAPHS) {
    const paragraph = document.createElement('p');
    paragraph.textContent = copy;
    prose.appendChild(paragraph);
  }
  panel.append(caption, prose);
  return panel;
}

function createStoryboard(): HTMLElement {
  const root = document.createElement('div');
  root.className = 'storyboard-root';
  const style = document.createElement('style');
  style.textContent = `
    .storyboard-root { width: 100%; min-width: 1276px; min-height: 608px; background: var(--canvas); color: var(--ink); }
    .storyboard-grid { display: grid; grid-template-columns: repeat(3, minmax(420px, 1fr)); gap: 8px; }
    .storyboard-panel { position: relative; box-sizing: border-box; min-width: 420px; height: 300px; overflow: hidden; border: 1px solid var(--line); background: var(--bg); color: var(--ink); }
    .storyboard-caption, .storyboard-prose { position: relative; z-index: 1; }
    .storyboard-caption { padding: 12px 16px 0; }
    .storyboard-caption h3 { margin: 0 0 4px; font: 700 15px/1.25 system-ui, sans-serif; letter-spacing: 0.01em; }
    .storyboard-caption p { margin: 0; color: var(--txt-2); font: 500 11px/1.35 ui-monospace, monospace; overflow-wrap: anywhere; }
    .storyboard-prose { max-width: 48ch; padding: 15px 20px 18px; font: 400 15px/1.45 system-ui, sans-serif; }
    .storyboard-prose h4 { margin: 0 0 8px; font: 700 17px/1.3 system-ui, sans-serif; }
    .storyboard-prose p { margin: 0 0 8px; }
  `;
  const grid = document.createElement('main');
  grid.className = 'storyboard-grid';
  grid.appendChild(createStoryboardPanel('Waffle (current)', WAFFLE_CURRENT));
  for (const [name, preset] of Object.entries(SUGAR_GLASS_PRESETS)) {
    grid.appendChild(createStoryboardPanel(PRESET_LABELS[name as SugarGlassPresetName], preset));
  }
  root.append(style, grid);
  return root;
}

const meta: Meta<ShaderArgs> = {
  title: 'Freezer/Shader',
  component: 'slicc-shader',
  tags: ['autodocs'],
  argTypes: {
    mode: { control: 'inline-radio', options: ['cone', 'scoop', 'freezer', 'sugar'] },
    tint: { control: 'color' },
    coverage: { control: { type: 'range', min: 0, max: 1, step: 0.05 } },
    brightness: { control: { type: 'range', min: 0.5, max: 1.5, step: 0.01 } },
    contrast: { control: { type: 'range', min: 0.5, max: 2, step: 0.01 } },
    noise: { control: { type: 'range', min: 0, max: 0.3, step: 0.01 } },
    blur: { control: { type: 'range', min: 0, max: 1, step: 0.01 } },
  },
  render: (args) => {
    const box = document.createElement('div');
    box.style.cssText =
      'position:relative;width:520px;height:320px;border-radius:14px;overflow:hidden;border:1px solid var(--line);background:var(--bg);';
    box.appendChild(createShader(args));
    return box;
  },
};

export default meta;
type Story = StoryObj<ShaderArgs>;

/** Five-up comparison board with real chat prose over every candidate field. */
export const Storyboard: Story = {
  name: 'STORYBOARD',
  parameters: { layout: 'fullscreen', controls: { disable: true } },
  render: () => createStoryboard(),
};

/** Cone — the sheared waffle lattice behind the cone/chat context. */
export const Cone: Story = {
  args: { ...WAFFLE_CURRENT },
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

/** Sugar Glass — warm amber cells and visible crack light. */
export const Caramel: Story = { args: { ...SUGAR_GLASS_PRESETS.caramel } };
/** Sugar Glass — broad quiet seams tuned for prose legibility. */
export const Frosted: Story = { args: { ...SUGAR_GLASS_PRESETS.frosted } };
/** Sugar Glass — dense sharp fractures with low glass fill. */
export const Brittle: Story = { args: { ...SUGAR_GLASS_PRESETS.brittle } };
/** Sugar Glass — the sugar treatment over the familiar waffle geometry. */
export const WaffleGlass: Story = { args: { ...SUGAR_GLASS_PRESETS['waffle-glass'] } };
