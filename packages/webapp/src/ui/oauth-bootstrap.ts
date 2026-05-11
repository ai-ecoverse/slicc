/**
 * OAuth Bootstrap — Re-pushes OAuth tokens to the proxy/SW replica on init.
 *
 * When the webapp starts (or on next page load after a node-server restart),
 * iterate getAccounts() and call saveOAuthAccount(...) for every non-expired
 * Account. This re-pushes OAuth tokens to the proxy/SW replica, idempotently.
 * Tolerates per-entry failure (log and continue).
 */

import { getAccounts, saveOAuthAccount } from './provider-settings.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('oauth-bootstrap');

export async function bootstrapOAuthReplicas(): Promise<void> {
  const accounts = getAccounts();
  log.debug('Bootstrap OAuth replicas', { count: accounts.length });

  for (const a of accounts) {
    // Skip expired accounts
    if (a.tokenExpiresAt && Date.now() >= a.tokenExpiresAt) {
      log.debug('Skipping expired account', { providerId: a.providerId });
      continue;
    }

    // Skip accounts without tokens
    if (!a.accessToken) {
      log.debug('Skipping account without token', { providerId: a.providerId });
      continue;
    }

    try {
      await saveOAuthAccount({
        providerId: a.providerId,
        accessToken: a.accessToken,
        refreshToken: a.refreshToken,
        tokenExpiresAt: a.tokenExpiresAt,
        userName: a.userName,
        userAvatar: a.userAvatar,
      });
      log.debug('Bootstrapped OAuth replica', { providerId: a.providerId });
    } catch (err) {
      log.error('OAuth bootstrap failed', {
        providerId: a.providerId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
