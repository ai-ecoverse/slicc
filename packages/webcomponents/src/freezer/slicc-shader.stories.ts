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
  speed: number;
}

const PRESET_LABELS: Readonly<Record<SugarGlassPresetName, string>> = {
  caramel: 'Caramel',
  'caramel-soft': 'Caramel — soft tone',
  frosted: 'Frosted',
  brittle: 'Brittle',
  'waffle-glass': 'Waffle-glass',
};

const CHAT_HEADING = 'Reviewing the assistant’s plan';
const CHAT_PARAGRAPHS = [
  'I traced the request through the current shell and found the smallest safe change. The existing conversation layout can stay in place while the background treatment is reviewed.',
  'Next I would verify the result in both themes, read the final diff, and call out any remaining risk before asking you to choose a direction.',
] as const;

type NumericShaderAttribute = Exclude<keyof ShaderArgs, 'mode' | 'tint'>;
type ControlAttribute = NumericShaderAttribute | 'tint';

const NUMERIC_CONTROLS: ReadonlyArray<{
  name: NumericShaderAttribute;
  label: string;
  min: number;
  max: number;
  step: number;
}> = [
  { name: 'coverage', label: 'Coverage', min: 0, max: 1, step: 0.01 },
  { name: 'brightness', label: 'Brightness', min: 0.5, max: 1.5, step: 0.01 },
  { name: 'contrast', label: 'Contrast', min: 0.5, max: 2, step: 0.01 },
  { name: 'noise', label: 'Noise', min: 0, max: 0.3, step: 0.005 },
  { name: 'blur', label: 'Blur', min: 0, max: 1, step: 0.01 },
  { name: 'speed', label: 'Speed', min: 0, max: 2, step: 0.05 },
];

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

function formatControlValue(name: ControlAttribute, value: string | number): string {
  if (name === 'tint') return String(value).toUpperCase();
  return Number(value).toFixed(name === 'noise' ? 3 : 2);
}

function createControlRow(
  panelLabel: string,
  label: string,
  input: HTMLInputElement,
  output: HTMLOutputElement
): HTMLElement {
  const row = document.createElement('label');
  row.className = 'storyboard-control';
  const text = document.createElement('span');
  text.textContent = label;
  input.setAttribute('aria-label', `${panelLabel} ${label}`);
  row.append(text, input, output);
  return row;
}

function createStoryboardPanel(
  label: string,
  args: Readonly<ShaderArgs>,
  interactive = false
): HTMLElement {
  const panel = document.createElement('article');
  panel.className = 'storyboard-panel';
  if (interactive) panel.classList.add('playground-panel');
  const shader = createShader(args);
  panel.appendChild(shader);

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
  if (interactive) {
    const current: ShaderArgs = { ...args };
    const inputs = new Map<ControlAttribute, HTMLInputElement>();
    const outputs = new Map<ControlAttribute, HTMLOutputElement>();
    const controls = document.createElement('form');
    controls.className = 'storyboard-controls';
    controls.addEventListener('submit', (event) => event.preventDefault());

    const addControl = (
      name: ControlAttribute,
      controlLabel: string,
      input: HTMLInputElement
    ): void => {
      const output = document.createElement('output');
      const update = (): void => {
        const value = name === 'tint' ? input.value : Number(input.value);
        Object.assign(current, { [name]: value });
        shader.setAttribute(name, String(value));
        output.textContent = formatControlValue(name, value);
        attributes.textContent = attributeCaption(current);
      };
      input.addEventListener('input', update);
      output.textContent = formatControlValue(name, current[name]);
      inputs.set(name, input);
      outputs.set(name, output);
      controls.appendChild(createControlRow(label, controlLabel, input, output));
    };

    const tint = document.createElement('input');
    tint.type = 'color';
    tint.value = args.tint;
    addControl('tint', 'Tint', tint);
    for (const spec of NUMERIC_CONTROLS) {
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(spec.min);
      input.max = String(spec.max);
      input.step = String(spec.step);
      input.value = String(args[spec.name]);
      addControl(spec.name, spec.label, input);
    }

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'storyboard-reset';
    reset.textContent = 'Reset to preset';
    reset.addEventListener('click', () => {
      Object.assign(current, args);
      applyShaderAttributes(shader, args);
      for (const [name, input] of inputs) {
        input.value = String(args[name]);
        const output = outputs.get(name);
        if (output) output.textContent = formatControlValue(name, args[name]);
      }
      attributes.textContent = attributeCaption(current);
    });
    controls.appendChild(reset);
    panel.appendChild(controls);
  }
  return panel;
}

function createStoryboard(interactive = false): HTMLElement {
  const root = document.createElement('div');
  root.className = 'storyboard-root';
  if (interactive) root.classList.add('playground-root');
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
    .playground-panel { height: 488px; }
    .storyboard-controls { position: relative; z-index: 1; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 9px 14px; margin: 0 16px 12px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; background: color-mix(in srgb, var(--bg) 88%, transparent); box-shadow: var(--shadow-pane); }
    .storyboard-control { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 4px 6px; min-width: 0; color: var(--txt-2); font: 600 10px/1.2 system-ui, sans-serif; }
    .storyboard-control input { grid-column: 1 / -1; width: 100%; min-width: 0; accent-color: var(--ctx); }
    .storyboard-control input[type='color'] { box-sizing: border-box; width: 100%; height: 22px; padding: 2px; border: 1px solid var(--line); border-radius: 5px; background: var(--canvas); }
    .storyboard-control output { grid-column: 2; grid-row: 1; color: var(--ink); font: 600 10px/1.2 ui-monospace, monospace; text-align: right; }
    .storyboard-reset { grid-column: 1 / -1; min-height: var(--ctl-h); border: 1px solid var(--line); border-radius: 7px; background: var(--ghost); color: var(--ink); font: 650 11px/1 system-ui, sans-serif; cursor: pointer; }
    .storyboard-reset:hover { background: var(--desk); }
  `;
  const grid = document.createElement('main');
  grid.className = 'storyboard-grid';
  for (const [name, preset] of Object.entries(SUGAR_GLASS_PRESETS)) {
    grid.appendChild(
      createStoryboardPanel(PRESET_LABELS[name as SugarGlassPresetName], preset, interactive)
    );
  }
  root.append(style, grid);
  return root;
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
    speed: { control: { type: 'range', min: 0, max: 2, step: 0.05 } },
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

/** Static comparison board with real chat prose over every candidate field. */
export const Storyboard: Story = {
  name: 'STORYBOARD',
  parameters: { layout: 'fullscreen', controls: { disable: true } },
  render: () => createStoryboard(),
};

/** Five-up live comparison: every retained preset owns an isolated control set. */
export const Playground: Story = {
  name: 'PLAYGROUND',
  parameters: { layout: 'fullscreen', controls: { disable: true } },
  render: () => createStoryboard(true),
};

/** Cone — the default Caramel Sugar Glass field behind the cone/chat context. */
export const Cone: Story = {
  args: { mode: 'cone' },
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
    speed: 1,
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
    speed: 1,
  },
};

/** Sugar Glass — Caramel color and texture with a softer tone. */
export const CaramelSoft: Story = { args: { ...SUGAR_GLASS_PRESETS['caramel-soft'] } };
/** Sugar Glass — broad quiet seams tuned for prose legibility. */
export const Frosted: Story = { args: { ...SUGAR_GLASS_PRESETS.frosted } };
/** Sugar Glass — dense sharp fractures with low glass fill. */
export const Brittle: Story = { args: { ...SUGAR_GLASS_PRESETS.brittle } };
/** Sugar Glass — the sugar treatment over the familiar waffle geometry. */
export const WaffleGlass: Story = { args: { ...SUGAR_GLASS_PRESETS['waffle-glass'] } };
