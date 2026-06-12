import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-freezer-card.js';

interface FreezerCardArgs {
  title?: string;
  meta?: string;
  slug?: string;
  icon?: string;
  expanded?: boolean;
  thawed?: boolean;
  hidden?: boolean;
}

/** Construct one freezer card from args (the building block for every story). */
function makeCard(args: FreezerCardArgs): HTMLElement {
  const el = document.createElement('slicc-freezer-card');
  if (args.title) el.setAttribute('title', args.title);
  if (args.meta) el.setAttribute('meta', args.meta);
  if (args.slug) el.setAttribute('slug', args.slug);
  if (args.icon) el.setAttribute('icon', args.icon);
  if (args.expanded) el.setAttribute('expanded', '');
  if (args.thawed) el.setAttribute('thawed', '');
  if (args.hidden) el.setAttribute('hidden', '');
  return el;
}

const meta: Meta<FreezerCardArgs> = {
  title: 'Freezer/FreezerCard',
  component: 'slicc-freezer-card',
  tags: ['autodocs'],
  argTypes: {
    title: { control: 'text', description: 'Session heading (.fzt)' },
    meta: { control: 'text', description: 'Meta line (.fzm)' },
    slug: { control: 'text', description: 'Session id, surfaced in freezer-card-select' },
    icon: { control: 'text', description: 'Optional lucide icon name (overrides the snowflake)' },
    expanded: {
      control: 'boolean',
      description: 'Fade in the title+meta (collapsed = badge only)',
    },
    thawed: { control: 'boolean', description: 'Rose reopen flash (mirrored onto the badge)' },
    hidden: { control: 'boolean', description: 'Search-hide (the prototype .match-hidden)' },
  },
  render: (args) => makeCard(args),
};

export default meta;
type Story = StoryObj<FreezerCardArgs>;

const SAMPLE = {
  title: 'warm hero redesign',
  meta: '2h ago · 18 turns · PR #128',
  slug: 'warm-hero',
};

/** Expanded — the default rail-open look: badge + title + meta. */
export const Expanded: Story = {
  args: { ...SAMPLE, expanded: true },
};

/** Collapsed — the icon-only strip (`.freezer:not(.open)`): badge only, text width 0. */
export const Collapsed: Story = {
  args: { ...SAMPLE },
};

/**
 * Collapsed + hover — the icon-only strip on hover: instead of a rectangular
 * ghost fill clashing around the lone badge, the hover affordance is a soft
 * circular ring hugging the snowflake. Surfaced via the global Pseudo States
 * toolbar.
 */
export const CollapsedHover: Story = {
  args: { ...SAMPLE },
  parameters: { pseudo: { hover: true } },
};

/** Thawing — the rose reopen flash: rose row + rose snowflake badge. */
export const Thawing: Story = {
  args: { ...SAMPLE, expanded: true, thawed: true },
};

/** Search-hidden — the prototype's `.match-hidden` (`display: none`). Renders nothing. */
export const SearchHidden: Story = {
  args: { ...SAMPLE, expanded: true, hidden: true },
};

/**
 * Custom icon — the snowflake is the default, but `icon` swaps in any lucide glyph
 * (here `flame`) inside the same circular badge for a per-session marker.
 */
export const CustomIcon: Story = {
  args: { ...SAMPLE, expanded: true, icon: 'flame' },
};

/**
 * A rail mixing the default snowflake with a few custom icons (`flame`,
 * `git-branch`, `bug`) — shows the badge staying visually consistent while the
 * glyph varies per session.
 */
export const CustomIconRail: Story = {
  render: () => {
    const rail = document.createElement('div');
    rail.style.cssText =
      'display:flex;flex-direction:column;gap:2px;width:240px;padding:8px;' +
      'background:var(--canvas);border:1px solid var(--line);border-radius:12px;';
    const rows: Array<[string, string, string, string | undefined]> = [
      ['warm hero redesign', '2h ago · 18 turns · PR #128', 'warm-hero', undefined],
      ['hotfix: payment crash', 'yesterday · 5 turns · PR #131', 'hotfix', 'flame'],
      ['feature/dark-mode', '3d ago · 7 turns · PR #119', 'dark-mode', 'git-branch'],
      ['triage: error states', 'last week · 12 turns · LIN-401', 'triage', 'bug'],
    ];
    for (const [title, metaLine, slug, icon] of rows) {
      rail.appendChild(makeCard({ title, meta: metaLine, slug, icon, expanded: true }));
    }
    return rail;
  },
};

/**
 * A populated freezer rail — the expanded left strip of frozen sessions, exactly
 * as the prototype lists them, so the row rhythm + hover + thaw read as a real
 * panel. Click any row to fire `freezer-card-select` and watch the thaw flash.
 */
export const FreezerRail: Story = {
  render: () => {
    const rail = document.createElement('div');
    rail.style.cssText =
      'display:flex;flex-direction:column;gap:2px;width:240px;padding:8px;' +
      'background:var(--canvas);border:1px solid var(--line);border-radius:12px;';
    const rows: Array<[string, string, string]> = [
      ['warm hero redesign', '2h ago · 18 turns · PR #128', 'warm-hero'],
      ['checkout funnel audit', 'yesterday · 11 turns · 4 scoops', 'checkout-audit'],
      ['dark-mode polish', '3d ago · 7 turns · PR #119', 'dark-mode'],
      ['onboarding rewrite', 'last week · 24 turns · LIN-401', 'onboarding'],
      ['mobile nav refresh', '2 weeks ago · 9 turns · PR #114', 'mobile-nav'],
      ['pricing table revamp', '3 weeks ago · 15 turns · PR #109', 'pricing'],
      ['search ux audit', 'last month · 6 turns · LIN-388', 'search-ux'],
      ['error states pass', '2 months ago · 12 turns · PR #95', 'errors'],
    ];
    for (const [title, metaLine, slug] of rows) {
      rail.appendChild(makeCard({ title, meta: metaLine, slug, expanded: true }));
    }
    return rail;
  },
};

/**
 * The collapsed rail — the freezer's icon-only strip. Eight snowflake badges
 * stacked; the text columns have zero width.
 */
export const CollapsedRail: Story = {
  render: () => {
    const rail = document.createElement('div');
    rail.style.cssText =
      'display:flex;flex-direction:column;gap:2px;width:44px;padding:8px;' +
      'background:var(--canvas);border:1px solid var(--line);border-radius:12px;';
    for (let i = 0; i < 8; i++) {
      rail.appendChild(makeCard({ title: `session ${i + 1}`, meta: 'frozen', slug: `s-${i}` }));
    }
    return rail;
  },
};
