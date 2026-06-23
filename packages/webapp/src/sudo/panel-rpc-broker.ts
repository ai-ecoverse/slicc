/**
 * Thin-bridge extension-leader sudo broker (kernel-worker → page relay).
 *
 * In the thin-bridge extension leader the agent's `SudoManager` runs in the
 * kernel worker, which has no `chrome` and whose leader origin (the tray-hub)
 * exposes no `/api/sudo-approve` — so the HTTP broker fails closed with no
 * prompt. This broker mirrors the `proxied-fetch` worker→page delegate: it
 * forwards the request over panel-RPC to the page realm (the hosted leader
 * tab the extension pins), where `resolveSudoRequest` raises the genuine
 * native modal. The agent can request approval but can never fabricate the
 * decision.
 *
 * The "Always" pattern suggestion is computed here in the worker realm (where
 * `quickLabel` reaches the provider) and shipped as the editable default —
 * same as the HTTP / extension brokers. Fail closed: no panel-RPC client, a
 * transport error / timeout, or a malformed decision resolves to `deny`.
 */

import { createLogger } from '../core/logger.js';
import type { PanelRpcClient } from '../kernel/panel-rpc.js';
import { suggestPattern } from './suggest-pattern.js';
import type { SudoBroker, SudoDecision, SudoRequest } from './types.js';

const log = createLogger('sudo-panel-rpc');

/**
 * Per-call timeout for the page relay. Unlike the panel-RPC default (15s),
 * a sudo prompt waits on a human gesture, so the window is generous; it only
 * exists to release a request whose page realm has gone away.
 */
const DEFAULT_SUDO_RPC_TIMEOUT_MS = 600_000;

/** Injection seams for tests. Production defaults talk to the live bridge. */
export interface PanelRpcSudoBrokerDeps {
  /** Resolve the worker-side panel-RPC client. Defaults to `getPanelRpcClient`. */
  getClient?: () => Promise<PanelRpcClient | null> | PanelRpcClient | null;
  /** Pattern suggester. Defaults to {@link suggestPattern}. */
  suggest?: (req: SudoRequest, signal?: AbortSignal) => Promise<string>;
  /** Per-call relay timeout. Defaults to {@link DEFAULT_SUDO_RPC_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** Create a {@link SudoBroker} that relays approval to the page over panel-RPC. */
export function createPanelRpcSudoBroker(deps: PanelRpcSudoBrokerDeps = {}): SudoBroker {
  const suggest = deps.suggest ?? suggestPattern;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_SUDO_RPC_TIMEOUT_MS;
  const getClient =
    deps.getClient ??
    (async () => {
      // Lazy import so panel-rpc isn't pulled into non-worker bundles.
      const { getPanelRpcClient } = await import('../kernel/panel-rpc.js');
      return getPanelRpcClient();
    });

  return {
    async requestApproval(req: SudoRequest): Promise<SudoDecision> {
      let suggestedPattern: string;
      try {
        suggestedPattern = await suggest(req);
      } catch {
        suggestedPattern = req.detail;
      }

      const enriched: SudoRequest = { ...req, suggestedPattern };

      let client: PanelRpcClient | null;
      try {
        client = await getClient();
      } catch (err) {
        log.warn('panel-RPC client lookup threw — denying', {
          error: err instanceof Error ? err.message : String(err),
        });
        return { decision: 'deny' };
      }
      if (!client) {
        log.warn('panel-RPC client unavailable in worker realm — denying');
        return { decision: 'deny' };
      }

      try {
        const { decision } = await client.call(
          'sudo-request',
          { request: enriched },
          { timeoutMs }
        );
        return normalizeDecision(decision, suggestedPattern);
      } catch (err) {
        log.warn('sudo panel-RPC relay failed — denying', {
          error: err instanceof Error ? err.message : String(err),
        });
        return { decision: 'deny' };
      }
    },
  };
}

/**
 * Coerce the page-returned decision into a {@link SudoDecision}. Anything that
 * is not a recognized `allow`/`always` shape becomes `deny` (fail closed). An
 * `always` decision without a pattern falls back to the suggested default.
 */
function normalizeDecision(decision: unknown, suggested: string): SudoDecision {
  if (!decision || typeof decision !== 'object') return { decision: 'deny' };
  const value = (decision as { decision?: unknown }).decision;
  if (value === 'allow') return { decision: 'allow' };
  if (value === 'always') {
    const pattern = (decision as { pattern?: unknown }).pattern;
    const resolved =
      typeof pattern === 'string' && pattern.trim().length > 0 ? pattern.trim() : suggested;
    return { decision: 'always', pattern: resolved };
  }
  return { decision: 'deny' };
}
