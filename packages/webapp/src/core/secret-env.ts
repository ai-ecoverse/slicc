/**
 * Secret environment population — fetches masked secret values from the server
 * and returns them as env vars for the shell.
 *
 * The server generates deterministic masked values per session using HMAC-SHA256.
 * The real values never leave the server. The shell only sees masked values,
 * which look like real tokens but aren't.
 */

import { createLogger } from './logger.js';

const log = createLogger('secret-env');

export interface MaskedSecretEntry {
  name: string;
  maskedValue: string;
  domains: string[];
}

/**
 * Fetch masked secret values from the server's /api/secrets/masked endpoint.
 * Returns a Record<name, maskedValue> suitable for passing as shell env vars.
 *
 * Fails silently (returns empty object) if the server is unavailable or
 * returns an error — secrets are optional and shouldn't block shell init.
 */
/**
 * Whether a secret name should be exposed as a shell env var.
 *
 * Only names that are valid POSIX env identifiers are exposed:
 *   [A-Za-z_][A-Za-z0-9_]*
 *
 * Dotted / hyphenated names (`s3.r2.access_key_id`, `oauth.adobe.token`,
 * `db.prod.password`) are internal subsystem secrets — they're still
 * loaded into the fetch-proxy for unmasking, but they don't leak into
 * the agent shell as `$s3` (which wouldn't even resolve in POSIX shells)
 * or into `printenv` output where they'd be visible to anything the
 * agent runs. Without this filter every dotted credential — including
 * AWS-shaped access keys — would be shell-visible.
 */
function isValidShellEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

export async function fetchSecretEnvVars(): Promise<Record<string, string>> {
  const isExtension = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;

  // Extension mode: fetch masked secrets from the service worker
  if (isExtension) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'secrets.list-masked-entries' }, (response: unknown) => {
        const resp = response as { entries?: MaskedSecretEntry[] };
        const env: Record<string, string> = {};
        for (const entry of resp?.entries ?? []) {
          if (entry.name && entry.maskedValue && isValidShellEnvName(entry.name)) {
            env[entry.name] = entry.maskedValue;
          }
        }

        if (Object.keys(env).length > 0) {
          log.info('Loaded masked secrets into shell env from SW', {
            count: Object.keys(env).length,
          });
        }

        resolve(env);
      });
    });
  }

  try {
    const resp = await fetch('/api/secrets/masked');
    if (!resp.ok) {
      log.warn('Failed to fetch masked secrets', { status: resp.status });
      return {};
    }

    const entries: MaskedSecretEntry[] = await resp.json();
    if (!Array.isArray(entries) || entries.length === 0) {
      return {};
    }

    const env: Record<string, string> = {};
    for (const entry of entries) {
      if (entry.name && entry.maskedValue && isValidShellEnvName(entry.name)) {
        env[entry.name] = entry.maskedValue;
      }
    }

    if (Object.keys(env).length > 0) {
      log.info('Loaded masked secrets into shell env', { count: Object.keys(env).length });
    }

    return env;
  } catch (err) {
    // Server unavailable or network error — degrade gracefully
    log.debug('Could not fetch masked secrets (server may be unavailable)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}
