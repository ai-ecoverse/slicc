import { createLogger } from '../core/logger.js';
import type { Account } from '../providers/account-store.js';
import { getRegisteredProviderConfig } from '../providers/index.js';
import { getAccounts, saveOAuthAccount } from './provider-settings.js';

const log = createLogger('oauth-bootstrap');

const RENEW_BUFFER_MS = 60_000;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function ensureMcpProvidersForBootstrap(): Promise<void> {
  try {
    const { ensureAllMcpProvidersRegistered } = await import('../shell/mcp/provider.js');
    const registered = await ensureAllMcpProvidersRegistered();
    if (registered.length > 0) {
      log.debug('Pre-registered MCP providers for OAuth bootstrap', {
        count: registered.length,
      });
    }
  } catch (err) {
    log.warn('Failed to pre-register MCP providers for OAuth bootstrap', {
      error: errorMessage(err),
    });
  }
}

function accountNeedsRenewal(account: Account): boolean {
  const expiresIn = (account.tokenExpiresAt ?? Infinity) - Date.now();
  return expiresIn <= RENEW_BUFFER_MS;
}

async function trySilentRenewal(account: Account): Promise<void> {
  const cfg = getRegisteredProviderConfig(account.providerId);
  if (!cfg?.onSilentRenew) {
    log.debug('Skipping expired account (no silent-renew hook)', {
      providerId: account.providerId,
    });
    return;
  }

  try {
    const renewed = await cfg.onSilentRenew();
    if (renewed) {
      log.info('Silently renewed OAuth token', { providerId: account.providerId });
      return;
    }
    log.warn('Silent renewal yielded no token; user must re-authenticate', {
      providerId: account.providerId,
    });
  } catch (err) {
    log.warn('Silent renewal failed', {
      providerId: account.providerId,
      error: errorMessage(err),
    });
  }
}

async function bootstrapAccountReplica(account: Account, accessToken: string): Promise<void> {
  try {
    await saveOAuthAccount({
      providerId: account.providerId,
      accessToken,
      refreshToken: account.refreshToken,
      tokenExpiresAt: account.tokenExpiresAt,
      userName: account.userName,
      userAvatar: account.userAvatar,
    });
    log.debug('Bootstrapped OAuth replica', { providerId: account.providerId });
  } catch (err) {
    log.error('OAuth bootstrap failed', {
      providerId: account.providerId,
      error: errorMessage(err),
    });
  }
}

async function bootstrapAccount(account: Account): Promise<void> {
  const accessToken = account.accessToken;
  if (!accessToken) {
    log.debug('Skipping account without token', { providerId: account.providerId });
    return;
  }

  if (accountNeedsRenewal(account)) {
    await trySilentRenewal(account);
    return;
  }

  await bootstrapAccountReplica(account, accessToken);
}

export async function bootstrapOAuthReplicas(): Promise<void> {
  await ensureMcpProvidersForBootstrap();

  const accounts = getAccounts();
  log.info('Bootstrap OAuth replicas', { count: accounts.length });

  for (const account of accounts) {
    await bootstrapAccount(account);
  }
}
