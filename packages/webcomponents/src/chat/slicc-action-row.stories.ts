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
