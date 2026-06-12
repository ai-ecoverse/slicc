/**
 * WC-native account settings — the avatar-menu "Account settings…" surface,
 * rebuilt over the library's `<slicc-dialog>` (prototype chrome + tokens)
 * instead of the legacy dialog stylesheet. Reuses ALL account logic from
 * `provider-settings.ts` (accounts store, provider registry, OAuth
 * launchers); only the presentation is new. Onboarding-only flows
 * (tray-join, auto-join) stay on the legacy dialog via the connect surface.
 */

import type { Account, ProviderConfig } from '../provider-settings.js';

type ProviderSettingsModule = typeof import('../provider-settings.js');

interface SettingsLogger {
  error(message: string, ...data: unknown[]): void;
}

const STYLE_ID = 'slicc-wc-settings-style';
const CSS = `
/* Width is owned by the dialog card (via ::part) — a min-width on the body
   used to overflow the card's content box and clip the row borders. */
slicc-dialog.wcset-dialog::part(dialog){width:min(520px,92vw);}
.wcset{display:flex;flex-direction:column;gap:14px;font-family:var(--ui);color:var(--ink);}
.wcset__list{display:flex;flex-direction:column;gap:8px;}
.wcset__empty{color:var(--txt-3);font-size:12.5px;}
.wcset__row{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--canvas);}
.wcset__info{flex:1;min-width:0;}
.wcset__name{font-size:13px;font-weight:600;}
.wcset__detail{font-size:11px;color:var(--txt-3);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.wcset__btn{font:500 12px var(--ui);color:var(--ink);background:transparent;border:1px solid var(--line);border-radius:8px;padding:5px 10px;cursor:pointer;flex:0 0 auto;}
.wcset__btn:hover{background:var(--ghost);}
.wcset__btn--danger:hover{color:#b91c1c;border-color:#b91c1c;}
.wcset__btn--primary{background:var(--ink);color:var(--canvas);border-color:var(--ink);}
.wcset__btn--primary:hover{background:color-mix(in srgb,var(--ink) 85%,var(--canvas));}
.wcset__add{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--line);padding-top:14px;}
.wcset__label{font-size:11px;font-weight:600;color:var(--txt-2);text-transform:uppercase;letter-spacing:.04em;}
.wcset__select,.wcset__input{font:400 12.5px var(--ui);color:var(--ink);background:var(--canvas);border:1px solid var(--line);border-radius:8px;padding:7px 9px;outline:none;width:100%;box-sizing:border-box;}
.wcset__select:focus,.wcset__input:focus{border-color:var(--ctx);}
.wcset__status{font-size:11.5px;color:var(--txt-3);min-height:14px;}
.wcset__status[data-error]{color:#b91c1c;}
`;

function ensureSettingsStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
}

function div(className: string, text?: string): HTMLDivElement {
  const node = document.createElement('div');
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className: string, label: string, onClick: () => void): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = className;
  node.textContent = label;
  node.addEventListener('click', onClick);
  return node;
}

/** Show only the key's edges — enough to recognize, never enough to leak. */
export function maskKey(key: string): string {
  if (!key) return '';
  return key.length <= 8 ? '••••' : `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/** The one-line account summary under the provider name. */
export function accountDetail(account: Account): string {
  let detail: string;
  if (account.loggedOut) {
    detail = account.userName ? `Logged out — was ${account.userName}` : 'Logged out';
  } else if (account.userName) {
    detail = account.userName;
  } else if (account.accessToken) {
    detail = 'Logged in';
  } else {
    detail = maskKey(account.apiKey);
  }
  return account.baseUrl ? `${detail} • ${account.baseUrl}` : detail;
}

interface ViewDeps {
  ps: ProviderSettingsModule;
  log: SettingsLogger;
  setStatus(text: string, isError?: boolean): void;
  renderList(): void;
}

/** Launch the provider's OAuth flow (intercepted or popup), mirroring the
 *  legacy dialog's handler. `onLoggedIn` re-renders the account list. */
async function oauthLogin(pid: string, baseUrl: string, deps: ViewDeps): Promise<void> {
  const { ps, log, setStatus, renderList } = deps;
  const config = ps.getProviderConfig(pid);
  const hadAccountBefore = ps.getAccounts().some((a) => a.providerId === pid);
  if (config.requiresBaseUrl) {
    if (!baseUrl.trim() && !ps.getBaseUrlForProvider(pid)) {
      setStatus('Base URL is required.', true);
      return;
    }
    // Save before login so the provider's onOAuthLogin can read it.
    if (baseUrl.trim()) ps.addAccount(pid, '', baseUrl.trim());
  }
  setStatus('Opening login window…');
  const onLoggedIn = (): void => {
    setStatus('');
    renderList();
  };
  try {
    if (config.onOAuthLoginIntercepted) {
      const { createInterceptingOAuthLauncherForCurrentRuntime } = await import(
        '../../providers/oauth-service.js'
      );
      const launcher = await createInterceptingOAuthLauncherForCurrentRuntime();
      if (!launcher) {
        throw new Error(
          'No controlled-browser CDP transport available — open SLICC in standalone mode or the Chrome extension.'
        );
      }
      await config.onOAuthLoginIntercepted(launcher, onLoggedIn);
    } else if (config.onOAuthLogin) {
      const { createOAuthLauncher } = await import('../../providers/oauth-service.js');
      await config.onOAuthLogin(createOAuthLauncher(), onLoggedIn);
    } else {
      throw new Error(`${config.name} does not support interactive login.`);
    }
  } catch (err) {
    if (!hadAccountBefore) {
      // Clean up the pre-login baseUrl placeholder.
      await ps.removeAccount(pid).catch(() => undefined);
    }
    log.error('WC settings OAuth login failed', { providerId: pid, err });
    setStatus(`Login failed: ${err instanceof Error ? err.message : String(err)}`, true);
  }
}

/** One connected-account row: provider, summary, login/logout + remove. */
function accountRow(account: Account, config: ProviderConfig, deps: ViewDeps): HTMLElement {
  const { ps, log, setStatus, renderList } = deps;
  const row = div('wcset__row');
  const info = div('wcset__info');
  info.append(div('wcset__name', config.name), div('wcset__detail', accountDetail(account)));
  row.append(info);

  if (config.isOAuth) {
    const loggedOut = account.loggedOut === true;
    row.append(
      button('wcset__btn', loggedOut ? 'Log in' : 'Log out', () => {
        if (loggedOut) {
          void oauthLogin(account.providerId, '', deps);
        } else {
          ps.logoutOAuthAccount(account.providerId)
            .then(renderList)
            .catch((err) => {
              log.error('WC settings logout failed', { providerId: account.providerId, err });
              setStatus('Logout failed.', true);
            });
        }
      })
    );
  }
  row.append(
    button('wcset__btn wcset__btn--danger', 'Remove', () => {
      ps.removeAccount(account.providerId)
        .then(renderList)
        .catch((err) => {
          log.error('WC settings remove failed', { providerId: account.providerId, err });
          setStatus('Remove failed.', true);
        });
    })
  );
  return row;
}

/** The add-account section: provider picker + per-provider auth controls. */
function buildAddSection(deps: ViewDeps): HTMLElement {
  const { ps, setStatus } = deps;
  const section = div('wcset__add');
  section.append(div('wcset__label', 'Add account'));

  const select = document.createElement('select');
  select.className = 'wcset__select';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Choose a provider…';
  select.append(placeholder);
  // Same semantics as the legacy picker: name-sorted, already-connected
  // providers skipped, auth-only providers (no LLM models) skipped.
  const connected = new Set(ps.getAccounts().map((a) => a.providerId));
  const offered = ps
    .getAvailableProviders()
    .filter((pid) => !connected.has(pid) && ps.providerOffersLlmModels(pid))
    .sort((a, b) => ps.getProviderConfig(a).name.localeCompare(ps.getProviderConfig(b).name));
  for (const pid of offered) {
    const option = document.createElement('option');
    option.value = pid;
    option.textContent = ps.getProviderConfig(pid).name;
    select.append(option);
  }
  section.append(select);

  const controls = div('wcset__controls');
  controls.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
  section.append(controls);

  const renderControls = (): void => {
    controls.replaceChildren();
    setStatus('');
    const pid = select.value;
    if (!pid) return;
    const config = ps.getProviderConfig(pid);

    const baseUrlInput = document.createElement('input');
    baseUrlInput.className = 'wcset__input';
    baseUrlInput.placeholder = 'Base URL';
    baseUrlInput.value = ps.getBaseUrlForProvider(pid) ?? '';
    if (config.requiresBaseUrl) controls.append(baseUrlInput);

    if (config.isOAuth) {
      controls.append(
        button('wcset__btn wcset__btn--primary', `Login with ${config.name}`, () => {
          void oauthLogin(pid, baseUrlInput.value, deps);
        })
      );
      return;
    }

    const keyInput = document.createElement('input');
    keyInput.className = 'wcset__input';
    keyInput.type = 'password';
    keyInput.placeholder = 'API key';
    keyInput.setAttribute('data-testid', 'wcset-api-key');
    controls.append(keyInput);
    controls.append(
      button('wcset__btn wcset__btn--primary', 'Save', () => {
        const key = keyInput.value.trim();
        if (!key) {
          setStatus('An API key is required.', true);
          keyInput.focus();
          return;
        }
        if (config.requiresBaseUrl && !baseUrlInput.value.trim()) {
          setStatus('Base URL is required.', true);
          baseUrlInput.focus();
          return;
        }
        ps.addAccount(pid, key, baseUrlInput.value.trim() || undefined);
        keyInput.value = '';
        setStatus(`${config.name} connected.`);
        deps.renderList();
      })
    );
  };
  select.addEventListener('change', renderControls);
  return section;
}

/**
 * Open the settings dialog. Resolves once dismissed, with `true` when the
 * accounts store changed (the caller refreshes models / identity / worker).
 */
export async function showWcSettings(log: SettingsLogger): Promise<boolean> {
  const ps = await import('../provider-settings.js');
  ensureSettingsStyle(document);
  const before = JSON.stringify(ps.getAccounts());

  return new Promise((resolve) => {
    const dialog = document.createElement('slicc-dialog');
    dialog.classList.add('wcset-dialog');
    dialog.setAttribute('heading', 'Accounts');

    const body = div('wcset');
    const list = div('wcset__list');
    const status = div('wcset__status');
    const setStatus = (text: string, isError = false): void => {
      status.textContent = text;
      status.toggleAttribute('data-error', isError);
    };

    // Announce account changes to same-document surfaces (the WC nav model
    // picker) the moment they happen — e.g. an OAuth callback landing while
    // the dialog is still open. The `storage` event never fires for
    // same-document writes, and waiting for the dialog to close would leave
    // the picker stale until then. Guarded so re-renders with no change
    // (initial open, list redraw) don't needlessly kick provider catalog
    // fetches downstream.
    let lastAnnounced = before;
    const announceIfChanged = (): void => {
      const now = JSON.stringify(ps.getAccounts());
      if (now === lastAnnounced) return;
      lastAnnounced = now;
      window.dispatchEvent(new CustomEvent('slicc:accounts-changed'));
    };

    const deps: ViewDeps = {
      ps,
      log,
      setStatus,
      renderList: () => {
        announceIfChanged();
        list.replaceChildren();
        const accounts = ps.getAccounts();
        if (accounts.length === 0) {
          list.append(div('wcset__empty', 'No accounts configured.'));
          return;
        }
        for (const account of accounts) {
          list.append(accountRow(account, ps.getProviderConfig(account.providerId), deps));
        }
      },
    };
    deps.renderList();

    body.append(list, buildAddSection(deps), status);
    dialog.append(body);

    const done = button('wcset__btn wcset__btn--primary', 'Done', () => {
      (dialog as HTMLElement & { hide?: () => void }).hide?.();
    });
    done.setAttribute('slot', 'footer');
    dialog.append(done);

    dialog.addEventListener('slicc-dialog-close', () => {
      dialog.remove();
      resolve(JSON.stringify(ps.getAccounts()) !== before);
    });

    document.body.append(dialog);
    (dialog as HTMLElement & { show?: () => void }).show?.();
  });
}
