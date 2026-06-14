/**
 * Proxied-fetch + Link-header discovery subcommand: fetch.
 */

import { fetchAndDiscover } from '../discover.js';
import type { PlaywrightHandler } from '../types.js';

export const fetchHandler: PlaywrightHandler = async ({ fs, positional, flags }) => {
  if (positional.length === 0) {
    return { stdout: '', stderr: 'fetch requires a URL\n', exitCode: 1 };
  }
  const targetUrl = positional[0];
  const discover = flags['discover'] === 'true';
  const method = flags['method'] ?? 'GET';
  const fullResult = await fetchAndDiscover(targetUrl, { discover, method, fs });
  // Strip browseShWarning before serializing — it's a stderr-only
  // signal, not part of the JSON payload scoops parse.
  const { browseShWarning, ...payload } = fullResult;
  // Always JSON; non-zero exit only when the primary fetch failed.
  return {
    stdout: JSON.stringify(payload, null, 2) + '\n',
    stderr: browseShWarning ? `${browseShWarning}\n` : '',
    exitCode: payload.error ? 1 : 0,
  };
};
