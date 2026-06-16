import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-lick-card.js';

interface LickCardArgs {
  kind?: string;
  'event-label'?: string;
  body?: string;
  bodyHtml?: string;
  hue?: string;
  'no-animate'?: boolean;
  collapsible?: boolean;
  collapsed?: boolean;
  theme?: 'light' | 'dark';
  state?: 'pending' | 'confirmed' | 'dismissed';
}

/**
 * Project the demo `bodyHtml` (plain text with `<b>…</b>` emphasis) into the
 * card's default slot as real DOM — text nodes plus `<b>` elements — instead of
 * an HTML-string assignment. The library builds markup by DOM construction,
 * stories included.
 */
function appendRichBody(el: HTMLElement, markup: string): void {
  // A capture-group split yields alternating segments: even indices are the
  // surrounding plain text, odd indices are the inner text of each `<b>…</b>`.
  markup.split(/<b>(.*?)<\/b>/g).forEach((part, i) => {
    if (part === '') return;
    if (i % 2 === 1) {
      const b = document.createElement('b');
      b.textContent = part;
      el.append(b);
    } else {
      el.append(document.createTextNode(part));
    }
  });
}

function build(args: LickCardArgs): HTMLElement {
  const el = document.createElement('slicc-lick-card');
  if (args.kind != null) el.setAttribute('kind', args.kind);
  if (args['event-label'] != null) el.setAttribute('event-label', args['event-label']);
  if (args['no-animate']) el.setAttribute('no-animate', '');
  if (args.collapsible) el.setAttribute('collapsible', '');
  if (args.collapsed) el.setAttribute('collapsed', '');
  if (args.theme) el.setAttribute('theme', args.theme);
  if (args.hue) el.setAttribute('hue', args.hue);
  if (args.state) el.setAttribute('state', args.state);
  // Rich slotted markup wins over the plain `body` attribute when supplied.
  if (args.bodyHtml != null) appendRichBody(el, args.bodyHtml);
  else if (args.body != null) el.setAttribute('body', args.body);
  return el;
}

const meta: Meta<LickCardArgs> = {
  title: 'Chat/LickCard',
  component: 'slicc-lick-card',
  tags: ['autodocs'],
  argTypes: {
    kind: { control: 'text', description: 'Lick kind shown after "lick · "' },
    'event-label': { control: 'text', description: 'Right-aligned amber pill text' },
    body: { control: 'text', description: 'Body text (escaped)' },
    bodyHtml: { control: 'text', description: 'Rich slotted body markup (overrides body)' },
    'no-animate': { control: 'boolean', description: 'Suppress the slide-in entrance' },
    collapsible: { control: 'boolean', description: 'Header toggles body visibility' },
    collapsed: { control: 'boolean', description: 'Hide the body (header stays)' },
    theme: { control: 'inline-radio', options: ['light', 'dark'], description: 'Theme override' },
    state: {
      control: 'inline-radio',
      options: ['pending', 'confirmed', 'dismissed'],
      description: 'Result state: pending (no glyph) / confirmed / dismissed',
    },
  },
  render: build,
};

export default meta;
type Story = StoryObj<LickCardArgs>;

/** The canonical prototype card: a support webhook arrives as a lick. */
export const Webhook: Story = {
  args: {
    kind: 'webhook',
    bodyHtml: 'A <b>lick</b> arrives — an external event. A support webhook pings the session.',
  },
};

/**
 * Focuses the header affordance: the prototype's 🔔 emoji is now a lucide icon
 * chosen by lick kind (here `webhook`), inheriting the amber header color via
 * `stroke: currentColor`. Review the crisp vector glyph here.
 */
export const HeaderIcon: Story = {
  args: {
    kind: 'webhook',
    'no-animate': true,
    bodyHtml: 'The header glyph is a <b>lucide</b> icon, not an emoji — vector, themeable, crisp.',
  },
};

/** Explicit dark variant — amber re-mixes over the canvas and the bell lightens to #e5b35a. */
export const Dark: Story = {
  args: {
    kind: 'webhook',
    theme: 'dark',
    bodyHtml: 'A <b>lick</b> in dark mode — the lucide bell inherits the lightened header color.',
  },
};

/** A cron-triggered lick — the header shows the lucide `clock` glyph. */
export const Cron: Story = {
  args: {
    kind: 'cron',
    bodyHtml: 'Nightly <b>cron</b> fired. sliccy spins a <b>one-shot scoop</b> to triage.',
  },
};

/** A workflow-completion lick — the header shows the lucide `workflow` glyph. */
export const WorkflowDone: Story = {
  args: {
    kind: 'workflow',
    'event-label': 'done',
    bodyHtml: 'Workflow <b>nightly-build</b> finished — 3 scoops fanned out, all green.',
  },
};

/** Plain-text body via the `body` attribute (no rich markup). */
export const PlainBody: Story = {
  args: {
    kind: 'webhook',
    body: 'A plain-text lick body with no emphasis spans, set via the body attribute.',
  },
};

/** Long body to show wrapping at full width. */
export const Wrapping: Story = {
  args: {
    kind: 'webhook',
    bodyHtml:
      'A <b>lick</b> arrives carrying a long payload summary that must wrap across multiple lines: ' +
      'the inbound support ticket references three prior threads, two attachments, and an SLA timer ' +
      'that sliccy now needs to triage before the next business hour.',
  },
};

/** Static (no slide-in) — for already-settled cards in the thread. */
export const NoAnimation: Story = {
  args: {
    kind: 'webhook',
    'no-animate': true,
    bodyHtml: 'A settled <b>lick</b> with the entrance animation suppressed.',
  },
};

/** Collapsible card, expanded — click the header to collapse. */
export const CollapsibleOpen: Story = {
  args: {
    kind: 'webhook',
    collapsible: true,
    bodyHtml: 'Click the header to <b>collapse</b> this lick. Click again to re-expand.',
  },
};

/** Collapsible card, collapsed — only the header band shows. */
export const CollapsibleClosed: Story = {
  args: {
    kind: 'webhook',
    collapsible: true,
    collapsed: true,
    bodyHtml: 'This body is hidden until the header is clicked.',
  },
};

/**
 * The icon-by-kind mapping in one frame: `webhook` → webhook glyph, `cron` →
 * clock, `workflow` → workflow glyph, and an unknown kind → the default bell.
 * Every card is right-aligned in the column.
 */
export const IconsByKind: Story = {
  render: () => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:4px;max-width:560px;';
    const rows: [string, string][] = [
      ['webhook', 'A support <b>webhook</b> pings the session.'],
      ['cron', 'A nightly <b>cron</b> job fired on schedule.'],
      ['workflow', 'A <b>workflow</b> run finished, all green.'],
      ['ping', 'An <b>unknown</b> kind keeps the default bell.'],
    ];
    for (const [kind, body] of rows) {
      const el = build({ kind, 'no-animate': true, bodyHtml: body });
      wrap.appendChild(el);
    }
    return wrap;
  },
};

/**
 * Right-alignment across collapse/expand: the collapsible card hugs the
 * column's right edge whether the body is shown or hidden — click the header to
 * toggle and confirm the right edge stays put.
 */
export const RightAligned: Story = {
  args: {
    kind: 'workflow',
    'event-label': 'done',
    collapsible: true,
    bodyHtml:
      'A right-aligned <b>workflow</b> lick. Collapsing hides this body, but the card stays pinned to the right.',
  },
};

/**
 * A scoop-originating lick wears the SCOOP's identity: the pill is the scoop
 * name in the scoop's accent color (white ink), not a repeat of the channel.
 */
export const ScoopIdentityTag: Story = {
  args: {
    kind: 'scoop-idle',
    'event-label': 'blame-roulette',
    hue: '#06b6d4',
    collapsible: true,
    collapsed: true,
    bodyHtml:
      'Scoop <b>blame-roulette</b> has been ready for 2 minutes without receiving any work.',
  },
};

/**
 * A resolved lick the user CONFIRMED: a green lucide `circle-check` is pinned at
 * the header's right edge, after the event pill. The card otherwise stays in its
 * normal amber tint.
 */
export const Confirmed: Story = {
  args: {
    kind: 'sudo-request',
    'event-label': 'sudo',
    state: 'confirmed',
    'no-animate': true,
    bodyHtml:
      'A <b>sudo request</b> the user <b>confirmed</b> — a green check marks the resolved lick.',
  },
};

/**
 * A resolved lick the user DISMISSED: a red lucide `circle-x` glyph, and the
 * whole card mutes — the amber tint desaturates to the neutral line/canvas mix
 * and the card dims via reduced opacity.
 */
export const Dismissed: Story = {
  args: {
    kind: 'sudo-request',
    'event-label': 'sudo',
    state: 'dismissed',
    'no-animate': true,
    bodyHtml:
      'A <b>sudo request</b> the user <b>dismissed</b> — a red cross and the whole card mutes.',
  },
};
