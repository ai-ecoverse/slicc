/**
 * OAuth Bootstrap — Re-pushes OAuth tokens to the proxy/SW replica on init.
 *
 * When the webapp starts (or on next page load after a node-server restart),
 * iterate getAccounts() and call saveOAuthAccount(...) for every non-expired
 * Account. This re-pushes OAuth tokens to the proxy/SW replica, idempotently.
 * Tolerates per-entry failure (log and continue).
 */

import { getAccounts, saveOAuthAccount } from './provider-settings.js';
import { getRegisteredProviderConfig } from '../providers/index.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('oauth-bootstrap');

// Renew if the token is already expired or expires within this window.
// 60s aligns with getValidAccessToken's freshness threshold.
const RENEW_BUFFER_MS = 60_000;

export async function bootstrapOAuthReplicas(): Promise<void> {
  const accounts = getAccounts();
  log.debug('Bootstrap OAuth replicas', { count: accounts.length });

  for (const a of accounts) {
    // Skip accounts without tokens
    if (!a.accessToken) {
      log.debug('Skipping account without token', { providerId: a.providerId });
      continue;
    }

    const expiresIn = (a.tokenExpiresAt ?? Infinity) - Date.now();
    const needsRenewal = expiresIn <= RENEW_BUFFER_MS;

    if (needsRenewal) {
      const cfg = getRegisteredProviderConfig(a.providerId);
      if (cfg?.onSilentRenew) {
        try {
          const renewed = await cfg.onSilentRenew();
          if (renewed) {
            // onSilentRenew already calls saveOAuthAccount internally — no
            // need to re-push the replica here.
            log.debug('Silently renewed OAuth token', { providerId: a.providerId });
            continue;
          }
          log.debug('Silent renewal yielded no token; user must re-authenticate', {
            providerId: a.providerId,
          });
          continue;
        } catch (err) {
          log.warn('Silent renewal failed', {
            providerId: a.providerId,
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
      }
      log.debug('Skipping expired account (no silent-renew hook)', {
        providerId: a.providerId,
      });
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
