import type { Meta, StoryObj } from '@storybook/web-components-vite';
import { iconSvg } from '../internal/icons.js';
// Importing the row registers `<slicc-action-row>` so the ToolCluster story can
// compose both affordances by tag, exactly as they appear in a chat turn.
import './slicc-action-row.js';
import './slicc-action-card.js';

interface ActionCardArgs {
  variant?: 'tool' | 'light' | 'pr';
  glyph?: string;
  tone?: 'ink' | 'cy' | 'vi' | 'am' | 'gh';
  title?: string;
  badge?: string;
  number?: string;
  status?: string;
  branch?: string;
  files?: string;
  add?: string;
  del?: string;
  checks?: string;
  body?: string;
  /** Lucide icon name for the glyph chip (replaces the text `glyph` attribute). */
  icon?: string;
}

/**
 * The lucide glyph chips inside both affordances are rendered as real `<svg>`
 * elements (never emoji or bespoke unicode). The chip wells set `color:#fff`, so
 * the icons inherit white via `stroke: currentColor`. Chip glyph is ~11px to sit
 * inside the 18px well; in-body markers are smaller still.
 */
const CHIP = 11;
const MARK = 12;

// Inline lucide markers for the monospace bodies — the prototype's prompt /
// tick / warning / diff symbols are real vector icons here, never glyph chars.
const PROMPT = iconSvg('chevron-right', { size: MARK }); // prototype prompt caret
const OK = iconSvg('check', { size: MARK }); // success tick
const WARN = iconSvg('triangle-alert', { size: MARK }); // warning marker
const ADD = iconSvg('plus', { size: 11 }); // diff add marker
const DEL = iconSvg('minus', { size: 11 }); // diff del marker

/**
 * Drop a lucide `<svg>` into the chip well of a freshly-mounted card/row. The
 * `glyph` / `icon` attributes render text only, so the chip is left empty at
 * mount and the vector glyph is injected here (the host owns its light DOM
 * synchronously after `connectedCallback`).
 */
function setChip(el: HTMLElement, selector: string, name: string): void {
  const ic = el.querySelector(selector);
  if (ic) ic.innerHTML = iconSvg(name, { size: CHIP });
}

/** Build a populated action card from args, filling the terminal body via innerHTML. */
function build(args: ActionCardArgs): HTMLElement {
  const el = document.createElement('slicc-action-card');
  el.style.maxWidth = '520px';
  for (const key of [
    'variant',
    'glyph',
    'tone',
    'title',
    'badge',
    'number',
    'status',
    'branch',
    'files',
    'add',
    'del',
    'checks',
  ] as const) {
    const v = args[key];
    if (v != null) el.setAttribute(key, v);
  }
  if (args.body != null) el.innerHTML = args.body;
  // PR cards carry their git glyph in the `.gi` well; tool/light cards in `.ic`.
  const icon = args.icon ?? (args.variant === 'pr' ? 'git-pull-request' : undefined);
  if (icon) {
    // Defer until the element has upgraded and built its light-DOM scaffold.
    queueMicrotask(() => setChip(el, args.variant === 'pr' ? '.gi' : '.ic', icon));
  }
  return el;
}

const meta: Meta<ActionCardArgs> = {
  title: 'Chat/ActionCard',
  component: 'slicc-action-card',
  tags: ['autodocs'],
  argTypes: {
    variant: {
      control: 'inline-radio',
      options: ['tool', 'light', 'pr'],
      description: 'Card form',
    },
    icon: { control: 'text', description: 'Lucide glyph-chip icon name (tool/light/pr)' },
    tone: {
      control: 'inline-radio',
      options: ['ink', 'cy', 'vi', 'am', 'gh'],
      description: 'Glyph chip tint (tool/light)',
    },
    title: { control: 'text', description: 'Header title (.nm / .pt)' },
    badge: { control: 'text', description: 'Right-aligned badge pill (tool/light)' },
    number: { control: 'text', description: 'PR number (.pn)' },
    status: { control: 'text', description: 'PR status pill (.open)' },
    branch: { control: 'text', description: 'PR branch summary' },
    files: { control: 'text', description: 'PR file count' },
    add: { control: 'text', description: 'PR additions delta' },
    del: { control: 'text', description: 'PR deletions delta' },
    checks: { control: 'text', description: 'PR checks summary' },
    body: { control: 'text', description: 'Terminal body HTML (tool/light)' },
    glyph: { table: { disable: true } },
  },
  render: (args) => build(args),
};

export default meta;
type Story = StoryObj<ActionCardArgs>;

/** Default tool card — dark terminal body with prompt / ok / muted spans. */
export const Tool: Story = {
  args: {
    variant: 'tool',
    icon: 'terminal',
    tone: 'ink',
    title: 'bash · run tests',
    body:
      `<span class="p">${PROMPT}</span> npm test\n` +
      `<span class="ok">${OK} 128 passed</span>\n` +
      '<span class="mut">0 failed · 1.2s</span>',
  },
};

/** Tool card with a right-aligned status badge — the git commit/push card. */
export const ToolWithBadge: Story = {
  args: {
    variant: 'tool',
    icon: 'git-branch',
    tone: 'gh',
    title: 'git · commit + push',
    badge: 'warm-hero',
    body:
      `<span class="p">${PROMPT}</span> git commit -am "feat(hero): warm redesign"\n` +
      `<span class="ok">[warm-hero 9f2a1c] 2 files changed, ${ADD}38 ${DEL}21</span>\n` +
      `<span class="p">${PROMPT}</span> git push -u origin warm-hero`,
  },
};

/** Cyan icon tone — e.g. a researcher/read tool. */
export const ToneCyan: Story = {
  args: {
    variant: 'tool',
    icon: 'eye',
    tone: 'cy',
    title: 'read_file · hero.css',
    body: '<span class="mut">42 lines</span>\n.hero{background:#0b1120;color:#e2e8f0;}',
  },
};

/** Violet icon tone — e.g. a designer/sprinkle tool. */
export const ToneViolet: Story = {
  args: {
    variant: 'tool',
    icon: 'sparkles',
    tone: 'vi',
    title: 'sprinkle · hero preview',
    body: `<span class="ok">${OK} rendered</span> <span class="mut">live in workbench</span>`,
  },
};

/** Amber icon tone — e.g. a tester tool surfacing a warning. */
export const ToneAmber: Story = {
  args: {
    variant: 'tool',
    icon: 'flask-conical',
    tone: 'am',
    title: 'test · a11y audit',
    body: `<span class="warn">${WARN} 1 contrast issue</span>\n<span class="mut">CTA on mobile</span>`,
  },
};

/** GitHub icon tone with a diff body (add / del lines). */
export const ToneGithubDiff: Story = {
  args: {
    variant: 'tool',
    icon: 'file-diff',
    tone: 'gh',
    title: 'edit_file · hero.css',
    body:
      `<span class="del">${DEL} background:#0b1120;</span>\n` +
      `<span class="add">${ADD} background:#fff7ed;</span>\n` +
      `<span class="del">${DEL} color:#e2e8f0;</span>\n` +
      `<span class="add">${ADD} color:#7c2d12;</span>`,
  },
};

/** Light variant — the body renders on the canvas surface, not the dark shell. */
export const Light: Story = {
  args: {
    variant: 'light',
    icon: 'file-code',
    tone: 'cy',
    title: 'cat · package.json',
    body: '<span class="mut">{</span>\n  "name": "@slicc/webapp",\n  "version": "3.46.0"\n<span class="mut">}</span>',
  },
};

/** PR card — green Open pill, branch summary, file count, +add / -del, checks. */
export const Pr: Story = {
  args: {
    variant: 'pr',
    icon: 'git-pull-request',
    title: 'feat(hero): warm redesign',
    number: '#128',
    status: 'Open',
    branch: 'warm-hero → main',
    files: '2',
    add: '38',
    del: '21',
    checks: 'passing',
  },
};

/**
 * TOOL CLUSTER — several tool affordances grouped vertically as they appear in a
 * single chat turn, composed by tag: two expandable `<slicc-action-row>`s (an
 * `edit_file` diff and a `vitest` run with pass lines), then three
 * `<slicc-action-card>`s — a dark terminal/git `.tcard`, a light `.tcard`, and
 * the resulting PR card with the green Open status pill and the +/- deltas.
 * Every glyph (chips, prompts, ticks, diff markers) is a lucide `<svg>`.
 */
export const ToolCluster: Story = {
  render: () => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'max-width:520px;display:flex;flex-direction:column;';

    // ── Expandable row 1: an edit_file diff (open) with a .vlink filename. ──
    const editRow = document.createElement('slicc-action-row');
    editRow.style.width = '100%';
    editRow.setAttribute('open', '');
    editRow.setAttribute('tone', 'vi');
    editRow.setAttribute('result', '4 changes');
    const editLabel = document.createElement('span');
    editLabel.innerHTML =
      'edit_file · <a class="vlink" data-file="fcss" data-kind="css">hero.css</a>';
    editRow.appendChild(editLabel);
    const editBody = document.createElement('div');
    editBody.setAttribute('slot', 'body');
    editBody.innerHTML =
      `<span class="del">${DEL} background: #0e0e0f;</span>\n` +
      `<span class="add">${ADD} background: #faf6f1;</span>\n` +
      `<span class="del">${DEL} font-family: ui-monospace;</span>\n` +
      `<span class="add">${ADD} font-family: Fraunces, serif;</span>\n` +
      `<span class="ok">${OK} live-reloaded at /preview/hero</span>`;
    editRow.appendChild(editBody);
    wrap.appendChild(editRow);

    // ── Expandable row 2: a vitest run (open) with pass lines. ──
    const testRow = document.createElement('slicc-action-row');
    testRow.style.width = '100%';
    testRow.setAttribute('open', '');
    testRow.setAttribute('tone', 'am');
    testRow.setAttribute('label', 'tester · vitest');
    testRow.setAttribute('result', '3 passed');
    const testBody = document.createElement('div');
    testBody.setAttribute('slot', 'body');
    testBody.innerHTML =
      `<span class="p">${PROMPT}</span> npm test -- hero\n` +
      `<span class="ok">${OK} hero renders warm canvas</span>\n` +
      `<span class="ok">${OK} single accessible CTA</span>\n` +
      `<span class="ok">${OK} contrast >= 4.5:1</span>\n` +
      '<span class="mut">0 failed · 1.2s</span>';
    testRow.appendChild(testBody);
    wrap.appendChild(testRow);

    // ── Card 1: a dark terminal / git .tcard. ──
    const gitCard = build({
      variant: 'tool',
      icon: 'git-branch',
      tone: 'gh',
      title: 'git · commit + push',
      badge: 'warm-hero',
      body:
        `<span class="p">${PROMPT}</span> git checkout -b warm-hero\n` +
        `<span class="ok">[warm-hero 9f2a1c] 2 files changed, ${ADD}38 ${DEL}21</span>\n` +
        `<span class="p">${PROMPT}</span> git push -u origin warm-hero`,
    });
    gitCard.style.maxWidth = '100%';
    wrap.appendChild(gitCard);

    // ── Card 2: a light .tcard (canvas-surface body). ──
    const lightCard = build({
      variant: 'light',
      icon: 'file-code',
      tone: 'cy',
      title: 'cat · package.json',
      body: '<span class="mut">{</span>\n  "name": "@slicc/webapp",\n  "version": "3.46.0"\n<span class="mut">}</span>',
    });
    lightCard.style.maxWidth = '100%';
    wrap.appendChild(lightCard);

    // ── Card 3: the resulting PR card (green Open pill + +/- deltas). ──
    const prCard = build({
      variant: 'pr',
      icon: 'git-pull-request',
      title: 'feat(hero): warm redesign',
      number: '#128',
      status: 'Open',
      branch: 'warm-hero → main',
      files: '2',
      add: '38',
      del: '21',
      checks: 'passing',
    });
    prCard.style.maxWidth = '100%';
    wrap.appendChild(prCard);

    // Inject the lucide chip glyphs into the two rows once they have upgraded.
    queueMicrotask(() => {
      setChip(editRow, '.slicc-act__ic', 'pen-line');
      setChip(testRow, '.slicc-act__ic', 'check-check');
    });

    return wrap;
  },
};
