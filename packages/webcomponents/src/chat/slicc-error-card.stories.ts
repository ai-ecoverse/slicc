import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-error-card.js';

interface ErrorCardArgs {
  label?: string;
  message?: string;
  bodyHtml?: string;
  'button-label'?: string;
  action?: 'retry' | 'settings' | 'change-model' | 'login';
  'secondary-action'?: 'retry' | 'settings' | 'change-model' | 'login';
  'secondary-button-label'?: string;
  theme?: 'light' | 'dark';
}

function appendRichBody(el: HTMLElement, markup: string): void {
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
  if (args['secondary-action']) el.setAttribute('secondary-action', args['secondary-action']);
  if (args['secondary-button-label'] != null) {
    el.setAttribute('secondary-button-label', args['secondary-button-label']);
  }
  if (args.theme) el.setAttribute('theme', args.theme);

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
    'secondary-action': {
      control: 'inline-radio',
      options: ['retry', 'settings', 'change-model', 'login'],
      description:
        'Optional second CTA rendered as an outline button before the primary one. Fires the ' +
        'same events as `action`. Absent means no secondary button.',
    },
    'secondary-button-label': {
      control: 'text',
      description: 'Secondary CTA label (defaults to the secondary action\u2019s own default)',
    },
    theme: { control: 'inline-radio', options: ['light', 'dark'], description: 'Theme override' },
  },
  render: build,
};

export default meta;
type Story = StoryObj<ErrorCardArgs>;

export const Default: Story = {
  args: {
    message: 'The agent turn failed. Check the network tab and try again.',
  },
};

export const RichBody: Story = {
  args: {
    bodyHtml:
      'The model returned a <b>400 Bad Request</b> — the prompt likely exceeded the ' +
      'context window. Retry to re-run the last turn through the send path.',
  },
};

export const LongJsonError: Story = {
  args: {
    message:
      '{"type":"error","error":{"details":null,"type":"api_error","message":"Internal server error"},"request_id":"req_m5ffjzo3zujenmw3bu3utiqv3tfa5q6vwrx2unvge4tmw4wvfseq"}',
  },
};

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

export const Dark: Story = {
  args: {
    theme: 'dark',
    bodyHtml: 'A failed turn in <b>dark mode</b> — the red tint re-mixes over the canvas.',
  },
};

export const CustomLabels: Story = {
  args: {
    label: 'Network unreachable',
    'button-label': 'Retry connection',
    message: 'The LLM provider returned no response. Check your connection and retry.',
  },
};

export const SettingsAction: Story = {
  args: {
    label: 'Cannot reach the model',
    action: 'settings',
    message: 'No API key configured for provider "adobe". Open Settings to add one.',
  },
};

export const SettingsActionDark: Story = {
  args: {
    label: 'Cannot reach the model',
    action: 'settings',
    theme: 'dark',
    message: 'No API key configured. Open Settings to add one.',
  },
};

export const LoginAction: Story = {
  args: {
    label: 'Session expired',
    action: 'login',
    message: 'Your session has expired. Log in again to continue.',
  },
};

export const QuotaExceeded: Story = {
  args: {
    label: 'Out of AI budget',
    action: 'change-model',
    'button-label': 'Switch provider and try again',
    'secondary-action': 'settings',
    'secondary-button-label': 'Add a provider',
    message: 'Weekly budget has been fully used. Resets on 2026-09-14.',
  },
};

export const QuotaExceededDark: Story = {
  args: {
    ...QuotaExceeded.args,
    theme: 'dark',
  },
};

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
