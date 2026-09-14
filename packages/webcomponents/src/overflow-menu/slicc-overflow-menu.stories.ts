import type { Meta, StoryObj } from '@storybook/web-components-vite';
import type { MenuItem } from './slicc-overflow-menu.js';
import { SliccOverflowMenu } from './slicc-overflow-menu.js';

const ALL_ITEMS: MenuItem[] = [
  { id: 'rename', label: 'Rename' },
  { id: 'duplicate', label: 'Duplicate' },
  { id: 'copy-path', label: 'Copy path' },
  { id: 'open-browser', label: 'Open in browser' },
  { id: 'delete', label: 'Delete', destructive: true },
];

function buildStory(items: MenuItem[]): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'padding:60px;font-family:var(--ui);';

  const btn = document.createElement('button');
  btn.textContent = 'Click to show menu';
  btn.style.cssText = 'padding:6px 12px;font-size:13px;cursor:pointer;';
  btn.addEventListener('click', () => {
    SliccOverflowMenu.show({ anchor: btn, items, context: { path: '/workspace/demo.txt' } });
  });
  wrap.appendChild(btn);

  const status = document.createElement('div');
  status.style.cssText = 'margin-top:12px;font-size:12px;color:var(--txt-2);';
  status.textContent = 'Click button to open menu…';
  wrap.appendChild(status);

  wrap.addEventListener('overflow-action', (e) => {
    const detail = (e as CustomEvent).detail;
    status.textContent = `overflow-action → action: ${detail.action}`;
  });

  return wrap;
}

const meta: Meta = {
  title: 'OverflowMenu/OverflowMenu',
  tags: ['autodocs'],
  render: () => buildStory(ALL_ITEMS),
};

export default meta;
type Story = StoryObj;

export const Default: Story = {};

export const WithoutOpenInBrowser: Story = {
  render: () =>
    buildStory(ALL_ITEMS.map((i) => (i.id === 'open-browser' ? { ...i, visible: false } : i))),
};

export const DestructiveHighlighted: Story = {
  render: () => buildStory([{ id: 'delete', label: 'Delete', destructive: true }]),
};
