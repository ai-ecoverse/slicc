import type { Meta, StoryObj } from '@storybook/web-components-vite';
// The dock is composed BY TAG in the wired story; importing it side-effect-first
// upgrades the rail so its `browser` globe can drive the overlay.
import './slicc-dock.js';
import type { SliccDock } from './slicc-dock.js';
import type { SliccTabOverlay, TabDescriptor } from './slicc-tab-overlay.js';
import './slicc-tab-overlay.js';

/** A tiny inline-SVG "screenshot" (a hued gradient + label) — no network fetch. */
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

/** The full roster used by the scrolling story (active tab carries the ctx ring). */
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

/** Build an open overlay seeded with the given tabs. */
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

/** A few open tabs — each card shows its screenshot, title, and URL. */
export const FewTabs: Story = {
  render: () => overlay(FEW),
};

/** A full roster — the responsive grid scrolls; one tab is the active (ctx-ringed) tab. */
export const ManyTabs: Story = {
  render: () => overlay(TABS),
};

/** The empty state — no open tabs, just the header and the empty message. */
export const Empty: Story = {
  render: () => overlay([]),
};

/** Mixed cards — some with screenshots, some falling back to the globe placeholder. */
export const Placeholders: Story = {
  render: () =>
    overlay([
      { id: 'a', title: 'With screenshot', url: 'a.example', screenshot: shot('a', '#8b5cf6') },
      { id: 'b', title: 'No screenshot (globe placeholder)', url: 'b.example' },
      { id: 'c', title: 'Active · no screenshot', url: 'c.example', active: true },
    ]),
};

/**
 * Wired: the dock rail's `Browser · CDP` globe opens the overlay. Clicking the
 * globe emits `slicc-dock-select` with id `browser`; the host listens and calls
 * `overlay.show()`. Closing the overlay collapses the dock item back to rest.
 */
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
