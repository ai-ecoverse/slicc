import type { Meta, StoryObj } from '@storybook/web-components-vite';
import type { SecretDialogRequest, SecretDialogSubmitHandler } from './slicc-secret-dialog.js';
import './slicc-secret-dialog.js';

const meta: Meta = {
  title: 'Overlay/SecretDialog',
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
};
export default meta;
type Story = StoryObj;

/** Faux chat behind the modal, so the backdrop blur reads like the real app. */
function backdropContent(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.cssText =
    'min-height:100vh;padding:28px;background:var(--bg);color:var(--txt-2);font:400 13px var(--ui,sans-serif);' +
    'display:flex;flex-direction:column;gap:10px;';
  for (const line of [
    'Configure the deploy script to push to the staging bucket.',
    'I need an API token for that. I will ask for it rather than guess.',
    'curl -H "Authorization: Bearer $STAGING_TOKEN" https://api.staging.example.com/deploy',
  ]) {
    const p = document.createElement('div');
    p.textContent = line;
    p.style.cssText =
      'max-width:640px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;' +
      'background:var(--canvas);';
    wrap.append(p);
  }
  return wrap;
}

/** Where the submitted (masked-in-real-life) outcome is echoed for the story. */
function outcomeLine(): HTMLElement {
  const el = document.createElement('div');
  el.style.cssText =
    'margin-top:6px;font:500 12.5px var(--ui,sans-serif);color:var(--ctx,#3b63fb);min-height:18px;';
  return el;
}

interface StoryOptions {
  /** What the flow asks for. */
  request?: SecretDialogRequest;
  /** The provider named as unable to read the value. */
  provider?: string;
  /** Simulated store step — return a message to keep the dialog open. */
  submitHandler?: SecretDialogSubmitHandler;
  /** Wrap in the dark theme scope. */
  dark?: boolean;
  /** Run after the dialog is open (drive a state the screenshot should show). */
  after?: (dialog: HTMLElement) => void;
}

function storyHost(options: StoryOptions = {}): HTMLElement {
  const root = document.createElement('div');
  if (options.dark) root.className = 'dark';
  root.style.cssText = 'position:relative;min-height:100vh;';

  const dialog = document.createElement('slicc-secret-dialog');
  const outcome = outcomeLine();
  if (options.submitHandler) dialog.submitHandler = options.submitHandler;
  if (options.provider) dialog.provider = options.provider;

  const reopen = document.createElement('button');
  reopen.type = 'button';
  reopen.textContent = 'Open the secret dialog…';
  reopen.style.cssText =
    'align-self:flex-start;font:500 13px var(--ui,sans-serif);padding:8px 14px;' +
    'border:1px solid var(--line,#ddd);border-radius:9px;background:var(--canvas,#fff);' +
    'color:var(--ink,#131313);cursor:pointer;';

  const run = (): void => {
    void dialog.open(options.request ?? {}).then((detail) => {
      outcome.textContent = detail
        ? `Stored “${detail.name}” · scope ${detail.domains.join(', ')} · ${
            detail.persist ? 'saved' : 'session-only'
          } (the value never leaves this tab)`
        : 'Cancelled — nothing stored.';
    });
    options.after?.(dialog);
  };
  reopen.addEventListener('click', run);

  const page = backdropContent();
  page.append(reopen, outcome);
  root.append(page, dialog);
  // Open on mount so the story (and the PR screenshot) shows the real surface
  // instead of a button that has to be clicked first.
  requestAnimationFrame(run);
  return root;
}

/** Default: password-masked value, an empty scope row waiting to be filled in. */
export const Default: Story = {
  render: () => storyHost(),
};

/** The same surface in the dark theme scope. */
export const DefaultDark: Story = {
  render: () => storyHost({ dark: true }),
};

/**
 * The options drawer, which `open()` always expands — one row per domain with the
 * − / + pair that edits the list, plus the session/saved choice.
 */
export const OptionsExpanded: Story = {
  render: () =>
    storyHost({
      request: { domains: ['api.github.com', 'uploads.github.com'] },
      provider: 'Anthropic',
    }),
};

/** A wildcard, once someone types one, calls itself out: the value could go anywhere. */
export const WildcardScope: Story = {
  render: () => storyHost({ request: { domains: ['*'] }, provider: 'Anthropic' }),
};

/**
 * The agent's `request_secret` shape: a suggested name, a narrow suggested
 * scope, and the reason it is asking. The scope is on screen from the start, so
 * the human reviews what they are allowing before they paste anything.
 */
export const AgentRequest: Story = {
  render: () =>
    storyHost({
      provider: 'Anthropic',
      request: {
        name: 'STAGING_TOKEN',
        domains: ['api.staging.example.com'],
        requester: 'Cone',
        reason: 'The deploy script needs a bearer token for api.staging.example.com',
      },
    }),
};

/** Agent request, dark theme. */
export const AgentRequestDark: Story = {
  render: () =>
    storyHost({
      dark: true,
      provider: 'Anthropic',
      request: {
        name: 'STAGING_TOKEN',
        domains: ['api.staging.example.com'],
        requester: 'Cone',
        reason: 'The deploy script needs a bearer token for api.staging.example.com',
      },
    }),
};

/** A dotted subsystem name: legal in the store, but not a shell variable. */
export const NonShellName: Story = {
  render: () =>
    storyHost({
      request: {
        name: 's3.r2.secret_access_key',
        domains: ['*.r2.cloudflarestorage.com'],
      },
    }),
};

/**
 * Validation: a pasted multi-line credential. The single-line input joins the
 * breaks itself, so the mangling has to be said out loud.
 */
export const ValidationError: Story = {
  render: () =>
    storyHost({
      after: (dialog) => {
        const el = dialog as HTMLElement & { setError: (m: string) => void };
        el.setError(
          'That value spans multiple lines and was joined into one. Secrets must be single-line — base64-encode it first (base64 -w0 key.pem).'
        );
      },
    }),
};

/**
 * A failed store keeps the dialog open with the typed value intact, so a
 * transient Keychain / bridge failure costs a click rather than a re-paste.
 */
export const StoreFailure: Story = {
  render: () =>
    storyHost({
      submitHandler: () => 'Keychain did not respond within 10s — the secret was not stored.',
      request: { domains: ['api.github.com'] },
      // Drive a real submit so the story shows the state it is named for: the
      // error line up, the credential still in the field.
      after: (dialog) => {
        const input = (name: string) =>
          dialog.querySelector(`[part="${name}"]`) as HTMLInputElement;
        input('name').value = 'GITHUB_TOKEN';
        input('value').value = 'ghp_liveTokenStaysInTheField';
        (dialog.querySelector('[part="save"]') as HTMLButtonElement).click();
      },
    }),
};
