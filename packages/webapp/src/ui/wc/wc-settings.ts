/**
 * WC-native account settings — the avatar-menu "Account settings…" surface,
 * rebuilt over the library's `<slicc-dialog>` (prototype chrome + tokens)
 * instead of the legacy dialog stylesheet. Reuses ALL account logic from
 * `provider-settings.ts` (accounts store, provider registry, OAuth
 * launchers); only the presentation is new. Onboarding-only flows
 * (tray-join, auto-join) stay on the legacy dialog via the connect surface.
 */

import type { Account, ProviderConfig } from '../provider-settings.js';
import { applyTheme } from '../theme.js';
import {
  clearActiveTheme,
  deleteCustomTheme,
  deriveTokens,
  exportTheme,
  getActiveThemeId,
  getCustomThemes,
  importTheme,
  saveCustomTheme,
  setActiveTheme,
} from '../theme-engine.js';
import { PRESETS } from '../theme-presets.js';
import type { SimplifiedSlots, SliccTheme } from '../theme-types.js';
import { TOKEN_GROUPS } from '../theme-types.js';

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
.wcset__appearance{display:flex;flex-direction:column;gap:12px;padding-bottom:14px;border-bottom:1px solid var(--line);}
.wcset__section-label{font-size:11px;font-weight:600;color:var(--txt-2);text-transform:uppercase;letter-spacing:.04em;}
.wcset__preset-grid{display:flex;flex-wrap:wrap;gap:8px;}
.wcset__preset-swatch{width:56px;height:48px;border-radius:8px;border:2px solid transparent;cursor:pointer;display:flex;flex-direction:column;overflow:hidden;transition:border-color 130ms ease;}
.wcset__preset-swatch:hover{border-color:var(--ctx);}
.wcset__preset-swatch--active{border-color:var(--ink);}
.wcset__preset-swatch__stripe{flex:1;}
.wcset__preset-name{font-size:9px;text-align:center;padding:2px 0;background:var(--canvas);color:var(--txt-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.wcset__custom-themes{display:flex;flex-direction:column;gap:6px;}
.wcset__custom-row{display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--line);border-radius:8px;}
.wcset__custom-row__name{flex:1;font-size:12px;font-weight:500;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.wcset__builder{display:flex;flex-direction:column;gap:10px;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--canvas);}
.wcset__builder-row{display:flex;align-items:center;gap:8px;}
.wcset__builder-row label{font-size:11px;color:var(--txt-2);min-width:80px;}
.wcset__builder-row input[type="color"]{width:32px;height:24px;border:1px solid var(--line);border-radius:4px;padding:0;cursor:pointer;background:transparent;}
.wcset__builder-row input[type="color"]::-webkit-color-swatch-wrapper{padding:2px;}
.wcset__builder-row input[type="color"]::-webkit-color-swatch{border-radius:2px;border:none;}
.wcset__advanced-toggle{font-size:11px;color:var(--ctx);cursor:pointer;background:none;border:none;padding:0;text-decoration:underline;}
.wcset__advanced-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;}
.wcset__advanced-token{display:flex;align-items:center;gap:4px;font-size:10px;color:var(--txt-3);}
.wcset__advanced-token input[type="color"]{width:20px;height:16px;border:1px solid var(--line);border-radius:3px;padding:0;cursor:pointer;background:transparent;}
.wcset__base-toggle{display:flex;gap:4px;}
.wcset__base-toggle button{font-size:11px;padding:3px 8px;border-radius:6px;border:1px solid var(--line);background:transparent;color:var(--txt-2);cursor:pointer;}
.wcset__base-toggle button.active{background:var(--ink);color:var(--canvas);border-color:var(--ink);}
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
    baseUrlInput.placeholder = config.baseUrlPlaceholder ?? 'Base URL';
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

    const deploymentInput = document.createElement('input');
    deploymentInput.className = 'wcset__input';
    deploymentInput.placeholder = config.deploymentPlaceholder ?? 'Model IDs (comma-separated)';
    deploymentInput.value = ps.getDeploymentForProvider(pid) ?? '';
    if (config.requiresDeployment) controls.append(deploymentInput);

    const keyInput = document.createElement('input');
    keyInput.className = 'wcset__input';
    keyInput.type = 'password';
    keyInput.placeholder = config.apiKeyPlaceholder ?? 'API key';
    keyInput.setAttribute('data-testid', 'wcset-api-key');
    if (config.requiresApiKey || config.optionalApiKey) controls.append(keyInput);
    controls.append(
      button('wcset__btn wcset__btn--primary', 'Save', () => {
        const key = keyInput.value.trim();
        if (config.requiresApiKey && !key) {
          setStatus('An API key is required.', true);
          keyInput.focus();
          return;
        }
        if (config.requiresBaseUrl && !baseUrlInput.value.trim()) {
          setStatus('Base URL is required.', true);
          baseUrlInput.focus();
          return;
        }
        if (config.requiresDeployment && !deploymentInput.value.trim()) {
          setStatus('Model IDs are required.', true);
          deploymentInput.focus();
          return;
        }
        ps.addAccount(
          pid,
          key,
          baseUrlInput.value.trim() || undefined,
          deploymentInput.value.trim() || undefined
        );
        keyInput.value = '';
        setStatus(`${config.name} connected.`);
        deps.renderList();
      })
    );
  };
  select.addEventListener('change', renderControls);
  return section;
}

function buildAppearanceSection(deps: ViewDeps): HTMLElement {
  const section = div('wcset__appearance');
  section.append(div('wcset__section-label', 'Appearance'));

  const activeId = getActiveThemeId();

  // Preset grid
  const grid = div('wcset__preset-grid');

  // Default (no theme) swatch
  const defaultSwatch = document.createElement('div');
  defaultSwatch.className = `wcset__preset-swatch${!activeId ? ' wcset__preset-swatch--active' : ''}`;
  const defaultStripes = ['#1a1a1a', '#2c2c2c', '#3562ff'];
  defaultSwatch.innerHTML =
    defaultStripes
      .map((c) => `<div class="wcset__preset-swatch__stripe" style="background:${c}"></div>`)
      .join('') + '<div class="wcset__preset-name">Default</div>';
  defaultSwatch.addEventListener('click', () => {
    clearActiveTheme();
    applyTheme();
    rebuildSection();
  });
  grid.append(defaultSwatch);

  for (const preset of PRESETS) {
    const swatch = document.createElement('div');
    swatch.className = `wcset__preset-swatch${activeId === preset.id ? ' wcset__preset-swatch--active' : ''}`;
    const bg = preset.tokens['--s2-gray-25'] || '#1a1a1a';
    const surface = preset.tokens['--s2-gray-100'] || '#2c2c2c';
    const accent = preset.tokens['--s2-accent'] || '#3562ff';
    swatch.innerHTML = `<div class="wcset__preset-swatch__stripe" style="background:${bg}"></div><div class="wcset__preset-swatch__stripe" style="background:${surface}"></div><div class="wcset__preset-swatch__stripe" style="background:${accent}"></div><div class="wcset__preset-name">${preset.name}</div>`;
    swatch.addEventListener('click', () => {
      setActiveTheme(preset.id);
      applyTheme();
      rebuildSection();
    });
    grid.append(swatch);
  }
  section.append(grid);

  // Custom themes list
  const customs = getCustomThemes();
  if (customs.length > 0) {
    const customSection = div('wcset__custom-themes');
    customSection.append(div('wcset__section-label', 'My Themes'));
    for (const theme of customs) {
      const row = div('wcset__custom-row');
      const name = div('wcset__custom-row__name', theme.name);
      if (activeId === theme.id) name.style.fontWeight = '700';
      row.append(name);
      row.append(
        button('wcset__btn', 'Use', () => {
          setActiveTheme(theme.id);
          applyTheme();
          rebuildSection();
        })
      );
      row.append(
        button('wcset__btn', 'Edit', () => {
          showBuilder(theme);
        })
      );
      row.append(
        button('wcset__btn', 'Export', () => {
          const blob = new Blob([exportTheme(theme)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${theme.name.toLowerCase().replace(/\s+/g, '-')}.slicc-theme.json`;
          a.click();
          URL.revokeObjectURL(url);
        })
      );
      row.append(
        button('wcset__btn wcset__btn--danger', '×', () => {
          deleteCustomTheme(theme.id);
          applyTheme();
          rebuildSection();
        })
      );
      customSection.append(row);
    }
    section.append(customSection);
  }

  // Actions: Create + Import
  const actions = div('');
  actions.style.cssText = 'display:flex;gap:8px;';
  actions.append(
    button('wcset__btn wcset__btn--primary', '+ Create Custom Theme', () => {
      showBuilder(null);
    })
  );
  actions.append(
    button('wcset__btn', 'Import Theme…', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.addEventListener('change', () => {
        const file = input.files?.[0];
        if (!file) return;
        file.text().then((text) => {
          try {
            const theme = importTheme(text);
            saveCustomTheme(theme);
            deps.setStatus(`Imported "${theme.name}".`);
            rebuildSection();
          } catch (err) {
            deps.setStatus(
              `Import failed: ${err instanceof Error ? err.message : String(err)}`,
              true
            );
          }
        });
      });
      input.click();
    })
  );
  section.append(actions);

  // Builder slot
  const builderSlot = div('');
  section.append(builderSlot);

  function rebuildSection(): void {
    const parent = section.parentElement;
    if (!parent) return;
    const newSection = buildAppearanceSection(deps);
    parent.replaceChild(newSection, section);
  }

  function showBuilder(existing: SliccTheme | null): void {
    builderSlot.replaceChildren(buildThemeBuilder(existing, deps, rebuildSection));
  }

  return section;
}

function buildAdvancedGrid(
  slots: SimplifiedSlots,
  base: 'dark' | 'light',
  manualOverrides: Record<string, string>,
  livePreview: () => void
): HTMLElement[] {
  const elements: HTMLElement[] = [];
  const derived = deriveTokens(slots, base);
  for (const [group, tokens] of Object.entries(TOKEN_GROUPS)) {
    elements.push(div('wcset__section-label', group));
    const grid = div('wcset__advanced-grid');
    for (const token of tokens) {
      const item = div('wcset__advanced-token');
      const input = document.createElement('input');
      input.type = 'color';
      const val = manualOverrides[token] || derived[token] || '#000000';
      input.value = val.startsWith('#') ? val : '#000000';
      input.addEventListener('input', () => {
        manualOverrides[token] = input.value;
        livePreview();
      });
      const tokenLabel = document.createElement('span');
      tokenLabel.textContent = token.replace('--s2-', '').replace('--slicc-', '');
      item.append(input, tokenLabel);
      grid.append(item);
    }
    elements.push(grid);
  }
  return elements;
}

function buildSlotPickers(slots: SimplifiedSlots, onInput: () => void): HTMLElement[] {
  const entries: [keyof SimplifiedSlots, string][] = [
    ['background', 'Background'],
    ['surface', 'Surface'],
    ['text', 'Text'],
    ['accent', 'Accent'],
    ['border', 'Border'],
    ['success', 'Success'],
    ['error', 'Error'],
  ];
  return entries.map(([key, label]) => {
    const row = div('wcset__builder-row');
    const lbl = document.createElement('label');
    lbl.textContent = label;
    const input = document.createElement('input');
    input.type = 'color';
    input.value = slots[key];
    input.addEventListener('input', () => {
      slots[key] = input.value;
      onInput();
    });
    row.append(lbl, input);
    return row;
  });
}

function buildThemeBuilder(
  existing: SliccTheme | null,
  deps: ViewDeps,
  onDone: () => void
): HTMLElement {
  const builder = div('wcset__builder');
  let base: 'dark' | 'light' = existing?.base ?? 'dark';
  let disableShader = existing?.disableShader ?? false;
  let showAdvanced = false;
  const slots: SimplifiedSlots = {
    background: existing?.tokens['--s2-gray-25'] || (base === 'dark' ? '#1a1a1a' : '#ffffff'),
    surface: existing?.tokens['--s2-gray-300'] || (base === 'dark' ? '#4a4a4a' : '#dadada'),
    text:
      existing?.tokens['--s2-content-default'] ||
      existing?.tokens['--s2-gray-900'] ||
      (base === 'dark' ? '#e8e8e8' : '#131313'),
    accent: existing?.tokens['--s2-accent'] || '#3562ff',
    border: existing?.tokens['--s2-border-default'] || (base === 'dark' ? '#4a4a4a' : '#dadada'),
    success: existing?.tokens['--s2-positive'] || '#2d9d78',
    error: existing?.tokens['--s2-negative'] || '#e34850',
  };
  const manualOverrides: Record<string, string> = {};

  const nameInput = document.createElement('input');
  nameInput.className = 'wcset__input';
  nameInput.placeholder = 'Theme name';
  nameInput.value = existing?.name ?? '';

  function generateId(): string {
    return (
      nameInput.value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || `custom-${Date.now()}`
    );
  }

  function livePreview(): void {
    const derived = deriveTokens(slots, base);
    const merged = { ...derived, ...manualOverrides };
    const tempTheme: SliccTheme = {
      id: '__preview',
      name: 'Preview',
      base,
      tokens: merged,
      disableShader,
    };
    saveCustomTheme(tempTheme);
    setActiveTheme('__preview');
    applyTheme();
  }

  function renderBuilder(): void {
    builder.replaceChildren();

    // Name row
    const nameRow = div('wcset__builder-row');
    const nameLabel = document.createElement('label');
    nameLabel.textContent = 'Name';
    nameRow.append(nameLabel, nameInput);
    builder.append(nameRow);

    // Base toggle
    const baseRow = div('wcset__builder-row');
    const baseLabel = document.createElement('label');
    baseLabel.textContent = 'Base';
    const baseToggle = div('wcset__base-toggle');
    const darkBtn = document.createElement('button');
    darkBtn.textContent = 'Dark';
    darkBtn.className = base === 'dark' ? 'active' : '';
    darkBtn.addEventListener('click', () => {
      base = 'dark';
      renderBuilder();
      livePreview();
    });
    const lightBtn = document.createElement('button');
    lightBtn.textContent = 'Light';
    lightBtn.className = base === 'light' ? 'active' : '';
    lightBtn.addEventListener('click', () => {
      base = 'light';
      renderBuilder();
      livePreview();
    });
    baseToggle.append(darkBtn, lightBtn);
    baseRow.append(baseLabel, baseToggle);
    builder.append(baseRow);

    // Simplified slot pickers
    for (const el of buildSlotPickers(slots, livePreview)) builder.append(el);

    // Disable shader checkbox
    const shaderRow = div('wcset__builder-row');
    const shaderLabel = document.createElement('label');
    shaderLabel.textContent = 'Background';
    const shaderCheck = document.createElement('input');
    shaderCheck.type = 'checkbox';
    shaderCheck.checked = disableShader;
    shaderCheck.style.cssText = 'width:auto;margin:0;';
    shaderCheck.addEventListener('change', () => {
      disableShader = shaderCheck.checked;
      livePreview();
    });
    const shaderSpan = document.createElement('span');
    shaderSpan.textContent = 'Hide animated background';
    shaderSpan.style.cssText = 'font-size:11px;color:var(--txt-2);';
    shaderRow.append(shaderLabel, shaderCheck, shaderSpan);
    builder.append(shaderRow);

    // Advanced toggle
    const advBtn = document.createElement('button');
    advBtn.className = 'wcset__advanced-toggle';
    advBtn.textContent = showAdvanced ? 'Hide advanced' : 'Show advanced';
    advBtn.addEventListener('click', () => {
      showAdvanced = !showAdvanced;
      renderBuilder();
    });
    builder.append(advBtn);

    // Advanced grid
    if (showAdvanced) {
      for (const el of buildAdvancedGrid(slots, base, manualOverrides, livePreview)) {
        builder.append(el);
      }
    }

    // Save / Cancel
    const actions = div('');
    actions.style.cssText = 'display:flex;gap:8px;margin-top:8px;';
    actions.append(
      button('wcset__btn wcset__btn--primary', 'Save', () => {
        const name = nameInput.value.trim();
        if (!name) {
          deps.setStatus('Name is required.', true);
          return;
        }
        const derived = deriveTokens(slots, base);
        const tokens = { ...derived, ...manualOverrides };
        const id = existing?.id ?? generateId();
        const theme: SliccTheme = { id, name, base, tokens, disableShader };
        deleteCustomTheme('__preview');
        saveCustomTheme(theme);
        setActiveTheme(id);
        applyTheme();
        deps.setStatus(`Saved "${name}".`);
        onDone();
      })
    );
    actions.append(
      button('wcset__btn', 'Cancel', () => {
        deleteCustomTheme('__preview');
        if (existing) setActiveTheme(existing.id);
        else clearActiveTheme();
        applyTheme();
        onDone();
      })
    );
    builder.append(actions);
  }

  renderBuilder();
  livePreview();
  return builder;
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
    dialog.setAttribute('heading', 'Settings');

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

    const addSectionSlot = div('');
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
        } else {
          for (const account of accounts) {
            list.append(accountRow(account, ps.getProviderConfig(account.providerId), deps));
          }
        }
        addSectionSlot.replaceChildren(buildAddSection(deps));
      },
    };
    deps.renderList();

    const appearance = buildAppearanceSection(deps);
    body.append(appearance, list, addSectionSlot, status);
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

/**
 * Open a standalone theme settings dialog (separate from account settings).
 */
export async function showThemeSettings(log: SettingsLogger): Promise<void> {
  ensureSettingsStyle(document);

  return new Promise((resolve) => {
    const dialog = document.createElement('slicc-dialog');
    dialog.classList.add('wcset-dialog');
    dialog.setAttribute('heading', 'Theme');

    const body = div('wcset');
    const status = div('wcset__status');
    const setStatus = (text: string, isError = false): void => {
      status.textContent = text;
      status.toggleAttribute('data-error', isError);
    };

    const deps: ViewDeps = {
      ps: null as unknown as ProviderSettingsModule,
      log,
      setStatus,
      renderList: () => {},
    };

    const appearance = buildAppearanceSection(deps);
    body.append(appearance, status);
    dialog.append(body);

    const done = button('wcset__btn wcset__btn--primary', 'Done', () => {
      (dialog as HTMLElement & { hide?: () => void }).hide?.();
    });
    done.setAttribute('slot', 'footer');
    dialog.append(done);

    dialog.addEventListener('slicc-dialog-close', () => {
      dialog.remove();
      resolve();
    });

    document.body.append(dialog);
    (dialog as HTMLElement & { show?: () => void }).show?.();
  });
}
