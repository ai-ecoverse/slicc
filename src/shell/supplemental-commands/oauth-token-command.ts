import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';

function helpText(): string {
  return `oauth-token — get an OAuth access token for a provider

Usage:
  oauth-token <providerId>        Get token for a specific provider
  oauth-token --provider <id>     Same, using flag form
  oauth-token                     Get token for the currently selected provider
  oauth-token --list              List OAuth providers with status
  oauth-token --help              Show this help message

If no valid token exists or the token is expired, the OAuth login flow
is triggered automatically. The raw access token is printed to stdout
on success.

Examples:
  oauth-token adobe
  curl -H "Authorization: Bearer $(oauth-token adobe)" https://api.corp.com/data
`;
}

export function createOAuthTokenCommand(): Command {
  return defineCommand('oauth-token', async (args) => {
    // Lazy imports — same pattern as other supplemental commands that
    // import from browser modules.
    const { getOAuthAccountInfo, getSelectedProvider, getAccounts } = await import('../../ui/provider-settings.js');
    const { getRegisteredProviderConfig, getRegisteredProviderIds } = await import('../../providers/index.js');

    if (args.includes('--help') || args.includes('-h')) {
      return { stdout: helpText(), stderr: '', exitCode: 0 };
    }

    if (args.includes('--list')) {
      return listProviders(getAccounts, getRegisteredProviderIds, getRegisteredProviderConfig, getOAuthAccountInfo);
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
      providerId = getSelectedProvider();
    }

    // Look up provider config
    const config = getRegisteredProviderConfig(providerId);
    if (!config) {
      return { stdout: '', stderr: `oauth-token: unknown provider "${providerId}"\n`, exitCode: 1 };
    }
    if (!config.isOAuth || !config.onOAuthLogin) {
      return { stdout: '', stderr: `oauth-token: provider "${providerId}" is not an OAuth provider\n`, exitCode: 1 };
    }

    // Check for existing valid token
    const info = getOAuthAccountInfo(providerId);
    if (info && !info.expired) {
      return { stdout: `${info.token}\n`, stderr: '', exitCode: 0 };
    }

    // No valid token — trigger the login flow
    try {
      const { createOAuthLauncher } = await import('../../providers/oauth-service.js');
      const launcher = createOAuthLauncher();
      await config.onOAuthLogin(launcher, () => { /* onSuccess callback */ });

      // Read the newly saved token
      const newInfo = getOAuthAccountInfo(providerId);
      if (newInfo && newInfo.token) {
        return { stdout: `${newInfo.token}\n`, stderr: '', exitCode: 0 };
      }

      console.error(`[oauth-token] Provider ${providerId}: login completed but no token was saved`);
      return { stdout: '', stderr: 'oauth-token: login completed but no token was saved\n', exitCode: 1 };
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
  getOAuthAccountInfo: (id: string) => { token: string; expiresAt?: number; userName?: string; expired: boolean } | null,
): { stdout: string; stderr: string; exitCode: number } {
  const allIds = getRegisteredProviderIds();
  const oauthIds = allIds.filter(id => {
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
