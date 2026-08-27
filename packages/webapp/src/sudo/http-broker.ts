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
 * to `deny`. The endpoint never auto-resolves on the server side either. An
 * aborted `signal` (the caller's approval budget expired) both cancels the
 * in-flight POST and stops a slow suggester from raising a stale dialog.
 */

import { createLogger } from '../base/logger.js';
import { apiHeaders, resolveApiUrl } from '../shell/proxied-fetch.js';
import { suggestPattern } from './suggest-pattern.js';
import {
  SUDO_APPROVE_PATH,
  type SudoBroker,
  type SudoDecision,
  type SudoRequest,
  type SudoRequestOptions,
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
    async requestApproval(req: SudoRequest, opts?: SudoRequestOptions): Promise<SudoDecision> {
      const signal = opts?.signal;
      let suggestedPattern: string;
      if (req.suggestedPattern) {
        suggestedPattern = req.suggestedPattern;
      } else {
        try {
          suggestedPattern = await suggest(req, signal);
        } catch {
          suggestedPattern = req.detail;
        }
      }
      // The suggester can outlive the caller's budget. Raising the OS dialog
      // now would prompt for an action that already timed out, so bail first.
      if (signal?.aborted) {
        log.warn('sudo approval aborted before prompting — denying', { detail: req.detail });
        return { decision: 'deny' };
      }

      try {
        const resp = await fetchImpl(resolveApiUrl(path), {
          method: 'POST',
          headers: apiHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            kind: req.kind,
            detail: req.detail,
            suggestedPattern,
            // Authenticated identity. Dropping it leaves the OS / TTY prompt
            // showing nothing but `detail`, which for a guest message is prose
            // the requester wrote about themselves.
            ...(req.requester ? { requester: req.requester } : {}),
          }),
          signal,
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
