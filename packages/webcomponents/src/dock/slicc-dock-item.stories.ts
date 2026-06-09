import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-dock-item.js';

interface DockItemArgs {
  itemId?: string;
  kind?: 'tool' | 'sprinkle';
  hue?: string;
  icon?: string;
  tip?: string;
  active?: boolean;
  lit?: boolean;
}

const meta: Meta<DockItemArgs> = {
  title: 'Dock/DockItem',
  component: 'slicc-dock-item',
  tags: ['autodocs'],
  argTypes: {
    itemId: {
      control: 'text',
      description: 'Logical launcher id (prototype data-t), echoed in events',
    },
    kind: {
      control: 'inline-radio',
      options: ['tool', 'sprinkle'],
      description: 'sprinkle adds the colored status dot',
    },
    hue: { control: 'color', description: 'Per-kind accent (--h); defaults to var(--violet)' },
    icon: {
      control: 'select',
      options: [
        'sparkles',
        'globe',
        'layout',
        'folder',
        'square-terminal',
        'brain',
        'database',
        'plus',
        'square',
      ],
      description: 'lucide icon name (kebab-case); default `square`',
    },
    tip: { control: 'text', description: 'Tooltip label shown on hover' },
    active: { control: 'boolean', description: 'Open/active state (.di.on) — ctx glow' },
    lit: {
      control: 'boolean',
      description: 'Transient lit state (.di.lit) — kind-hue ring + tint',
    },
  },
  render: ({ itemId, kind, hue, icon, tip, active, lit }) => {
    const el = document.createElement('slicc-dock-item');
    if (itemId) el.setAttribute('item-id', itemId);
    if (kind) el.setAttribute('kind', kind);
    if (hue) el.setAttribute('hue', hue);
    if (icon) el.setAttribute('icon', icon);
    if (tip) el.setAttribute('tip', tip);
    if (active) el.toggleAttribute('active', true);
    if (lit) el.toggleAttribute('lit', true);
    return el;
  },
};

export default meta;
type Story = StoryObj<DockItemArgs>;

/** Idle tool launcher — transparent, muted lucide glyph. Hover for the tooltip. */
export const Tool: Story = {
  args: { itemId: 'browser', icon: 'globe', tip: 'Browser · CDP' },
};

/** Active/open tool (.di.on) — ctx-tinted fill, ring and outer glow. */
export const ToolActive: Story = {
  args: { itemId: 'files', icon: 'folder', tip: 'Files · VFS', active: true },
};

/** Lit tool (.di.lit) — a transient kind-hue ring + tint (here violet). */
export const ToolLit: Story = {
  args: { itemId: 'memory', icon: 'brain', tip: 'Memory', lit: true },
};

/** The "new sprinkle" plus launcher — a tool launcher with no status dot. */
export const NewSprinkle: Story = {
  args: { icon: 'plus', tip: 'New sprinkle' },
};

/** Sprinkle launcher (.di.sp) — `sparkles` glyph plus a violet status dot (default hue). */
export const Sprinkle: Story = {
  args: { itemId: 'hero', kind: 'sprinkle', icon: 'sparkles', tip: 'Hero studio', hue: '#8b5cf6' },
};

/** Amber sprinkle (the prototype palette launcher) — status dot in --h. */
export const SprinkleAmber: Story = {
  args: { itemId: 'palette', kind: 'sprinkle', icon: 'sparkles', tip: 'palette', hue: '#f59e0b' },
};

/** Active sprinkle — open surface glow plus the kind status dot. */
export const SprinkleActive: Story = {
  args: {
    itemId: 'hero',
    kind: 'sprinkle',
    icon: 'sparkles',
    tip: 'Hero studio',
    hue: '#8b5cf6',
    active: true,
  },
};

/** Lit sprinkle — transient ring + tint in the sprinkle's hue (amber here). */
export const SprinkleLit: Story = {
  args: {
    itemId: 'palette',
    kind: 'sprinkle',
    icon: 'sparkles',
    tip: 'palette',
    hue: '#f59e0b',
    lit: true,
  },
};

/**
 * The lucide mapping for the prototype's hand-drawn dock glyphs, laid out as a
 * legend: sprinkles → `sparkles`, browser → `globe` (or `layout`), files →
 * `folder`, terminal → `square-terminal`, memory → `brain` (or `database`),
 * new → `plus`.
 */
export const IconMapping: Story = {
  render: () => {
    const row = document.createElement('div');
    Object.assign(row.style, {
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: '14px',
      padding: '12px',
      fontFamily: 'var(--ui)',
      color: 'var(--ink)',
    } as Partial<CSSStyleDeclaration>);

    const items: Array<{ icon: string; tip: string; kind?: 'sprinkle' }> = [
      { icon: 'sparkles', tip: 'sprinkles → sparkles', kind: 'sprinkle' },
      { icon: 'globe', tip: 'browser → globe' },
      { icon: 'layout', tip: 'browser → layout' },
      { icon: 'folder', tip: 'files → folder' },
      { icon: 'square-terminal', tip: 'terminal → square-terminal' },
      { icon: 'brain', tip: 'memory → brain' },
      { icon: 'database', tip: 'memory → database' },
      { icon: 'plus', tip: 'new → plus' },
    ];

    for (const { icon, tip, kind } of items) {
      const cell = document.createElement('div');
      Object.assign(cell.style, {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '4px',
        fontSize: '10px',
        color: 'var(--txt-2)',
      } as Partial<CSSStyleDeclaration>);
      const el = document.createElement('slicc-dock-item');
      el.setAttribute('icon', icon);
      el.setAttribute('tip', tip);
      if (kind) el.setAttribute('kind', kind);
      const label = document.createElement('span');
      label.textContent = icon;
      cell.append(el, label);
      row.appendChild(cell);
    }
    return row;
  },
};

/** The full prototype dock rail, populated — sprinkles up top, tools below a divider. */
export const DockRail: Story = {
  render: () => {
    const dock = document.createElement('div');
    Object.assign(dock.style, {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: '8px',
      background: 'color-mix(in srgb, var(--ctx) 12%, var(--bg))',
      borderLeft: '1px solid var(--line)',
      padding: '10px 0',
      width: '48px',
    } as Partial<CSSStyleDeclaration>);

    const make = (attrs: Record<string, string | boolean>): HTMLElement => {
      const el = document.createElement('slicc-dock-item');
      for (const [k, v] of Object.entries(attrs)) {
        if (typeof v === 'boolean') el.toggleAttribute(k, v);
        else el.setAttribute(k, v);
      }
      return el;
    };

    dock.append(
      make({
        'item-id': 'hero',
        kind: 'sprinkle',
        icon: 'sparkles',
        tip: 'Hero studio',
        hue: '#8b5cf6',
        active: true,
      }),
      make({
        'item-id': 'palette',
        kind: 'sprinkle',
        icon: 'sparkles',
        tip: 'palette',
        hue: '#f59e0b',
      }),
      make({ icon: 'plus', tip: 'New sprinkle' })
    );

    const grow = document.createElement('div');
    grow.style.flex = '1';
    grow.style.minHeight = '40px';
    dock.appendChild(grow);

    const divider = document.createElement('div');
    Object.assign(divider.style, {
      width: '22px',
      height: '1px',
      background: 'var(--line)',
      margin: '2px 0',
    } as Partial<CSSStyleDeclaration>);
    dock.appendChild(divider);

    dock.append(
      make({ 'item-id': 'browser', icon: 'globe', tip: 'Browser · CDP' }),
      make({ 'item-id': 'files', icon: 'folder', tip: 'Files · VFS' }),
      make({ 'item-id': 'term', icon: 'square-terminal', tip: 'Terminal' }),
      make({ 'item-id': 'memory', icon: 'brain', tip: 'Memory' })
    );

    return dock;
  },
};
