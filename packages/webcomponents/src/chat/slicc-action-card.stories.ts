import type { Meta, StoryObj } from '@storybook/web-components-vite';
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
    glyph: { control: 'text', description: 'Glyph chip text (tool/light header)' },
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
  },
  render: (args) => build(args),
};

export default meta;
type Story = StoryObj<ActionCardArgs>;

/** Default tool card — dark terminal body with prompt / ok / muted spans. */
export const Tool: Story = {
  args: {
    variant: 'tool',
    glyph: '⚡',
    title: 'bash · run tests',
    body:
      '<span class="p">❯</span> npm test\n' +
      '<span class="ok">✓ 128 passed</span>\n' +
      '<span class="mut">0 failed · 1.2s</span>',
  },
};

/** Tool card with a right-aligned status badge. */
export const ToolWithBadge: Story = {
  args: {
    variant: 'tool',
    glyph: '⎇',
    tone: 'gh',
    title: 'git · commit + push',
    badge: 'warm-hero',
    body:
      '<span class="p">❯</span> git commit -am "feat(hero): warm redesign"\n' +
      '<span class="ok">[warm-hero 9f2a1c] 2 files changed, +38 −21</span>\n' +
      '<span class="p">❯</span> git push -u origin warm-hero',
  },
};

/** Cyan icon tone — e.g. a researcher/read tool. */
export const ToneCyan: Story = {
  args: {
    variant: 'tool',
    glyph: '◎',
    tone: 'cy',
    title: 'read_file · hero.css',
    body: '<span class="mut">42 lines</span>\n.hero{background:#0b1120;color:#e2e8f0;}',
  },
};

/** Violet icon tone — e.g. a designer/sprinkle tool. */
export const ToneViolet: Story = {
  args: {
    variant: 'tool',
    glyph: '✦',
    tone: 'vi',
    title: 'sprinkle · hero preview',
    body: '<span class="ok">✓ rendered</span> <span class="mut">live in workbench</span>',
  },
};

/** Amber icon tone — e.g. a tester tool surfacing a warning. */
export const ToneAmber: Story = {
  args: {
    variant: 'tool',
    glyph: '◐',
    tone: 'am',
    title: 'test · a11y audit',
    body: '<span class="warn">⚠ 1 contrast issue</span>\n<span class="mut">CTA on mobile</span>',
  },
};

/** GitHub icon tone with a diff body (add / del lines). */
export const ToneGithubDiff: Story = {
  args: {
    variant: 'tool',
    glyph: '⎇',
    tone: 'gh',
    title: 'edit_file · hero.css',
    body:
      '<span class="del">- background:#0b1120;</span>\n' +
      '<span class="add">+ background:#fff7ed;</span>\n' +
      '<span class="del">- color:#e2e8f0;</span>\n' +
      '<span class="add">+ color:#7c2d12;</span>',
  },
};

/** Light variant — the body renders on the canvas surface, not the dark shell. */
export const Light: Story = {
  args: {
    variant: 'light',
    glyph: '◎',
    tone: 'cy',
    title: 'cat · package.json',
    body: '<span class="mut">{</span>\n  "name": "@slicc/webapp",\n  "version": "3.46.0"\n<span class="mut">}</span>',
  },
};

/** PR card — green Open pill, branch summary, file count, +add/−del, checks. */
export const PullRequest: Story = {
  args: {
    variant: 'pr',
    title: 'feat(hero): warm redesign',
    number: '#128',
    status: 'Open',
    branch: 'warm-hero → main',
    files: '2',
    add: '38',
    del: '21',
    checks: '✓ passing',
  },
};

/** A realistic chat fragment: a tool card, a git card, and the resulting PR card. */
export const ChatSequence: Story = {
  render: () => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'max-width:520px;display:flex;flex-direction:column;';

    wrap.appendChild(
      build({
        variant: 'tool',
        glyph: '⚡',
        title: 'test · run suite',
        body:
          '<span class="p">❯</span> npm test\n' +
          '<span class="ok">✓ 128 passed</span> <span class="mut">0 failed · 1.2s</span>',
      })
    );
    wrap.appendChild(
      build({
        variant: 'tool',
        glyph: '⎇',
        tone: 'gh',
        title: 'git · commit + push',
        badge: 'warm-hero',
        body:
          '<span class="p">❯</span> git checkout -b warm-hero\n' +
          '<span class="ok">[warm-hero 9f2a1c] 2 files changed, +38 −21</span>\n' +
          '<span class="p">❯</span> git push -u origin warm-hero',
      })
    );
    wrap.appendChild(
      build({
        variant: 'pr',
        title: 'feat(hero): warm redesign',
        number: '#128',
        status: 'Open',
        branch: 'warm-hero → main',
        files: '2',
        add: '38',
        del: '21',
        checks: '✓ passing',
      })
    );
    return wrap;
  },
};
