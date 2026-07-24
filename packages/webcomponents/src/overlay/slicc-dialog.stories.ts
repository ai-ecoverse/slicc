import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-dialog.js';

const meta: Meta = {
  title: 'Overlay/Dialog',
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
};
export default meta;
type Story = StoryObj;

/** Shared control styling so the provider `<select>` matches the text inputs. */
const CONTROL_CSS =
  'width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--line,#e1e1e1);' +
  'border-radius:9px;background:var(--ghost,#f3f3f3);color:var(--ink,#131313);font:inherit;outline:none;';

/** A labelled text field (light-DOM, host-styled); the wrapper is shown/hidden by callers. */
function field(
  label: string,
  value: string,
  opts: { mono?: boolean; type?: string; placeholder?: string; hint?: string } = {}
): HTMLLabelElement {
  const wrap = document.createElement('label');
  wrap.style.cssText = 'display:block;margin-bottom:14px;';
  const lb = document.createElement('div');
  lb.className = 'field-label';
  lb.textContent = label;
  lb.style.cssText = 'font-size:12px;color:var(--txt-2,#505050);margin-bottom:6px;';
  const input = document.createElement('input');
  input.value = value;
  input.type = opts.type ?? 'text';
  if (opts.placeholder) input.placeholder = opts.placeholder;
  input.style.cssText = CONTROL_CSS + (opts.mono ? 'font-family:ui-monospace,monospace;' : '');
  wrap.append(lb, input);
  if (opts.hint) {
    const h = document.createElement('div');
    h.textContent = opts.hint;
    h.style.cssText = 'font-size:11px;color:var(--txt-3,#717171);margin-top:6px;';
    wrap.append(h);
  }
  return wrap;
}

/** A labelled `<select>` dropdown (light-DOM, host-styled) — the provider picker. */
function select(
  label: string,
  options: ReadonlyArray<{ value: string; label: string; disabled?: boolean }>
): { wrap: HTMLLabelElement; sel: HTMLSelectElement } {
  const wrap = document.createElement('label');
  wrap.style.cssText = 'display:block;margin-bottom:14px;';
  const lb = document.createElement('div');
  lb.textContent = label;
  lb.style.cssText = 'font-size:12px;color:var(--txt-2,#505050);margin-bottom:6px;';
  const sel = document.createElement('select');
  sel.style.cssText = `${CONTROL_CSS}cursor:pointer;`;
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    if (o.disabled) opt.disabled = true;
    sel.append(opt);
  }
  wrap.append(lb, sel);
  return { wrap, sel };
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

/**
 * Provider catalog mirroring the prod account dialog (`provider-settings.ts`):
 * each entry drives which auth affordance + extra fields the dropdown reveals —
 * API-key vs OAuth login, plus base URL / deployment / API version where needed.
 */
interface ProviderSpec {
  id: string;
  name: string;
  description: string;
  auth: 'apikey' | 'oauth';
  apiKeyPlaceholder?: string;
  apiKeyEnvVar?: string;
  optionalApiKey?: boolean;
  requiresBaseUrl?: boolean;
  baseUrlPlaceholder?: string;
  requiresDeployment?: boolean;
  requiresApiVersion?: boolean;
  apiVersionDefault?: string;
}

const PROVIDERS: readonly ProviderSpec[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    description: 'Claude models via the Anthropic API.',
    auth: 'apikey',
    apiKeyPlaceholder: 'sk-ant-...',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    description: 'GPT models via the OpenAI API.',
    auth: 'apikey',
    apiKeyPlaceholder: 'sk-...',
    apiKeyEnvVar: 'OPENAI_API_KEY',
  },
  {
    id: 'adobe',
    name: 'Adobe',
    description: 'Adobe-hosted Claude + GPT models via IMS login.',
    auth: 'oauth',
  },
  {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    description: 'Copilot-backed models via GitHub OAuth.',
    auth: 'oauth',
  },
  {
    id: 'xai',
    name: 'xAI Grok',
    description: 'Grok models via xAI OAuth login.',
    auth: 'oauth',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    description: 'OpenRouter models via OAuth login.',
    auth: 'oauth',
  },
  {
    id: 'azure-openai',
    name: 'Azure OpenAI',
    description: 'OpenAI models on your own Azure deployment.',
    auth: 'apikey',
    apiKeyPlaceholder: 'Azure API key',
    requiresBaseUrl: true,
    baseUrlPlaceholder: 'https://<resource>.openai.azure.com',
    requiresDeployment: true,
    requiresApiVersion: true,
    apiVersionDefault: '2024-10-21',
  },
  {
    id: 'local',
    name: 'Local (OpenAI-compatible)',
    description: 'A local server — Ollama, LM Studio, vLLM.',
    auth: 'apikey',
    optionalApiKey: true,
    apiKeyPlaceholder: 'optional',
    requiresBaseUrl: true,
    baseUrlPlaceholder: 'http://localhost:11434/v1',
  },
];

/**
 * The account-settings sub-dialog: a provider form behind a blurred backdrop.
 * The provider `<select>` mirrors the prod dialog's expressiveness — picking a
 * provider swaps between an API-key field and an OAuth login button and reveals
 * base URL / deployment / API version fields only when that provider needs them.
 * The dialog stays generic; all provider logic lives here in the slotted body.
 */
export const AccountSettings: Story = {
  render: () => {
    const { wrap: providerWrap, sel: provider } = select('Provider', [
      { value: '', label: 'Select a provider…', disabled: true },
      ...PROVIDERS.map((p) => ({ value: p.id, label: p.name })),
    ]);

    const desc = document.createElement('div');
    desc.style.cssText = 'font-size:12px;color:var(--txt-3,#717171);margin:-6px 0 14px;';

    const oauthWrap = document.createElement('div');
    oauthWrap.style.cssText = 'margin-bottom:14px;';
    const loginBtn = document.createElement('button');
    loginBtn.type = 'button';
    loginBtn.style.cssText = `${CONTROL_CSS}font-weight:600;cursor:pointer;text-align:center;`;
    oauthWrap.append(loginBtn);

    const apiKey = field('API key', '', { mono: true, type: 'password' });
    const apiKeyInput = apiKey.querySelector('input') as HTMLInputElement;
    const apiKeyLabel = apiKey.querySelector('.field-label') as HTMLElement;
    const baseUrl = field('Base URL', '', {});
    const baseUrlInput = baseUrl.querySelector('input') as HTMLInputElement;
    const deployment = field('Deployment', '', { placeholder: 'deployment-name' });
    const apiVersion = field('API version', '', {});
    const apiVersionInput = apiVersion.querySelector('input') as HTMLInputElement;

    const save = btn('Save', true);

    const show = (el: HTMLElement, on: boolean): void => {
      el.style.display = on ? '' : 'none';
    };
    const syncApiKey = (spec: ProviderSpec): void => {
      const env = spec.apiKeyEnvVar ? ` (${spec.apiKeyEnvVar})` : '';
      apiKeyLabel.textContent = `${spec.optionalApiKey ? 'API key (optional)' : 'API key'}${env}`;
      apiKeyInput.placeholder = spec.apiKeyPlaceholder ?? 'API key';
    };

    function update(): void {
      const spec = PROVIDERS.find((p) => p.id === provider.value);
      const oauth = spec?.auth === 'oauth';
      const apikey = !!spec && !oauth;
      desc.textContent = spec?.description ?? '';
      // OAuth providers complete via the login button, so the Save action hides.
      show(oauthWrap, !!spec && oauth);
      show(apiKey, apikey);
      show(save, apikey);
      show(baseUrl, !!spec?.requiresBaseUrl);
      show(deployment, !!spec?.requiresDeployment);
      show(apiVersion, !!spec?.requiresApiVersion);
      if (!spec) return;
      if (oauth) loginBtn.textContent = `Login with ${spec.name}`;
      if (apikey) syncApiKey(spec);
      if (spec.requiresBaseUrl) baseUrlInput.placeholder = spec.baseUrlPlaceholder ?? 'https://...';
      if (spec.requiresApiVersion) apiVersionInput.placeholder = spec.apiVersionDefault ?? '';
    }
    provider.addEventListener('change', update);
    provider.value = 'anthropic';
    update();

    return dialog({
      heading: 'Add account',
      description: 'Connect an LLM provider with an API key or OAuth login.',
      body: [providerWrap, desc, oauthWrap, apiKey, baseUrl, deployment, apiVersion],
      footer: [btn('Cancel', false), save],
    });
  },
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
