import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-action-row.js';

interface ActionRowArgs {
  open?: boolean;
  icon?: string;
  tone?: 'ink' | 'vi' | 'am' | 'cy' | 'gh';
  label?: string;
  result?: string;
  /** Raw monospace body HTML (carries `.add`/`.del`/`.ok`/`.p`/`.mut`). */
  body?: string;
  /** Optional label HTML override (e.g. a `.vlink` filename) for the default slot. */
  labelHtml?: string;
}

/** Build a populated action row so each story is reviewable end-to-end. */
function buildRow({
  open,
  icon,
  tone,
  label,
  result,
  body,
  labelHtml,
}: ActionRowArgs): HTMLElement {
  const row = document.createElement('slicc-action-row');
  row.style.width = '440px';
  if (open) row.setAttribute('open', '');
  if (icon) row.setAttribute('icon', icon);
  if (tone) row.setAttribute('tone', tone);
  if (result != null) row.setAttribute('result', result);

  if (labelHtml) {
    // Default-slot rich label (e.g. `edit_file · hero.css` with a clickable file).
    const span = document.createElement('span');
    span.innerHTML = labelHtml;
    row.appendChild(span);
  } else if (label != null) {
    row.setAttribute('label', label);
  }

  const bodyEl = document.createElement('div');
  bodyEl.setAttribute('slot', 'body');
  bodyEl.innerHTML = body ?? '';
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
    body: { control: 'text', description: 'Monospace body HTML' },
    labelHtml: { control: 'text', description: 'Rich label HTML (default slot) override' },
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
    body:
      '<span class="p">❯</span> npm test -- hero\n' +
      '<span class="ok">✓ hero renders warm canvas</span>\n' +
      '<span class="ok">✓ single accessible CTA</span>\n' +
      '<span class="ok">✓ contrast ≥ 4.5:1</span>\n' +
      '<span class="mut">0 failed · 1.2s</span>',
  },
};

/** Open — body expanded, chevron rotated 90°. A diff edit_file with a `.vlink`. */
export const OpenDiff: Story = {
  args: {
    open: true,
    icon: '✎',
    tone: 'vi',
    result: '4 changes',
    labelHtml: 'edit_file · <a class="vlink" data-file="fcss" data-kind="css">hero.css</a>',
    body:
      '<span class="del">- background: #0e0e0f;</span>\n' +
      '<span class="add">+ background: #faf6f1;</span>\n' +
      '<span class="del">- font-family: ui-monospace;</span>\n' +
      '<span class="add">+ font-family: Fraunces, serif;</span>\n' +
      '<span class="ok">✓ live-reloaded at /preview/hero</span>',
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
    body:
      '<span class="p">❯</span> playwright screenshot --selector .hero before.png\n' +
      '<span class="p">❯</span> playwright screenshot --selector .hero after.png\n' +
      '<span class="ok">✓ DPR normalized → see the Browser panel</span>',
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
    body: '<span class="add">+ accent applied</span>',
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
    body: '<span class="ok">✓ all green</span>\n<span class="mut">0 failed · 1.2s</span>',
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
    body: '<span class="mut">scanned 12 files</span>',
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
    body:
      '<span class="p">❯</span> git checkout -b warm-hero\n' +
      '<span class="p">❯</span> git commit -am "feat(hero): warm redesign"\n' +
      '<span class="ok">[warm-hero 9f2a1c] 2 files changed, +38 −21</span>\n' +
      '<span class="p">❯</span> git push -u origin warm-hero',
  },
};

/** No result badge — the badge region collapses when `result` is empty. */
export const NoBadge: Story = {
  args: {
    open: true,
    icon: '✦',
    tone: 'ink',
    label: 'upskill · brand-voice',
    body:
      '<span class="p">❯</span> upskill https://github.com/acme/brand-voice\n' +
      '<span class="ok">✓ installed skill → /workspace/skills/</span>',
  },
};
