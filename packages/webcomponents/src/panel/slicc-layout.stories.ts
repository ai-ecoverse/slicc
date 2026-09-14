import type { Meta, StoryObj } from '@storybook/web-components-vite';
import type { LayoutDocument } from './layout-schema.js';
import { LAYOUT_SCHEMA_VERSION } from './layout-schema.js';
import type { SliccLayout } from './slicc-layout.js';
import './slicc-layout.js';
import type { PanelMeta } from './slicc-panel.js';
import { SliccPanel } from './slicc-panel.js';

class StoryPanel extends SliccPanel {
  static readonly panelMeta: PanelMeta = { id: 'story-panel', title: 'Panel' };
}
if (!customElements.get('story-panel')) customElements.define('story-panel', StoryPanel);

const CHROME = 'color-mix(in srgb, var(--panel2, #217399) 82%, transparent)';
const WORK = 'color-mix(in srgb, var(--accent, #6366f1) 16%, transparent)';

function panel(id: string, label: string, opts: { chrome?: boolean } = {}): SliccPanel {
  const element = document.createElement('story-panel') as SliccPanel;
  element.setAttribute('panel-id', id);
  const body = document.createElement('div');
  body.style.cssText = [
    'flex:1 1 auto;display:flex;align-items:center;justify-content:center;',
    'min-width:0;min-height:0;box-sizing:border-box;',
    'font:600 13px/1.2 var(--ui, system-ui), sans-serif;letter-spacing:0.02em;',
    `background:${opts.chrome ? CHROME : WORK};`,
    'color:var(--ink, #eaf2f6);',
    opts.chrome ? 'border-radius:0;' : 'border-radius:8px;margin:4px;',
  ].join('');
  body.textContent = label;
  element.append(body);
  return element;
}

function chromeDocks(): LayoutDocument['base']['docks'] {
  return [
    { edge: 'top', size: '36px', panels: ['scoop-switcher'], locked: true },
    { edge: 'left', size: '44px', panels: ['sessions-rail'], locked: true },
    { edge: 'right', size: '48px', panels: ['dock-rail'], locked: true },
  ];
}

function doc(base: LayoutDocument['base'], over: Partial<LayoutDocument> = {}): LayoutDocument {
  return { version: LAYOUT_SCHEMA_VERSION, id: 'story', base, ...over };
}

function frame(
  document_: LayoutDocument,
  panels: SliccPanel[],
  size: { width: number; height: number } = { width: 1100, height: 620 }
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = [
    `width:${size.width}px;height:${size.height}px;`,
    'display:flex;border:1px solid var(--line);border-radius:14px;overflow:hidden;',
    'background:var(--canvas);',
  ].join('');
  const layout = document.createElement('slicc-layout') as SliccLayout;
  for (const element of panels) layout.append(element);
  wrap.append(layout);

  queueMicrotask(() => layout.setLayout(document_));
  return wrap;
}

function chromePanels(): SliccPanel[] {
  return [
    panel('scoop-switcher', 'scoop switcher · budget', { chrome: true }),
    panel('sessions-rail', '▤', { chrome: true }),
    panel('dock-rail', '▦', { chrome: true }),
  ];
}

const meta: Meta = {
  title: 'Panels/Layout',
};
export default meta;
type Story = StoryObj;

export const Default: Story = {
  render: () =>
    frame(doc({ docks: chromeDocks(), zones: { center: ['chat'] } }), [
      ...chromePanels(),
      panel('chat', 'chat'),
    ]),
};

export const FiveZones: Story = {
  render: () =>
    frame(
      doc({
        docks: chromeDocks(),
        zones: {
          top: ['status'],
          left: ['chat'],
          center: ['main'],
          right: ['inspector'],
          bottom: ['log'],
          sizes: { top: '72px', bottom: '96px', left: '22%', right: '18%' },
        },
      }),
      [
        ...chromePanels(),
        panel('status', 'top — status bar'),
        panel('chat', 'left — chat'),
        panel('main', 'center — fills the remainder'),
        panel('inspector', 'right'),
        panel('log', 'bottom — log'),
      ]
    ),
};

export const TwoPanelsStacked: Story = {
  render: () =>
    frame(
      doc({
        docks: chromeDocks(),
        zones: { left: ['files', 'terminal'], center: ['chat'], sizes: { left: '34%' } },
      }),
      [
        ...chromePanels(),
        panel('files', 'left · files'),
        panel('terminal', 'left · terminal'),
        panel('chat', 'center — chat'),
      ]
    ),
};

export const TwoPanelsSideBySide: Story = {
  render: () =>
    frame(
      doc({
        docks: chromeDocks(),
        zones: {
          bottom: ['files', 'terminal'],
          center: ['chat'],
          axes: { bottom: 'row' },
          sizes: { bottom: '38%' },
        },
      }),
      [
        ...chromePanels(),
        panel('files', 'bottom · files'),
        panel('terminal', 'bottom · terminal'),
        panel('chat', 'center — chat'),
      ]
    ),
};

export const Locked: Story = {
  render: () =>
    frame(
      doc(
        {
          docks: chromeDocks(),
          zones: {
            top: ['status'],
            left: ['chat'],
            center: ['main'],
            sizes: { top: '72px', left: '28%' },
          },
        },
        { locked: true }
      ),
      [
        ...chromePanels(),
        panel('status', 'top — pushed by the embedder'),
        panel('chat', 'left — chat'),
        panel('main', 'center — locked, no grip'),
      ]
    ),
};

export const FloatingPanel: Story = {
  render: () =>
    frame(
      doc({
        docks: chromeDocks(),
        zones: { center: ['chat'] },
        floating: [{ panel: 'monitor', anchor: 'right', width: '280px', height: '200px' }],
      }),
      [...chromePanels(), panel('chat', 'center — chat'), panel('monitor', 'floating · monitor')]
    ),
};

export const HiddenPanel: Story = {
  render: () =>
    frame(
      doc(
        {
          docks: chromeDocks(),
          zones: { center: ['chat'], right: ['inspector'], sizes: { right: '30%' } },
        },
        { panels: { inspector: { visible: false } } }
      ),
      [
        ...chromePanels(),
        panel('chat', 'center — takes the full width'),
        panel('inspector', 'right — hidden'),
      ]
    ),
};

export const NarrowVariant: Story = {
  render: () =>
    frame(
      doc(
        {
          docks: chromeDocks(),
          zones: {
            top: ['status'],
            left: ['chat'],
            right: ['inspector'],
            sizes: { top: '72px', left: '40%' },
          },
        },
        {
          variants: [{ when: { maxWidth: 700 }, docks: [], zones: { center: ['chat'] } }],
        }
      ),
      [
        ...chromePanels(),
        panel('status', 'top'),
        panel('chat', 'chat — the only panel below 700px'),
        panel('inspector', 'right'),
      ],
      { width: 520, height: 620 }
    ),
};

export const StackedDocks: Story = {
  render: () =>
    frame(
      doc({
        docks: [
          { edge: 'top', size: '36px', panels: ['scoop-switcher'], locked: true },
          { edge: 'top', size: '64px', panels: ['banner'] },
          { edge: 'left', size: '44px', panels: ['sessions-rail'], locked: true },
          { edge: 'right', size: '48px', panels: ['dock-rail'], locked: true },
        ],
        zones: { center: ['chat'] },
      }),
      [
        ...chromePanels(),
        panel('banner', 'second top dock — spans over the rails', { chrome: true }),
        panel('chat', 'center — chat'),
      ]
    ),
};
