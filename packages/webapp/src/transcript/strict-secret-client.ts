/**
 * Fail-closed known-secret batch redactor client.
 *
 * Unlike the fail-open `getToolResultScrubber()`, every error path here
 * throws `TranscriptExportError('redaction-unavailable')`. This ensures
 * transcript export never silently skips secret redaction.
 *
 * Request/response shape is identical across all floats:
 *   Request:  { texts: string[] }
 *   Response: { texts: string[]; redactionCount: number }
 */
import { TranscriptExportError } from '@slicc/shared-ts';
import { resolveSecretTopology } from '../core/secret-topology.js';
import { callSecretsBridge } from '../core/secrets-bridge-client.js';
import { apiHeaders, resolveApiUrl } from '../shell/proxied-fetch.js';
import type { KnownSecretBatchRedactor } from './redact.js';

type RedactExportResponse = { texts: string[]; redactionCount: number };

function fail(): never {
  throw new TranscriptExportError('redaction-unavailable');
}

function validateResponse(response: unknown, expectedLength: number): readonly string[] {
  if (
    typeof response !== 'object' ||
    response === null ||
    !Array.isArray((response as RedactExportResponse).texts) ||
    (response as RedactExportResponse).texts.length !== expectedLength
  ) {
    fail();
  }
  return (response as RedactExportResponse).texts;
}

function nodeRestRedactor(): KnownSecretBatchRedactor {
  return {
    async redact(texts) {
      let resp: Response;
      try {
        resp = await fetch(resolveApiUrl('/api/secrets/redact-export'), {
          method: 'POST',
          headers: apiHeaders({ 'content-type': 'application/json' }),
          body: JSON.stringify({ texts }),
        });
      } catch {
        fail();
      }
      if (!resp.ok) fail();
      let json: unknown;
      try {
        json = await resp.json();
      } catch {
        fail();
      }
      return validateResponse(json, texts.length);
    },
  };
}

function extensionMessageRedactor(): KnownSecretBatchRedactor {
  return {
    async redact(texts) {
      let resp: unknown;
      try {
        resp = await new Promise<unknown>((resolve) => {
          chrome.runtime.sendMessage(
            { type: 'secrets.redact-export', texts },
            (response: unknown) => {
              // Read lastError to suppress Chrome's "Unchecked runtime.lastError" console
              // warning when the service worker is unavailable. Null response →
              // validateResponse will fail() below, preserving fail-closed semantics.
              void chrome.runtime.lastError;
              resolve(response ?? null);
            }
          );
        });
      } catch {
        fail();
      }
      if (
        typeof resp === 'object' &&
        resp !== null &&
        'error' in (resp as Record<string, unknown>)
      ) {
        fail();
      }
      return validateResponse(resp, texts.length);
    },
  };
}

function extensionBridgeRedactor(): KnownSecretBatchRedactor {
  return {
    async redact(texts) {
      let resp: unknown;
      try {
        resp = await callSecretsBridge<unknown>('secrets.redact-export', { texts });
      } catch {
        fail();
      }
      if (resp === undefined || resp === null) fail();
      if (typeof resp === 'object' && 'error' in (resp as Record<string, unknown>)) {
        fail();
      }
      return validateResponse(resp, texts.length);
    },
  };
}

function rejectingRedactor(): KnownSecretBatchRedactor {
  return {
    async redact(_texts) {
      fail();
    },
  };
}

/**
 * Build the active fail-closed known-secret batch redactor for the current
 * float topology.
 *
 * - `connect`: throws immediately — no secret pipeline is reachable.
 * - `extension-direct`: routes through `chrome.runtime.sendMessage`.
 * - `extension-delegate`: routes through the `secrets.crud` Port bridge.
 * - `node-rest`: POSTs to `/api/secrets/redact-export`.
 *
 * Every error path throws `TranscriptExportError('redaction-unavailable')`.
 */
export function getStrictKnownSecretRedactor(): KnownSecretBatchRedactor {
  const topology = resolveSecretTopology();
  if (topology === 'connect') return rejectingRedactor();
  if (topology === 'extension-direct') return extensionMessageRedactor();
  if (topology === 'extension-delegate') return extensionBridgeRedactor();
  return nodeRestRedactor();
}
