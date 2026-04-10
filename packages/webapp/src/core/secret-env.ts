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
export async function fetchSecretEnvVars(): Promise<Record<string, string>> {
  const isExtension = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;

  // Extension mode has no server-side proxy — secrets unavailable
  if (isExtension) {
    return {};
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
      if (entry.name && entry.maskedValue) {
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
