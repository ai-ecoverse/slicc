import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-tab.js';

interface TabArgs {
  'tab-id'?: string;
  kind?: 'tool' | 'sprinkle';
  active?: boolean;
  closable?: boolean;
  badge?: string;
  glyph?: string;
  label?: string;
}

const meta: Meta<TabArgs> = {
  title: 'Workbench/Tab',
  component: 'slicc-tab',
  tags: ['autodocs'],
  argTypes: {
    'tab-id': { control: 'text', description: 'Identifier on select/close detail (and data-t)' },
    kind: {
      control: 'inline-radio',
      options: ['tool', 'sprinkle'],
      description: 'Tool (plain) or sprinkle (defined chip + sparkle badge)',
    },
    active: { control: 'boolean', description: 'Selected `.on` state' },
    closable: { control: 'boolean', description: 'Render the `.x` close affordance' },
    badge: { control: 'text', description: 'Sprinkle badge glyph (sprinkle kind)' },
    glyph: { control: 'text', description: 'Leading `.gl` glyph (tool kind)' },
    label: { control: 'text', description: 'Tab label' },
  },
  render: ({ 'tab-id': tabId, kind, active, closable, badge, glyph, label }) => {
    const el = document.createElement('slicc-tab');
    if (tabId) el.setAttribute('tab-id', tabId);
    if (kind) el.setAttribute('kind', kind);
    if (active) el.setAttribute('active', '');
    if (closable) el.setAttribute('closable', '');
    if (badge) el.setAttribute('badge', badge);
    if (glyph) el.setAttribute('glyph', glyph);
    if (label != null) el.setAttribute('label', label);
    return el;
  },
};

export default meta;
type Story = StoryObj<TabArgs>;

/** Tool tab, idle — a quiet ghost chip. */
export const ToolIdle: Story = { args: { kind: 'tool', label: 'Files', 'tab-id': 'files' } };

/** Tool tab, active — `.on`: ink text on the `--ghost` fill. */
export const ToolActive: Story = {
  args: { kind: 'tool', label: 'Files', 'tab-id': 'files', active: true },
};

/** Tool tab with a leading `.gl` glyph (e.g. a terminal prompt). */
export const ToolWithGlyph: Story = {
  args: { kind: 'tool', label: 'Terminal', 'tab-id': 'term', glyph: '>_' },
};

/** Sprinkle tab, idle — a defined `--canvas` chip with the rainbow sparkle badge. */
export const SprinkleIdle: Story = {
  args: { kind: 'sprinkle', label: 'Hero studio', 'tab-id': 'hero' },
};

/** Sprinkle tab, active — violet-tinted `.sp.on` fill + border. */
export const SprinkleActive: Story = {
  args: { kind: 'sprinkle', label: 'Hero studio', 'tab-id': 'hero', active: true },
};

/** Sprinkle tab with the close affordance (the prototype tab-strip look). */
export const SprinkleClosable: Story = {
  args: { kind: 'sprinkle', label: 'palette', 'tab-id': 'palette', closable: true },
};

/** Active, closable sprinkle tab — the fully-loaded chip. */
export const SprinkleActiveClosable: Story = {
  args: { kind: 'sprinkle', label: 'Hero studio', 'tab-id': 'hero', active: true, closable: true },
};

/**
 * A realistic populated tab strip, matching the prototype `.tabstrip`: tool
 * tabs then a divider then sprinkle tabs, with one sprinkle active.
 */
export const TabStrip: Story = {
  render: () => {
    const strip = document.createElement('div');
    strip.style.cssText =
      'display:flex;align-items:center;gap:4px;padding:8px 12px;border-bottom:1px solid var(--line);font-family:var(--ui);';

    const tool = (id: string, label: string, glyph: string, active = false): HTMLElement => {
      const t = document.createElement('slicc-tab');
      t.setAttribute('tab-id', id);
      t.setAttribute('label', label);
      t.setAttribute('glyph', glyph);
      if (active) t.setAttribute('active', '');
      return t;
    };
    const sprinkle = (id: string, label: string, active = false): HTMLElement => {
      const t = document.createElement('slicc-tab');
      t.setAttribute('tab-id', id);
      t.setAttribute('kind', 'sprinkle');
      t.setAttribute('label', label);
      t.setAttribute('closable', '');
      if (active) t.setAttribute('active', '');
      return t;
    };

    const divider = document.createElement('span');
    divider.style.cssText =
      'width:1px;height:18px;background:var(--line);margin:0 4px;flex:0 0 auto;';

    strip.append(
      tool('files', 'Files', '⌗', true),
      tool('term', 'Terminal', '>_'),
      divider,
      sprinkle('hero', 'Hero studio', true),
      sprinkle('palette', 'palette')
    );
    return strip;
  },
};
