import type { Command, CommandContext } from 'just-bash';
import { defineCommand } from 'just-bash';

function helpText(): string {
  return `oauth-token — get an OAuth access token for a provider, or run an
ad-hoc OAuth interception against an arbitrary authorize URL.

Usage:
  oauth-token [<providerId>|--from-file <path>|--intercept …] [flags]

Provider mode:
  oauth-token <providerId>        Get token for a specific provider
  oauth-token --provider <id>     Same, using flag form
  oauth-token                     Get token for the currently selected provider
  oauth-token --list              List OAuth providers with status
  oauth-token --scope <scopes>    Request specific OAuth scopes (comma-separated)
  oauth-token --renew [<id>]      Force a silent token renewal now (onSilentRenew),
                                  bypassing the expiry gate. Reports success and
                                  the new expiry.

Declarative intercept mode (no provider needed):
  oauth-token --from-file <path>  Run an intercepted OAuth flow defined by a
                                  JSON file in the VFS. The file's shape is
                                  InterceptOAuthConfig: { authorizeUrl,
                                  redirectUriPattern, rewrite?, onCapture?,
                                  timeoutMs? }. The captured redirect URL is
                                  printed to stdout.
  oauth-token --intercept         Build an intercept config from flags.
    --authorize-url <url>           (required) URL the controlled tab opens.
    --redirect-pattern <pat>        (required) URL pattern to capture, e.g.
                                    http://127.0.0.1:56121/*
    --rewrite <match=key=val>       Append a query param to any request whose
                                    URL contains <match>. Repeatable.
    --leave-tab                     Don't close the OAuth tab on capture.

Common:
  --help                          Show this help message

If no valid token exists or the token is expired (provider mode), the
OAuth login flow is triggered automatically. The raw access token is
printed to stdout on success.

The --scope flag overrides the provider's default scopes for this login.
This forces a new login even if a valid token exists, since the existing
token may not have the requested scopes.

Examples:
  oauth-token adobe
  oauth-token github --scope "repo,models:read"
  oauth-token --from-file /workspace/.slicc/oauth/xai.json
  oauth-token --intercept \\
    --authorize-url 'https://auth.x.ai/oauth2/auth?...' \\
    --redirect-pattern 'http://127.0.0.1:56121/*'
  curl -H "Authorization: Bearer $(oauth-token github)" https://api.github.com/user
`;
}

export function createOAuthTokenCommand(): Command {
  return defineCommand('oauth-token', async (args, ctx) => {
    // Lazy imports — same pattern as other supplemental commands that
    // import from browser modules.
    const { getOAuthAccountInfo, getSelectedProvider, getAccounts } = await import(
      '../../providers/account-store.js'
    );
    const { getRegisteredProviderConfig, getRegisteredProviderIds } = await import(
      '../../providers/index.js'
    );

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

    // Force a silent renewal now via onSilentRenew(), bypassing the expiry gate.
    if (args.includes('--renew')) {
      return runSilentRenew(args);
    }

    // ── Declarative intercept mode: --from-file / --intercept ──
    // These two paths bypass the provider registry entirely. They run a
    // one-off OAuth interception driven by a JSON config (file or flags),
    // print the captured redirect URL to stdout, and exit. No tokens are
    // persisted to the slicc account store — that's the provider's job.
    if (args.includes('--from-file') || args.includes('--intercept')) {
      return runDeclarativeIntercept(args, ctx);
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
      if (
        selectedConfig?.isOAuth &&
        (selectedConfig.onOAuthLogin || selectedConfig.onOAuthLoginIntercepted)
      ) {
        providerId = selected;
      } else {
        // Find the first available OAuth provider
        const allIds = getRegisteredProviderIds();
        providerId = allIds.find((id) => {
          const cfg = getRegisteredProviderConfig(id);
          return cfg?.isOAuth && (cfg.onOAuthLogin || cfg.onOAuthLoginIntercepted);
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
    if (!config.isOAuth || (!config.onOAuthLogin && !config.onOAuthLoginIntercepted)) {
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

    // No valid token (or --scope override) — trigger the login flow.
    // Providers expose either `onOAuthLogin` (popup / chrome.identity) or
    // `onOAuthLoginIntercepted` (controlled-browser CDP capture). Dispatch
    // based on which one they implemented; the launcher type differs but
    // the success path is identical.
    try {
      if (config.onOAuthLoginIntercepted) {
        const { createInterceptingOAuthLauncherForCurrentRuntime } = await import(
          '../../providers/oauth-service.js'
        );
        const launcher = await createInterceptingOAuthLauncherForCurrentRuntime();
        if (!launcher) {
          return {
            stdout: '',
            stderr: `oauth-token: provider "${providerId}" needs the controlled-browser interceptor, but no CDP transport is available in this runtime.\n`,
            exitCode: 1,
          };
        }
        await config.onOAuthLoginIntercepted(
          launcher,
          () => {
            /* onSuccess callback */
          },
          scopeOverride ? { scopes: scopeOverride } : undefined
        );
      } else if (config.onOAuthLogin) {
        const { createOAuthLauncher } = await import('../../providers/oauth-service.js');
        const launcher = createOAuthLauncher();
        await config.onOAuthLogin(
          launcher,
          () => {
            /* onSuccess callback */
          },
          scopeOverride ? { scopes: scopeOverride } : undefined
        );
      } else {
        return {
          stdout: '',
          stderr: `oauth-token: provider "${providerId}" has no OAuth login hook\n`,
          exitCode: 1,
        };
      }

      // Read the newly saved token
      const newInfo = getOAuthAccountInfo(providerId);
      if (newInfo?.token) {
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

/**
 * Force a silent token renewal now via the provider's `onSilentRenew()` hook,
 * bypassing the expiry gate. Reports whether a fresh token came back and the
 * new expiry — useful for verifying renewal without waiting for natural expiry.
 */
async function runSilentRenew(
  args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { getSelectedProvider, getOAuthAccountInfo } = await import(
    '../../providers/account-store.js'
  );
  const { getRegisteredProviderConfig, getRegisteredProviderIds } = await import(
    '../../providers/index.js'
  );

  // First non-flag arg is the provider id; fall back to the selected
  // provider, then the first registered provider that supports renewal.
  const positional = args.filter((a) => !a.startsWith('-'));
  let providerId: string | undefined = positional[0];
  if (!providerId) {
    const selected = getSelectedProvider();
    if (getRegisteredProviderConfig(selected)?.onSilentRenew) {
      providerId = selected;
    } else {
      providerId = getRegisteredProviderIds().find(
        (id) => getRegisteredProviderConfig(id)?.onSilentRenew
      );
    }
  }
  if (!providerId) {
    return errResult('oauth-token --renew: no provider supports silent renewal');
  }

  const config = getRegisteredProviderConfig(providerId);
  if (!config) {
    return errResult(`oauth-token --renew: unknown provider "${providerId}"`);
  }
  if (!config.onSilentRenew) {
    return errResult(`oauth-token --renew: provider "${providerId}" has no onSilentRenew hook`);
  }

  const before = getOAuthAccountInfo(providerId);
  const beforeToken = before?.token;

  const lines: string[] = [`oauth-token --renew ${providerId}`];
  lines.push(`  before: ${describeAccount(before)}`);

  let result: string | null = null;
  let threw: string | null = null;
  try {
    result = await config.onSilentRenew();
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }

  if (threw) {
    lines.push(`  silent renewal: ERROR — ${threw}`);
  } else if (result) {
    const after = getOAuthAccountInfo(providerId);
    const changed = Boolean(beforeToken && after?.token && beforeToken !== after.token);
    lines.push(`  silent renewal: SUCCESS${changed ? ' — token refreshed' : ' (token unchanged)'}`);
    lines.push(`  after:  ${describeAccount(after)}`);
  } else {
    lines.push('  silent renewal: FAILED (onSilentRenew returned null)');
    lines.push('  → no window should have appeared. Open DevTools console and');
    lines.push('    look for "[oauth-service] Extension OAuth error" / "[adobe]" to see');
    lines.push('    the IMS/Chrome reason (e.g. login_required).');
  }

  return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: result ? 0 : 1 };
}

function describeAccount(
  info: { expiresAt?: number; expired: boolean } | null | undefined
): string {
  if (!info) return 'no token';
  if (info.expired) return 'expired';
  if (info.expiresAt) {
    const rem = info.expiresAt - Date.now();
    if (rem > 0) {
      const h = Math.floor(rem / 3600000);
      const m = Math.floor((rem % 3600000) / 60000);
      return h > 0 ? `valid, expires in ${h}h ${m}m` : `valid, expires in ${m}m`;
    }
  }
  return 'valid';
}

/**
 * Run a one-off OAuth interception driven by either a JSON config file in
 * the VFS (`--from-file <path>`) or a set of flags (`--intercept …`).
 *
 * The captured redirect URL is printed to stdout. Token exchange and
 * persistence are the caller's responsibility — this command exists for
 * inspecting / testing OAuth flows without writing a provider module.
 */
async function runDeclarativeIntercept(
  args: string[],
  ctx: CommandContext
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { parseInterceptOAuthConfig } = await import('../../providers/intercepted-oauth.js');
  const { createInterceptingOAuthLauncherForCurrentRuntime } = await import(
    '../../providers/oauth-service.js'
  );

  let rawConfig: unknown;
  const fromFileIdx = args.indexOf('--from-file');
  if (fromFileIdx >= 0) {
    const path = args[fromFileIdx + 1];
    if (!path) return errResult('oauth-token: --from-file requires a path');
    try {
      // Read the intercept config from the shell's primary VFS (the same
      // filesystem every other shell command sees via `ctx.fs`). Absolute
      // paths pass through; relative paths resolve against `ctx.cwd`.
      const resolved = ctx.fs.resolvePath(ctx.cwd, path);
      const raw = await ctx.fs.readFile(resolved);
      rawConfig = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch (err) {
      return errResult(
        `oauth-token: failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else {
    // --intercept + flags
    const authorizeUrl = pickFlagValue(args, '--authorize-url');
    const redirectUriPattern = pickFlagValue(args, '--redirect-pattern');
    if (!authorizeUrl) return errResult('oauth-token: --authorize-url is required');
    if (!redirectUriPattern) return errResult('oauth-token: --redirect-pattern is required');

    const rewrite: Array<{ match: string; appendParams: Record<string, string> }> = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] !== '--rewrite') continue;
      const spec = args[i + 1];
      if (!spec) return errResult('oauth-token: --rewrite requires a value');
      // Format: <match>=<key>=<value>
      const parts = spec.split('=');
      if (parts.length < 3) {
        return errResult(`oauth-token: --rewrite "${spec}" must be "<match>=<key>=<value>"`);
      }
      const [match, key, ...rest] = parts;
      rewrite.push({ match, appendParams: { [key]: rest.join('=') } });
    }

    rawConfig = {
      authorizeUrl,
      redirectUriPattern,
      onCapture: args.includes('--leave-tab') ? 'leave' : 'close',
      ...(rewrite.length > 0 ? { rewrite } : {}),
    };
  }

  const parsed = parseInterceptOAuthConfig(rawConfig);
  if (!parsed.ok) {
    return errResult(`oauth-token: invalid intercept config: ${parsed.error}`);
  }

  const launcher = await createInterceptingOAuthLauncherForCurrentRuntime();
  if (!launcher) {
    return errResult(
      'oauth-token: no CDP transport available in this runtime; --intercept needs the controlled browser.'
    );
  }

  const captured = await launcher(parsed.config);
  if (!captured) {
    return errResult('oauth-token: intercept timed out or was cancelled');
  }
  return { stdout: `${captured}\n`, stderr: '', exitCode: 0 };
}

function pickFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  const v = args[idx + 1];
  if (!v || v.startsWith('--')) return undefined;
  return v;
}

function errResult(message: string): { stdout: string; stderr: string; exitCode: number } {
  return { stdout: '', stderr: `${message}\n`, exitCode: 1 };
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
