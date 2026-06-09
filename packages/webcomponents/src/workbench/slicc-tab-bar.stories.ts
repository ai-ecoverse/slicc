import type { Meta, StoryObj } from '@storybook/web-components-vite';
// Compose the workbench tab BY TAG — importing its side-effect module so the
// `<slicc-tab>` children the bar renders upgrade and paint their own chrome.
import '../workbench/slicc-tab.js';
import type { SliccTabBar, TabDescriptor } from './slicc-tab-bar.js';
import './slicc-tab-bar.js';

interface TabBarArgs {
  /** The ordered tab set. */
  tabs?: TabDescriptor[];
  /** The active tab id. */
  active?: string;
  /** Width of the surrounding `.wbhead` band (narrow → horizontal scroll). */
  width?: number;
}

/** The prototype's default tool tabs, pinned in the dock rail. */
const TOOL_TABS: TabDescriptor[] = [
  { id: 'files', label: 'Files', kind: 'tool', glyph: '◇' },
  { id: 'term', label: 'Terminal', kind: 'tool', glyph: '◇' },
  { id: 'memory', label: 'Memory', kind: 'tool', glyph: '◇' },
];

/** The prototype's sprinkle tabs (`.tab.sp` defined chips, closable). */
const SPRINKLE_TABS: TabDescriptor[] = [
  { id: 'hero', label: 'Hero studio', kind: 'sprinkle', closable: true },
  { id: 'palette', label: 'palette', kind: 'sprinkle', closable: true },
];

/** Tool tabs followed by sprinkle tabs — the full workbench strip with a divider. */
const MIXED_TABS: TabDescriptor[] = [...TOOL_TABS, ...SPRINKLE_TABS];

/** An overflowing set — more tabs than the narrow header can show without scroll. */
const MANY_TABS: TabDescriptor[] = [
  ...TOOL_TABS,
  { id: 'browser', label: 'Browser', kind: 'tool', glyph: '◇' },
  { id: 'hero', label: 'Hero studio', kind: 'sprinkle', closable: true },
  { id: 'palette', label: 'Palette', kind: 'sprinkle', closable: true },
  { id: 'shader', label: 'Shader playground', kind: 'sprinkle', closable: true },
  { id: 'gallery', label: 'Reference gallery', kind: 'sprinkle', closable: true },
];

/**
 * Mount the tab bar inside a faux `.wbhead` band (the workbench header), so the
 * strip reads against its real prototype context: the `.tdiv` divider hairline
 * between tool and sprinkle groups, the spacer, the `tool`/`sprinkle` pin tag
 * (which tracks the active tab's kind), and the collapse control. The
 * `<slicc-tab>` children paint their own chrome from the inherited tokens.
 */
function buildBar({ tabs = MIXED_TABS, active, width }: TabBarArgs): HTMLElement {
  const head = document.createElement('div');
  head.style.cssText =
    'display:flex;align-items:center;gap:6px;padding:8px 12px;' +
    'border-bottom:1px solid var(--line);background:var(--canvas);overflow:hidden;' +
    `box-sizing:border-box;font-family:var(--ui);${width ? `width:${width}px;` : 'width:560px;'}`;

  const bar = document.createElement('slicc-tab-bar') as SliccTabBar;
  bar.tabs = tabs;
  bar.active = active ?? tabs[0]?.id ?? null;

  const spacer = document.createElement('div');
  spacer.style.flex = '1';

  const ptag = document.createElement('span');
  ptag.style.cssText =
    'font-family:var(--ui);font-size:10px;color:var(--violet);' +
    'background:color-mix(in srgb,var(--violet) 12%,#fff);' +
    'border:1px solid color-mix(in srgb,var(--violet) 30%,var(--line));' +
    'border-radius:26px;padding:2px 9px;flex:0 0 auto;';
  const reflectPin = (id: string | null) => {
    const kind = bar.tabs.find((t) => t.id === id)?.kind ?? 'tool';
    ptag.textContent = kind === 'sprinkle' ? 'sprinkle' : 'tool';
  };
  reflectPin(bar.active);
  bar.addEventListener('tab-select', (e) =>
    reflectPin((e as CustomEvent<{ id: string }>).detail.id)
  );

  const col = document.createElement('button');
  col.textContent = '⤡';
  col.style.cssText =
    'flex:0 0 auto;border:1px solid var(--line);background:var(--canvas);border-radius:8px;' +
    'height:28px;padding:0 9px;cursor:pointer;color:var(--txt-2);font-family:var(--ui);font-size:12px;';

  head.append(bar, spacer, ptag, col);
  return head;
}

const meta: Meta<TabBarArgs> = {
  title: 'Workbench/TabBar',
  tags: ['autodocs'],
  argTypes: {
    active: {
      control: 'text',
      description: 'Active tab id',
    },
    width: {
      control: { type: 'number', min: 240, max: 900, step: 20 },
      description: 'Workbench header width (narrow → horizontal scroll)',
    },
  },
  render: buildBar,
};

export default meta;
type Story = StoryObj<TabBarArgs>;

/** Empty strip — no tabs yet (the workbench before anything is opened). */
export const Empty: Story = { args: { tabs: [], active: undefined } };

/** Tool tabs only — the pinned Files / Terminal / Memory surfaces. */
export const ToolTabs: Story = { args: { tabs: TOOL_TABS, active: 'files' } };

/** Sprinkle tabs only — defined `.tab.sp` chips with the ✦ badge, closable. */
export const SprinkleTabs: Story = { args: { tabs: SPRINKLE_TABS, active: 'hero' } };

/**
 * The full workbench strip: tool tabs, a `.tdiv` hairline divider, then the
 * sprinkle chips. A sprinkle chip is active (violet-tinted).
 */
export const Mixed: Story = { args: { tabs: MIXED_TABS, active: 'hero' } };

/**
 * Overflowing — more tabs than the narrow header can show: the strip scrolls
 * horizontally (`overflow-x:auto`, `min-width:0`) rather than widening the header.
 */
export const Overflowing: Story = { args: { tabs: MANY_TABS, active: 'files', width: 380 } };
