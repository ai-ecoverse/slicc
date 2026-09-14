import type { Meta, StoryObj } from '@storybook/web-components-vite';
import type { SliccAddMenu, SliccAddSection } from './slicc-add-menu.js';
import './slicc-add-menu.js';

interface AddMenuArgs {
  open?: boolean;

  query?: string;

  results?: SliccAddSection[];

  secretAction?: boolean;
}

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

function buildAddMenu({ open, query, results, secretAction }: AddMenuArgs): HTMLElement {
  const frame = document.createElement('div');
  frame.style.cssText =
    'width:420px;padding:14px;background:var(--canvas);border:1px solid var(--line);border-radius:14px;font-family:var(--ui);margin-top:320px;';

  const el = document.createElement('slicc-add-menu') as SliccAddMenu;
  if (results) el.results = results;
  if (secretAction) el.setAttribute('secret-action', '');
  frame.appendChild(el);

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

export const Closed: Story = { args: {} };

export const Open: Story = { args: { open: true } };

export const OpenWithSearchQuery: Story = { args: { query: 'main' } };

export const QuickActions: Story = { args: { query: 'take' } };

export const OpenWithResults: Story = { args: { open: true, results: CUSTOM_RESULTS } };

export const SecretAction: Story = { args: { open: true, secretAction: true } };

export const SecretActionSearch: Story = { args: { query: 'secret', secretAction: true } };

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

export const GlobalDrop: Story = {
  render: () => {
    const frame = buildAddMenu({ open: true });
    const el = frame.querySelector('slicc-add-menu') as SliccAddMenu;
    el.setAttribute('global-drop', '');

    requestAnimationFrame(() => el.setAttribute('data-dropping', ''));
    return frame;
  },
};

export const Dark: Story = {
  args: { open: true },
  globals: { theme: 'dark' },
};
