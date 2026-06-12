import type { Meta, StoryObj } from '@storybook/web-components-vite';
import type { SliccAddMenu, SliccAddSection } from './slicc-add-menu.js';
import './slicc-add-menu.js';

interface AddMenuArgs {
  /** Open the panel after mount. */
  open?: boolean;
  /** Pre-fill the search box (implies open). */
  query?: string;
  /** Inject a custom results dataset in place of the built-in demo data. */
  results?: SliccAddSection[];
}

/** A small custom dataset demonstrating the injectable `results` property. */
const CUSTOM_RESULTS: SliccAddSection[] = [
  {
    kind: 'doc',
    label: 'Docs',
    icon: 'file',
    entries: [
      { id: 'spec', label: 'Design spec', sub: 'docs/design.md' },
      { id: 'rfc', label: 'Composer RFC', sub: 'docs/rfc/composer.md' },
    ],
  },
  {
    kind: 'agent',
    label: 'Agents',
    icon: 'sparkles',
    entries: [
      { id: 'researcher', label: 'researcher', sub: 'Fans out web searches' },
      { id: 'designer', label: 'designer', sub: 'Generates UI mocks' },
    ],
  },
];

/**
 * Mount inside a faux composer footer band so the upward-popping results panel
 * has room to overlay content above it (matching the prototype context).
 */
function buildAddMenu({ open, query, results }: AddMenuArgs): HTMLElement {
  const frame = document.createElement('div');
  frame.style.cssText =
    'width:420px;padding:14px;background:var(--canvas);border:1px solid var(--line);border-radius:14px;font-family:var(--ui);margin-top:320px;';

  const el = document.createElement('slicc-add-menu') as SliccAddMenu;
  if (results) el.results = results;
  frame.appendChild(el);

  // Open / pre-search after the element has connected and rendered its shadow.
  if (open || query) {
    requestAnimationFrame(() => {
      el.open();
      if (query) {
        const input = el.shadowRoot?.querySelector<HTMLInputElement>('.searchbox input');
        if (input) {
          input.value = query;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
    });
  }
  return frame;
}

const meta: Meta<AddMenuArgs> = {
  title: 'AddMenu/AddMenu',
  component: 'slicc-add-menu',
  tags: ['autodocs'],
  argTypes: {
    open: { control: 'boolean', description: 'Open the results panel on mount' },
    query: { control: 'text', description: 'Pre-fill the search box (filters the demo dataset)' },
  },
  render: (args) => buildAddMenu(args),
};

export default meta;
type Story = StoryObj<AddMenuArgs>;

/**
 * Resting state — the trigger shows the lucide `plus` glyph (an `<svg>`, not a
 * unicode `+`); the search box and results panel are collapsed.
 */
export const Closed: Story = { args: {} };

/**
 * Open with the default demo dataset: the trigger glyph has swapped to the lucide
 * `x`, the search box has slid in, and the panel shows the quick actions
 * (`upload` / `image` / `monitor` lucide icons) above Files / Skills /
 * Conversations sections (`file` / `sparkles` / `message-square`).
 */
export const Open: Story = { args: { open: true } };

/** Open with a search query, filtering the demo dataset across all sections. */
export const OpenWithSearchQuery: Story = { args: { query: 'main' } };

/**
 * Quick actions only — searching for "take" surfaces the photo + screenshot
 * capture rows, each carrying its lucide glyph (`image` / `monitor`).
 */
export const QuickActions: Story = { args: { query: 'take' } };

/** Open with a host-injected `results` dataset replacing the built-in demo data. */
export const OpenWithResults: Story = { args: { open: true, results: CUSTOM_RESULTS } };

/**
 * The trigger glyph swap, side by side: closed renders the lucide `plus`, open
 * renders the lucide `x` (with the prototype's quarter-turn rotate riding on the
 * swap). Both are real `<svg>`s — no unicode `+` / `×`.
 */
export const TriggerGlyphSwap: Story = {
  render: () => {
    const row = document.createElement('div');
    row.style.cssText =
      'display:flex;gap:48px;align-items:flex-start;padding:20px;font-family:var(--ui);';
    for (const open of [false, true]) {
      const cell = document.createElement('div');
      cell.style.cssText = 'display:flex;flex-direction:column;gap:8px;align-items:center;';
      const caption = document.createElement('span');
      caption.style.cssText = 'font:600 11px var(--ui);color:var(--txt-3);';
      caption.textContent = open ? 'open · lucide x' : 'closed · lucide plus';
      const menu = document.createElement('slicc-add-menu') as SliccAddMenu;
      cell.append(menu, caption);
      row.appendChild(cell);
      if (open) requestAnimationFrame(() => menu.open());
    }
    return row;
  },
};

/** Dark theme — surfaces flip via the inherited `.dark` scope (Storybook theme toolbar). */
export const Dark: Story = {
  args: { open: true },
  globals: { theme: 'dark' },
};
