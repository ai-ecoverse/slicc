import type { Command, CommandContext } from 'just-bash';
import { defineCommand } from 'just-bash';

type CommandResult = { stdout: string; stderr: string; exitCode: number };
type ProviderRegistry = typeof import('../../providers/index.js');
type ProviderSettings = typeof import('../../ui/provider-settings.js');
type ProviderConfig = NonNullable<ReturnType<ProviderRegistry['getRegisteredProviderConfig']>>;
type ValueResult<T> = { ok: true; value: T } | { ok: false; result: CommandResult };

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
  return defineCommand('oauth-token', executeOAuthTokenCommand);
}

async function executeOAuthTokenCommand(
  args: string[],
  ctx: CommandContext
): Promise<CommandResult> {
  const settings = await import('../../ui/provider-settings.js');
  const registry = await import('../../providers/index.js');
  if (args.includes('--help') || args.includes('-h')) {
    return { stdout: helpText(), stderr: '', exitCode: 0 };
  }
  if (args.includes('--list')) {
    return listProviders(
      settings.getAccounts,
      registry.getRegisteredProviderIds,
      registry.getRegisteredProviderConfig,
      settings.getOAuthAccountInfo
    );
  }
  if (args.includes('--renew')) return runSilentRenew(args);
  if (args.includes('--from-file') || args.includes('--intercept')) {
    return runDeclarativeIntercept(args, ctx);
  }

  const scope = parseScopeOverride(args);
  if (!scope.ok) return scope.result;
  const provider = resolveProviderId(args, settings, registry);
  if (!provider.ok) return provider.result;
  const config = resolveOAuthProviderConfig(provider.value, registry.getRegisteredProviderConfig);
  if (!config.ok) return config.result;

  if (!scope.value) {
    const cached = await readCachedProviderToken(
      provider.value,
      config.value,
      settings.getOAuthAccountInfo
    );
    if (cached) return cached;
  }
  return runInteractiveProviderLogin(
    provider.value,
    config.value,
    scope.value,
    settings.getOAuthAccountInfo
  );
}

function parseScopeOverride(args: string[]): ValueResult<string | undefined> {
  const index = args.indexOf('--scope');
  if (index < 0) return { ok: true, value: undefined };
  const scope = args[index + 1]?.trim();
  if (!scope || scope.startsWith('-')) {
    return { ok: false, result: errResult('oauth-token: --scope requires a value') };
  }
  args.splice(index, 2);
  return { ok: true, value: scope };
}

function resolveProviderId(
  args: string[],
  settings: ProviderSettings,
  registry: ProviderRegistry
): ValueResult<string> {
  const providerFlagIdx = args.indexOf('--provider');
  if (providerFlagIdx >= 0) {
    const providerId = args[providerFlagIdx + 1];
    if (providerId) return { ok: true, value: providerId };
    return { ok: false, result: errResult('oauth-token: --provider requires a value') };
  }
  if (args.length > 0) return { ok: true, value: args[0] };

  const selected = settings.getSelectedProvider();
  if (isOAuthLoginProvider(registry.getRegisteredProviderConfig(selected))) {
    return { ok: true, value: selected };
  }
  const providerId = registry
    .getRegisteredProviderIds()
    .find((id) => isOAuthLoginProvider(registry.getRegisteredProviderConfig(id)));
  if (providerId) return { ok: true, value: providerId };
  return { ok: false, result: errResult('oauth-token: no OAuth providers configured') };
}

function isOAuthLoginProvider(config: ProviderConfig | undefined): boolean {
  return Boolean(config?.isOAuth && (config.onOAuthLogin || config.onOAuthLoginIntercepted));
}

function resolveOAuthProviderConfig(
  providerId: string,
  getConfig: ProviderRegistry['getRegisteredProviderConfig']
): ValueResult<ProviderConfig> {
  const config = getConfig(providerId);
  if (!config) {
    return { ok: false, result: errResult(`oauth-token: unknown provider "${providerId}"`) };
  }
  if (!isOAuthLoginProvider(config)) {
    return {
      ok: false,
      result: errResult(`oauth-token: provider "${providerId}" is not an OAuth provider`),
    };
  }
  return { ok: true, value: config };
}

async function readCachedProviderToken(
  providerId: string,
  config: ProviderConfig,
  getInfo: ProviderSettings['getOAuthAccountInfo']
): Promise<CommandResult | null> {
  const info = getInfo(providerId);
  if (info && !info.expired) return maskedTokenResult(providerId, info.maskedValue);
  if (!info?.expired || !config.onSilentRenew) return null;
  return tryExpiredTokenSilentRenew(providerId, config.onSilentRenew, getInfo);
}

function maskedTokenResult(providerId: string, masked: string | undefined): CommandResult {
  if (!masked) {
    return errResult(`oauth-token: no masked value for ${providerId} (try logging in again)`);
  }
  return { stdout: `${masked}\n`, stderr: '', exitCode: 0 };
}

async function runInteractiveProviderLogin(
  providerId: string,
  config: ProviderConfig,
  scopeOverride: string | undefined,
  getInfo: ProviderSettings['getOAuthAccountInfo']
): Promise<CommandResult> {
  try {
    const launchError = await launchProviderLogin(providerId, config, scopeOverride);
    if (launchError) return launchError;
    return readSavedProviderToken(providerId, getInfo);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[oauth-token] Provider ${providerId}: login failed:`, msg);
    return errResult(`oauth-token: login failed: ${msg}`);
  }
}

async function launchProviderLogin(
  providerId: string,
  config: ProviderConfig,
  scopeOverride: string | undefined
): Promise<CommandResult | null> {
  const options = scopeOverride ? { scopes: scopeOverride } : undefined;
  if (config.onOAuthLoginIntercepted) {
    const { createInterceptingOAuthLauncherForCurrentRuntime } = await import(
      '../../providers/oauth-service.js'
    );
    const launcher = await createInterceptingOAuthLauncherForCurrentRuntime();
    if (!launcher) {
      return errResult(
        `oauth-token: provider "${providerId}" needs the controlled-browser interceptor, but no CDP transport is available in this runtime.`
      );
    }
    await config.onOAuthLoginIntercepted(launcher, () => {}, options);
    return null;
  }
  if (config.onOAuthLogin) {
    const { createOAuthLauncher } = await import('../../providers/oauth-service.js');
    await config.onOAuthLogin(createOAuthLauncher(), () => {}, options);
    return null;
  }
  return errResult(`oauth-token: provider "${providerId}" has no OAuth login hook`);
}

function readSavedProviderToken(
  providerId: string,
  getInfo: ProviderSettings['getOAuthAccountInfo']
): CommandResult {
  const info = getInfo(providerId);
  if (info?.token) return maskedTokenResult(providerId, info.maskedValue);
  console.error(`[oauth-token] Provider ${providerId}: login completed but no token was saved`);
  return errResult('oauth-token: login completed but no token was saved');
}

async function tryExpiredTokenSilentRenew(
  providerId: string,
  onSilentRenew: () => Promise<string | null>,
  getOAuthAccountInfo: ProviderSettings['getOAuthAccountInfo']
): Promise<CommandResult | null> {
  try {
    const renewedToken = await onSilentRenew();
    if (renewedToken === null) return null;

    return maskedTokenResult(providerId, getOAuthAccountInfo(providerId)?.maskedValue);
  } catch {
    // Silent renewal is best-effort; fall back to interactive login.
    return null;
  }
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
    '../../ui/provider-settings.js'
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
): Promise<CommandResult> {
  const { parseInterceptOAuthConfig } = await import('../../providers/intercepted-oauth.js');
  const { createInterceptingOAuthLauncherForCurrentRuntime } = await import(
    '../../providers/oauth-service.js'
  );

  const rawConfig = await resolveRawInterceptConfig(args, ctx);
  if (!rawConfig.ok) return rawConfig.result;
  const parsed = parseInterceptOAuthConfig(rawConfig.value);
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

function resolveRawInterceptConfig(
  args: string[],
  ctx: CommandContext
): Promise<ValueResult<unknown>> | ValueResult<unknown> {
  const fromFileIdx = args.indexOf('--from-file');
  if (fromFileIdx >= 0) return readInterceptConfigFile(args[fromFileIdx + 1], ctx);
  return buildInterceptConfigFromFlags(args);
}

async function readInterceptConfigFile(
  path: string | undefined,
  ctx: CommandContext
): Promise<ValueResult<unknown>> {
  if (!path) {
    return { ok: false, result: errResult('oauth-token: --from-file requires a path') };
  }
  try {
    const resolved = ctx.fs.resolvePath(ctx.cwd, path);
    const raw = await ctx.fs.readFile(resolved);
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, result: errResult(`oauth-token: failed to read ${path}: ${message}`) };
  }
}

function buildInterceptConfigFromFlags(args: string[]): ValueResult<unknown> {
  const authorizeUrl = pickFlagValue(args, '--authorize-url');
  const redirectUriPattern = pickFlagValue(args, '--redirect-pattern');
  if (!authorizeUrl) {
    return { ok: false, result: errResult('oauth-token: --authorize-url is required') };
  }
  if (!redirectUriPattern) {
    return { ok: false, result: errResult('oauth-token: --redirect-pattern is required') };
  }
  const rewrites = parseInterceptRewrites(args);
  if (!rewrites.ok) return rewrites;
  return {
    ok: true,
    value: {
      authorizeUrl,
      redirectUriPattern,
      onCapture: args.includes('--leave-tab') ? 'leave' : 'close',
      ...(rewrites.value.length > 0 ? { rewrite: rewrites.value } : {}),
    },
  };
}

function parseInterceptRewrites(
  args: string[]
): ValueResult<Array<{ match: string; appendParams: Record<string, string> }>> {
  const rewrites: Array<{ match: string; appendParams: Record<string, string> }> = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--rewrite') continue;
    const spec = args[i + 1];
    if (!spec) {
      return { ok: false, result: errResult('oauth-token: --rewrite requires a value') };
    }
    const parts = spec.split('=');
    if (parts.length < 3) {
      return {
        ok: false,
        result: errResult(`oauth-token: --rewrite "${spec}" must be "<match>=<key>=<value>"`),
      };
    }
    const [match, key, ...rest] = parts;
    rewrites.push({ match, appendParams: { [key]: rest.join('=') } });
  }
  return { ok: true, value: rewrites };
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
