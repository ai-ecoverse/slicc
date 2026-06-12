import type { Meta, StoryObj } from '@storybook/web-components-vite';
// Compose the dock-item BY TAG — importing its side-effect module so the rendered
// `<slicc-dock-item>` rail buttons upgrade in Storybook (the dock creates them).
import './slicc-dock-item.js';
import type { DockItemDescriptor, SliccDock } from './slicc-dock.js';
import './slicc-dock.js';

interface DockArgs {
  /** The sprinkle launchers shown at the top of the rail. */
  items?: DockItemDescriptor[];
  /** Active item id (lit/on). */
  active?: string;
  /** Append the pinned Browser/Files/Terminal/Memory system tools at the bottom. */
  systemTools?: boolean;
  /** Rail height (the launcher rail fills the shell height). */
  height?: number;
}

/** The prototype's default sprinkle launchers (hero = violet, palette = amber). */
const SPRINKLES: DockItemDescriptor[] = [
  { id: 'hero', icon: 'sparkles', label: 'Hero studio', kind: 'sprinkle', hue: 'var(--violet)' },
  { id: 'palette', icon: 'palette', label: 'palette', kind: 'sprinkle', hue: 'var(--amber)' },
];

/**
 * Mount the dock against a faux shell body so the always-visible 48px rail, its
 * `--ctx`-tinted background, the `border-left` hairline, and the `.grow`-anchored
 * system tools read in their real prototype context (the rail is the right column
 * of `.shell`). The reading area to the left is a neutral placeholder.
 */
function buildDock({
  items = SPRINKLES,
  active = 'hero',
  systemTools = true,
  height = 520,
}: DockArgs): HTMLElement {
  const shell = document.createElement('div');
  shell.style.cssText =
    'display:flex;align-items:stretch;' +
    `height:${height}px;background:var(--bg);` +
    'border:1px solid var(--line);border-radius:14px;overflow:hidden;' +
    'box-shadow:var(--shadow-pane);font-family:var(--ui);box-sizing:border-box;';

  const reading = document.createElement('div');
  reading.style.cssText =
    'flex:1;min-width:0;display:flex;align-items:center;justify-content:center;' +
    'color:var(--txt-3);font-size:13px;background:var(--canvas);';
  reading.textContent = 'reading area';
  shell.appendChild(reading);

  const dock = document.createElement('slicc-dock') as SliccDock;
  dock.items = items;
  if (active) dock.active = active;
  dock.systemTools = systemTools;
  shell.appendChild(dock);

  return shell;
}

const meta: Meta<DockArgs> = {
  title: 'Dock/Dock',
  tags: ['autodocs'],
  argTypes: {
    active: {
      control: 'inline-radio',
      options: ['hero', 'palette', 'new', 'browser', 'files', 'term', 'memory'],
      description: 'Active (lit) item id',
    },
    systemTools: {
      control: 'boolean',
      description: 'Append the pinned Browser/Files/Terminal/Memory tools',
    },
    height: {
      control: { type: 'number', min: 240, max: 800, step: 20 },
      description: 'Rail height (fills the shell)',
    },
  },
  render: buildDock,
};

export default meta;
type Story = StoryObj<DockArgs>;

/** The full rail: sprinkles + New, the grow spacer, the divider, and pinned tools. */
export const Default: Story = {
  args: { items: SPRINKLES, active: 'hero', systemTools: true },
};

/** Just the sprinkle launchers + the New + (no pinned system tools). */
export const SprinklesOnly: Story = {
  args: { items: SPRINKLES, active: undefined, systemTools: false },
};

/** Only the pinned system tools below the New launcher (no sprinkles yet). */
export const SystemTools: Story = {
  args: { items: [], active: undefined, systemTools: true },
};

/** A sprinkle is active/lit — the hero studio panel is open. */
export const ActiveSprinkle: Story = {
  args: { items: SPRINKLES, active: 'hero', systemTools: true },
};

/** A pinned system tool is active — the Files panel is open. */
export const ActiveTool: Story = {
  args: { items: SPRINKLES, active: 'files', systemTools: true },
};

/** Nothing selected (collapsed shell) — the rail is idle, all items at rest. */
export const Collapsed: Story = {
  args: { items: SPRINKLES, active: undefined, systemTools: true },
};

/** A fuller sprinkle roster pushing the New + and tools down the rail. */
export const ManySprinkles: Story = {
  args: {
    items: [
      ...SPRINKLES,
      { id: 'chart', icon: 'chart-pie', label: 'chart', kind: 'sprinkle', hue: 'var(--cyan)' },
      { id: 'notes', icon: 'notebook-pen', label: 'notes', kind: 'sprinkle', hue: 'var(--rose)' },
    ],
    active: 'palette',
    systemTools: true,
  },
};
