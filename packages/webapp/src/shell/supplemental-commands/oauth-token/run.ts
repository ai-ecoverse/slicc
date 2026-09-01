/**
 * `oauth-token` implementation. Registered through the stub in
 * `../oauth-token-command.ts` and imported on FIRST USE — `index.ts` sits in
 * the kernel worker's boot-critical graph, and a shell command nobody has
 * typed yet has no business being downloaded before the terminal opens (see
 * `packages/webapp/first-load-budget.json`).
 */

import type { CommandContext } from 'just-bash';
import { scopesSatisfied } from '../../../providers/oauth-scopes.js';
import { type ParsedKnownFlags, parseKnownFlags } from '../subcommand-flags.js';
import { isHelpRequest } from '../subcommand-help.js';

type CommandResult = { stdout: string; stderr: string; exitCode: number };
type ProviderRegistry = typeof import('../../../providers/index.js');
type ProviderSettings = typeof import('../../../providers/account-store.js');
type ProviderConfig = NonNullable<ReturnType<ProviderRegistry['getRegisteredProviderConfig']>>;
type ValueResult<T> = { ok: true; value: T } | { ok: false; result: CommandResult };
type OAuthTokenValidation = Awaited<ReturnType<NonNullable<ProviderConfig['onValidateToken']>>>;

/**
 * Exit code reserved for "automated recovery is exhausted": nothing is stored,
 * or the provider itself has confirmed it no longer accepts what is stored, so
 * someone has to run `oauth-token <id> --force-login` and approve the consent
 * window. Callers branch on it instead of parsing prose (#2695).
 *
 * Everything unsettled stays 1 — could not run, outcome unknown, or a further
 * automated step (a retry, or the next rung named in the output) is still
 * available. Claiming 3 without confirmation would send a caller to a human
 * over a transient failure, which is the mirror image of the bug this fixes.
 */
const EXIT_NEEDS_INTERACTIVE_LOGIN = 3;

/** Value-taking flags — same list passed to {@link isHelpRequest} as `valueFlags`. */
const OAUTH_TOKEN_VALUE_FLAGS = [
  '--provider',
  '--scope',
  '--from-file',
  '--authorize-url',
  '--redirect-pattern',
  '--rewrite',
] as const;

/** Standalone flags accepted in any position. */
const OAUTH_TOKEN_BOOL_FLAGS = [
  '--list',
  '--check',
  '--expire',
  '--renew',
  '--intercept',
  '--force-login',
  '--leave-tab',
] as const;

function helpText(): string {
  return `oauth-token — get an OAuth access token for a provider, or run an
ad-hoc OAuth interception against an arbitrary authorize URL.

Usage:
  oauth-token [<providerId>|--from-file <path>|--intercept …] [flags]

Provider mode:
  oauth-token <providerId>        Get token for a specific provider
  oauth-token --provider <id>     Same, using flag form
  oauth-token                     Get token for the currently selected provider
  oauth-token --list              List OAuth providers and the token held for
                                  each. Local state only — see "Held vs working".
  oauth-token --check [<id>]      Ask the provider whether it still accepts the
                                  stored token, with one cheap authenticated
                                  call. The only surface that reports whether a
                                  token WORKS.
  oauth-token --scope <scopes>    Request specific OAuth scopes (comma-separated)
  oauth-token --force-login       Always run the OAuth login flow, ignoring any
                                  cached token. Opens a consent window, so a
                                  human has to be at the keyboard.
  oauth-token --renew [<id>]      Force a silent token renewal now (onSilentRenew),
                                  bypassing the expiry gate. Reports success and the
                                  new expiry. If the upstream session has ended this
                                  cannot succeed — fall back to --force-login.

Testing:
  oauth-token <providerId> --expire
  oauth-token --expire [<id>]     Back-date the locally stored token expiry only.
                                  Does not revoke anything upstream; the next network
                                  operation will trigger silent renewal.

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

Held vs working:
  A stored token that has not reached its recorded expiry can still have been
  invalidated upstream (revoked grant, ended SSO session). Local expiry is not
  proof of validity, so --list and --renew report what is HELD, and only
  --check asks the provider whether it still WORKS.

When a token stops working, escalate in this order:
  1. oauth-token --check <id>     Does the provider still accept it?
  2. oauth-token --renew <id>     Try a silent renewal (no user interaction).
  3. oauth-token <id> --force-login
                                  Re-consent. Opens a window; needs a human, so
                                  an unattended agent should stop and ask.

Exit codes:
  0  success
  1  the outcome is not settled: the command could not run, the result is
     unknown, or an automated step is still available — retry, or take the
     next rung the output names
  3  automated recovery is exhausted — a human must complete an interactive
     login: "oauth-token <id> --force-login"

If no valid token exists or the token is expired (provider mode), the
OAuth login flow is triggered automatically. The raw access token is
printed to stdout on success.

The --scope flag overrides the provider's default scopes for this login.
The cached token is reused when the scopes it was granted already cover
the requested ones (GitHub's implied scopes are understood, so a token
granted "repo" satisfies "public_repo"). A login is triggered when they
do not, or when the granted scopes are unknown — which is the case for
tokens obtained before scopes were recorded.

Use --force-login to always log in, with or without --scope.

Examples:
  oauth-token adobe
  oauth-token --check github
  oauth-token github --scope "repo,models:read"
  oauth-token github --scope repo --force-login
  oauth-token --from-file /workspace/.slicc/oauth/xai.json
  oauth-token --intercept \\
    --authorize-url 'https://auth.x.ai/oauth2/auth?...' \\
    --redirect-pattern 'http://127.0.0.1:56121/*'
  curl -H "Authorization: Bearer $(oauth-token github)" https://api.github.com/user
`;
}

export async function runOAuthToken(args: string[], ctx: CommandContext): Promise<CommandResult> {
  const settings = await import('../../../providers/account-store.js');
  const registry = await import('../../../providers/index.js');
  if (isHelpRequest(args, { valueFlags: OAUTH_TOKEN_VALUE_FLAGS })) {
    return { stdout: helpText(), stderr: '', exitCode: 0 };
  }

  const parsed = parseKnownFlags(args, {
    value: OAUTH_TOKEN_VALUE_FLAGS,
    bool: OAUTH_TOKEN_BOOL_FLAGS,
  });
  if ('error' in parsed) {
    return errResult(`oauth-token: ${parsed.error}`);
  }

  if (parsed.bools.has('--list')) {
    return listProviders(
      settings.getAccounts,
      registry.getRegisteredProviderIds,
      registry.getRegisteredProviderConfig,
      settings.getOAuthAccountInfo
    );
  }
  if (parsed.bools.has('--check')) return runUpstreamCheck(parsed.positionals);
  if (parsed.bools.has('--expire')) return runExpire(parsed.positionals);
  if (parsed.bools.has('--renew')) return runSilentRenew(parsed.positionals);
  if (parsed.values.has('--from-file') || parsed.bools.has('--intercept')) {
    return runDeclarativeIntercept(parsed, args, ctx);
  }

  const scope = readScopeOverride(parsed);
  if (!scope.ok) return scope.result;
  const forceLogin = parsed.bools.has('--force-login');
  const provider = resolveProviderId(parsed, settings, registry);
  if (!provider.ok) return provider.result;
  const config = resolveOAuthProviderConfig(provider.value, registry.getRegisteredProviderConfig);
  if (!config.ok) return config.result;

  if (!forceLogin) {
    const cached = await readCachedProviderToken(
      provider.value,
      config.value,
      settings.getOAuthAccountInfo,
      scope.value
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

function readScopeOverride(parsed: ParsedKnownFlags): ValueResult<string | undefined> {
  if (!parsed.values.has('--scope')) return { ok: true, value: undefined };
  const scope = parsed.values.get('--scope')?.trim();
  // A dash-leading token was consumed as the value; treat it as missing so
  // `oauth-token --scope --force-login` still errors instead of requesting
  // the literal scope "--force-login".
  if (!scope || scope.startsWith('-')) {
    return { ok: false, result: errResult('oauth-token: --scope requires a value') };
  }
  return { ok: true, value: scope };
}

function resolveProviderId(
  parsed: ParsedKnownFlags,
  settings: ProviderSettings,
  registry: ProviderRegistry
): ValueResult<string> {
  if (parsed.values.has('--provider')) {
    const providerId = parsed.values.get('--provider');
    if (providerId) return { ok: true, value: providerId };
    return { ok: false, result: errResult('oauth-token: --provider requires a value') };
  }
  if (parsed.positionals.length > 0) return { ok: true, value: parsed.positionals[0] };

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
  getInfo: ProviderSettings['getOAuthAccountInfo'],
  requestedScope: string | undefined
): Promise<CommandResult | null> {
  const info = getInfo(providerId);
  if (info && !info.expired) return cachedTokenResult(providerId, info, requestedScope);
  if (!info?.expired || !config.onSilentRenew) return null;
  const renewed = await trySilentRenew(config.onSilentRenew);
  if (!renewed) return null;
  // Re-read so the freshest recorded scopes drive the coverage check.
  return cachedTokenResult(providerId, getInfo(providerId), requestedScope);
}

/**
 * A cached token only answers a `--scope` request when the scopes it was
 * granted cover it; otherwise the caller falls through to interactive login.
 */
function cachedTokenResult(
  providerId: string,
  info: { maskedValue?: string; scopes?: string } | null | undefined,
  requestedScope: string | undefined
): CommandResult | null {
  if (requestedScope && !scopesSatisfied(info?.scopes, requestedScope)) return null;
  return maskedTokenResult(providerId, info?.maskedValue);
}

function maskedTokenResult(providerId: string, masked: string | undefined): CommandResult {
  if (!masked) {
    // Never say this on stdout: the caller expects a token there, and a
    // sentence is long enough to pass a naive "looks like a token" check.
    return errResult(
      `oauth-token: no usable token for ${providerId}; run: oauth-token ${providerId} --force-login`
    );
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
    const launch = await launchProviderLogin(providerId, config, scopeOverride);
    if (launch.error) return launch.error;
    return readSavedProviderToken(providerId, getInfo, launch.succeeded);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // A delegated login (#1915) that found no human reports why. Say so
    // plainly rather than burying it under a generic "login failed".
    if (err instanceof Error && err.name === 'OAuthLaunchError') {
      console.error(`[oauth-token] Provider ${providerId}: login could not be shown:`, msg);
      return errResult(`oauth-token: ${msg}`);
    }
    console.error(`[oauth-token] Provider ${providerId}: login failed:`, msg);
    return errResult(`oauth-token: login failed: ${msg}`);
  }
}

async function launchProviderLogin(
  providerId: string,
  config: ProviderConfig,
  scopeOverride: string | undefined
): Promise<{ error: CommandResult | null; succeeded: boolean }> {
  const options = scopeOverride ? { scopes: scopeOverride } : undefined;
  // Every provider login hook invokes its onSuccess callback only after the
  // token is exchanged and persisted. That explicit signal — not the mere
  // presence of a stored token afterwards — is what distinguishes a completed
  // login from a cancelled/timed-out popup with a stale token left behind.
  let succeeded = false;
  const onSuccess = (): void => {
    succeeded = true;
  };
  if (config.onOAuthLoginIntercepted) {
    const { createInterceptingOAuthLauncherForCurrentRuntime } = await import(
      '../../../providers/oauth-service.js'
    );
    const launcher = await createInterceptingOAuthLauncherForCurrentRuntime();
    if (!launcher) {
      return {
        error: errResult(
          `oauth-token: provider "${providerId}" needs the controlled-browser interceptor, but no CDP transport is available in this runtime.`
        ),
        succeeded: false,
      };
    }
    await config.onOAuthLoginIntercepted(launcher, onSuccess, options);
    return { error: null, succeeded };
  }
  if (config.onOAuthLogin) {
    const { createOAuthLauncher } = await import('../../../providers/oauth-service.js');
    await config.onOAuthLogin(createOAuthLauncher(), onSuccess, options);
    return { error: null, succeeded };
  }
  return {
    error: errResult(`oauth-token: provider "${providerId}" has no OAuth login hook`),
    succeeded: false,
  };
}

function readSavedProviderToken(
  providerId: string,
  getInfo: ProviderSettings['getOAuthAccountInfo'],
  launchSucceeded: boolean
): CommandResult {
  if (!launchSucceeded) {
    // The interactive attempt never completed (popup cancelled, timed out, or
    // nobody could approve it). An earlier token may still be stored —
    // possibly the expired one that forced this attempt — and returning it
    // with exit 0 would report success for a login that never happened.
    console.error(`[oauth-token] Provider ${providerId}: interactive login was not completed`);
    return errResult(
      'oauth-token: interactive login was not completed (cancelled, timed out, or no one could approve it)'
    );
  }
  const info = getInfo(providerId);
  if (info?.token && !info.expired) return maskedTokenResult(providerId, info.maskedValue);
  if (info?.token) {
    return errResult('oauth-token: login completed but the saved token is already expired');
  }
  console.error(`[oauth-token] Provider ${providerId}: login completed but no token was saved`);
  return errResult('oauth-token: login completed but no token was saved');
}

async function trySilentRenew(onSilentRenew: () => Promise<string | null>): Promise<boolean> {
  try {
    return (await onSilentRenew()) !== null;
  } catch {
    // Silent renewal is best-effort; fall back to interactive login.
    return false;
  }
}

function resolveProviderIdWithHook(
  positionals: readonly string[],
  hook: 'onSilentRenew' | 'onValidateToken',
  getSelectedProvider: ProviderSettings['getSelectedProvider'],
  getRegisteredProviderConfig: ProviderRegistry['getRegisteredProviderConfig'],
  getRegisteredProviderIds: ProviderRegistry['getRegisteredProviderIds']
): string | undefined {
  const explicit = positionals[0];
  if (explicit) return explicit;

  const selected = getSelectedProvider();
  if (getRegisteredProviderConfig(selected)?.[hook]) return selected;
  return getRegisteredProviderIds().find((id) => getRegisteredProviderConfig(id)?.[hook]);
}

/**
 * Ask the provider whether it still accepts the stored token, via its
 * `onValidateToken` hook (one cheap authenticated call). This is the only
 * surface that answers "does the token WORK" — `--list` and `--renew` can
 * only report what is stored locally, and a token inside its recorded expiry
 * is routinely rejected upstream after a revoked grant or ended session.
 */
async function runUpstreamCheck(positionals: readonly string[]): Promise<CommandResult> {
  const { getSelectedProvider, getOAuthAccountInfo } = await import(
    '../../../providers/account-store.js'
  );
  const { getRegisteredProviderConfig, getRegisteredProviderIds } = await import(
    '../../../providers/index.js'
  );

  const providerId = resolveProviderIdWithHook(
    positionals,
    'onValidateToken',
    getSelectedProvider,
    getRegisteredProviderConfig,
    getRegisteredProviderIds
  );
  if (!providerId) {
    return errResult('oauth-token --check: no provider supports an upstream token check');
  }
  const config = getRegisteredProviderConfig(providerId);
  if (!config) {
    return errResult(`oauth-token --check: unknown provider "${providerId}"`);
  }
  if (!config.onValidateToken) {
    return errResult(
      `oauth-token --check: provider "${providerId}" cannot be checked upstream ` +
        '(no onValidateToken hook); only locally stored state is known.'
    );
  }

  const stored = getOAuthAccountInfo(providerId);
  const lines = [
    `oauth-token --check ${providerId}`,
    `  stored token: ${describeStoredToken(stored)}`,
  ];
  if (!stored) {
    lines.push('  upstream check: skipped — nothing to check', ...forceLoginRemedy(providerId));
    return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: EXIT_NEEDS_INTERACTIVE_LOGIN };
  }

  const validation = await validateQuietly(config);
  if (validation?.status === 'accepted') {
    const who = validation.userName ? ` (as ${validation.userName})` : '';
    lines.push(`  upstream check: ACCEPTED${who} — the provider honoured the token`);
    return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 };
  }
  if (validation?.status === 'rejected') {
    lines.push(...describeRejection(providerId, Boolean(config.onSilentRenew), validation.detail));
    // A stored refresh token may still replace a refused access token, so this
    // only demands a human once silent renewal is off the table.
    const exitCode = config.onSilentRenew ? 1 : EXIT_NEEDS_INTERACTIVE_LOGIN;
    return { stdout: lines.join('\n') + '\n', stderr: '', exitCode };
  }
  lines.push(
    `  upstream check: UNKNOWN — the check itself could not run${detailSuffix(validation?.detail)}`,
    '    This says nothing about the token. Retry when the provider is reachable.'
  );
  return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 1 };
}

function describeRejection(
  providerId: string,
  canRenew: boolean,
  detail: string | undefined
): string[] {
  const head = `  upstream check: REJECTED — the provider refused the token${detailSuffix(detail)}`;
  if (!canRenew) {
    return [
      head,
      '    This provider has no silent renewal, so nothing automated is left.',
      ...forceLoginRemedy(providerId),
    ];
  }
  return [
    head,
    '    A stored refresh token may still be able to replace it — silent renewal',
    '    has not been tried yet.',
    '',
    `  → Next: oauth-token ${providerId} --renew`,
    `    If that is declined too: oauth-token ${providerId} --force-login (needs a human).`,
  ];
}

function detailSuffix(detail: string | undefined): string {
  return detail ? ` (${detail})` : '';
}

/** Debug aid: back-date only the locally stored expiry so the next network op renews. */
async function runExpire(positionals: readonly string[]): Promise<CommandResult> {
  const { getAccounts, getSelectedProvider, saveOAuthAccount } = await import(
    '../../../providers/account-store.js'
  );
  const { getRegisteredProviderConfig, getRegisteredProviderIds } = await import(
    '../../../providers/index.js'
  );
  const providerId = resolveProviderIdWithHook(
    positionals,
    'onSilentRenew',
    getSelectedProvider,
    getRegisteredProviderConfig,
    getRegisteredProviderIds
  );
  if (!providerId) {
    return errResult('oauth-token --expire: no provider supports silent renewal');
  }
  const config = getRegisteredProviderConfig(providerId);
  if (!config) {
    return errResult(`oauth-token --expire: unknown provider "${providerId}"`);
  }
  if (!config.onSilentRenew) {
    return errResult(`oauth-token --expire: provider "${providerId}" has no onSilentRenew hook`);
  }

  const existing = getAccounts().find((account) => account.providerId === providerId);
  if (!existing?.accessToken) {
    return errResult(`oauth-token --expire: no stored OAuth account for "${providerId}"`);
  }
  try {
    await saveOAuthAccount({
      ...existing,
      accessToken: existing.accessToken,
      tokenExpiresAt: Date.now() - 1000,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errResult(`oauth-token --expire: failed to update "${providerId}": ${message}`);
  }
  return {
    stdout: `oauth-token ${providerId}: stored token marked expired; next network op will trigger silent renewal.\n`,
    stderr: '',
    exitCode: 0,
  };
}

/**
 * Force a silent token renewal now via the provider's `onSilentRenew()` hook,
 * bypassing the expiry gate. Reports whether a fresh token came back and the
 * new expiry — useful for verifying renewal without waiting for natural expiry.
 */
async function runSilentRenew(
  positionals: readonly string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { getSelectedProvider, getOAuthAccountInfo } = await import(
    '../../../providers/account-store.js'
  );
  const { getRegisteredProviderConfig, getRegisteredProviderIds } = await import(
    '../../../providers/index.js'
  );

  const providerId = resolveProviderIdWithHook(
    positionals,
    'onSilentRenew',
    getSelectedProvider,
    getRegisteredProviderConfig,
    getRegisteredProviderIds
  );
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
  lines.push(`  stored token: ${describeStoredToken(before)}`);

  let result: string | null = null;
  let threw: string | null = null;
  try {
    result = await config.onSilentRenew();
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }

  if (result) {
    const after = getOAuthAccountInfo(providerId);
    const changed = Boolean(beforeToken && after?.token && beforeToken !== after.token);
    lines.push(`  silent renewal: SUCCESS${changed ? ' — token refreshed' : ' (token unchanged)'}`);
    lines.push(`  renewed token: ${describeStoredToken(after)}`);
    return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 };
  }

  if (threw) {
    // The renewal call itself failed, which is routinely transient (offline,
    // 5xx, a bridge that has not started). Retrying is the right first move.
    lines.push(`  silent renewal: ERROR — ${threw}`, ...retryThenLoginAdvice(providerId));
    return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 1 };
  }

  // `onSilentRenew` returning null does NOT by itself prove the session ended:
  // provider hooks catch transport failures and return null too. Ask the
  // provider whether the stored token still works before telling anyone that
  // only a human can fix this.
  const outcome = describeDecline(providerId, await validateQuietly(config));
  lines.push(...outcome.lines);
  return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: outcome.exitCode };
}

/**
 * Report a renewal the provider answered with no token, using the upstream
 * check (when the provider offers one) to decide whether this is the lapsed
 * session it usually is, or something transient wearing the same mask.
 */
function describeDecline(
  providerId: string,
  confirmation: OAuthTokenValidation | null
): { lines: string[]; exitCode: number } {
  const head = [
    '  silent renewal: DECLINED — the provider returned no token without user',
    '    interaction (typically login_required: the upstream session has ended).',
  ];
  if (confirmation?.status === 'rejected') {
    return {
      lines: [
        ...head,
        `  upstream check: REJECTED — the provider no longer accepts the stored`,
        `    token${detailSuffix(confirmation.detail)}. Local expiry was never proof of validity.`,
        ...forceLoginRemedy(providerId),
      ],
      exitCode: EXIT_NEEDS_INTERACTIVE_LOGIN,
    };
  }
  if (confirmation?.status === 'accepted') {
    const who = confirmation.userName ? ` (as ${confirmation.userName})` : '';
    return {
      lines: [
        ...head,
        `  upstream check: ACCEPTED${who} — the stored token still works, so callers`,
        '    are not blocked; only the renewal itself did not happen. No login needed.',
      ],
      exitCode: 1,
    };
  }
  const unconfirmed = [
    '    Unconfirmed: provider renewal hooks also return no token when the renewal',
    '    call itself fails, so this alone does not prove the session ended.',
  ];
  if (confirmation?.detail) unconfirmed.push(`    (upstream check: ${confirmation.detail})`);
  return {
    lines: [...head, ...unconfirmed, ...likelyForceLoginRemedy(providerId)],
    exitCode: 1,
  };
}

/** Run the upstream check without letting a check failure mask the real report. */
async function validateQuietly(config: ProviderConfig): Promise<OAuthTokenValidation | null> {
  if (!config.onValidateToken) return null;
  return config.onValidateToken().catch((err: unknown) => ({
    status: 'unknown' as const,
    detail: err instanceof Error ? err.message : String(err),
  }));
}

/**
 * The one command that fixes a lapsed session, for the cases where the provider
 * has CONFIRMED the credential is dead. Named explicitly because the primary
 * caller is an agent that cannot read the browser console, so a
 * diagnostics-only hint reads as "the OAuth service is broken" (#2695).
 */
function forceLoginRemedy(providerId: string): string[] {
  return [
    '',
    `  → Fix: oauth-token ${providerId} --force-login`,
    '    Opens a consent window, so a human has to be at the keyboard: an',
    '    unattended agent should stop and ask the user to re-authorise rather',
    '    than retrying or probing further.',
    '    (Diagnostics, if a human is present: browser DevTools console,',
    '     "[oauth-service] Extension OAuth error".)',
  ];
}

/** Same remedy, without claiming a retry is pointless — nothing confirmed it. */
function likelyForceLoginRemedy(providerId: string): string[] {
  return [
    '',
    `  → Likely fix: oauth-token ${providerId} --force-login`,
    '    Opens a consent window, so a human has to be at the keyboard. If the',
    '    failure was transient instead, a later retry succeeds on its own.',
    '    (Diagnostics: browser DevTools console, "[oauth-service] Extension',
    '     OAuth error".)',
  ];
}

/** A call that failed outright: retry first, escalate only if it persists. */
function retryThenLoginAdvice(providerId: string): string[] {
  return [
    '',
    '  → The renewal call failed rather than being declined; this is often',
    '    transient (offline, 5xx, bridge not up). Retry it.',
    `    If it keeps failing: oauth-token ${providerId} --force-login (needs a human).`,
  ];
}

/**
 * Describe the LOCALLY stored token. Deliberately never says "valid" — this
 * surface only knows that a token is held and what expiry was recorded with
 * it, never whether the provider still accepts it (#2695).
 */
function describeStoredToken(
  info: { expiresAt?: number; expired: boolean } | null | undefined
): string {
  if (!info) return 'none stored';
  // `expired` is the renewal buffer (60s before `expiresAt`), not proof the
  // timestamp has passed — so the timestamp still drives the wording.
  if (info.expired) return `present, ${describeLocalExpiry(info.expiresAt)} — renewal needed`;
  return `present, ${describeLocalExpiry(info.expiresAt)}, not validated upstream`;
}

function describeLocalExpiry(expiresAt: number | undefined): string {
  if (!expiresAt) return 'no local expiry recorded';
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) return 'past its local expiry';
  if (remaining < 60000) return 'local expiry in under a minute';
  const hours = Math.floor(remaining / 3600000);
  const minutes = Math.floor((remaining % 3600000) / 60000);
  return `local expiry in ${hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`}`;
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
  parsed: ParsedKnownFlags,
  rawArgs: readonly string[],
  ctx: CommandContext
): Promise<CommandResult> {
  const { parseInterceptOAuthConfig } = await import('../../../providers/intercepted-oauth.js');
  const { createInterceptingOAuthLauncherForCurrentRuntime } = await import(
    '../../../providers/oauth-service.js'
  );

  const rawConfig = await resolveRawInterceptConfig(parsed, rawArgs, ctx);
  if (!rawConfig.ok) return rawConfig.result;
  const configParsed = parseInterceptOAuthConfig(rawConfig.value);
  if (!configParsed.ok) {
    return errResult(`oauth-token: invalid intercept config: ${configParsed.error}`);
  }

  const launcher = await createInterceptingOAuthLauncherForCurrentRuntime();
  if (!launcher) {
    return errResult(
      'oauth-token: no CDP transport available in this runtime; --intercept needs the controlled browser.'
    );
  }

  const captured = await launcher(configParsed.config);
  if (!captured) {
    return errResult('oauth-token: intercept timed out or was cancelled');
  }
  return { stdout: `${captured}\n`, stderr: '', exitCode: 0 };
}

function resolveRawInterceptConfig(
  parsed: ParsedKnownFlags,
  rawArgs: readonly string[],
  ctx: CommandContext
): Promise<ValueResult<unknown>> | ValueResult<unknown> {
  if (parsed.values.has('--from-file')) {
    return readInterceptConfigFile(parsed.values.get('--from-file'), ctx);
  }
  return buildInterceptConfigFromFlags(parsed, rawArgs);
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

function buildInterceptConfigFromFlags(
  parsed: ParsedKnownFlags,
  rawArgs: readonly string[]
): ValueResult<unknown> {
  const authorizeUrl = parsed.values.get('--authorize-url');
  const redirectUriPattern = parsed.values.get('--redirect-pattern');
  if (!authorizeUrl) {
    return { ok: false, result: errResult('oauth-token: --authorize-url is required') };
  }
  if (!redirectUriPattern) {
    return { ok: false, result: errResult('oauth-token: --redirect-pattern is required') };
  }
  const rewrites = parseInterceptRewrites(rawArgs);
  if (!rewrites.ok) return rewrites;
  return {
    ok: true,
    value: {
      authorizeUrl,
      redirectUriPattern,
      onCapture: parsed.bools.has('--leave-tab') ? 'leave' : 'close',
      ...(rewrites.value.length > 0 ? { rewrite: rewrites.value } : {}),
    },
  };
}

function parseInterceptRewrites(
  args: readonly string[]
): ValueResult<Array<{ match: string; appendParams: Record<string, string> }>> {
  const rewrites: Array<{ match: string; appendParams: Record<string, string> }> = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') break;
    if (arg !== '--rewrite' && !arg.startsWith('--rewrite=')) continue;
    const spec = arg === '--rewrite' ? args[++i] : arg.slice('--rewrite='.length);
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

function errResult(message: string): { stdout: string; stderr: string; exitCode: number } {
  return { stdout: '', stderr: `${message}\n`, exitCode: 1 };
}

function listProviders(
  _getAccounts: () => { providerId: string }[],
  getRegisteredProviderIds: () => string[],
  getRegisteredProviderConfig: (id: string) => { isOAuth?: boolean; name: string } | undefined,
  getOAuthAccountInfo: (id: string) => {
    token: string;
    expiresAt?: number;
    userName?: string;
    scopes?: string;
    expired: boolean;
  } | null
): { stdout: string; stderr: string; exitCode: number } {
  const allIds = getRegisteredProviderIds();
  const oauthIds = allIds.filter((id) => {
    return getRegisteredProviderConfig(id)?.isOAuth;
  });

  if (oauthIds.length === 0) {
    return { stdout: 'No OAuth providers configured.\n', stderr: '', exitCode: 0 };
  }

  const lines: string[] = [];
  let anyHeld = false;
  for (const id of oauthIds) {
    const info = getOAuthAccountInfo(id);
    if (!info) {
      lines.push(`${id} (no token)`);
      continue;
    }
    anyHeld = true;
    lines.push(`${id} (${describeHeldToken(info).join(', ')})`);
  }
  // The caveat belongs on the listing itself: every row above is read out of
  // local storage, so "held" must never be read as "works" (#2695).
  if (anyHeld) {
    lines.push(
      '',
      'Local state only — a held token can already be rejected upstream.',
      'Verify with "oauth-token --check <id>"; re-consent with "oauth-token <id> --force-login".'
    );
  }

  return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 };
}

/** Row body for one provider that has a stored token. */
function describeHeldToken(info: {
  expiresAt?: number;
  userName?: string;
  scopes?: string;
  expired: boolean;
}): string[] {
  const parts = [info.userName ? `token held for ${info.userName}` : 'token held'];
  parts.push(describeLocalExpiry(info.expiresAt));
  // `expired` fires 60s early so renewal has room; say what it means rather
  // than overwriting the expiry itself.
  if (info.expired) parts.push('renewal needed');
  if (info.scopes) parts.push(`scopes: ${info.scopes}`);
  return parts;
}
