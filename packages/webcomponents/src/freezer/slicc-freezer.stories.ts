import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-freezer.js';

/**
 * Storybook for `<slicc-freezer>` — the collapsible past-sessions rail.
 *
 * The session rows + New-chat affordance are composed BY TAG. The sibling
 * elements `<slicc-freezer-new>` / `<slicc-freezer-card>` are built in the same
 * wave, so these stories slot the prototype's raw `.fznew` / `.fzcard` markup
 * (which the freezer's search filter also recognises) to stay reviewable without
 * importing the siblings. Light/dark + viewport are global toolbars — no
 * per-story theme wrappers.
 */
interface FreezerArgs {
  open?: boolean;
  ctx?: boolean;
}

/** A single prototype session row (`.fzcard`) — snowflake icon + title + meta. */
function card(slug: string, title: string, meta: string): string {
  return (
    `<div class="fzcard" data-s="${slug}" title="${title} — ${meta}">` +
    '<span class="snow">❄</span>' +
    `<div class="ftext"><div class="fzt">${title}</div><div class="fzm">${meta}</div></div>` +
    '</div>'
  );
}

/** The prototype's New-chat affordance (`.fznew`) — pencil icon + label. */
const NEW_CHAT =
  '<button class="fznew" title="New chat" aria-label="New chat">' +
  '<span class="nico"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"' +
  ' stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M11.5 2.5l2 2L6 12l-3 1 1-3z"/><line x1="9.5" y1="4.5" x2="11.5" y2="6.5"/></svg></span>' +
  '<span class="nlbl">New chat</span></button>';

/** The full slotted rail content (New-chat + a stack of frozen sessions). */
const RAIL_CONTENT =
  NEW_CHAT +
  card('warm-hero', 'warm hero redesign', '2h ago · 18 turns · PR #128') +
  card('checkout-audit', 'checkout funnel audit', 'yesterday · 11 turns · 4 scoops') +
  card('dark-mode', 'dark-mode polish', '3d ago · 7 turns · PR #119') +
  card('onboarding', 'onboarding rewrite', 'last week · 24 turns · LIN-401') +
  card('mobile-nav', 'mobile nav refresh', '2 weeks ago · 9 turns · PR #114') +
  card('pricing', 'pricing table revamp', '3 weeks ago · 15 turns · PR #109') +
  card('search-ux', 'search ux audit', 'last month · 6 turns · LIN-388') +
  card('footer', 'footer redesign', 'last month · 8 turns · PR #102') +
  card('errors', 'error states pass', '2 months ago · 12 turns · PR #95') +
  card('analytics', 'analytics dashboard', '2 months ago · 21 turns · PR #88');

function build({ open, ctx }: FreezerArgs): HTMLElement {
  const el = document.createElement('slicc-freezer');
  if (open) el.setAttribute('open', '');
  if (ctx) el.setAttribute('ctx', '');
  el.innerHTML = RAIL_CONTENT;
  return el;
}

const meta: Meta<FreezerArgs> = {
  title: 'Freezer/Rail',
  component: 'slicc-freezer',
  tags: ['autodocs'],
  argTypes: {
    open: { control: 'boolean', description: 'Expand the rail (260px) vs collapsed (44px)' },
    ctx: { control: 'boolean', description: 'Ice-blue accent while a freezer context is active' },
  },
  // The freezer is position:fixed to the left edge — give Storybook room.
  decorators: [
    (story) => {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:relative;min-height:520px;';
      wrap.appendChild(story() as HTMLElement);
      return wrap;
    },
  ],
  render: (args) => build(args),
};

export default meta;
type Story = StoryObj<FreezerArgs>;

/** Default resting state: collapsed to a 44px icon-only column. */
export const Collapsed: Story = { args: { open: false } };

/** Expanded to the 260px rail with search visible and session titles stretched. */
export const Open: Story = { args: { open: true } };

/** Open with a freezer context active — chrome takes the ice-blue accent. */
export const FreezerContext: Story = { args: { open: true, ctx: true } };

/** Collapsed with a freezer context active (icon-only, ice-blue toggle). */
export const CollapsedContext: Story = { args: { open: false, ctx: true } };
