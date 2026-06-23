/**
 * Tool-output secret scrubber — defense-in-depth real→masked pass over
 * completed tool results before they reach the agent loop.
 *
 * Reuses the existing per-session `SecretsPipeline` that lives in the
 * extension service worker (extension float) or the node-server process
 * (CLI/Electron/hosted floats). The agent realm never holds the real
 * secret values, so the scrub is implemented as a single RPC over the
 * completed result buffer.
 *
 * Direction is real→masked ONLY. The scrub never unmasks, so it is
 * always safe regardless of which domain the data originated from. Any
 * RPC failure degrades to "return the input unchanged" — secrets that
 * leaked are the operator's failure (env-var masking should be the
 * load-bearing invariant); the scrub is defense-in-depth, not the
 * primary defense.
 */

import { apiHeaders, resolveApiUrl } from '../shell/proxied-fetch.js';
import { createLogger } from './logger.js';
import { resolveSecretTopology } from './secret-topology.js';
import { callSecretsBridge } from './secrets-bridge-client.js';

const log = createLogger('secret-scrub');

/** Async tool-result scrubber. Always returns the input on any failure. */
export type ToolResultScrubber = (text: string) => Promise<string>;

const identityScrubber: ToolResultScrubber = async (text) => text;

/**
 * Build the active per-session scrubber for the current float.
 *
 * - Extension: posts `secrets.scrub-tool-result` to the SW, which calls
 *   `SecretsPipeline.scrubResponse` against its in-realm pipeline.
 * - CLI/Electron/hosted: POSTs the text to `/api/secrets/scrub`, which
 *   calls `SecretProxyManager.scrubResponse`.
 * - All other floats (no chrome runtime, fetch failure, server absent):
 *   returns the identity scrubber.
 *
 * The function is cheap — it returns a scrubber closure rather than
 * scrubbing immediately, so callers (`scoop-context.ts`) can wire it
 * into `adaptTools` once per scoop init and reuse it for every tool
 * call.
 */
export function getToolResultScrubber(): ToolResultScrubber {
  const topology = resolveSecretTopology();

  // Extension (same-extension page / offscreen): direct SW sendMessage.
  if (topology === 'extension-direct') {
    return async (text) => {
      if (!text) return text;
      try {
        const resp = await new Promise<{ text?: string; error?: string }>((resolve) => {
          chrome.runtime.sendMessage(
            { type: 'secrets.scrub-tool-result', text },
            (response: unknown) => resolve((response ?? {}) as { text?: string; error?: string })
          );
        });
        if (resp.error) {
          log.debug('SW scrub-tool-result returned error', { error: resp.error });
          return text;
        }
        return typeof resp.text === 'string' ? resp.text : text;
      } catch (err) {
        log.debug('SW scrub-tool-result failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        return text;
      }
    };
  }

  // Thin-extension hosted leader / kernel worker: route over the secrets.crud
  // Port bridge.
  if (topology === 'extension-delegate') {
    return async (text) => {
      if (!text) return text;
      try {
        const resp = await callSecretsBridge<{ text?: string; error?: string } | undefined>(
          'secrets.scrub-tool-result',
          { text }
        );
        if (resp?.error) {
          log.debug('Bridge scrub-tool-result returned error', { error: resp.error });
          return text;
        }
        return typeof resp?.text === 'string' ? resp.text : text;
      } catch (err) {
        log.debug('Bridge scrub-tool-result failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        return text;
      }
    };
  }

  // Connect mode: no secret pipeline reachable — scrub is a no-op (identity).
  if (topology === 'connect') {
    return identityScrubber;
  }

  // node-rest (CLI / Electron / swift) — node-server endpoint.
  return async (text) => {
    if (!text) return text;
    try {
      const resp = await fetch(resolveApiUrl('/api/secrets/scrub'), {
        method: 'POST',
        headers: apiHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ text }),
      });
      if (!resp.ok) {
        log.debug('Server scrub-tool-result returned non-ok', { status: resp.status });
        return text;
      }
      const json = (await resp.json()) as { text?: string };
      return typeof json.text === 'string' ? json.text : text;
    } catch (err) {
      log.debug('Server scrub-tool-result failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return text;
    }
  };
}

/** Identity scrubber — used by tests and floats that opt out of scrubbing. */
export function getIdentityToolResultScrubber(): ToolResultScrubber {
  return identityScrubber;
}
