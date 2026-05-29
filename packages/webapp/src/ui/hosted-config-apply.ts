import type { Account } from '@slicc/cloud-core/cone-config';

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
