/**
 * OAuth Bootstrap — Re-pushes OAuth tokens to the proxy/SW replica on init.
 *
 * When the webapp starts (or on next page load after a node-server restart),
 * iterate getAccounts() and call saveOAuthAccount(...) for every non-expired
 * Account. This re-pushes OAuth tokens to the proxy/SW replica, idempotently.
 * Tolerates per-entry failure (log and continue).
 */

import { createLogger } from '../core/logger.js';
import { getRegisteredProviderConfig } from '../providers/index.js';
import { getAccounts, saveOAuthAccount } from './provider-settings.js';

const log = createLogger('oauth-bootstrap');

// Renew if the token is already expired or expires within this window.
// 60s aligns with getValidAccessToken's freshness threshold.
const RENEW_BUFFER_MS = 60_000;

export async function bootstrapOAuthReplicas(): Promise<void> {
  // MCP providers are lazy-registered by the first `mcp` subcommand
  // (see `shell/mcp/provider.ts:ensureMcpProviderRegistered`), so on
  // a fresh page load `mcp:<name>` configs aren't in the registry
  // yet. Without explicit registration here, an expired MCP token
  // skips silent renewal below — `getRegisteredProviderConfig` returns
  // undefined — and the user has to redo `mcp add` even though a
  // refresh token is on disk. Best-effort: a corrupt
  // `/workspace/.mcp/servers.json` or missing-FS path shouldn't block
  // bootstrap for non-MCP providers.
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
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const accounts = getAccounts();
  log.info('Bootstrap OAuth replicas', { count: accounts.length });

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
            log.info('Silently renewed OAuth token', { providerId: a.providerId });
            continue;
          }
          log.warn('Silent renewal yielded no token; user must re-authenticate', {
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
