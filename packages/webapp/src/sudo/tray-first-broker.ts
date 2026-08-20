/**
 * Tray-first sudo broker wrapper (issue #2062).
 *
 * Wraps a float's native broker (node-server OS dialog, extension panel
 * confirm) so that, before the native modal fires, the page realm gets a
 * chance to route the prompt to a tray follower's human — the phone with
 * Face ID when the user is driving from it, or the only human at all on a
 * headless leader. The page answers over panel-RPC (`sudo-request`,
 * `mode: 'tray-first'`); when it reports `handled: false` the inner broker
 * runs exactly as before.
 *
 * The worker computes the "Always" suggestion once here and hands the
 * enriched request to both paths, so the native broker's own suggester is
 * short-circuited to the precomputed value.
 *
 * Fail-open TOWARD THE INNER BROKER on plumbing errors (no panel-RPC client,
 * RPC failure): those mean "nobody else can answer", not "deny". A malformed
 * page decision with `handled: true` still denies.
 */

import { createLogger } from '../base/logger.js';
import type { PanelRpcClient } from '../kernel/panel-rpc.js';
import { suggestPattern } from './suggest-pattern.js';
import type { SudoBroker, SudoDecision, SudoRequest, SudoRequestOptions } from './types.js';

const log = createLogger('sudo:tray-first');

/** Generous: a delegated prompt waits on a human, possibly on a suspended phone. */
const DEFAULT_TRAY_FIRST_TIMEOUT_MS = 600_000;

export interface TrayFirstBrokerDeps {
  /** Resolve the worker-side panel-RPC client. Defaults to `getPanelRpcClient`. */
  getClient?: () => Promise<PanelRpcClient | null> | PanelRpcClient | null;
  /** Pattern suggester. Defaults to {@link suggestPattern}. */
  suggest?: (req: SudoRequest, signal?: AbortSignal) => Promise<string>;
  timeoutMs?: number;
}

/** Wrap `inner` so the page realm may delegate the prompt to a tray follower first. */
export function createTrayFirstSudoBroker(
  inner: SudoBroker,
  deps: TrayFirstBrokerDeps = {}
): SudoBroker {
  const suggest = deps.suggest ?? suggestPattern;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TRAY_FIRST_TIMEOUT_MS;
  const getClient =
    deps.getClient ??
    (async () => {
      const { getPanelRpcClient } = await import('../kernel/panel-rpc.js');
      return getPanelRpcClient();
    });

  return {
    async requestApproval(req: SudoRequest, opts?: SudoRequestOptions): Promise<SudoDecision> {
      if (opts?.signal?.aborted) return { decision: 'deny' };
      let suggestedPattern = req.suggestedPattern;
      if (!suggestedPattern) {
        try {
          suggestedPattern = await suggest(req, opts?.signal);
        } catch {
          suggestedPattern = req.detail;
        }
      }
      const enriched: SudoRequest = { ...req, suggestedPattern };

      let client: PanelRpcClient | null = null;
      try {
        client = await getClient();
      } catch (err) {
        log.debug?.('panel-RPC client lookup threw — using native broker', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (client) {
        try {
          const result = await client.call(
            'sudo-request',
            { request: enriched, mode: 'tray-first' },
            { timeoutMs }
          );
          if (result?.handled !== false) {
            return normalizeDecision(result?.decision, suggestedPattern);
          }
        } catch (err) {
          log.warn('tray-first sudo probe failed — using native broker', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return inner.requestApproval(enriched, opts);
    },
  };
}

/** Coerce an untrusted page decision; anything unrecognised denies. */
function normalizeDecision(decision: unknown, suggested: string): SudoDecision {
  if (!decision || typeof decision !== 'object') return { decision: 'deny' };
  const d = decision as { decision?: unknown; pattern?: unknown; attestation?: unknown };
  const attestation =
    d.attestation === 'biometric' || d.attestation === 'passcode' || d.attestation === 'none'
      ? d.attestation
      : undefined;
  if (d.decision === 'allow') return { decision: 'allow', ...(attestation ? { attestation } : {}) };
  if (d.decision === 'always') {
    const pattern =
      typeof d.pattern === 'string' && d.pattern.trim().length > 0 ? d.pattern.trim() : suggested;
    return { decision: 'always', pattern, ...(attestation ? { attestation } : {}) };
  }
  return { decision: 'deny' };
}
