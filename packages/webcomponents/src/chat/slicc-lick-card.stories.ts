import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-lick-card.js';

interface LickCardArgs {
  kind?: string;
  'event-label'?: string;
  body?: string;
  bodyHtml?: string;
  'no-animate'?: boolean;
  collapsible?: boolean;
  collapsed?: boolean;
  theme?: 'light' | 'dark';
}

function build(args: LickCardArgs): HTMLElement {
  const el = document.createElement('slicc-lick-card');
  if (args.kind != null) el.setAttribute('kind', args.kind);
  if (args['event-label'] != null) el.setAttribute('event-label', args['event-label']);
  if (args['no-animate']) el.setAttribute('no-animate', '');
  if (args.collapsible) el.setAttribute('collapsible', '');
  if (args.collapsed) el.setAttribute('collapsed', '');
  if (args.theme) el.setAttribute('theme', args.theme);
  // Rich slotted markup wins over the plain `body` attribute when supplied.
  if (args.bodyHtml != null) el.innerHTML = args.bodyHtml;
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

/** A cron-triggered lick — kind variant via the header text. */
export const Cron: Story = {
  args: {
    kind: 'cron',
    bodyHtml: 'Nightly <b>cron</b> fired. sliccy spins a <b>one-shot scoop</b> to triage.',
  },
};

/** A workflow-completion lick with a custom pill label. */
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
