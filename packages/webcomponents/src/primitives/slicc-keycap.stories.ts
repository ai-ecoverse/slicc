import type { Meta, StoryObj } from '@storybook/web-components-vite';
import '../add-menu/slicc-add-menu.js';
import '../composer/slicc-composer-meta.js';
import '../composer/slicc-composer.js';
import '../composer/slicc-input-card.js';
import '../composer/slicc-key-hud.js';
import '../dock/slicc-dock-item.js';
import './slicc-send-button.js';
import type { SliccKeycapPlacement, SliccKeycapVariant } from './slicc-keycap.js';
import './slicc-keycap.js';

interface KeycapArgs {
  variant?: SliccKeycapVariant;
  placement?: SliccKeycapPlacement;
  dim?: boolean;
}

const meta: Meta<KeycapArgs> = {
  title: 'Primitives/Keycap',
  component: 'slicc-keycap',
  tags: ['autodocs'],
  parameters: { layout: 'fullscreen' },
  argTypes: {
    variant: {
      control: 'inline-radio',
      options: ['chiclet', 'deck', 'holo'],
      description: 'Which of the three looks',
    },
    placement: {
      control: 'select',
      options: ['top-end', 'top-start', 'bottom-end', 'bottom-start', 'end', 'start'],
      description: 'Which corner of the target the cap overhangs',
    },
    dim: { control: 'boolean', description: 'Bound, but its surface is not on this screen' },
  },
};

export default meta;
type Story = StoryObj<KeycapArgs>;

const DEMO_EMAIL = 'lars@trieloff.net';
const PLACEHOLDER = 'Ask sliccy, or describe a change…';

const DOCK_KEYS = [
  { id: 'files', icon: 'folder', tip: 'Files', cap: 'f' },
  { id: 'terminal', icon: 'square-terminal', tip: 'Terminal', cap: 't' },
  { id: 'browser', icon: 'globe', tip: 'Tabs', cap: 'b' },
  { id: 'memory', icon: 'brain', tip: 'Memory', cap: 'm' },
  { id: 'monitor', icon: 'activity', tip: 'Monitor', cap: 'g' },
  { id: 'sprinkles', icon: 'sparkles', tip: 'Sprinkles', cap: 'e' },
] as const;

function keycap(
  cap: string,
  options: {
    variant?: SliccKeycapVariant;
    placement?: SliccKeycapPlacement;
    i?: number;
    dim?: boolean;
    hot?: boolean;
  } = {}
): HTMLElement {
  const el = document.createElement('slicc-keycap');
  el.setAttribute('cap', cap);
  if (options.variant) el.setAttribute('variant', options.variant);
  if (options.placement) el.setAttribute('placement', options.placement);
  if (options.i !== undefined) el.setAttribute('stagger', String(options.i));
  if (options.dim) el.setAttribute('dim', '');

  if (options.hot) el.setAttribute('hot', '');
  return el;
}

function anchored(target: HTMLElement, cap: HTMLElement | null): HTMLElement {
  const box = document.createElement('div');
  box.style.cssText = 'position:relative;display:inline-flex;';
  box.append(target);
  if (cap) box.append(cap);
  return box;
}

function dockItem(spec: (typeof DOCK_KEYS)[number], active: boolean): HTMLElement {
  const el = document.createElement('slicc-dock-item');
  el.setAttribute('item-id', spec.id);
  el.setAttribute('icon', spec.icon);
  el.setAttribute('tip', spec.tip);
  if (active) el.toggleAttribute('active', true);
  return el;
}

function rail(variant: SliccKeycapVariant | undefined, capped: boolean): HTMLElement {
  const col = document.createElement('div');
  col.style.cssText =
    'display:flex;flex-direction:column;gap:10px;padding:14px 12px;background:var(--desk);border-right:1px solid var(--line);';
  DOCK_KEYS.forEach((spec, i) => {
    col.append(
      anchored(
        dockItem(spec, spec.id === 'files'),
        capped ? keycap(spec.cap, { variant, i }) : null
      )
    );
  });
  return col;
}

function tab(name: string, hue: string, active: boolean): HTMLElement {
  const el = document.createElement('div');
  el.textContent = name;
  el.style.cssText = `display:flex;align-items:center;gap:6px;height:26px;padding:0 12px;border-radius:8px;font:600 12px/1 var(--ui);white-space:nowrap;color:${active ? 'var(--ink)' : 'var(--txt-2)'};background:${active ? 'var(--canvas)' : 'transparent'};border:1px solid ${active ? 'var(--line)' : 'transparent'};box-shadow:${active ? 'var(--shadow-pane)' : 'none'};`;
  const dot = document.createElement('span');
  dot.style.cssText = `width:6px;height:6px;border-radius:50%;background:${hue};flex:0 0 auto;`;
  el.prepend(dot);
  return el;
}

function tabStrip(variant: SliccKeycapVariant | undefined, capped: boolean): HTMLElement {
  const strip = document.createElement('div');
  strip.style.cssText =
    'display:flex;align-items:center;gap:8px;padding:12px 20px 10px;border-bottom:1px solid var(--line);background:var(--bg);';
  const tabs: Array<[string, string]> = [
    ['sliccy', 'var(--waffle)'],
    ['reviewer', 'var(--violet)'],
    ['scribe', 'var(--cyan)'],
  ];
  const track = document.createElement('div');
  track.style.cssText = 'position:relative;display:flex;align-items:center;gap:8px;';
  tabs.forEach(([name, hue], i) => {
    track.append(tab(name, hue, i === 0));
  });
  if (capped) track.append(keycap('← →', { variant, placement: 'end', i: 0 }));

  const spacer = document.createElement('div');
  spacer.style.flex = '1';
  strip.append(track, spacer);
  return strip;
}

function transcript(variant: SliccKeycapVariant | undefined, capped: boolean): HTMLElement {
  const thread = document.createElement('div');
  thread.style.cssText =
    'flex:1 1 auto;overflow:auto;padding:22px 24px 8px;color:var(--txt-2);font:14px/1.55 var(--ui);';
  for (const [tone, text] of [
    ['ink', 'Make the landing hero feel warmer.'],
    [
      'mute',
      'Auditing the cold hero now, then redesigning it in a live sprinkle. I will verify the before/after in the browser and open a PR.',
    ],
  ] as const) {
    const p = document.createElement('p');
    p.textContent = text;
    p.style.cssText = tone === 'ink' ? 'margin:0 0 12px;color:var(--ink);' : 'margin:0 0 14px;';
    thread.append(p);
  }

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:10px;align-items:center;margin:4px 0 10px;';
  for (const label of ['Copy reply', 'Copy chat']) {
    const button = document.createElement('button');
    button.textContent = label;
    button.style.cssText =
      'height:26px;padding:0 11px;border-radius:8px;border:1px solid var(--line);background:var(--canvas);color:var(--txt-2);font:500 11.5px/1 var(--ui);cursor:pointer;';
    row.append(button);
  }
  thread.append(row);
  return thread;
}

function composerBand(variant: SliccKeycapVariant | undefined, capped: boolean): HTMLElement {
  const composer = document.createElement('slicc-composer');
  const card = document.createElement('slicc-input-card');
  card.setAttribute('placeholder', PLACEHOLDER);

  const addWrap = anchored(
    document.createElement('slicc-add-menu'),
    capped ? keycap('u', { variant, placement: 'top-start', i: 0 }) : null
  );
  addWrap.setAttribute('slot', 'toolbar');

  const spacer = document.createElement('div');
  spacer.setAttribute('slot', 'toolbar');
  spacer.style.flex = '1';

  const send = document.createElement('slicc-send-button');
  send.setAttribute('email', DEMO_EMAIL);

  const sendWrap = anchored(send, capped ? keycap('s', { variant, i: 1 }) : null);
  sendWrap.setAttribute('slot', 'toolbar');

  card.append(addWrap, spacer, sendWrap);

  const metaRow = document.createElement('slicc-composer-meta');
  metaRow.setAttribute('model', 'Opus 4.8');
  metaRow.setAttribute('thinking', 'max');

  const band = document.createElement('div');
  band.style.cssText = 'position:relative;display:block;';
  band.append(card);
  if (capped) {
    const home = keycap('i', { variant, placement: 'top-start', i: 0 });

    home.style.cssText = 'top:.6em;left:1.5em;';
    band.append(home);
  }

  composer.append(band, metaRow);
  if (capped) composer.setAttribute('keys', '');
  return composer;
}

function shell(options: {
  variant?: SliccKeycapVariant;
  capped?: boolean;
  height?: string;
}): HTMLElement {
  const capped = options.capped !== false;
  const frame = document.createElement('div');
  frame.style.cssText = `display:flex;height:${options.height ?? '100vh'};background:var(--bg);font-family:var(--ui);overflow:hidden;`;

  frame.append(rail(options.variant, capped));

  const column = document.createElement('div');
  column.style.cssText =
    'position:relative;display:flex;flex-direction:column;flex:1 1 auto;min-width:0;';
  column.append(tabStrip(options.variant, capped), transcript(options.variant, capped));
  column.append(composerBand(options.variant, capped));

  if (capped) {
    const hud = document.createElement('slicc-key-hud');
    column.append(hud);
  }

  frame.append(column);
  return frame;
}

export const Chiclet: Story = {
  args: { variant: 'chiclet' },
  render: () => shell({ variant: 'chiclet' }),
};

export const Deck: Story = {
  args: { variant: 'deck' },
  render: () => shell({ variant: 'deck' }),
};

export const Holo: Story = {
  args: { variant: 'holo' },
  render: () => shell({ variant: 'holo' }),
};

export const ThreeVariants: Story = {
  args: {},
  render: () => {
    const row = document.createElement('div');
    row.style.cssText =
      'display:flex;gap:0;min-height:100vh;background:var(--bg);font-family:var(--ui);align-items:center;';
    for (const variant of ['chiclet', 'deck', 'holo'] as const) {
      const cell = document.createElement('div');
      cell.style.cssText =
        'flex:1;display:flex;flex-direction:column;align-items:center;gap:14px;padding:22px 10px 26px;border-right:1px solid var(--line);';
      const title = document.createElement('div');
      title.textContent = variant;
      title.style.cssText =
        'font:600 11px/1 var(--ui);letter-spacing:.08em;text-transform:uppercase;color:var(--txt-3);';
      cell.append(title, rail(variant, true));
      row.append(cell);
    }
    return row;
  },
};

export const ModeOffVsOn: Story = {
  args: { variant: 'chiclet' },
  render: ({ variant }) => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;';
    wrap.append(shell({ variant, capped: false, height: '360px' }));
    wrap.append(shell({ variant, capped: true, height: '360px' }));
    return wrap;
  },
};

export const Placements: Story = {
  args: { variant: 'chiclet' },
  render: ({ variant, dim }) => {
    const grid = document.createElement('div');
    grid.style.cssText =
      'display:grid;grid-template-columns:repeat(3,150px);gap:34px 46px;padding:52px;min-height:100vh;align-content:center;background:var(--bg);font-family:var(--ui);justify-content:center;';
    const places: SliccKeycapPlacement[] = [
      'top-start',
      'top-end',
      'bottom-start',
      'bottom-end',
      'start',
      'end',
    ];
    places.forEach((placement, i) => {
      const target = document.createElement('div');
      target.textContent = placement;
      target.style.cssText =
        'display:grid;place-items:center;width:110px;height:44px;border-radius:10px;border:1px solid var(--line);background:var(--canvas);color:var(--txt-2);font:500 11px/1 var(--ui);';
      const box = anchored(target, keycap('f', { variant, placement, i, dim }));
      box.style.margin = '0 auto';
      grid.append(box);
    });
    return grid;
  },
};

export const HoverPress: Story = {
  args: { variant: 'chiclet' },
  render: ({ variant }) => {
    const wrap = document.createElement('div');
    wrap.style.cssText =
      'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:38px;min-height:100vh;padding:40px;background:var(--bg);font-family:var(--ui);';

    const style = document.createElement('style');
    style.textContent =
      '.frozen slicc-keycap[hot]::part(key){animation-delay:-.11s;animation-play-state:paused;}';
    wrap.append(style);

    for (const [caption, hot] of [
      ['hover these — the cap presses', false],
      ['the bottom of the press, held', true],
    ] as const) {
      const label = document.createElement('div');
      label.textContent = caption;
      label.style.cssText =
        'font:600 11px/1 var(--ui);letter-spacing:.08em;text-transform:uppercase;color:var(--txt-3);';

      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:26px;';
      DOCK_KEYS.forEach((spec, i) => {
        row.append(anchored(dockItem(spec, false), keycap(spec.cap, { variant, i, hot })));
      });

      const cell = document.createElement('div');
      cell.className = hot ? 'frozen' : '';
      cell.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:16px;';
      cell.append(label, row);
      wrap.append(cell);
    }
    return wrap;
  },
};

export const Live: Story = {
  args: { variant: 'chiclet' },
  render: ({ variant }) => {
    const host = document.createElement('div');
    host.tabIndex = 0;
    host.style.cssText = 'outline:none;';
    let on = false;
    const draw = (): void => {
      host.replaceChildren(shell({ variant, capped: on }));
      if (!on) {
        const nudge = document.createElement('div');
        nudge.textContent = 'Press Esc for keyboard mode';
        nudge.style.cssText =
          'position:absolute;left:50%;bottom:96px;transform:translateX(-50%);padding:6px 12px;border-radius:20px;background:var(--canvas);border:1px solid var(--line);color:var(--txt-2);font:600 11px/1 var(--ui);';
        host.firstElementChild?.lastElementChild?.append(nudge);
      }
    };
    host.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      on = !on;
      draw();
    });
    draw();

    queueMicrotask(() => host.focus());
    return host;
  },
};
