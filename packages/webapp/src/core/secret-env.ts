import { createLogger } from '../base/logger.js';
import { isValidShellEnvName } from '../base/shell-env-name.js';
import { apiHeaders, resolveApiUrl } from '../shell/proxied-fetch.js';
import { resolveSecretTopology } from './secret-topology.js';
import { callSecretsBridge } from './secrets-bridge-client.js';

export { isValidShellEnvName } from '../base/shell-env-name.js';

const log = createLogger('secret-env');

const MASKED_SECRETS_TIMEOUT_MS = 10_000;

export interface MaskedSecretEntry {
  name: string;
  maskedValue: string;
  domains: string[];
}

export interface MaskedEnvEntryLike {
  name: string;
  maskedValue: string;
}

export function buildEnvFromMaskedEntries(
  entries: readonly MaskedEnvEntryLike[]
): Record<string, string> {
  const env: Record<string, string> = {};
  let githubOAuthMasked: string | undefined;
  for (const entry of entries) {
    if (!entry?.name || !entry?.maskedValue) continue;
    if (entry.name === 'oauth.github.token') {
      githubOAuthMasked = entry.maskedValue;
    }
    if (isValidShellEnvName(entry.name)) {
      env[entry.name] = entry.maskedValue;
    }
  }
  if (githubOAuthMasked) {
    if (env.GITHUB_TOKEN === undefined) env.GITHUB_TOKEN = githubOAuthMasked;
    if (env.GH_TOKEN === undefined) env.GH_TOKEN = githubOAuthMasked;
  }
  return env;
}

export async function fetchSecretEnvVars(): Promise<Record<string, string>> {
  const topology = resolveSecretTopology();

  if (topology === 'extension-direct') {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'secrets.list-masked-entries' }, (response: unknown) => {
        const resp = response as { entries?: MaskedSecretEntry[] };
        const env = buildEnvFromMaskedEntries(resp?.entries ?? []);

        if (Object.keys(env).length > 0) {
          log.info('Loaded masked secrets into shell env from SW', {
            count: Object.keys(env).length,
          });
        }

        resolve(env);
      });
    });
  }

  if (topology === 'extension-delegate') {
    try {
      const resp = await callSecretsBridge<{ entries?: MaskedSecretEntry[] } | undefined>(
        'secrets.list-masked-entries'
      );
      const env = buildEnvFromMaskedEntries(resp?.entries ?? []);
      if (Object.keys(env).length > 0) {
        log.info('Loaded masked secrets into shell env from bridge', {
          count: Object.keys(env).length,
        });
      }
      return env;
    } catch (err) {
      log.debug('Bridge list-masked-entries failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return {};
    }
  }

  if (topology === 'connect') {
    return {};
  }

  try {
    const resp = await fetch(resolveApiUrl('/api/secrets/masked'), {
      headers: apiHeaders(),
      signal: AbortSignal.timeout(MASKED_SECRETS_TIMEOUT_MS),
    });
    if (!resp.ok) {
      log.warn('Failed to fetch masked secrets', { status: resp.status });
      return {};
    }

    const entries: MaskedSecretEntry[] = await resp.json();
    if (!Array.isArray(entries) || entries.length === 0) {
      return {};
    }

    const env = buildEnvFromMaskedEntries(entries);

    if (Object.keys(env).length > 0) {
      log.info('Loaded masked secrets into shell env', { count: Object.keys(env).length });
    }

    return env;
  } catch (err) {
    log.debug('Could not fetch masked secrets (server may be unavailable)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}
