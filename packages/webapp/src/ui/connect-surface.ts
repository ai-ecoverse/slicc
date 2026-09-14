import {
  getAccounts,
  getAllAvailableModels,
  getProviderConfig,
  removeAccount,
  showProviderSettings,
} from './provider-settings.js';

const MODEL_CATALOG_KEY = 'slicc_cloud_model_catalog';

const ADOBE_PROVIDER_ID = 'adobe';

function isConnectViableProvider(providerId: string): boolean {
  if (providerId === ADOBE_PROVIDER_ID) return false;
  const config = getProviderConfig(providerId);
  if (config.hidden) return false;
  if (config.onOAuthLoginIntercepted) return false;
  return true;
}

function persistModelCatalog(): void {
  try {
    const groups = getAllAvailableModels().map((g) => ({
      providerId: g.providerId,
      providerName: g.providerName,
      models: g.models.map((m) => ({ id: m.id, name: m.name })),
    }));
    localStorage.setItem(MODEL_CATALOG_KEY, JSON.stringify(groups));
  } catch {}
}

export async function mountConnectSurface(root: HTMLElement): Promise<void> {
  while (root.firstChild) root.removeChild(root.firstChild);
  root.className = 'connect-surface';

  const title = document.createElement('h1');
  title.className = 'connect-surface__title';
  title.textContent = 'Connect providers';
  root.appendChild(title);

  const desc = document.createElement('p');
  desc.className = 'connect-surface__desc';
  desc.textContent =
    'Log in or add API keys for the providers your cone should use, then click Done to return to the dashboard.';
  root.appendChild(desc);

  const accountsSection = document.createElement('div');
  accountsSection.className = 'connect-surface__accounts';
  root.appendChild(accountsSection);

  function renderAccounts() {
    while (accountsSection.firstChild) accountsSection.removeChild(accountsSection.firstChild);

    const accounts = getAccounts().filter((a) => a.providerId !== ADOBE_PROVIDER_ID);
    if (accounts.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'connect-surface__empty';
      empty.textContent = 'No providers connected yet.';
      accountsSection.appendChild(empty);
    } else {
      const list = document.createElement('div');
      list.className = 'connect-surface__accounts-list';

      for (const account of accounts) {
        const config = getProviderConfig(account.providerId);
        const row = document.createElement('div');
        row.className = 'connect-surface__account-row';

        const info = document.createElement('div');
        info.className = 'connect-surface__account-info';

        const name = document.createElement('div');
        name.className = 'connect-surface__account-name';
        name.textContent = config.name;
        info.appendChild(name);

        const detail = document.createElement('div');
        detail.className = 'connect-surface__account-detail';
        if (account.userName) {
          detail.textContent = account.userName;
        } else if (account.accessToken) {
          detail.textContent = 'Logged in';
        } else {
          detail.textContent = account.apiKey ? 'API key set' : 'No credentials';
        }
        info.appendChild(detail);
        row.appendChild(info);

        const removeBtn = document.createElement('button');
        removeBtn.className = 'connect-surface__remove-btn';
        removeBtn.textContent = 'Remove';
        removeBtn.onclick = async () => {
          await removeAccount(account.providerId);
          persistModelCatalog();
          renderAccounts();
        };
        row.appendChild(removeBtn);

        list.appendChild(row);
      }
      accountsSection.appendChild(list);
    }

    const addBtn = document.createElement('button');
    addBtn.className = 'connect-surface__add-btn';
    addBtn.textContent = accounts.length === 0 ? 'Add provider' : 'Manage providers';
    addBtn.onclick = async () => {
      const changed = await showProviderSettings({
        startInAddAccount: true,
        providerFilter: isConnectViableProvider,
      });
      if (changed) {
        persistModelCatalog();
        renderAccounts();
      }
    };
    accountsSection.appendChild(addBtn);
  }

  renderAccounts();

  persistModelCatalog();

  const footer = document.createElement('div');
  footer.className = 'connect-surface__footer';
  const doneBtn = document.createElement('button');
  doneBtn.className = 'connect-surface__done-btn';
  doneBtn.textContent = 'Done — return to dashboard';
  doneBtn.onclick = () => {
    persistModelCatalog();
    window.close();
  };
  footer.appendChild(doneBtn);
  root.appendChild(footer);

  if (!document.getElementById('connect-surface-style')) {
    const style = document.createElement('style');
    style.id = 'connect-surface-style';
    style.textContent = `
    .connect-surface {
      padding: 2rem;
      max-width: 560px;
      margin: 0 auto;
      font: 14.5px/1.55 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    }
    .connect-surface__title {
      font-size: 1.4rem;
      font-weight: 600;
      margin-bottom: 0.35rem;
      color: var(--s2-content-default, #1f1d1a);
    }
    .connect-surface__desc {
      color: var(--s2-content-secondary, #6e655d);
      margin-bottom: 1.75rem;
    }
    .connect-surface__accounts {
      margin-bottom: 1.5rem;
    }
    .connect-surface__accounts-list {
      margin-bottom: 1rem;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .connect-surface__account-row {
      display: flex;
      align-items: center;
      padding: 0.75rem 1rem;
      background: var(--s2-bg-layer-2, #faf8f4);
      border-radius: var(--s2-radius-default, 10px);
      border: 1px solid var(--s2-border-subtle, #ece8df);
    }
    .connect-surface__account-info {
      flex: 1;
    }
    .connect-surface__account-name {
      font-weight: 600;
      color: var(--s2-content-default, #1f1d1a);
    }
    .connect-surface__account-detail {
      font-size: 0.85rem;
      color: var(--s2-content-secondary, #6e655d);
    }
    .connect-surface__remove-btn {
      margin-left: auto;
      padding: 0.35rem 0.75rem;
      background: transparent;
      color: var(--s2-content-secondary, #6e655d);
      border: 1px solid var(--s2-border-subtle, #ece8df);
      border-radius: 8px;
      cursor: pointer;
      font: inherit;
      font-size: 0.85rem;
    }
    .connect-surface__remove-btn:hover {
      border-color: #d96363;
      color: #d96363;
    }
    .connect-surface__add-btn {
      padding: 0.5rem 1rem;
      background: var(--s2-bg-layer-2, #fff);
      color: var(--s2-content-default, #1f1d1a);
      border: 1px solid var(--s2-border-subtle, #ece8df);
      border-radius: 8px;
      cursor: pointer;
      font: inherit;
      font-weight: 500;
    }
    .connect-surface__add-btn:hover {
      border-color: var(--s2-primary, #e8516b);
      color: var(--s2-primary, #c4344f);
    }
    .connect-surface__empty {
      color: var(--s2-content-disabled, #998f86);
      font-style: italic;
      margin-bottom: 1rem;
      padding: 0.75rem 1rem;
      border: 1px dashed var(--s2-border-subtle, #ece8df);
      border-radius: 10px;
    }
    .connect-surface__footer {
      margin-top: 2rem;
      padding-top: 1.25rem;
      border-top: 1px solid var(--s2-border-subtle, #ece8df);
    }
    .connect-surface__done-btn {
      width: 100%;
      padding: 0.7rem 1rem;
      background: var(--s2-primary, #e8516b);
      color: #fff;
      border: 1px solid var(--s2-primary, #e8516b);
      border-radius: 8px;
      cursor: pointer;
      font: inherit;
      font-weight: 600;
    }
    .connect-surface__done-btn:hover {
      background: var(--s2-primary-hover, #c4344f);
      border-color: var(--s2-primary-hover, #c4344f);
    }
  `;
    document.head.appendChild(style);
  }
}
