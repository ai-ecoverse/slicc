import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { append, frag, type HChild, h } from '../internal/dom.js';
import './slicc-action-row.js';

interface ActionRowArgs {
  open?: boolean;
  icon?: string;
  tone?: 'ink' | 'vi' | 'am' | 'cy' | 'gh';
  label?: string;
  result?: string;
  /** Monospace body content builder (spans carry `.add`/`.del`/`.ok`/`.p`/`.mut`). */
  body?: () => HChild[];
  /** Optional rich label builder (e.g. a `.vlink` filename) for the default slot. */
  labelNodes?: () => HChild[];
}

/** A monospace body span with one of the prototype syntax classes. */
function span(cls: string, text: string): HTMLElement {
  return h('span', { class: cls }, text);
}

/** Interleave the given nodes with literal newline text nodes (one body line each). */
function lines(...rows: HChild[]): HChild[] {
  const out: HChild[] = [];
  rows.forEach((row, i) => {
    if (i > 0) out.push('\n');
    out.push(row);
  });
  return out;
}

/**
 * Terminal 16-color palette — mirrors `TERMINAL_THEME` in
 * `../workbench/slicc-terminal.ts`. Used so the ANSI stories present the
 * rendered result with the exact same swatches the real terminal emits (the
 * stories don't run the webapp `ansi-to-dom` parser — webcomponents must not
 * depend on `@slicc/webapp`).
 */
const ANSI = {
  red: '#f43f5e',
  green: '#5bd17b',
  yellow: '#f59e0b',
  blue: '#3b82f6',
  magenta: '#8b5cf6',
  cyan: '#06b6d4',
  white: '#e7e7ea',
  brightBlack: '#8a8a93',
  brightRed: '#fb7185',
  brightGreen: '#86efac',
  brightYellow: '#fbbf24',
  brightBlue: '#60a5fa',
  brightMagenta: '#a78bfa',
  brightCyan: '#22d3ee',
  brightWhite: '#ffffff',
} as const;

/** An ANSI run — a monospace span carrying an inline `style` (color/weight/…). */
function ansi(style: string, text: string): HTMLElement {
  return h('span', { style }, text);
}

/**
 * Wrap body rows in a dark terminal-style container (background + light default
 * ink) so the row reads like the real `.wcmsg-out` terminal output in BOTH page
 * themes — the terminal surface is dark by design (see `TERMINAL_THEME`).
 */
function term(...rows: HChild[]): HChild[] {
  return [
    h(
      'div',
      { style: 'margin:-9px -11px;padding:9px 11px;background:#0c0c0e;color:#e7e7ea' },
      ...lines(...rows)
    ),
  ];
}

/** Build a populated action row so each story is reviewable end-to-end. */
function buildRow({
  open,
  icon,
  tone,
  label,
  result,
  body,
  labelNodes,
}: ActionRowArgs): HTMLElement {
  const row = document.createElement('slicc-action-row');
  row.style.width = '440px';
  if (open) row.setAttribute('open', '');
  if (icon) row.setAttribute('icon', icon);
  if (tone) row.setAttribute('tone', tone);
  if (result != null) row.setAttribute('result', result);

  if (labelNodes) {
    // Default-slot rich label (e.g. `edit_file · hero.css` with a clickable file).
    const wrap = h('span');
    append(wrap, labelNodes());
    row.appendChild(wrap);
  } else if (label != null) {
    row.setAttribute('label', label);
  }

  const bodyEl = h('div', { slot: 'body' });
  if (body) append(bodyEl, body());
  row.appendChild(bodyEl);

  return row;
}

const meta: Meta<ActionRowArgs> = {
  title: 'Chat/ActionRow',
  component: 'slicc-action-row',
  tags: ['autodocs'],
  argTypes: {
    open: { control: 'boolean', description: 'Expand the body and rotate the chevron' },
    icon: { control: 'text', description: 'Glyph character for the square chip' },
    tone: {
      control: 'inline-radio',
      options: ['ink', 'vi', 'am', 'cy', 'gh'],
      description: 'Chip tone',
    },
    label: { control: 'text', description: 'Header label (escaped)' },
    result: { control: 'text', description: 'Right-aligned result badge (hidden when empty)' },
    body: { control: false, description: 'Monospace body content builder' },
    labelNodes: { control: false, description: 'Rich label content builder (default slot)' },
  },
  render: (args) => buildRow(args),
};

export default meta;
type Story = StoryObj<ActionRowArgs>;

/** Closed by default — the quiet collapsed feed row. Click the header to expand. */
export const Closed: Story = {
  args: {
    icon: '✓',
    tone: 'am',
    label: 'tester · vitest',
    result: '3 passed',
    body: () =>
      lines(
        frag(span('p', '❯'), ' npm test -- hero'),
        span('ok', '✓ hero renders warm canvas'),
        span('ok', '✓ single accessible CTA'),
        span('ok', '✓ contrast ≥ 4.5:1'),
        span('mut', '0 failed · 1.2s')
      ),
  },
};

/** Open — body expanded, chevron rotated 90°. A diff edit_file with a `.vlink`. */
export const OpenDiff: Story = {
  args: {
    open: true,
    icon: '✎',
    tone: 'vi',
    result: '4 changes',
    labelNodes: () => [
      'edit_file · ',
      h('a', { class: 'vlink', 'data-file': 'fcss', 'data-kind': 'css' }, 'hero.css'),
    ],
    body: () =>
      lines(
        span('del', '- background: #0e0e0f;'),
        span('add', '+ background: #faf6f1;'),
        span('del', '- font-family: ui-monospace;'),
        span('add', '+ font-family: Fraunces, serif;'),
        span('ok', '✓ live-reloaded at /preview/hero')
      ),
  },
};

/** Default ink chip tone — the neutral `Use Computer` row, open with a command log. */
export const ToneInk: Story = {
  args: {
    open: true,
    icon: '◳',
    tone: 'ink',
    label: 'Use Computer · playwright screenshot',
    result: '2 shots',
    body: () =>
      lines(
        frag(span('p', '❯'), ' playwright screenshot --selector .hero before.png'),
        frag(span('p', '❯'), ' playwright screenshot --selector .hero after.png'),
        span('ok', '✓ DPR normalized → see the Browser panel')
      ),
  },
};

/** Violet chip tone (`.vi`). */
export const ToneViolet: Story = {
  args: {
    open: true,
    icon: '✎',
    tone: 'vi',
    label: 'designer · edit',
    result: '2 changes',
    body: () => [span('add', '+ accent applied')],
  },
};

/** Amber chip tone (`.am`). */
export const ToneAmber: Story = {
  args: {
    open: true,
    icon: '✓',
    tone: 'am',
    label: 'tester · vitest',
    result: '3 passed',
    body: () => lines(span('ok', '✓ all green'), span('mut', '0 failed · 1.2s')),
  },
};

/** Cyan chip tone (`.cy`). */
export const ToneCyan: Story = {
  args: {
    open: true,
    icon: '◈',
    tone: 'cy',
    label: 'researcher · audit',
    result: 'done',
    body: () => [span('mut', 'scanned 12 files')],
  },
};

/** GitHub-dark chip tone (`.gh`) — the git commit/push row. */
export const ToneGitHub: Story = {
  args: {
    open: true,
    icon: '⎇',
    tone: 'gh',
    label: 'git · commit + push',
    result: 'warm-hero',
    body: () =>
      lines(
        frag(span('p', '❯'), ' git checkout -b warm-hero'),
        frag(span('p', '❯'), ' git commit -am "feat(hero): warm redesign"'),
        span('ok', '[warm-hero 9f2a1c] 2 files changed, +38 −21'),
        frag(span('p', '❯'), ' git push -u origin warm-hero')
      ),
  },
};

/** No result badge — the badge region collapses when `result` is empty. */
export const NoBadge: Story = {
  args: {
    open: true,
    icon: '✦',
    tone: 'ink',
    label: 'upskill · brand-voice',
    body: () =>
      lines(
        frag(span('p', '❯'), ' upskill https://github.com/acme/brand-voice'),
        span('ok', '✓ installed skill → /workspace/skills/')
      ),
  },
};

/**
 * ANSI-colored bash output — a colored CLI help screen (mimicking `swarm --help`)
 * rendered in a dark terminal body, exercising standard + bright foreground
 * colors from the terminal 16-color palette.
 */
export const BashAnsiColors: Story = {
  args: {
    open: true,
    icon: 'terminal',
    tone: 'ink',
    label: 'bash · swarm --help',
    result: 'exit 0',
    body: () =>
      term(
        frag(
          ansi(`color:${ANSI.brightWhite};font-weight:700`, 'swarm'),
          ansi(`color:${ANSI.brightBlack}`, '  parallel agent orchestration  '),
          ansi(`color:${ANSI.magenta}`, 'v2.4.0')
        ),
        '',
        frag(
          ansi(`color:${ANSI.yellow};font-weight:700`, 'USAGE'),
          '  ',
          ansi(`color:${ANSI.green}`, 'swarm'),
          ' ',
          ansi(`color:${ANSI.cyan}`, '<command>'),
          ' ',
          ansi(`color:${ANSI.brightBlack}`, '[options]')
        ),
        '',
        ansi(`color:${ANSI.yellow};font-weight:700`, 'COMMANDS'),
        frag(
          '  ',
          ansi(`color:${ANSI.brightCyan}`, 'run   '),
          ansi(`color:${ANSI.brightBlack}`, 'fan out agents in parallel')
        ),
        frag(
          '  ',
          ansi(`color:${ANSI.brightBlue}`, 'list  '),
          ansi(`color:${ANSI.brightBlack}`, 'show running agents')
        ),
        frag(
          '  ',
          ansi(`color:${ANSI.brightRed}`, 'kill  '),
          ansi(`color:${ANSI.brightBlack}`, 'stop an agent by id')
        ),
        '',
        frag(
          ansi(`color:${ANSI.green}`, '✓'),
          ' ',
          ansi(`color:${ANSI.brightGreen}`, '3 agents ready'),
          ansi(`color:${ANSI.brightBlack}`, '  ·  0 failed')
        )
      ),
  },
};

/**
 * ANSI style attributes — bold / dim / italic / underline runs (with and
 * without color), rendered in the dark terminal body.
 */
export const BashAnsiStyles: Story = {
  args: {
    open: true,
    icon: 'terminal',
    tone: 'vi',
    label: 'bash · echo -e styles',
    result: 'exit 0',
    body: () =>
      term(
        frag(
          ansi('font-weight:700', 'bold'),
          '  ',
          ansi('opacity:.55', 'dim'),
          '  ',
          ansi('font-style:italic', 'italic'),
          '  ',
          ansi('text-decoration:underline', 'underline')
        ),
        frag(
          ansi(`color:${ANSI.cyan};font-weight:700`, 'bold cyan'),
          '  ',
          ansi(`color:${ANSI.magenta};text-decoration:underline`, 'underline violet'),
          '  ',
          ansi(`color:${ANSI.yellow};font-style:italic`, 'italic amber')
        ),
        ansi(`color:${ANSI.brightBlack}`, '# dim comment line')
      ),
  },
};

/**
 * 24-bit truecolor swatches — a couple of arbitrary RGB colors inline, beyond
 * the fixed 16-color palette, to confirm truecolor runs render.
 */
export const BashTrueColor: Story = {
  args: {
    open: true,
    icon: 'terminal',
    tone: 'cy',
    label: 'bash · truecolor swatches',
    result: '24-bit',
    body: () =>
      term(
        frag(
          ansi('color:#ff6b6b', '████'),
          ' ',
          ansi(`color:${ANSI.brightBlack}`, 'rgb(255,107,107)')
        ),
        frag(
          ansi('color:#4ecdc4', '████'),
          ' ',
          ansi(`color:${ANSI.brightBlack}`, 'rgb(78,205,196)')
        ),
        frag(
          ansi('color:#ffe66d', '████'),
          ' ',
          ansi(`color:${ANSI.brightBlack}`, 'rgb(255,230,109)')
        )
      ),
  },
};
