import type { Meta, StoryObj } from '@storybook/web-components-vite';

import './slicc-dock.js';
import type { SliccDock } from './slicc-dock.js';
import type { SliccTabOverlay, TabDescriptor } from './slicc-tab-overlay.js';
import './slicc-tab-overlay.js';

function shot(label: string, hue: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${hue}"/><stop offset="1" stop-color="#0a0a0a"/>` +
    `</linearGradient></defs><rect width="320" height="200" fill="url(#g)"/>` +
    `<text x="16" y="180" font-family="sans-serif" font-size="15" fill="#fff" opacity="0.9">${label}</text>` +
    `</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const TABS: TabDescriptor[] = [
  {
    id: 't1',
    title: 'SLICC · prototype',
    url: 'localhost:5710',
    screenshot: shot('prototype', '#8b5cf6'),
    active: true,
  },
  {
    id: 't2',
    title: 'GitHub — pull requests',
    url: 'github.com/slicc',
    screenshot: shot('github', '#06b6d4'),
  },
  { id: 't3', title: 'Storybook', url: 'localhost:6006', screenshot: shot('storybook', '#f43f5e') },
  { id: 't4', title: 'Lucide icons', url: 'lucide.dev', screenshot: shot('lucide', '#f59e0b') },
  { id: 't5', title: 'MDN — Web Components', url: 'developer.mozilla.org' },
  {
    id: 't6',
    title: 'Vitest — browser mode',
    url: 'vitest.dev',
    screenshot: shot('vitest', '#16a34a'),
  },
  {
    id: 't7',
    title: 'Cloudflare dashboard',
    url: 'dash.cloudflare.com',
    screenshot: shot('cloudflare', '#ea580c'),
  },
  {
    id: 't8',
    title: 'A very long tab title that should ellipsize cleanly in its card',
    url: 'example.com/some/deep/path',
  },
];

const FEW: TabDescriptor[] = TABS.slice(0, 3);

const HUES = ['#8b5cf6', '#06b6d4', '#f43f5e', '#f59e0b', '#16a34a', '#ea580c'];

const LONG: TabDescriptor[] = Array.from({ length: 32 }, (_, i) => ({
  id: `long-${i}`,
  title: `Open tab ${i + 1}`,
  url: `example.com/page/${i + 1}`,
  active: i === 0,
  ...(i % 5 === 4 ? {} : { screenshot: shot(`tab ${i + 1}`, HUES[i % HUES.length]) }),
}));

function overlay(tabs: TabDescriptor[]): HTMLElement {
  const el = document.createElement('slicc-tab-overlay') as SliccTabOverlay;
  el.tabs = tabs;
  el.setAttribute('open', '');
  return el;
}

const meta: Meta = {
  title: 'Dock/Tab Overlay',
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
};
export default meta;
type Story = StoryObj;

export const FewTabs: Story = {
  render: () => overlay(FEW),
};

export const ManyTabs: Story = {
  render: () => overlay(TABS),
};

export const LongList: Story = {
  render: () => overlay(LONG),
};

export const Empty: Story = {
  render: () => overlay([]),
};

export const TabsAndComputers: Story = {
  render: () =>
    overlay([
      ...FEW,
      {
        id: 'computer:jsh:fake',
        kind: 'computer',
        live: true,
        title: 'fake',
        url: 'jsh · live',
        screenshot: shot('jsh:fake', '#22c55e'),
        softKeys: [
          { label: 'Home', keysym: 'Home' },
          { label: 'Back', keysym: 'Escape' },
        ],
      },
      {
        id: 'computer:v86:vm0',
        kind: 'computer',
        live: false,
        title: 'vm0',
        url: 'v86 · gone',
        softKeys: [{ label: 'Ctrl+Alt+Del', keysym: 'ctrl+alt+Delete' }],
      },
    ]),
};

export const Placeholders: Story = {
  render: () =>
    overlay([
      { id: 'a', title: 'With screenshot', url: 'a.example', screenshot: shot('a', '#8b5cf6') },
      { id: 'b', title: 'No screenshot (globe placeholder)', url: 'b.example' },
      { id: 'c', title: 'Active · no screenshot', url: 'c.example', active: true },
    ]),
};

export const WiredToDockGlobe: Story = {
  render: () => {
    const wrap = document.createElement('div');
    wrap.style.cssText =
      'display:flex;align-items:stretch;height:520px;background:var(--bg);' +
      'border:1px solid var(--line);border-radius:14px;overflow:hidden;font-family:var(--ui);';

    const reading = document.createElement('div');
    reading.style.cssText =
      'flex:1;display:grid;place-items:center;color:var(--txt-3);font-size:13px;background:var(--canvas);';
    reading.textContent = 'Click the globe (Browser · CDP) at the bottom of the rail →';
    wrap.appendChild(reading);

    const dock = document.createElement('slicc-dock') as SliccDock;
    dock.items = [
      {
        id: 'hero',
        icon: 'sparkles',
        label: 'Hero studio',
        kind: 'sprinkle',
        hue: 'var(--violet)',
      },
    ];
    dock.systemTools = true;
    wrap.appendChild(dock);

    const ov = overlay(TABS);
    ov.removeAttribute('open');
    wrap.appendChild(ov);

    dock.addEventListener('slicc-dock-select', (e) => {
      if ((e as CustomEvent<{ id: string }>).detail.id === 'browser') {
        (ov as SliccTabOverlay).show();
      }
    });
    ov.addEventListener('overlay-close', () => dock.collapse());
    ov.addEventListener('tab-activate', () => (ov as SliccTabOverlay).hide());
    return wrap;
  },
};
