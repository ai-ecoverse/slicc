import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-error-card.js';

interface ErrorCardArgs {
  label?: string;
  message?: string;
  bodyHtml?: string;
  'button-label'?: string;
  action?: 'retry' | 'settings' | 'change-model' | 'login';
  theme?: 'light' | 'dark';
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

function build(args: ErrorCardArgs): HTMLElement {
  const el = document.createElement('slicc-error-card');
  if (args.label != null) el.setAttribute('label', args.label);
  if (args['button-label'] != null) el.setAttribute('button-label', args['button-label']);
  if (args.action) el.setAttribute('action', args.action);
  if (args.theme) el.setAttribute('theme', args.theme);
  // Rich slotted markup wins over the plain `message` attribute when supplied.
  if (args.bodyHtml != null) appendRichBody(el, args.bodyHtml);
  else if (args.message != null) el.setAttribute('message', args.message);
  return el;
}

const meta: Meta<ErrorCardArgs> = {
  title: 'Chat/ErrorCard',
  component: 'slicc-error-card',
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'The cone error card rendered in the chat stream when an agent turn fails. ' +
          'Mirrors the `slicc-lick-card` shape (rounded card, iconed header, body line) but ' +
          'in the red/destructive palette with a trailing "Try again" affordance. The button ' +
          'dispatches a bubbling, composed `slicc-error-retry` CustomEvent the host catches ' +
          'to re-run the last user turn through its existing send path.',
      },
    },
  },
  argTypes: {
    label: { control: 'text', description: 'Header label (default "Something went wrong")' },
    message: { control: 'text', description: 'Error body text (escaped)' },
    bodyHtml: { control: 'text', description: 'Rich slotted body markup (overrides message)' },
    'button-label': { control: 'text', description: 'Retry button label (default "Try again")' },
    action: {
      control: 'inline-radio',
      options: ['retry', 'settings', 'change-model', 'login'],
      description:
        'Action mode: `retry` (default) fires `slicc-error-retry`; `settings` flips the CTA to ' +
        '"Open Settings" and fires `slicc-error-open-settings`; `change-model` flips it to ' +
        '"Change model" and fires `slicc-error-change-model`; `login` flips it to "Log in again" ' +
        'and fires `slicc-error-login`.',
    },
    theme: { control: 'inline-radio', options: ['light', 'dark'], description: 'Theme override' },
  },
  render: build,
};

export default meta;
type Story = StoryObj<ErrorCardArgs>;

/** The canonical card: a typical cone error with the default label and retry affordance. */
export const Default: Story = {
  args: {
    message: 'The agent turn failed. Check the network tab and try again.',
  },
};

/** Rich slotted body with `<b>` emphasis spans inside the message line. */
export const RichBody: Story = {
  args: {
    bodyHtml:
      'The model returned a <b>400 Bad Request</b> — the prompt likely exceeded the ' +
      'context window. Retry to re-run the last turn through the send path.',
  },
};

/** Long multiline body — confirms the card wraps and the retry button stays right-aligned. */
export const LongMessage: Story = {
  args: {
    label: 'Tool call failed',
    bodyHtml:
      'The <b>bash</b> tool call timed out after 30 seconds while running the build. ' +
      'The shell process was terminated and the partial output was discarded. ' +
      'This usually means the command is waiting on input that never arrives, or the ' +
      'build step itself is hung. Retry to re-run the last turn — if it fails again, ' +
      'inspect the terminal panel for the hanging process and kill it manually before ' +
      'retrying.',
  },
};

/** Explicit dark variant — red re-mixes over the canvas and the header lightens. */
export const Dark: Story = {
  args: {
    theme: 'dark',
    bodyHtml: 'A failed turn in <b>dark mode</b> — the red tint re-mixes over the canvas.',
  },
};

/** Custom header label and button label — host can override both copy slots. */
export const CustomLabels: Story = {
  args: {
    label: 'Network unreachable',
    'button-label': 'Retry connection',
    message: 'The LLM provider returned no response. Check your connection and retry.',
  },
};

/**
 * `action="settings"` variant — the CTA flips to "Open Settings" with a
 * settings glyph and dispatches `slicc-error-open-settings` instead of
 * `slicc-error-retry`. Used by the host for failures the user fixes by
 * opening Settings (e.g. "No API key configured").
 */
export const SettingsAction: Story = {
  args: {
    label: 'Cannot reach the model',
    action: 'settings',
    message: 'No API key configured for provider "adobe". Open Settings to add one.',
  },
};

/** Settings variant in dark mode — same red tint over the dark canvas. */
export const SettingsActionDark: Story = {
  args: {
    label: 'Cannot reach the model',
    action: 'settings',
    theme: 'dark',
    message: 'No API key configured. Open Settings to add one.',
  },
};

/**
 * `action="login"` variant — the CTA flips to "Log in again" with a `log-in`
 * glyph and dispatches `slicc-error-login` instead of `slicc-error-retry`.
 * Used by the host for auth failures (e.g. an expired session) the user fixes
 * by re-running the login flow rather than re-running the same failing turn.
 */
export const LoginAction: Story = {
  args: {
    label: 'Session expired',
    action: 'login',
    message: 'Your session has expired. Log in again to continue.',
  },
};

/**
 * Live event demo: the `slicc-error-retry` CustomEvent is captured and logged
 * to the panel below the card. Click "Try again" to fire it.
 */
export const RetryEvent: Story = {
  render: () => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;max-width:560px;';

    const card = build({
      message: 'Click the button below to dispatch the slicc-error-retry event.',
    });

    const out = document.createElement('div');
    out.style.cssText =
      'font:11px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--txt-2);padding:6px 8px;border:1px dashed var(--line);border-radius:6px;';
    out.textContent = 'waiting for retry…';

    let count = 0;
    card.addEventListener('slicc-error-retry', (e) => {
      count += 1;
      out.textContent = `slicc-error-retry × ${count} → ${JSON.stringify((e as CustomEvent).detail)}`;
    });

    wrap.append(card, out);
    return wrap;
  },
};
