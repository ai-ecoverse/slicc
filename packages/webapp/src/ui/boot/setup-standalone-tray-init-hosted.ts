/**
 * `setup-standalone-tray-init-hosted.ts` — the post-leader-start hosted
 * bootstrap IIFE extracted from `mainStandaloneWorker` (~main.ts:1078).
 * Sleeps 5 s after page boot to avoid racing the first follower's WebRTC
 * setup (writing to localStorage triggers the kernel-worker's shim re-init
 * which would break in-flight peer setup), then fetches
 * `/api/hosted-bootstrap`, pre-warms the provider model lists, and
 * applies the bundled cone config (model + accounts).
 *
 * The pre-warm step is load-bearing: applying an account writes to
 * localStorage which triggers the worker re-init that resolves the
 * cone's model, so the provider's model list must be warm first (else
 * an id pi-ai doesn't know resolves against a cold default).
 */

import { removeAccount, saveOAuthAccount } from '../provider-settings.js';
import type { BootStageLogger } from './types.js';

export interface RunHostedBootstrapDeps {
  log: BootStageLogger;
}

export async function runHostedBootstrap(deps: RunHostedBootstrapDeps): Promise<void> {
  const { log } = deps;
  await new Promise((r) => setTimeout(r, 5000));
  try {
    const res = await fetch('/api/hosted-bootstrap', {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return;
    const boot = (await res.json()) as {
      model?: string;
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
      localStorage.setItem('selected-model', 'adobe:claude-opus-4-6');
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
    log.info('hosted-leader: cone config applied', { count: accounts.length });
  } catch (err) {
    log.warn('hosted-leader: bootstrap fetch failed; provider needs manual login', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
