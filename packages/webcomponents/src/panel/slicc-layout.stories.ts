import type { Meta, StoryObj } from '@storybook/web-components-vite';
import type { LayoutDocument } from './layout-schema.js';
import { LAYOUT_SCHEMA_VERSION } from './layout-schema.js';
import type { SliccLayout } from './slicc-layout.js';
import './slicc-layout.js';
import type { PanelMeta } from './slicc-panel.js';
import { SliccPanel } from './slicc-panel.js';

/**
 * Stories for the panel system — `<slicc-layout>` plus `SliccPanel`.
 *
 * These exist so the arrangement is REVIEWABLE. The PR screenshot workflow
 * (`.github/workflows/storybook-screenshots.yml`) captures affected stories in light
 * and dark on every PR touching this package, selected by directory: a change under
 * `src/panel/` picks up the stories declared here. Without them the whole panel
 * system was invisible in review, which is how a status bar rendered beside the price
 * counter for a full session before anyone saw it.
 *
 * Each story drives the REAL component against a real `LayoutDocument`, so what you
 * see is what the resolver and renderer actually produce — not a mock of them.
 */

/** A panel whose body is a labelled block, so placement reads at a glance. */
class StoryPanel extends SliccPanel {
  static readonly panelMeta: PanelMeta = { id: 'story-panel', title: 'Panel' };
}
if (!customElements.get('story-panel')) customElements.define('story-panel', StoryPanel);

/** Fills that distinguish chrome from working-area panels without a theme fight. */
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

/** The three shipped chrome docks, so every story shows zones nested inside them. */
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

/**
 * Mount a layout at a fixed size with the panels its document names.
 *
 * `width`/`height` are explicit because the component re-resolves `variants` against
 * its own box, not the window's — the narrow story depends on that.
 */
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
  // After connection: `setLayout` before `connectedCallback` is fine, but placing it
  // here matches how the webapp drives it (mount, then load a document).
  queueMicrotask(() => layout.setLayout(document_));
  return wrap;
}

/** The chrome panels every story needs — the docks reference these ids. */
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

/**
 * The shipped arrangement: chat fills the center, with the three locked chrome docks
 * around it. What a default install boots.
 */
export const Default: Story = {
  render: () =>
    frame(doc({ docks: chromeDocks(), zones: { center: ['chat'] } }), [
      ...chromePanels(),
      panel('chat', 'chat'),
    ]),
};

/**
 * All five zones populated — the `BorderLayout` shape.
 *
 * The point of this story is the NESTING: `top` sits below the scoop strip and
 * `left`/`right` are inboard of the rails, because the zones only ever divide what the
 * docks leave over. A panel in `zones.top` can never overlap the chrome, which is
 * exactly the distinction that goes wrong when a layout is authored with a second
 * `top` dock instead.
 */
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

/**
 * Two panels in one zone, STACKED — the default for a tall zone.
 *
 * Capacity and destination are separate concerns: a drag offers five destinations, but
 * a zone holds any number of panels. The divider between them is draggable.
 */
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

/** The same pair SIDE BY SIDE, via the zone's `axes` override. */
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

/**
 * A LOCKED document — what a Cherry embedder pushes.
 *
 * No move grips and no resize seams anywhere: a locked panel renders no button at all
 * rather than a disabled one, so "cannot rearrange" reads literally. Compare against
 * `FiveZones`, which is the same shape unlocked.
 */
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

/**
 * A FLOATING panel: painted over the docked arrangement without reflowing it.
 *
 * `presentation: 'floating'` lives in the layout's own stratum — a later sibling of
 * the docked structure, so it paints above without entering the numeric z-index game
 * and stays below the app's trusted layer.
 */
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

/**
 * A hidden panel takes NO space, and its zone collapses with it.
 *
 * `panels[id].visible: false` is the mechanism behind the panels menu's checkmarks.
 * The `right` zone is named by the document but renders nothing, so `center` gets the
 * whole width rather than leaving a dead gap.
 */
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

/**
 * The narrow-viewport variant, at 520px wide.
 *
 * Every shipped preset carries `when: { maxWidth: 700 }`, which drops both rails and
 * collapses the working area to chat alone — what makes the extension side panel and a
 * phone-sized viewport usable. Variants resolve against the COMPONENT's box, not the
 * window's, so this story reproduces it at a fixed size rather than needing a viewport
 * toolbar setting.
 */
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

/**
 * Several strips on ONE edge, stacked in declaration order.
 *
 * Two `edge: 'top'` docks stack vertically and each keeps its own thickness. This was
 * a real bug: the specs were merged into a single container, so the second dock became
 * a sibling of the first and a 180px status bar landed beside the 36px scoop strip,
 * sharing its row and overwriting its height.
 *
 * Note what a dock spans — full width, OVER the rails. A bar that should sit between
 * the rails belongs in `zones.top`; see `FiveZones`.
 */
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
