import { createLogger } from '../base/logger.js';
import { apiHeaders, resolveApiUrl } from '../shell/proxied-fetch.js';
import { resolveSecretTopology } from './secret-topology.js';
import { callSecretsBridge } from './secrets-bridge-client.js';

const log = createLogger('secret-scrub');
const SCRUB_FAILURE_OUTPUT = '[tool output withheld: secret scrub unavailable]';

export type ToolResultScrubber = (text: string) => Promise<string>;

const identityScrubber: ToolResultScrubber = async (text) => text;

export function getToolResultScrubber(): ToolResultScrubber {
  const topology = resolveSecretTopology();

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
          log.debug('SW scrub-tool-result returned error');
          return SCRUB_FAILURE_OUTPUT;
        }
        return typeof resp.text === 'string' ? resp.text : SCRUB_FAILURE_OUTPUT;
      } catch {
        log.debug('SW scrub-tool-result failed');
        return SCRUB_FAILURE_OUTPUT;
      }
    };
  }

  if (topology === 'extension-delegate') {
    return async (text) => {
      if (!text) return text;
      try {
        const resp = await callSecretsBridge<{ text?: string; error?: string } | undefined>(
          'secrets.scrub-tool-result',
          { text }
        );
        if (resp?.error) {
          log.debug('Bridge scrub-tool-result returned error');
          return SCRUB_FAILURE_OUTPUT;
        }
        return typeof resp?.text === 'string' ? resp.text : SCRUB_FAILURE_OUTPUT;
      } catch {
        log.debug('Bridge scrub-tool-result failed');
        return SCRUB_FAILURE_OUTPUT;
      }
    };
  }

  if (topology === 'connect') {
    return identityScrubber;
  }

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

export function getIdentityToolResultScrubber(): ToolResultScrubber {
  return identityScrubber;
}
