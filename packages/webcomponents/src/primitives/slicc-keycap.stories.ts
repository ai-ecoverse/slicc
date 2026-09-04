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

/** The shipped keymap, as the shell would hand it to the caps. */
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
  // Normally the cap sets this itself while its anchor is hovered; forced here
  // so a still frame (and the screenshot CI, which cannot hover) can show it.
  if (options.hot) el.setAttribute('hot', '');
  return el;
}

/**
 * A target that can host a cap: the cap pins to the nearest positioned
 * ancestor, so the shell either positions the control itself or wraps it —
 * which is exactly what this does.
 */
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

/** The dock rail, capped — six launchers, six letters, one sweep. */
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

/**
 * The tab strip, named ONCE rather than per segment.
 *
 * The digits would be the precise answer and cannot be drawn:
 * `<slicc-agent-tabs>` clips its own track — that is how overflowing tabs hide
 * behind the "more" button — so a cap overhanging a segment is cut in half.
 * The arrows beside the track say the same thing better anyway: once for the
 * strip instead of nine times, and the digits are the one binding a user
 * already expects.
 *
 * One cap with TWO legends, because they are one affordance and sit adjacent
 * on a real keyboard — which is exactly what the pair looks like here.
 */
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

  /*
   * The copy row, deliberately UNCAPPED even in the mode — this is the shipped
   * shape, not an omission.
   *
   * `y` / `Y` are bound and reachable; the transcript is just the one part of
   * the shell that mutates on every streamed token, and keeping a cap glued to
   * a row that moves under it would put an observer on the hot path for two of
   * the most guessable bindings in the map. The HUD and the help sheet still
   * name both keys.
   */
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
  // `s` stops the running turn, and the send button IS the stop button while
  // one runs — the same control, so the same cap.
  const sendWrap = anchored(send, capped ? keycap('s', { variant, i: 1 }) : null);
  sendWrap.setAttribute('slot', 'toolbar');

  card.append(addWrap, spacer, sendWrap);

  const metaRow = document.createElement('slicc-composer-meta');
  metaRow.setAttribute('model', 'Opus 4.8');
  metaRow.setAttribute('thinking', 'max');

  /*
   * The way back to typing, at the caret's own corner — the most important key
   * in a mode that is the RESTING state. "How do I type again?" is the question
   * it has to answer, and the corner of the text answers it better than a strip
   * at the bottom of the column does.
   *
   * The shell anchors it to the textarea itself. Here the cap goes on a box
   * around the card, because `<slicc-input-card>` is a shadow component and a
   * child appended to one lands in its light DOM and is never rendered — the
   * very reason the shell floats its caps in a layer instead of parenting them
   * to the controls they name.
   */
  const band = document.createElement('div');
  band.style.cssText = 'position:relative;display:block;';
  band.append(card);
  if (capped) {
    const home = keycap('i', { variant, placement: 'top-start', i: 0 });
    // Nudged in from the card's corner to the TEXT's corner, which is where
    // the shell's measured anchor puts it.
    home.style.cssText = 'top:.6em;left:1.5em;';
    band.append(home);
  }

  composer.append(band, metaRow);
  if (capped) composer.setAttribute('keys', '');
  return composer;
}

/**
 * The whole point of the affordance, so every story renders it: a shell with
 * enough real chrome that you can judge whether a screenful of caps helps or
 * shouts.
 */
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

  // The HUD the mode already ships. Both are on screen at once in the real
  // shell, so both are on screen here: the caps say what is reachable, the
  // strip says what was pressed.
  if (capped) {
    const hud = document.createElement('slicc-key-hud');
    column.append(hud);
  }

  frame.append(column);
  return frame;
}

/**
 * **Chiclet** — the laptop key. A single low face with a thin lip, tilted 16°
 * so it catches light from the same direction as the rest of the chrome, and
 * bobbing a pixel and a half above its own shadow on a long, staggered cycle.
 *
 * The quietest of the three, and the one that survives a screenful: twenty of
 * these read as a legend, not as a rash.
 */
export const Chiclet: Story = {
  args: { variant: 'chiclet' },
  render: () => shell({ variant: 'chiclet' }),
};

/**
 * **Deck** — the mechanical key. A five-layer hard-shadow extrusion swivelled
 * on both axes, tinted with the context accent and moulded with an inner
 * highlight and an underlit lower lip. It lands with a punch-and-rebound and
 * then holds still, because a lump of moulded plastic that floated would be
 * lying about what it is.
 *
 * The most fun and the most expensive: it is physically taller than the
 * controls it labels, so a dense rail starts to look like a keyboard someone
 * spilled onto the app.
 */
export const Deck: Story = {
  args: { variant: 'deck' },
  render: () => shell({ variant: 'deck' }),
};

/**
 * **Holo** — the HUD key. No moulding at all: a pane of tinted glass standing
 * off the surface at 14°, backdrop-blurred, with the app's own `--rainbow`
 * sweeping across it. Swings in edge-on and sways.
 *
 * The only one of the three that stays legible over a photo, a terminal or a
 * diff — the surfaces the caps have to survive — and the only one that reads
 * as software rather than as hardware, which cuts both ways.
 */
export const Holo: Story = {
  args: { variant: 'holo' },
  render: () => shell({ variant: 'holo' }),
};

/** The three, on the same rail, at the same moment. This is the comparison. */
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

/**
 * **Before / after.** The same shell with the mode off and on — the honest
 * test of whether the caps are a legend or a mess.
 */
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

/**
 * Every corner a cap can hang off, plus `dim` — the state for a key that is
 * bound but whose surface is not on this screen (a read-only unit's send
 * button, a follower's tab strip). Shown faded rather than dropped, for the
 * same reason the HUD shows an unbound press: a cap that vanishes reads as a
 * broken keyboard.
 */
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

/**
 * **The press, held still.** Hovering a control presses its cap: the key
 * travels down, its lip collapses under it — the lip going away is what sells
 * the key bottoming out, the travel alone reads as a slide — and it rebounds
 * with a wobble that damps out over two swings. One press per hover, not a
 * loop: hovering asks "what does this do?", and the honest answer is the key
 * doing what your finger is about to make it do.
 *
 * The cap has no hit area of its own, so what it actually watches is the
 * ANCHOR it is pinned inside — meaning the affordance costs the host nothing.
 * Hover the rail here to see it live; the bottom row is the mid-press frame,
 * forced, because a screenshot cannot hover.
 */
export const HoverPress: Story = {
  args: { variant: 'chiclet' },
  render: ({ variant }) => {
    const wrap = document.createElement('div');
    wrap.style.cssText =
      'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:38px;min-height:100vh;padding:40px;background:var(--bg);font-family:var(--ui);';

    /*
     * Holding the bottom of the press still, from OUTSIDE the shadow root:
     * `hot` runs the press once and it ends, by design, on the resting frame —
     * so a forced attribute alone would show nothing. `::part(key)` is the
     * component's own hook, and a negative delay plus a paused play state
     * parks the animation at the 26% mark, which is the bottom of the travel.
     */
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

/**
 * **Live.** Press `Escape` to enter keyboard mode and watch the sweep land;
 * press it again to leave. Click the canvas first so it has focus.
 *
 * The staggered entry is the part to judge here: the caps arrive as a wave
 * across the shell rather than as one flat pop, which is what makes twenty of
 * them read as one gesture.
 */
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
    // Storybook renders a fresh canvas per story, so the listener dies with
    // the node — no teardown hook needed.
    queueMicrotask(() => host.focus());
    return host;
  },
};
