import type { Meta, StoryObj } from '@storybook/web-components-vite';

import './slicc-dock-item.js';
import type { DockItemDescriptor, SliccDock } from './slicc-dock.js';
import './slicc-dock.js';

interface DockArgs {
  items?: DockItemDescriptor[];

  active?: string;

  systemTools?: boolean;

  height?: number;
}

const SPRINKLES: DockItemDescriptor[] = [
  { id: 'hero', icon: 'sparkles', label: 'Hero studio', kind: 'sprinkle', hue: 'var(--violet)' },
  { id: 'palette', icon: 'palette', label: 'palette', kind: 'sprinkle', hue: 'var(--amber)' },
];

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
      options: ['hero', 'palette', 'browser', 'files', 'term', 'memory'],
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

export const Default: Story = {
  args: { items: SPRINKLES, active: 'hero', systemTools: true },
};

export const SprinklesOnly: Story = {
  args: { items: SPRINKLES, active: undefined, systemTools: false },
};

export const SystemTools: Story = {
  args: { items: [], active: undefined, systemTools: true },
};

export const ActiveSprinkle: Story = {
  args: { items: SPRINKLES, active: 'hero', systemTools: true },
};

export const ActiveTool: Story = {
  args: { items: SPRINKLES, active: 'files', systemTools: true },
};

export const Collapsed: Story = {
  args: { items: SPRINKLES, active: undefined, systemTools: true },
};

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
