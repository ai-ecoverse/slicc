/**
 * CLI / standalone / Electron sudo broker.
 *
 * The agent's `node` is a browser shim, so a genuine native dialog can only be
 * raised by the real `node-server` process. This broker POSTs the request to
 * the node-server endpoint (`/api/sudo-approve`); the server selects an
 * OS-native backend (Electron / osascript / PowerShell / zenity / TTY) and
 * resolves the human's gesture. The pattern suggestion is computed here in the
 * browser realm (where `quickLabel` can reach the provider) and passed along
 * as the editable default.
 *
 * Fail closed: any transport error, non-OK status, or malformed body resolves
 * to `deny`. The endpoint never auto-resolves on the server side either.
 */

import { createLogger } from '../core/logger.js';
import { apiHeaders, resolveApiUrl } from '../shell/proxied-fetch.js';
import { suggestPattern } from './suggest-pattern.js';
import {
  SUDO_APPROVE_PATH,
  type SudoBroker,
  type SudoDecision,
  type SudoRequest,
} from './types.js';

const log = createLogger('sudo-http');

/** Injection seams for tests. Production defaults talk to the live endpoint. */
export interface HttpSudoBrokerDeps {
  /** `fetch` implementation. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Endpoint path. Defaults to {@link SUDO_APPROVE_PATH}. */
  path?: string;
  /** Pattern suggester. Defaults to {@link suggestPattern}. */
  suggest?: (req: SudoRequest, signal?: AbortSignal) => Promise<string>;
}

/** Create a {@link SudoBroker} that delegates to the node-server endpoint. */
export function createHttpSudoBroker(deps: HttpSudoBrokerDeps = {}): SudoBroker {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const path = deps.path ?? SUDO_APPROVE_PATH;
  const suggest = deps.suggest ?? suggestPattern;

  return {
    async requestApproval(req: SudoRequest): Promise<SudoDecision> {
      let suggestedPattern: string;
      try {
        suggestedPattern = await suggest(req);
      } catch {
        suggestedPattern = req.detail;
      }

      try {
        const resp = await fetchImpl(resolveApiUrl(path), {
          method: 'POST',
          headers: apiHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            kind: req.kind,
            detail: req.detail,
            suggestedPattern,
          }),
        });
        if (!resp.ok) {
          log.warn('sudo endpoint returned non-OK status — denying', {
            status: resp.status,
          });
          return { decision: 'deny' };
        }
        const body = (await resp.json()) as unknown;
        return normalizeDecision(body, suggestedPattern);
      } catch (err) {
        log.warn('sudo endpoint request failed — denying', {
          error: err instanceof Error ? err.message : String(err),
        });
        return { decision: 'deny' };
      }
    },
  };
}

/**
 * Coerce an untrusted endpoint body into a {@link SudoDecision}. Anything that
 * is not a recognized `allow`/`always` shape becomes `deny` (fail closed). An
 * `always` decision without a pattern falls back to the suggested default.
 */
function normalizeDecision(body: unknown, suggested: string): SudoDecision {
  if (!body || typeof body !== 'object') return { decision: 'deny' };
  const decision = (body as { decision?: unknown }).decision;
  if (decision === 'allow') return { decision: 'allow' };
  if (decision === 'always') {
    const pattern = (body as { pattern?: unknown }).pattern;
    const resolved =
      typeof pattern === 'string' && pattern.trim().length > 0 ? pattern.trim() : suggested;
    return { decision: 'always', pattern: resolved };
  }
  return { decision: 'deny' };
}
