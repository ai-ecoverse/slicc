import type { Account } from '@slicc/cloud-core/cone-config';
import { createLogger } from '../core/logger.js';
import type { ProviderConfig } from '../providers/types.js';

const log = createLogger('hosted-config');

export interface ApplyAccountsDeps {
  saveOAuthAccount: (o: {
    providerId: string;
    accessToken: string;
    refreshToken?: string;
    tokenExpiresAt?: number;
    userName?: string;
    baseUrl?: string;
  }) => Promise<void>;
  addAccount: (
    providerId: string,
    apiKey: string,
    baseUrl?: string,
    deployment?: string,
    apiVersion?: string
  ) => void;
  removeAccount: (providerId: string) => Promise<void>;
  /** providerIds currently in slicc_accounts. */
  currentProviderIds: () => string[];
  /** providerIds this cone previously cloud-managed (from the prior bundle). */
  previouslyManaged: () => string[];
}

/** Reconcile localStorage accounts to the bundle; only remove cloud-managed ones. */
export async function applyHostedAccounts(
  accounts: Account[],
  deps: ApplyAccountsDeps
): Promise<void> {
  const desired = new Set(accounts.map((a) => a.providerId));
  for (const a of accounts) {
    if (a.kind === 'oauth') {
      await deps.saveOAuthAccount({
        providerId: a.providerId,
        accessToken: a.accessToken,
        refreshToken: a.refreshToken,
        tokenExpiresAt: a.tokenExpiresAt,
        userName: a.userName,
        baseUrl: a.baseUrl,
      });
    } else {
      deps.addAccount(a.providerId, a.apiKey, a.baseUrl, a.deployment, a.apiVersion);
    }
  }
  const managed = new Set(deps.previouslyManaged());
  for (const id of deps.currentProviderIds()) {
    if (managed.has(id) && !desired.has(id)) {
      await deps.removeAccount(id);
    }
  }
}

export interface PrewarmModelsDeps {
  /** Resolve a provider's optional `refreshModels` hook, or undefined if it has none. */
  getRefreshModels: (providerId: string) => ProviderConfig['refreshModels'];
}

/**
 * Pre-warm provider model lists for injected OAuth accounts.
 *
 * Must run BEFORE `applyHostedAccounts`: applying an account writes
 * localStorage, which triggers the kernel-worker's re-init and model
 * resolution. If the provider's model list hasn't been fetched by then, the
 * cone resolves against a cold default — for a model id pi-ai's registry
 * doesn't know (e.g. `claude-opus-4-8`) that previously degraded to a native
 * Anthropic model and 401'd. The provider-routed fallback in
 * `resolveCurrentModel`/`resolveModelById` (`buildProviderRoutedModel`) now
 * keeps the request on the proxy regardless, but the model metadata (e.g.
 * Adobe's 1M context window) would be a 200K default until the list warms.
 * Pre-warming here, with the token in hand, makes the cone's first init see
 * the real model + metadata.
 *
 * Best-effort: a failed refresh must never block account application, and each
 * refresh is bounded by `timeoutMs` so a hung `/v1/models` fetch can't stall
 * cold start (a slow fetch keeps running in the background, harmlessly).
 */
export async function prewarmHostedModels(
  accounts: Account[],
  deps: PrewarmModelsDeps,
  timeoutMs = 5000
): Promise<void> {
  await Promise.all(
    accounts.map(async (a) => {
      if (a.kind !== 'oauth' || !a.accessToken) return;
      const refresh = deps.getRefreshModels(a.providerId);
      if (!refresh) return;
      try {
        await Promise.race([
          refresh(a.accessToken),
          new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
        ]);
      } catch (err) {
        // Best-effort: the cone still boots and the provider-routed fallback
        // keeps requests on the proxy — only the warmed metadata is missed
        // (a 200K instead of 1M context window). Log it so a silently-degraded
        // boot is traceable rather than a mystery.
        log.warn('prewarm: refreshModels failed; cone boots with cold model metadata', {
          providerId: a.providerId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })
  );
}
