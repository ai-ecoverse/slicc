import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-freezer.js';
// Import the child modules so the composed tags register (composition BY TAG).
import './slicc-freezer-card.js';
import './slicc-freezer-new.js';
import './slicc-frost-shader.js';

/**
 * Storybook for `<slicc-freezer>` — the collapsible past-sessions rail.
 *
 * This is the POPULATED side-rail review: the freezer chrome with a
 * `<slicc-freezer-new>` New-chat affordance at the top of the rail and a stack of
 * `<slicc-freezer-card>` session rows, all composed BY TAG (the freezer relocates
 * its slotted children into the `.fzrail` on connect). A `<slicc-frost-shader>` is
 * laid in behind the rail as the crystallizing ice background, so the corner-grown
 * frost reads underneath the chrome exactly as in the prototype. Every glyph comes
 * from the child components' shared lucide `iconSvg` helper (square-pen / snowflake),
 * never emoji.
 *
 * The freezer is `position: fixed` to the left edge at `z-index: 6`; the two named
 * exports surface both rail states — `Collapsed` (44px icon strip) and `Open`
 * (260px, the `open` attribute set, children `expanded` so titles fade in). The
 * cards own their own `expanded` flag (the prototype gates this on `.freezer.open`),
 * so the rail state and the child state are set together. Light/dark + viewport are
 * global toolbars — no per-story theme wrappers.
 */
interface FreezerArgs {
  open?: boolean;
  ctx?: boolean;
  frost?: boolean;
}

/** One frozen-session row: title + meta + slug, composed as a child element. */
interface CardSpec {
  title: string;
  meta: string;
  slug: string;
}

/** The session stack shown in the rail — varied titles/meta, prototype-style. */
const SESSIONS: CardSpec[] = [
  { title: 'warm hero redesign', meta: '2h ago · 18 turns · PR #128', slug: 'warm-hero' },
  { title: 'checkout funnel audit', meta: 'yesterday · 11 turns · 4 scoops', slug: 'checkout' },
  { title: 'dark-mode polish', meta: '3d ago · 7 turns · PR #119', slug: 'dark-mode' },
  { title: 'onboarding rewrite', meta: 'last week · 24 turns · LIN-401', slug: 'onboarding' },
  { title: 'mobile nav refresh', meta: '2 weeks ago · 9 turns · PR #114', slug: 'mobile-nav' },
  { title: 'pricing table revamp', meta: '3 weeks ago · 15 turns · PR #109', slug: 'pricing' },
  { title: 'search ux audit', meta: 'last month · 6 turns · LIN-388', slug: 'search-ux' },
  { title: 'error states pass', meta: '2 months ago · 12 turns · PR #95', slug: 'errors' },
  { title: 'analytics dashboard', meta: '2 months ago · 21 turns · PR #88', slug: 'analytics' },
];

/** The New-chat affordance, composed by tag; `expanded` mirrors the rail state. */
function makeNew(expanded: boolean): HTMLElement {
  const el = document.createElement('slicc-freezer-new');
  if (expanded) el.setAttribute('expanded', '');
  return el;
}

/** One session row, composed by tag; `expanded` mirrors the rail state. */
function makeCard(spec: CardSpec, expanded: boolean): HTMLElement {
  const el = document.createElement('slicc-freezer-card');
  el.setAttribute('title', spec.title);
  el.setAttribute('meta', spec.meta);
  el.setAttribute('slug', spec.slug);
  if (expanded) el.setAttribute('expanded', '');
  return el;
}

/**
 * Build the populated freezer: the rail with a `<slicc-freezer-new>` at the top
 * and the `SESSIONS` stack of `<slicc-freezer-card>`s, composed by tag. The
 * children's `expanded` flag tracks the rail's `open` state (the prototype gates
 * the fade-in on `.freezer.open`).
 */
function buildFreezer({ open, ctx }: FreezerArgs): HTMLElement {
  const el = document.createElement('slicc-freezer');
  if (open) el.setAttribute('open', '');
  if (ctx) el.setAttribute('ctx', '');
  el.append(makeNew(Boolean(open)));
  for (const spec of SESSIONS) el.append(makeCard(spec, Boolean(open)));
  return el;
}

/**
 * Lay a `<slicc-frost-shader>` behind the freezer as the ice background, pinned to
 * the left edge under the rail. It is fixed and `z-index: 0` so the `z-index: 6`
 * freezer chrome sits on top; the canvas is `pointer-events: none`, so it never
 * intercepts toggle/search interaction. Honors `prefers-reduced-motion` itself
 * (renders a single static frost frame).
 */
function frostBehind(open: boolean): HTMLElement {
  const frost = document.createElement('slicc-frost-shader');
  frost.setAttribute('coverage', '0.7');
  frost.style.cssText = `position:fixed;left:0;top:0;bottom:0;width:${
    open ? '260px' : '44px'
  };z-index:0;`;
  return frost;
}

const meta: Meta<FreezerArgs> = {
  title: 'Freezer/Rail',
  component: 'slicc-freezer',
  tags: ['autodocs'],
  argTypes: {
    open: { control: 'boolean', description: 'Expand the rail (260px) vs collapsed (44px)' },
    ctx: { control: 'boolean', description: 'Ice-blue accent while a freezer context is active' },
    frost: { control: 'boolean', description: 'Lay a <slicc-frost-shader> ice background behind' },
  },
  // The freezer is position:fixed to the left edge — give Storybook room and a
  // relative origin so the (also-fixed) frost shader frames cleanly.
  decorators: [
    (story) => {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:relative;min-height:560px;';
      wrap.appendChild(story() as HTMLElement);
      return wrap;
    },
  ],
  render: (args) => {
    const stage = document.createDocumentFragment();
    if (args.frost) stage.appendChild(frostBehind(Boolean(args.open)));
    stage.appendChild(buildFreezer(args));
    // A fragment can't be a single root; wrap it so the decorator gets one node.
    const host = document.createElement('div');
    host.appendChild(stage);
    return host;
  },
};

export default meta;
type Story = StoryObj<FreezerArgs>;

/**
 * Collapsed — the resting 44px icon-only column: the snowflake card badges and the
 * square-pen New-chat badge stacked, all text columns at zero width. Frost laid in
 * behind the strip.
 */
export const Collapsed: Story = { args: { open: false, frost: true } };

/**
 * Open — the expanded 260px rail (`open` set): the New-chat label and every session
 * title + meta faded in, search visible in the header, over the ice background. The
 * full populated side-rail the design review wants to see.
 */
export const Open: Story = { args: { open: true, frost: true } };

/**
 * Open with a freezer context active — the chrome takes the ice-blue `ctx` accent
 * on the toggle and the New-chat badge while a past session is in focus.
 */
export const FreezerContext: Story = { args: { open: true, ctx: true, frost: true } };

/**
 * Collapsed with a freezer context active — the icon-only strip with the ice-blue
 * toggle/new-badge accent.
 */
export const CollapsedContext: Story = { args: { open: false, ctx: true, frost: true } };
