import { DEFAULT_CONE_MODEL } from '@slicc/cloud-core/cone-config';
import { apiHeaders, resolveApiUrl } from '../../shell/proxied-fetch.js';
import { removeAccount, saveOAuthAccount } from '../provider-settings.js';
import type { BootStageLogger } from './types.js';

export interface RunHostedBootstrapDeps {
  log: BootStageLogger;
}

export async function runHostedBootstrap(deps: RunHostedBootstrapDeps): Promise<void> {
  const { log } = deps;
  await new Promise((r) => setTimeout(r, 5000));
  try {
    const res = await fetch(resolveApiUrl('/api/hosted-bootstrap'), {
      signal: AbortSignal.timeout(10000),
      headers: apiHeaders(),
    });
    if (!res.ok) return;
    const boot = (await res.json()) as {
      model?: string;
      effortLevel?: string;
      accounts?: import('@slicc/cloud-core/cone-config').Account[];
      adobeImsToken?: string;
    };
    const accounts =
      boot.accounts ??
      (boot.adobeImsToken
        ? [{ providerId: 'adobe', kind: 'oauth' as const, accessToken: boot.adobeImsToken }]
        : []);
    if (boot.model) localStorage.setItem('selected-model', boot.model);
    else if (!localStorage.getItem('selected-model'))
      localStorage.setItem('selected-model', DEFAULT_CONE_MODEL);
    if (boot.effortLevel) localStorage.setItem('slicc_locked_effort_level', boot.effortLevel);
    else localStorage.removeItem('slicc_locked_effort_level');
    const [{ applyHostedAccounts, prewarmHostedModels }, ps] = await Promise.all([
      import('../hosted-config-apply.js'),
      import('../provider-settings.js'),
    ]);
    await prewarmHostedModels(accounts, {
      getRefreshModels: (pid) => ps.getProviderConfig(pid).refreshModels,
    });
    const prevManaged = JSON.parse(localStorage.getItem('slicc_cloud_managed') ?? '[]') as string[];
    await applyHostedAccounts(accounts, {
      saveOAuthAccount,
      addAccount: ps.addAccount,
      removeAccount,
      currentProviderIds: () => ps.getAccounts().map((a) => a.providerId),
      previouslyManaged: () => prevManaged,
    });
    localStorage.setItem('slicc_cloud_managed', JSON.stringify(accounts.map((a) => a.providerId)));

    window.dispatchEvent(new CustomEvent('slicc:accounts-changed'));
    log.info('hosted-leader: cone config applied', { count: accounts.length });
  } catch (err) {
    log.warn('hosted-leader: bootstrap fetch failed; provider needs manual login', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
