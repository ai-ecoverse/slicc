/**
 * Provider Settings dialog — the DOM/UI surface for managing provider
 * accounts (the account list, add/edit form, OAuth login, and tray-join
 * views). The pure, DOM-free data accessors and resolvers were extracted to
 * `../providers/account-store.js` (issue #968); they are re-exported here so
 * existing `ui/provider-settings.js` importers keep working unchanged.
 */

import type { RefreshTrayRuntimeMsg } from '../../../chrome-extension/src/messages.js';
import { createLogger } from '../core/index.js';
import {
  ACCOUNTS_KEY,
  type Account,
  addAccount,
  exportProviders,
  getAccounts,
  getAvailableProviders,
  getBaseUrlForProvider,
  getProviderConfig,
  logoutOAuthAccount,
  providerOffersLlmModels,
  removeAccount,
} from '../providers/account-store.js';
import type { DeviceCodePrompter } from '../providers/types.js';
import { getFollowerTrayRuntimeStatus } from '../scoops/tray-follower-status.js';
import { hasStoredTrayJoinUrl, storeTrayJoinUrl } from '../scoops/tray-runtime-config.js';
import { copyTextToClipboard } from './clipboard.js';
import { trackSettingsOpen } from './telemetry.js';
import { describeInvalidJoinUrl } from './tray-join-url.js';

// Re-export the data layer for backward compatibility with the many callers
// that still import account/model accessors from this module path.
export * from '../providers/account-store.js';
export { describeInvalidJoinUrl };

const log = createLogger('provider-settings');

function isExtensionRuntime(): boolean {
  return typeof chrome !== 'undefined' && !!chrome?.runtime?.id;
}

/**
 * Dispatch the `slicc:tray-join` CustomEvent and wire a one-shot
 * `slicc:tray-join-failed` listener that surfaces the half-state
 * failure in the dialog's status element. Returns a cancel function
 * so the caller can detach the listener proactively if the dialog
 * closes before the event arrives.
 *
 * Each dispatch is stamped with a fresh `requestId` carried in the
 * `slicc:tray-join` event's `detail` and echoed back on the failure
 * event — the listener filters by `requestId` so a double-Connect
 * doesn't bleed errors between attempts. If the user clicks
 * "Connect" twice rapidly each click has its own correlation id.
 *
 * If `statusEl` is detached from the DOM by the time the failure
 * event arrives, we log at `error` level so the half-state isn't
 * invisible — the UX swallowing path matters because the next chat
 * send in a half-state could route to the wrong agent.
 */
/** Exposed for unit testing — not part of the public module surface. */
export function _testOnly_dispatchTrayJoinWithFailureFeedback(
  joinUrl: string,
  statusEl: HTMLElement
): () => void {
  return dispatchTrayJoinWithFailureFeedback(joinUrl, statusEl);
}

function dispatchTrayJoinWithFailureFeedback(joinUrl: string, statusEl: HTMLElement): () => void {
  const requestId = `tray-join-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let removed = false;
  let autoCleanupTimer: ReturnType<typeof setTimeout> | undefined;
  const remove = () => {
    if (removed) return;
    removed = true;
    // Clear the auto-cleanup timer so a proactive cancel() releases
    // the closure (joinUrl, statusEl, onFailure) instead of pinning
    // it for up to 10s after the dialog dismisses.
    if (autoCleanupTimer !== undefined) clearTimeout(autoCleanupTimer);
    window.removeEventListener('slicc:tray-join-failed', onFailure);
  };
  const onFailure = (e: Event) => {
    const detail = (e as CustomEvent<{ joinUrl: string; error: string; requestId?: string }>)
      .detail;
    // Filter by requestId so a double-Connect attempt doesn't receive
    // the other attempt's failure. Older `slicc:tray-join` dispatchers
    // (pre-R12) don't echo the requestId — we accept those too (legacy
    // path) so the listener still works during a rolling upgrade of
    // the codebase.
    if (detail.requestId !== undefined && detail.requestId !== requestId) return;
    remove();
    if (!statusEl.isConnected) {
      // Dialog dismissed before the failure event arrived — the user
      // sees no error UX. Surface to logs at error so the half-state
      // is at least auditable.
      log.error('Tray-join failure arrived after dialog dismissed (UX swallowed half-state)', {
        joinUrl,
        error: detail.error,
        requestId,
      });
      return;
    }
    // Cancel the optimistic dismiss so the user can read the error.
    const dismissTimerStr = statusEl.dataset.dismissTimer;
    if (dismissTimerStr) {
      const dismissTimer = Number(dismissTimerStr);
      if (Number.isFinite(dismissTimer)) clearTimeout(dismissTimer);
      delete statusEl.dataset.dismissTimer;
    }
    statusEl.textContent = `Sync failed: ${detail.error}. Reload the page and try again.`;
    statusEl.style.color = 'var(--slicc-cone)';
  };
  window.addEventListener('slicc:tray-join-failed', onFailure);
  // Auto-cleanup the listener after 10s — much longer than the 800ms
  // optimistic dismiss, but short enough that a stale listener doesn't
  // outlive the dialog if the user navigates away.
  autoCleanupTimer = setTimeout(remove, 10_000);
  window.dispatchEvent(new CustomEvent('slicc:tray-join', { detail: { joinUrl, requestId } }));
  return remove;
}

// --- Export accounts as providers.json (DOM download) ---

/** Trigger a browser download of the current accounts as providers.json. */
export function downloadProviders(): void {
  const json = JSON.stringify(exportProviders(), null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'providers.json';
  a.click();
  URL.revokeObjectURL(url);
}

/** Mask an API key for display: show first 4 and last 4 chars */
function maskApiKey(key: string): string {
  if (key.length <= 10) return '****';
  return key.slice(0, 4) + '...' + key.slice(-4);
}

/** Create an S2-style outline SVG icon (matches layout.ts pattern). */
function svgIcon(paths: string[]): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const d of paths) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

const ICON_PATHS = {
  pen: ['M14.3 3.3a1.5 1.5 0 0 1 2.1 0l.3.3a1.5 1.5 0 0 1 0 2.1L7.7 14.8l-3.2.7.7-3.2z'],
  trash: [
    'M4 6h12',
    'M8 6V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2',
    'M6 6v10a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V6',
  ],
  /** Arrow leaving a box — used for the Logout button */
  logout: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'M16 17l5-5-5-5', 'M21 12H9'],
  /** Arrow entering a box — used for the Login (re-connect) button */
  login: ['M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4', 'M10 17l5-5-5-5', 'M15 12H3'],
};

export interface ShowProviderSettingsOptions {
  /** When true, start with the "Join a tray" form instead of the account form (when no accounts exist). */
  preferTrayJoin?: boolean;
  /** When set, show a simplified "Join this tray" confirmation with the URL pre-filled (no paste needed). */
  autoJoinUrl?: string;
  /**
   * When true, open straight to the add-account form (provider picker + login),
   * skipping the accounts list and tray-join views. Used by connect mode, where
   * the dashboard already shows the account list and tray-join is irrelevant.
   * In this mode the form's secondary button is a plain "Cancel" (close) instead
   * of "Back"/"Connect to another browser".
   */
  startInAddAccount?: boolean;
  /**
   * Restrict the provider picker to providers matching this predicate. When set,
   * it fully controls the dropdown (overriding the default "models only" filter),
   * so auth-only providers like GitHub can be offered. Used by connect mode to
   * show only providers that can actually authenticate there.
   */
  providerFilter?: (providerId: string) => boolean;
}

/**
 * Show the Accounts management dialog.
 * Returns a promise that resolves to `true` if accounts were modified,
 * `false` if the user closed without changes (so callers can skip reload).
 */
export function showProviderSettings(options?: ShowProviderSettingsOptions): Promise<boolean> {
  trackSettingsOpen('button');
  return new Promise((resolve) => {
    const accountsBefore = localStorage.getItem(ACCOUNTS_KEY) ?? '';

    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'dialog';
    dialog.style.cssText = 'max-width: 480px; width: 90vw; padding: 32px;';

    // After an account is added/logged-in: in connect mode the parent surface
    // owns the list (with its own remove + Done), so close instead of showing
    // the internal accounts list — which carries tray-join + "Get Started".
    const finishAccountChange = () => {
      if (options?.startInAddAccount) {
        overlay.remove();
        resolve((localStorage.getItem(ACCOUNTS_KEY) ?? '') !== accountsBefore);
      } else {
        renderAccountsList();
      }
    };

    // Decide initial view: list if accounts exist, tray-join or add-form if empty
    if (options?.startInAddAccount) {
      renderAccountForm();
    } else if (getAccounts().length > 0) {
      renderAccountsList();
    } else if (options?.autoJoinUrl) {
      renderAutoJoinConfirmation(options.autoJoinUrl);
    } else if (options?.preferTrayJoin) {
      renderJoinTrayForm();
    } else {
      renderAccountForm();
    }

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // ── Accounts list view ──────────────────────────────────────────
    function renderAccountsList() {
      dialog.innerHTML = '';

      const title = document.createElement('div');
      title.className = 'dialog__title';
      title.textContent = 'Accounts';
      dialog.appendChild(title);

      const currentAccounts = getAccounts();

      const iconBtnStyle =
        'background: transparent; border: 1px solid var(--s2-border-subtle); ' +
        'color: var(--s2-content-secondary); border-radius: var(--s2-radius-s); ' +
        'padding: 6px; cursor: pointer; display: flex; align-items: center; ' +
        'justify-content: center; transition: color 0.15s, border-color 0.15s;';

      if (currentAccounts.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'dialog__desc';
        empty.textContent = 'No accounts configured.';
        dialog.appendChild(empty);
      } else {
        const list = document.createElement('div');
        list.style.cssText = 'margin-bottom: 16px;';

        for (const account of currentAccounts) {
          const config = getProviderConfig(account.providerId);
          const row = document.createElement('div');
          row.style.cssText =
            'display: flex; align-items: center; justify-content: space-between; ' +
            'padding: 10px 12px; background: var(--s2-bg-layer-2); border-radius: var(--s2-radius-default); ' +
            'margin-bottom: 8px; border: 1px solid var(--s2-border-subtle);';

          const info = document.createElement('div');
          info.style.cssText = 'flex: 1; min-width: 0;';

          const name = document.createElement('div');
          name.style.cssText =
            'font-size: 14px; font-weight: 600; color: var(--s2-content-default);';
          name.textContent = config.name;
          info.appendChild(name);

          const detail = document.createElement('div');
          detail.style.cssText =
            'font-size: 11px; color: var(--s2-content-disabled); font-family: monospace; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
          if (account.loggedOut) {
            detail.textContent = account.userName
              ? `Logged out — was ${account.userName}`
              : 'Logged out';
            detail.style.color = 'var(--s2-content-disabled)';
          } else if (account.userName) {
            detail.textContent = account.userName;
          } else if (account.accessToken) {
            detail.textContent = 'Logged in';
          } else {
            detail.textContent = maskApiKey(account.apiKey);
          }
          if (account.baseUrl) {
            detail.textContent += ' \u2022 ' + account.baseUrl;
          }
          info.appendChild(detail);

          row.appendChild(info);

          const actions = document.createElement('div');
          actions.style.cssText = 'display: flex; gap: 4px; margin-left: 12px; flex-shrink: 0;';

          const editBtn = document.createElement('button');
          editBtn.style.cssText = iconBtnStyle;
          editBtn.setAttribute('aria-label', 'Edit account');
          editBtn.appendChild(svgIcon(ICON_PATHS.pen));
          editBtn.addEventListener('mouseenter', () => {
            editBtn.style.color = 'var(--s2-accent)';
            editBtn.style.borderColor = 'var(--s2-accent)';
          });
          editBtn.addEventListener('mouseleave', () => {
            editBtn.style.color = 'var(--s2-content-secondary)';
            editBtn.style.borderColor = 'var(--s2-border-subtle)';
          });
          editBtn.addEventListener('click', () => {
            renderAccountForm(account);
          });
          actions.appendChild(editBtn);

          // Logout/Login toggle — OAuth providers only
          if (config.isOAuth) {
            const isLoggedOut = account.loggedOut === true;
            const authBtn = document.createElement('button');
            authBtn.style.cssText = iconBtnStyle;
            if (isLoggedOut) {
              authBtn.setAttribute('aria-label', 'Log in');
              authBtn.setAttribute('title', 'Log in');
              authBtn.appendChild(svgIcon(ICON_PATHS.login));
              authBtn.addEventListener('mouseenter', () => {
                authBtn.style.color = 'var(--s2-accent)';
                authBtn.style.borderColor = 'var(--s2-accent)';
              });
              authBtn.addEventListener('mouseleave', () => {
                authBtn.style.color = 'var(--s2-content-secondary)';
                authBtn.style.borderColor = 'var(--s2-border-subtle)';
              });
              authBtn.addEventListener('click', async () => {
                const { createOAuthLauncher, createInterceptingOAuthLauncherForCurrentRuntime } =
                  await import('../providers/oauth-service.js');
                // Always force re-auth when reconnecting from a logged-out
                // state so providers with SSO (e.g. Adobe IMS) don't silently
                // re-authorize the previous account.
                const loginOptions = { forceReauth: true };
                if (config.onOAuthLoginIntercepted) {
                  const interceptingLauncher =
                    await createInterceptingOAuthLauncherForCurrentRuntime();
                  if (interceptingLauncher) {
                    await config.onOAuthLoginIntercepted(
                      interceptingLauncher,
                      renderAccountsList,
                      loginOptions
                    );
                  }
                } else if (config.onOAuthLogin) {
                  const launcher = createOAuthLauncher();
                  await config.onOAuthLogin(launcher, renderAccountsList, loginOptions);
                }
              });
            } else {
              authBtn.setAttribute('aria-label', 'Log out');
              authBtn.setAttribute('title', 'Log out');
              authBtn.appendChild(svgIcon(ICON_PATHS.logout));
              authBtn.addEventListener('mouseenter', () => {
                authBtn.style.color = 'var(--s2-warning, #f59e0b)';
                authBtn.style.borderColor = 'var(--s2-warning, #f59e0b)';
              });
              authBtn.addEventListener('mouseleave', () => {
                authBtn.style.color = 'var(--s2-content-secondary)';
                authBtn.style.borderColor = 'var(--s2-border-subtle)';
              });
              authBtn.addEventListener('click', async () => {
                await logoutOAuthAccount(account.providerId);
                renderAccountsList();
              });
            }
            actions.appendChild(authBtn);
          }

          const deleteBtn = document.createElement('button');
          deleteBtn.style.cssText = iconBtnStyle;
          deleteBtn.setAttribute('aria-label', 'Remove account');
          deleteBtn.appendChild(svgIcon(ICON_PATHS.trash));
          deleteBtn.addEventListener('mouseenter', () => {
            deleteBtn.style.color = 'var(--s2-negative)';
            deleteBtn.style.borderColor = 'var(--s2-negative)';
          });
          deleteBtn.addEventListener('mouseleave', () => {
            deleteBtn.style.color = 'var(--s2-content-secondary)';
            deleteBtn.style.borderColor = 'var(--s2-border-subtle)';
          });
          deleteBtn.addEventListener('click', async () => {
            await removeAccount(account.providerId);
            renderAccountsList();
          });
          actions.appendChild(deleteBtn);

          row.appendChild(actions);

          list.appendChild(row);
        }
        dialog.appendChild(list);
      }

      // Action buttons row
      const btnRow = document.createElement('div');
      btnRow.style.cssText = 'display: flex; gap: 8px;';

      const addBtn = document.createElement('button');
      addBtn.className =
        currentAccounts.length > 0 ? 'dialog__btn dialog__btn--secondary' : 'dialog__btn';
      addBtn.style.flex = '1';
      addBtn.textContent = 'Add Account';
      addBtn.addEventListener('click', () => renderAccountForm());
      btnRow.appendChild(addBtn);

      const exportBtn = document.createElement('button');
      exportBtn.className = 'dialog__btn dialog__btn--secondary';
      exportBtn.style.flex = '1';
      exportBtn.textContent = 'Export';
      exportBtn.addEventListener('click', () => downloadProviders());
      btnRow.appendChild(exportBtn);

      dialog.appendChild(btnRow);

      // ── Tray section ────────────────────────────────────────────
      const traySep = document.createElement('hr');
      traySep.style.cssText =
        'border: none; border-top: 1px solid var(--s2-border-subtle); margin: 16px 0;';
      dialog.appendChild(traySep);

      const trayLabel = document.createElement('div');
      trayLabel.className = 'dialog__desc';
      trayLabel.style.cssText = 'font-weight: 600; margin-bottom: 8px;';
      trayLabel.textContent = 'Tray';
      dialog.appendChild(trayLabel);

      const followerStatus = getFollowerTrayRuntimeStatus();
      const isFollowerActive = followerStatus.state !== 'inactive';
      const hasJoinUrl = hasStoredTrayJoinUrl(window.localStorage);

      if (isFollowerActive || hasJoinUrl) {
        const trayStatus = document.createElement('div');
        trayStatus.style.cssText =
          'font-size: 12px; color: var(--s2-content-secondary); margin-bottom: 8px;';
        const stateLabel = isFollowerActive ? followerStatus.state : 'configured';
        trayStatus.textContent = `Follower: ${stateLabel}`;
        if (followerStatus.error) {
          trayStatus.textContent += ` — ${followerStatus.error}`;
          trayStatus.style.color = 'var(--slicc-cone)';
        }
        dialog.appendChild(trayStatus);
      }

      const joinTrayBtn = document.createElement('button');
      joinTrayBtn.className = 'dialog__btn dialog__btn--secondary';
      joinTrayBtn.textContent =
        isFollowerActive || hasJoinUrl
          ? 'Reconnect to other browser'
          : 'Connect to another browser';
      joinTrayBtn.addEventListener('click', () => renderJoinTrayForm());
      dialog.appendChild(joinTrayBtn);

      // Separator before Get Started
      const closeSep = document.createElement('hr');
      closeSep.style.cssText =
        'border: none; border-top: 1px solid var(--s2-border-subtle); margin: 16px 0;';
      dialog.appendChild(closeSep);

      // Close button
      const closeBtn = document.createElement('button');
      closeBtn.className = 'dialog__btn';
      closeBtn.textContent = 'Get Started';
      closeBtn.addEventListener('click', () => {
        overlay.remove();
        resolve((localStorage.getItem(ACCOUNTS_KEY) ?? '') !== accountsBefore);
      });
      dialog.appendChild(closeBtn);
    }

    // ── Account form view (add or edit) ─────────────────────────────
    function renderAccountForm(editing?: Account) {
      dialog.innerHTML = '';
      const isEdit = !!editing;

      const title = document.createElement('div');
      title.className = 'dialog__title';
      title.textContent = isEdit ? 'Edit Account' : 'Add Account';
      dialog.appendChild(title);

      // Provider selector
      const providerLabel = document.createElement('div');
      providerLabel.className = 'dialog__desc';
      providerLabel.textContent = 'Provider:';
      dialog.appendChild(providerLabel);

      const providerSelect = document.createElement('select');
      providerSelect.className = 'dialog__input';
      providerSelect.style.marginBottom = '8px';

      if (isEdit) {
        // Locked to the existing provider
        const config = getProviderConfig(editing.providerId);
        const opt = document.createElement('option');
        opt.value = editing.providerId;
        opt.textContent = config.name;
        providerSelect.appendChild(opt);
        providerSelect.disabled = true;
        providerSelect.style.opacity = '0.7';
      } else {
        // Placeholder so nothing is silently pre-selected — users must
        // explicitly pick a provider before any auth/key UI shows up.
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'Select a provider…';
        placeholder.disabled = true;
        placeholder.selected = true;
        placeholder.hidden = true;
        providerSelect.appendChild(placeholder);

        const providers = getAvailableProviders();
        const existingProviders = new Set(getAccounts().map((a) => a.providerId));
        const sorted = [...providers].sort((a, b) => {
          const nameA = getProviderConfig(a).name;
          const nameB = getProviderConfig(b).name;
          return nameA.localeCompare(nameB);
        });
        for (const providerId of sorted) {
          if (existingProviders.has(providerId)) continue;
          if (options?.providerFilter) {
            // Caller-supplied filter fully controls the list (e.g. connect mode
            // offers GitHub — an auth-only provider — but hides ones that can't
            // authenticate there).
            if (!options.providerFilter(providerId)) continue;
          } else if (!providerOffersLlmModels(providerId)) {
            // Default: skip auth-only providers (no LLM models to expose) —
            // useful as existing accounts, but not something to "add" here.
            continue;
          }
          const config = getProviderConfig(providerId);
          const opt = document.createElement('option');
          opt.value = providerId;
          opt.textContent = config.name;
          providerSelect.appendChild(opt);
        }
      }
      dialog.appendChild(providerSelect);

      // Provider description
      const providerDesc = document.createElement('div');
      providerDesc.className = 'dialog__desc';
      providerDesc.style.cssText =
        'font-size: 12px; color: var(--s2-content-tertiary); margin-bottom: 16px; margin-top: -4px;';
      dialog.appendChild(providerDesc);

      // OAuth login section (shown for isOAuth providers)
      const oauthSection = document.createElement('div');
      oauthSection.style.cssText = 'margin-bottom: 16px; display: none;';

      const oauthLoginBtn = document.createElement('button');
      oauthLoginBtn.className = 'dialog__btn';
      oauthLoginBtn.textContent = 'Login';
      oauthLoginBtn.style.cssText = 'width: 100%; margin-bottom: 8px;';
      oauthSection.appendChild(oauthLoginBtn);

      const oauthStatus = document.createElement('div');
      oauthStatus.className = 'dialog__desc';
      oauthStatus.style.cssText =
        'font-size: 12px; color: var(--s2-content-secondary); text-align: center;';
      oauthSection.appendChild(oauthStatus);

      // OAuth login handler — calls the provider's onOAuthLogin callback with a generic launcher.
      // Device-flow providers (e.g. github-copilot) also receive a `presentDeviceCode` prompter
      // that renders the verification code inline in this dialog instead of via a floating overlay.
      const createDialogDeviceCodePrompter = (): DeviceCodePrompter => {
        const host = oauthSection;
        const status = oauthStatus;
        const loginBtn = oauthLoginBtn;
        return (input) =>
          new Promise<'continue' | 'cancel'>((resolve) => {
            // Hide the default login UI while the prompt is active so the
            // dialog only shows the code + the continue/cancel pair. The
            // original elements are restored on resolution.
            const wasLoginHidden = loginBtn.style.display;
            const wasStatusHidden = status.style.display;
            loginBtn.style.display = 'none';
            status.style.display = 'none';

            const prompt = document.createElement('div');
            prompt.setAttribute('data-slicc-device-code-prompt', '');
            prompt.style.cssText = 'display:flex;flex-direction:column;gap:8px';

            const label = document.createElement('div');
            label.className = 'dialog__desc';
            label.textContent = 'Verification code';
            label.style.cssText = 'font-size: 11px; color: var(--s2-content-tertiary);';

            const code = document.createElement('div');
            code.textContent = input.userCode;
            code.style.cssText = [
              'font: 600 22px ui-monospace, SFMono-Regular, Menlo, monospace',
              'letter-spacing: 2px',
              'color: var(--s2-content-primary, #e6edf3)',
              'background: var(--s2-bg-secondary, #161b22)',
              'border: 1px solid var(--s2-border, #30363d)',
              'border-radius: 6px',
              'padding: 10px 12px',
              'text-align: center',
              'user-select: all',
              'cursor: text',
            ].join(';');

            const hint = document.createElement('div');
            hint.className = 'dialog__desc';
            hint.style.cssText = 'font-size: 12px; color: var(--s2-content-secondary);';
            hint.textContent =
              'Click Copy & Continue — we will open the GitHub authorization page in a new tab. Paste this code there if it is not already filled in.';

            const row = document.createElement('div');
            row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:4px';

            const cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.className = 'dialog__btn';
            cancelBtn.textContent = 'Cancel';

            const continueBtn = document.createElement('button');
            continueBtn.type = 'button';
            continueBtn.className = 'dialog__btn dialog__btn--primary';
            continueBtn.textContent = 'Copy & Continue';

            const cleanup = () => {
              try {
                prompt.remove();
              } catch {
                /* already removed */
              }
              loginBtn.style.display = wasLoginHidden;
              status.style.display = wasStatusHidden;
            };

            cancelBtn.addEventListener('click', () => {
              cleanup();
              resolve('cancel');
            });
            continueBtn.addEventListener('click', () => {
              void (async () => {
                try {
                  await copyTextToClipboard(input.userCode);
                } catch {
                  /* user can still copy manually from the displayed code */
                }
                cleanup();
                status.style.display = wasStatusHidden;
                status.textContent = 'Waiting for you to authorize in the new tab…';
                resolve('continue');
              })();
            });

            row.appendChild(cancelBtn);
            row.appendChild(continueBtn);

            prompt.appendChild(label);
            prompt.appendChild(code);
            prompt.appendChild(hint);
            prompt.appendChild(row);
            host.appendChild(prompt);
          });
      };

      oauthLoginBtn.addEventListener('click', async () => {
        const pid = providerSelect.value;
        if (!pid) return;
        const providerConfig = getProviderConfig(pid);
        if (!providerConfig.onOAuthLogin && !providerConfig.onOAuthLoginIntercepted) return;

        // Validate base URL if required
        const hadAccountBefore = getAccounts().some((a) => a.providerId === pid);
        const existingBaseUrl = getBaseUrlForProvider(pid);
        if (providerConfig.requiresBaseUrl && !baseUrlInput.value.trim() && !existingBaseUrl) {
          oauthStatus.textContent = 'Base URL is required.';
          oauthStatus.style.color = 'var(--slicc-cone)';
          baseUrlInput.focus();
          return;
        }
        // Save baseUrl before login so the provider's onOAuthLogin can read it
        if (providerConfig.requiresBaseUrl && baseUrlInput.value.trim()) {
          addAccount(pid, '', baseUrlInput.value.trim());
        }
        oauthStatus.textContent = 'Opening login window...';
        try {
          if (providerConfig.onOAuthLoginIntercepted) {
            const { createInterceptingOAuthLauncherForCurrentRuntime } = await import(
              '../providers/oauth-service.js'
            );
            const launcher = await createInterceptingOAuthLauncherForCurrentRuntime();
            if (!launcher) {
              throw new Error(
                'No controlled-browser CDP transport available — open SLICC in standalone mode or the Chrome extension.'
              );
            }
            await providerConfig.onOAuthLoginIntercepted(launcher, finishAccountChange, {
              presentDeviceCode: createDialogDeviceCodePrompter(),
            });
          } else if (providerConfig.onOAuthLogin) {
            const { createOAuthLauncher } = await import('../providers/oauth-service.js');
            const launcher = createOAuthLauncher();
            await providerConfig.onOAuthLogin(launcher, finishAccountChange);
          }
        } catch (err) {
          // Clean up pre-login baseUrl placeholder if no account existed before
          if (!hadAccountBefore) {
            try {
              await removeAccount(pid);
            } catch {
              /* best-effort cleanup */
            }
          }
          log.error('OAuth login failed', {
            providerId: pid,
            error: err instanceof Error ? err.message : String(err),
          });
          oauthStatus.textContent = `Login failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      });

      // Show logged-in user if editing an OAuth account
      if (isEdit && editing.userName) {
        oauthStatus.textContent = `Logged in as ${editing.userName}`;
        oauthLoginBtn.textContent = 'Re-login';
      }

      dialog.appendChild(oauthSection);

      // API Key section
      const apiKeySection = document.createElement('div');

      const apiKeyLabel = document.createElement('div');
      apiKeyLabel.className = 'dialog__desc';
      apiKeySection.appendChild(apiKeyLabel);

      const apiKeyInput = document.createElement('input');
      apiKeyInput.className = 'dialog__input';
      apiKeyInput.type = 'password';
      apiKeyInput.autocomplete = 'off';
      apiKeyInput.spellcheck = false;
      if (isEdit) apiKeyInput.value = editing.apiKey;
      apiKeySection.appendChild(apiKeyInput);

      dialog.appendChild(apiKeySection);

      // Base URL section
      const baseUrlSection = document.createElement('div');

      const baseUrlLabel = document.createElement('div');
      baseUrlLabel.className = 'dialog__desc';
      baseUrlLabel.textContent = 'Base URL:';
      baseUrlSection.appendChild(baseUrlLabel);

      const baseUrlInput = document.createElement('input');
      baseUrlInput.className = 'dialog__input';
      baseUrlInput.type = 'text';
      baseUrlInput.autocomplete = 'off';
      baseUrlInput.spellcheck = false;
      if (isEdit && editing.baseUrl) baseUrlInput.value = editing.baseUrl;
      baseUrlSection.appendChild(baseUrlInput);

      const baseUrlDesc = document.createElement('div');
      baseUrlDesc.className = 'dialog__desc';
      baseUrlDesc.style.cssText =
        'font-size: 11px; color: var(--s2-content-secondary); margin-top: -12px; margin-bottom: 16px;';
      baseUrlSection.appendChild(baseUrlDesc);

      dialog.appendChild(baseUrlSection);

      // Deployment section (shown for providers with requiresDeployment)
      const deploymentSection = document.createElement('div');
      deploymentSection.style.display = 'none';

      const deploymentLabel = document.createElement('div');
      deploymentLabel.className = 'dialog__desc';
      deploymentLabel.textContent = 'Deployment:';
      deploymentSection.appendChild(deploymentLabel);

      const deploymentInput = document.createElement('input');
      deploymentInput.className = 'dialog__input';
      deploymentInput.type = 'text';
      deploymentInput.autocomplete = 'off';
      deploymentInput.spellcheck = false;
      if (isEdit && editing.deployment) deploymentInput.value = editing.deployment;
      deploymentSection.appendChild(deploymentInput);

      const deploymentDesc = document.createElement('div');
      deploymentDesc.className = 'dialog__desc';
      deploymentDesc.style.cssText =
        'font-size: 11px; color: var(--s2-content-secondary); margin-top: -12px; margin-bottom: 16px;';
      deploymentSection.appendChild(deploymentDesc);

      dialog.appendChild(deploymentSection);

      // API version section (shown for providers with requiresApiVersion)
      const apiVersionSection = document.createElement('div');
      apiVersionSection.style.display = 'none';

      const apiVersionLabel = document.createElement('div');
      apiVersionLabel.className = 'dialog__desc';
      apiVersionLabel.textContent = 'API Version:';
      apiVersionSection.appendChild(apiVersionLabel);

      const apiVersionInput = document.createElement('input');
      apiVersionInput.className = 'dialog__input';
      apiVersionInput.type = 'text';
      apiVersionInput.autocomplete = 'off';
      apiVersionInput.spellcheck = false;
      if (isEdit && editing.apiVersion) apiVersionInput.value = editing.apiVersion;
      apiVersionSection.appendChild(apiVersionInput);

      const apiVersionDesc = document.createElement('div');
      apiVersionDesc.className = 'dialog__desc';
      apiVersionDesc.style.cssText =
        'font-size: 11px; color: var(--s2-content-secondary); margin-top: -12px; margin-bottom: 16px;';
      apiVersionSection.appendChild(apiVersionDesc);

      dialog.appendChild(apiVersionSection);

      // Error message area
      const errorEl = document.createElement('div');
      errorEl.style.cssText =
        'color: var(--slicc-cone); font-size: 12px; margin-bottom: 8px; display: none;';
      dialog.appendChild(errorEl);

      // Save button (created before updateFormFields so it can be toggled)
      const saveBtn = document.createElement('button');
      saveBtn.className = 'dialog__btn';
      saveBtn.textContent = isEdit ? 'Save' : 'Add';

      function updateFormFields() {
        const pid = providerSelect.value;
        if (!pid) {
          // Placeholder state — hide everything so the dialog only shows
          // the dropdown until the user makes a choice.
          providerDesc.textContent = '';
          oauthSection.style.display = 'none';
          apiKeySection.style.display = 'none';
          baseUrlSection.style.display = 'none';
          deploymentSection.style.display = 'none';
          apiVersionSection.style.display = 'none';
          saveBtn.style.display = 'none';
          return;
        }
        const providerConfig = getProviderConfig(pid);

        providerDesc.textContent = providerConfig.description;

        // OAuth providers show login button instead of API key input
        if (providerConfig.isOAuth) {
          oauthSection.style.display = '';
          apiKeySection.style.display = 'none';
          baseUrlSection.style.display = providerConfig.requiresBaseUrl ? '' : 'none';
          if (providerConfig.requiresBaseUrl) {
            baseUrlInput.placeholder = providerConfig.baseUrlPlaceholder || 'https://...';
            baseUrlDesc.textContent = providerConfig.baseUrlDescription || '';
          }
          oauthLoginBtn.textContent = `Login with ${providerConfig.name}`;
          saveBtn.style.display = 'none';
        } else {
          oauthSection.style.display = 'none';
          const keyLabel = providerConfig.requiresApiKey ? 'API Key' : 'API Key (optional)';
          apiKeyLabel.textContent = `${keyLabel}${providerConfig.apiKeyEnvVar ? ` (${providerConfig.apiKeyEnvVar})` : ''}:`;
          apiKeyInput.placeholder = providerConfig.apiKeyPlaceholder || 'API key';
          const showApiKey = providerConfig.requiresApiKey || providerConfig.optionalApiKey;
          apiKeySection.style.display = showApiKey ? '' : 'none';
          baseUrlInput.placeholder = providerConfig.baseUrlPlaceholder || 'https://...';
          baseUrlDesc.textContent = providerConfig.baseUrlDescription || '';
          baseUrlSection.style.display = providerConfig.requiresBaseUrl ? '' : 'none';
          saveBtn.style.display = '';
        }

        // Deployment field
        if (providerConfig.requiresDeployment) {
          deploymentSection.style.display = '';
          deploymentInput.placeholder = providerConfig.deploymentPlaceholder || 'deployment-name';
          deploymentDesc.textContent = providerConfig.deploymentDescription || '';
        } else {
          deploymentSection.style.display = 'none';
        }

        // API version field
        if (providerConfig.requiresApiVersion) {
          apiVersionSection.style.display = '';
          if (!apiVersionInput.value && providerConfig.apiVersionDefault) {
            apiVersionInput.value = providerConfig.apiVersionDefault;
          }
          apiVersionInput.placeholder = providerConfig.apiVersionDefault || 'api-version';
          apiVersionDesc.textContent = providerConfig.apiVersionDescription || '';
        } else {
          apiVersionSection.style.display = 'none';
        }
      }

      providerSelect.addEventListener('change', () => {
        errorEl.style.display = 'none';
        updateFormFields();
      });
      updateFormFields();

      function validateAndSave() {
        const pid = providerSelect.value;
        if (!pid) return;
        const config = getProviderConfig(pid);

        if (config.requiresApiKey && apiKeyInput.value.trim().length < 5) {
          errorEl.textContent = 'API key is required (at least 5 characters).';
          errorEl.style.display = '';
          apiKeyInput.focus();
          return;
        }

        if (config.requiresBaseUrl && !baseUrlInput.value.trim()) {
          errorEl.textContent = 'Base URL is required for this provider.';
          errorEl.style.display = '';
          baseUrlInput.focus();
          return;
        }

        if (config.requiresDeployment && !deploymentInput.value.trim()) {
          errorEl.textContent = 'Deployment name is required for this provider.';
          errorEl.style.display = '';
          deploymentInput.focus();
          return;
        }

        addAccount(
          pid,
          apiKeyInput.value.trim(),
          baseUrlInput.value.trim() || undefined,
          deploymentInput.value.trim() || undefined,
          apiVersionInput.value.trim() || undefined
        );

        finishAccountChange();
      }

      saveBtn.addEventListener('click', validateAndSave);

      const handleEnter = (e: KeyboardEvent) => {
        if (e.key === 'Enter') validateAndSave();
      };
      apiKeyInput.addEventListener('keydown', handleEnter);
      baseUrlInput.addEventListener('keydown', handleEnter);
      deploymentInput.addEventListener('keydown', handleEnter);
      apiVersionInput.addEventListener('keydown', handleEnter);

      dialog.appendChild(saveBtn);

      // Back button (only shown when accounts already exist)
      const hasAccounts = getAccounts().length > 0;
      if (options?.startInAddAccount) {
        // Connect mode: the parent surface owns the account list, and tray-join
        // is irrelevant here — offer a plain close instead of "Back"/"Connect to
        // another browser" (both of which dropped users into confusing views).
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'dialog__btn dialog__btn--secondary';
        cancelBtn.style.marginTop = '8px';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => {
          overlay.remove();
          resolve((localStorage.getItem(ACCOUNTS_KEY) ?? '') !== accountsBefore);
        });
        dialog.appendChild(cancelBtn);
      } else if (!isEdit && !hasAccounts) {
        const joinBtn = document.createElement('button');
        joinBtn.className = 'dialog__btn dialog__btn--secondary';
        joinBtn.style.marginTop = '8px';
        joinBtn.textContent = 'Connect to another browser';
        joinBtn.addEventListener('click', () => {
          renderJoinTrayForm();
        });
        dialog.appendChild(joinBtn);
      } else if (hasAccounts) {
        const backBtn = document.createElement('button');
        backBtn.className = 'dialog__btn dialog__btn--secondary';
        backBtn.style.marginTop = '8px';
        backBtn.textContent = 'Back';
        backBtn.addEventListener('click', () => {
          renderAccountsList();
        });
        dialog.appendChild(backBtn);
      }

      requestAnimationFrame(() => {
        const pid = providerSelect.value;
        if (!pid) return;
        const config = getProviderConfig(pid);
        if (config.requiresApiKey) {
          apiKeyInput.focus();
        } else if (config.requiresBaseUrl) {
          baseUrlInput.focus();
        }
      });
    }

    function renderAutoJoinConfirmation(joinUrl: string) {
      dialog.innerHTML = '';

      const title = document.createElement('div');
      title.className = 'dialog__title';
      title.textContent = 'Connect this browser?';
      dialog.appendChild(title);

      const desc = document.createElement('div');
      desc.className = 'dialog__desc';
      desc.style.marginBottom = '12px';
      desc.textContent =
        'You\u2019ve been invited to mirror another SLICC browser. Click below to start syncing.';
      dialog.appendChild(desc);

      // Show truncated URL for context
      const urlDisplay = document.createElement('div');
      urlDisplay.className = 'dialog__desc';
      urlDisplay.style.cssText =
        'font-family: monospace; font-size: 11px; color: var(--s2-content-secondary); word-break: break-all; margin-bottom: 16px; padding: 8px; background: var(--s2-bg-secondary); border-radius: 4px;';
      const displayUrl =
        joinUrl.length > 80 ? joinUrl.slice(0, 40) + '\u2026' + joinUrl.slice(-37) : joinUrl;
      urlDisplay.textContent = displayUrl;
      dialog.appendChild(urlDisplay);

      const statusEl = document.createElement('div');
      statusEl.style.cssText =
        'font-size: 12px; color: var(--s2-content-secondary); margin-bottom: 8px; display: none;';
      dialog.appendChild(statusEl);

      const joinBtn = document.createElement('button');
      joinBtn.className = 'dialog__btn';
      joinBtn.textContent = 'Connect';
      joinBtn.addEventListener('click', () => {
        const stored = storeTrayJoinUrl(window.localStorage, joinUrl);
        if (!stored) {
          statusEl.textContent = 'Invalid sync URL.';
          statusEl.style.display = '';
          statusEl.style.color = 'var(--slicc-cone)';
          return;
        }

        if (isExtensionRuntime()) {
          const payload: RefreshTrayRuntimeMsg = {
            type: 'refresh-tray-runtime',
            joinUrl: stored.joinUrl,
            workerBaseUrl: stored.workerBaseUrl,
          };
          void chrome.runtime.sendMessage({ source: 'panel' as const, payload }).catch(() => {});
        } else {
          dispatchTrayJoinWithFailureFeedback(stored.joinUrl, statusEl);
        }

        statusEl.textContent = 'Connecting\u2026';
        statusEl.style.display = '';
        statusEl.style.color = 'var(--s2-content-secondary)';

        // 800 ms is fast feedback for the success path; failure
        // surfaces sooner via `slicc:tray-join-failed` and the
        // listener inside `dispatchTrayJoinWithFailureFeedback`
        // cancels this timer.
        const dismissTimer = setTimeout(() => {
          overlay.remove();
          resolve(false);
        }, 800);
        statusEl.dataset.dismissTimer = String(dismissTimer);
      });
      dialog.appendChild(joinBtn);

      const altBtn = document.createElement('button');
      altBtn.className = 'dialog__btn dialog__btn--secondary';
      altBtn.style.marginTop = '8px';
      altBtn.textContent = 'Set up an account instead';
      altBtn.addEventListener('click', () => {
        renderAccountForm();
      });
      dialog.appendChild(altBtn);
    }

    function renderJoinTrayForm() {
      dialog.innerHTML = '';

      const title = document.createElement('div');
      title.className = 'dialog__title';
      title.textContent = 'Connect to another browser';
      dialog.appendChild(title);

      const desc = document.createElement('div');
      desc.className = 'dialog__desc';
      desc.style.marginBottom = '12px';
      desc.textContent = 'Paste a multi-browser sync URL to mirror another SLICC browser.';
      dialog.appendChild(desc);

      const hint = document.createElement('details');
      hint.style.cssText =
        'margin-bottom: 12px; font-size: 12px; color: var(--s2-content-secondary);';
      const hintSummary = document.createElement('summary');
      hintSummary.style.cssText =
        'cursor: pointer; user-select: none; color: var(--s2-content-secondary);';
      hintSummary.textContent = 'How do I get the sync URL?';
      hint.appendChild(hintSummary);
      const hintBody = document.createElement('div');
      hintBody.style.cssText =
        'margin-top: 8px; padding: 10px 12px; background: var(--s2-bg-layer-2); border-radius: var(--s2-radius-default); border: 1px solid var(--s2-border-subtle); line-height: 1.5;';
      const hintList = document.createElement('ol');
      hintList.style.cssText = 'margin: 0; padding-left: 20px;';
      const steps = [
        'On the other SLICC, click the avatar (top right).',
        'Choose \u201cEnable multi-browser sync\u201d \u2014 the URL is copied automatically.',
        'Paste it below. Both browsers must be on the same SLICC version.',
      ];
      for (const step of steps) {
        const li = document.createElement('li');
        li.textContent = step;
        hintList.appendChild(li);
      }
      hintBody.appendChild(hintList);
      hint.appendChild(hintBody);
      dialog.appendChild(hint);

      const trayUrlLabel = document.createElement('div');
      trayUrlLabel.className = 'dialog__desc';
      trayUrlLabel.textContent = 'Sync URL:';
      dialog.appendChild(trayUrlLabel);

      const trayUrlInput = document.createElement('input');
      trayUrlInput.className = 'dialog__input';
      trayUrlInput.type = 'text';
      trayUrlInput.autocomplete = 'off';
      trayUrlInput.spellcheck = false;
      trayUrlInput.placeholder = 'https://www.sliccy.ai/join/<token>';
      dialog.appendChild(trayUrlInput);

      const errorEl = document.createElement('div');
      errorEl.style.cssText =
        'color: var(--slicc-cone); font-size: 12px; margin-bottom: 8px; display: none;';
      dialog.appendChild(errorEl);

      const statusEl = document.createElement('div');
      statusEl.style.cssText =
        'font-size: 12px; color: var(--s2-content-secondary); margin-bottom: 8px; display: none;';

      const joinBtn = document.createElement('button');
      joinBtn.className = 'dialog__btn';
      joinBtn.textContent = 'Connect';
      joinBtn.addEventListener('click', () => {
        const raw = trayUrlInput.value.trim();
        if (!raw) {
          errorEl.textContent = 'Paste a sync URL to continue.';
          errorEl.style.display = '';
          trayUrlInput.focus();
          return;
        }
        const stored = storeTrayJoinUrl(window.localStorage, raw);
        if (!stored) {
          errorEl.textContent = describeInvalidJoinUrl(raw);
          errorEl.style.display = '';
          trayUrlInput.focus();
          return;
        }

        if (isExtensionRuntime()) {
          const payload: RefreshTrayRuntimeMsg = {
            type: 'refresh-tray-runtime',
            joinUrl: stored.joinUrl,
            workerBaseUrl: stored.workerBaseUrl,
          };
          void chrome.runtime.sendMessage({ source: 'panel' as const, payload }).catch(() => {
            // Offscreen may not be ready yet; mainExtension will reconnect shortly.
          });
        } else {
          dispatchTrayJoinWithFailureFeedback(stored.joinUrl, statusEl);
        }

        statusEl.textContent = 'Connecting\u2026';
        statusEl.style.display = '';
        statusEl.style.color = 'var(--s2-content-secondary)';

        // See note above the other dispatch site \u2014 the listener
        // inside `dispatchTrayJoinWithFailureFeedback` cancels this
        // timer if a failure event arrives.
        const dismissTimer = setTimeout(() => {
          overlay.remove();
          resolve(false);
        }, 800);
        statusEl.dataset.dismissTimer = String(dismissTimer);
      });
      dialog.appendChild(joinBtn);
      dialog.appendChild(statusEl);

      const backBtn = document.createElement('button');
      backBtn.className = 'dialog__btn dialog__btn--secondary';
      backBtn.style.marginTop = '8px';
      backBtn.textContent = 'Back';
      backBtn.addEventListener('click', () => {
        renderAccountForm();
      });
      dialog.appendChild(backBtn);

      trayUrlInput.addEventListener('input', () => {
        errorEl.style.display = 'none';
      });
      trayUrlInput.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter') joinBtn.click();
      });

      requestAnimationFrame(() => trayUrlInput.focus());
    }
  });
}
