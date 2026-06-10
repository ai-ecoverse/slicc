import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-dialog.js';

const meta: Meta = {
  title: 'Overlay/Dialog',
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
};
export default meta;
type Story = StoryObj;

/** A labelled form field for the dialog body (light-DOM, host-styled). */
function field(
  label: string,
  value: string,
  opts: { mono?: boolean; type?: string } = {}
): HTMLElement {
  const wrap = document.createElement('label');
  wrap.style.cssText = 'display:block;margin-bottom:14px;';
  const lb = document.createElement('div');
  lb.textContent = label;
  lb.style.cssText = 'font-size:12px;color:var(--txt-2,#505050);margin-bottom:6px;';
  const input = document.createElement('input');
  input.value = value;
  input.type = opts.type ?? 'text';
  input.style.cssText =
    'width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--line,#e1e1e1);' +
    `border-radius:9px;background:var(--ghost,#f3f3f3);color:var(--ink,#131313);font:inherit;${
      opts.mono ? 'font-family:ui-monospace,monospace;' : ''
    }outline:none;`;
  wrap.append(lb, input);
  return wrap;
}

/** A footer button (primary or secondary) slotted into the dialog footer. */
function btn(label: string, primary: boolean): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.setAttribute('slot', 'footer');
  b.style.cssText = primary
    ? 'padding:9px 16px;border:none;border-radius:9999px;background:var(--accent,#3b63fb);color:#fff;font:inherit;font-weight:600;cursor:pointer;'
    : 'padding:9px 16px;border:1px solid var(--line,#e1e1e1);border-radius:9999px;background:transparent;color:var(--ink,#131313);font:inherit;font-weight:600;cursor:pointer;';
  return b;
}

function dialog(opts: {
  heading: string;
  description?: string;
  persistent?: boolean;
  body: HTMLElement[];
  footer: HTMLElement[];
}): HTMLElement {
  const d = document.createElement('slicc-dialog');
  d.setAttribute('open', '');
  d.setAttribute('heading', opts.heading);
  if (opts.description) d.setAttribute('description', opts.description);
  if (opts.persistent) d.setAttribute('persistent', '');
  d.append(...opts.body, ...opts.footer);
  return d;
}

/** The account-settings sub-dialog: a provider form behind a blurred backdrop. */
export const AccountSettings: Story = {
  render: () =>
    dialog({
      heading: 'Add account',
      description: 'Connect an LLM provider with an API key or OAuth login.',
      body: [
        field('Provider', 'Anthropic'),
        field('API key', 'sk-ant-••••••••••••••••••••', { mono: true, type: 'password' }),
        field('Base URL (optional)', 'https://api.anthropic.com'),
      ],
      footer: [btn('Cancel', false), btn('Save', true)],
    }),
};

/** A compact confirmation dialog with a destructive primary action. */
export const Confirm: Story = {
  render: () => {
    const p = document.createElement('p');
    p.textContent =
      'This clears every connected account from this browser. Your memory and sessions stay.';
    p.style.cssText = 'margin:0;font-size:13px;color:var(--ink,#131313);line-height:1.5;';
    return dialog({
      heading: 'Clear all accounts?',
      body: [p],
      footer: [btn('Cancel', false), btn('Clear accounts', true)],
    });
  },
};

/** A persistent dialog — the backdrop is inert; only ✕ / Escape / a button closes. */
export const Persistent: Story = {
  render: () => {
    const p = document.createElement('p');
    p.textContent = 'A required step — clicking the backdrop will not dismiss this dialog.';
    p.style.cssText = 'margin:0;font-size:13px;color:var(--ink,#131313);line-height:1.5;';
    return dialog({
      heading: 'Finish setup',
      description: 'Persistent: backdrop clicks are ignored.',
      persistent: true,
      body: [p],
      footer: [btn('Got it', true)],
    });
  },
};
