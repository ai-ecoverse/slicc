import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';

function helpText(): string {
  return `oauth-token — get an OAuth access token for a provider

Usage:
  oauth-token <providerId>        Get token for a specific provider
  oauth-token --provider <id>     Same, using flag form
  oauth-token                     Get token for the currently selected provider
  oauth-token --list              List OAuth providers with status
  oauth-token --scope <scopes>    Request specific OAuth scopes (comma-separated)
  oauth-token --help              Show this help message

If no valid token exists or the token is expired, the OAuth login flow
is triggered automatically. The raw access token is printed to stdout
on success.

The --scope flag overrides the provider's default scopes for this login.
This forces a new login even if a valid token exists, since the existing
token may not have the requested scopes.

Examples:
  oauth-token adobe
  oauth-token github --scope "repo,models:read"
  curl -H "Authorization: Bearer $(oauth-token github)" https://api.github.com/user
`;
}

export function createOAuthTokenCommand(): Command {
  return defineCommand('oauth-token', async (args) => {
    // Lazy imports — same pattern as other supplemental commands that
    // import from browser modules.
    const { getOAuthAccountInfo, getSelectedProvider, getAccounts } =
      await import('../../ui/provider-settings.js');
    const { getRegisteredProviderConfig, getRegisteredProviderIds } =
      await import('../../providers/index.js');

    if (args.includes('--help') || args.includes('-h')) {
      return { stdout: helpText(), stderr: '', exitCode: 0 };
    }

    if (args.includes('--list')) {
      return listProviders(
        getAccounts,
        getRegisteredProviderIds,
        getRegisteredProviderConfig,
        getOAuthAccountInfo
      );
    }

    // Parse --scope flag
    let scopeOverride: string | undefined;
    const scopeFlagIdx = args.indexOf('--scope');
    if (scopeFlagIdx >= 0) {
      scopeOverride = args[scopeFlagIdx + 1]?.trim();
      if (!scopeOverride || scopeOverride.startsWith('-')) {
        return { stdout: '', stderr: 'oauth-token: --scope requires a value\n', exitCode: 1 };
      }
      // Remove --scope and its value so they don't interfere with provider ID parsing
      args.splice(scopeFlagIdx, 2);
    }

    // Determine provider ID
    let providerId: string | undefined;
    const providerFlagIdx = args.indexOf('--provider');
    if (providerFlagIdx >= 0) {
      providerId = args[providerFlagIdx + 1];
      if (!providerId) {
        return { stdout: '', stderr: 'oauth-token: --provider requires a value\n', exitCode: 1 };
      }
    } else if (args.length > 0) {
      providerId = args[0];
    } else {
      // No args: try selected provider, fall back to first OAuth provider
      const selected = getSelectedProvider();
      const selectedConfig = getRegisteredProviderConfig(selected);
      if (selectedConfig?.isOAuth && selectedConfig.onOAuthLogin) {
        providerId = selected;
      } else {
        // Find the first available OAuth provider
        const allIds = getRegisteredProviderIds();
        providerId = allIds.find((id) => {
          const cfg = getRegisteredProviderConfig(id);
          return cfg?.isOAuth && cfg.onOAuthLogin;
        });
        if (!providerId) {
          return {
            stdout: '',
            stderr: 'oauth-token: no OAuth providers configured\n',
            exitCode: 1,
          };
        }
      }
    }

    // Look up provider config
    const config = getRegisteredProviderConfig(providerId);
    if (!config) {
      return { stdout: '', stderr: `oauth-token: unknown provider "${providerId}"\n`, exitCode: 1 };
    }
    if (!config.isOAuth || !config.onOAuthLogin) {
      return {
        stdout: '',
        stderr: `oauth-token: provider "${providerId}" is not an OAuth provider\n`,
        exitCode: 1,
      };
    }

    // Check for existing valid token (skip if --scope is set, since the
    // existing token may not have the requested scopes)
    if (!scopeOverride) {
      const info = getOAuthAccountInfo(providerId);
      if (info && !info.expired) {
        const masked = info.maskedValue;
        if (!masked) {
          return {
            stdout: '',
            stderr: `oauth-token: no masked value for ${providerId} (try logging in again)\n`,
            exitCode: 1,
          };
        }
        return { stdout: `${masked}\n`, stderr: '', exitCode: 0 };
      }
    }

    // No valid token (or --scope override) — trigger the login flow
    try {
      const { createOAuthLauncher } = await import('../../providers/oauth-service.js');
      const launcher = createOAuthLauncher();
      await config.onOAuthLogin(
        launcher,
        () => {
          /* onSuccess callback */
        },
        scopeOverride ? { scopes: scopeOverride } : undefined
      );

      // Read the newly saved token
      const newInfo = getOAuthAccountInfo(providerId);
      if (newInfo && newInfo.token) {
        const masked = newInfo.maskedValue;
        if (!masked) {
          return {
            stdout: '',
            stderr: `oauth-token: no masked value for ${providerId} (try logging in again)\n`,
            exitCode: 1,
          };
        }
        return { stdout: `${masked}\n`, stderr: '', exitCode: 0 };
      }

      console.error(`[oauth-token] Provider ${providerId}: login completed but no token was saved`);
      return {
        stdout: '',
        stderr: 'oauth-token: login completed but no token was saved\n',
        exitCode: 1,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[oauth-token] Provider ${providerId}: login failed:`, msg);
      return { stdout: '', stderr: `oauth-token: login failed: ${msg}\n`, exitCode: 1 };
    }
  });
}

function listProviders(
  _getAccounts: () => { providerId: string }[],
  getRegisteredProviderIds: () => string[],
  getRegisteredProviderConfig: (id: string) => { isOAuth?: boolean; name: string } | undefined,
  getOAuthAccountInfo: (
    id: string
  ) => { token: string; expiresAt?: number; userName?: string; expired: boolean } | null
): { stdout: string; stderr: string; exitCode: number } {
  const allIds = getRegisteredProviderIds();
  const oauthIds = allIds.filter((id) => {
    return getRegisteredProviderConfig(id)?.isOAuth;
  });

  if (oauthIds.length === 0) {
    return { stdout: 'No OAuth providers configured.\n', stderr: '', exitCode: 0 };
  }

  const lines: string[] = [];
  for (const id of oauthIds) {
    const info = getOAuthAccountInfo(id);
    if (!info) {
      lines.push(`${id} (no token)`);
    } else if (info.expired) {
      const userStr = info.userName ? ` as ${info.userName}` : '';
      lines.push(`${id} (expired${userStr})`);
    } else {
      const parts: string[] = [];
      if (info.userName) parts.push(`logged in as ${info.userName}`);
      else parts.push('logged in');
      if (info.expiresAt) {
        const remaining = info.expiresAt - Date.now();
        if (remaining > 0) {
          const hours = Math.floor(remaining / 3600000);
          const minutes = Math.floor((remaining % 3600000) / 60000);
          if (hours > 0) parts.push(`expires in ${hours}h`);
          else parts.push(`expires in ${minutes}m`);
        }
      }
      lines.push(`${id} (${parts.join(', ')})`);
    }
  }

  return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 };
}
