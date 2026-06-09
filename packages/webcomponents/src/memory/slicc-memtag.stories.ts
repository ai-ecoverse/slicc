import type { Meta, StoryObj } from '@storybook/web-components-vite';
// `<slicc-memrow>` is an already-built sibling (earlier wave); the `InMemoryRows`
// story composes it, so import it to guarantee registration in isolation.
import './slicc-memrow.js';
import './slicc-memtag.js';

type MemtagType = 'user' | 'feedback' | 'project';

interface MemtagArgs {
  type?: MemtagType;
  label?: string;
}

const meta: Meta<MemtagArgs> = {
  title: 'Memory/Memtag',
  component: 'slicc-memtag',
  tags: ['autodocs'],
  argTypes: {
    type: {
      control: 'inline-radio',
      options: ['user', 'feedback', 'project'],
      description: 'Tag type — user → rose, feedback → cyan, project → violet',
    },
    label: { control: 'text', description: 'Optional label override (defaults to the type name)' },
  },
  render: ({ type, label }) => {
    const el = document.createElement('slicc-memtag');
    if (type) el.setAttribute('type', type);
    if (label != null) el.setAttribute('label', label);
    return el;
  },
};

export default meta;
type Story = StoryObj<MemtagArgs>;

/** User memory — rose tint (`.mtag.us`). */
export const User: Story = { args: { type: 'user' } };

/** Feedback memory — cyan tint (`.mtag.fb`). */
export const Feedback: Story = { args: { type: 'feedback' } };

/** Project memory — violet tint (`.mtag.pj`). */
export const Project: Story = { args: { type: 'project' } };

/** A custom label override on the cyan feedback hue. */
export const CustomLabel: Story = { args: { type: 'feedback', label: 'review' } };

/** All three type tags at once — quick visual matrix for light/dark review. */
export const AllTypes: StoryObj = {
  render: () => {
    const wrap = document.createElement('div');
    wrap.style.display = 'flex';
    wrap.style.flexWrap = 'wrap';
    wrap.style.gap = '8px';
    wrap.style.alignItems = 'center';
    for (const type of ['user', 'feedback', 'project'] as const) {
      const el = document.createElement('slicc-memtag');
      el.setAttribute('type', type);
      wrap.appendChild(el);
    }
    return wrap;
  },
};

/**
 * Realistic memory rows — the populated panel context the tag lives in
 * (`<slicc-memrow>` carries the right-pinned `<slicc-memtag>`). Reviewable in
 * both light and dark via the theme toolbar.
 */
export const InMemoryRows: StoryObj = {
  render: () => {
    const wrap = document.createElement('div');
    wrap.style.maxWidth = '360px';
    const rows: Array<[string, string, MemtagType, boolean]> = [
      [
        'palette preference: warm paper',
        'Prefers paper #faf6f1 canvas + violet accent + single pill CTA for marketing pages.',
        'user',
        true,
      ],
      [
        'icon buttons need tooltips',
        'All icon-only buttons must have data-tooltip + aria-label.',
        'feedback',
        false,
      ],
      [
        'UI redesign exploration',
        '3 axes — structure × palette × style; the "lick" blob; mockups in slicc-styles/.',
        'project',
        false,
      ],
    ];
    for (const [title, summary, type, fresh] of rows) {
      const row = document.createElement('slicc-memrow');
      row.setAttribute('title', title);
      row.setAttribute('summary', summary);
      row.setAttribute('tag', type);
      if (fresh) row.setAttribute('fresh', '');
      wrap.appendChild(row);
    }
    return wrap;
  },
};
