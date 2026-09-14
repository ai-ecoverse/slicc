import { createLogger } from '../base/logger.js';
import type { PanelRpcClient } from '../kernel/panel-rpc.js';
import { suggestPattern } from './suggest-pattern.js';
import type { SudoBroker, SudoDecision, SudoRequest, SudoRequestOptions } from './types.js';

const log = createLogger('sudo:tray-first');

const DEFAULT_TRAY_FIRST_TIMEOUT_MS = 600_000;

export interface TrayFirstBrokerDeps {
  getClient?: () => Promise<PanelRpcClient | null> | PanelRpcClient | null;

  suggest?: (req: SudoRequest, signal?: AbortSignal) => Promise<string>;
  timeoutMs?: number;
}

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
