import type { Account } from '@slicc/cloud-core/cone-config';
import { createLogger } from '../base/logger.js';
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

  currentProviderIds: () => string[];

  previouslyManaged: () => string[];
}

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
  getRefreshModels: (providerId: string) => ProviderConfig['refreshModels'];
}

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
        log.warn('prewarm: refreshModels failed; cone boots with cold model metadata', {
          providerId: a.providerId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })
  );
}
