/**
 * The native-gesture hop, wrapping the injected `CapabilityBroker`'s
 * `approvals.request` op (#2276 slice C).
 *
 * Replaces `http-broker.ts` / `extension-broker.ts` / `panel-rpc-broker.ts`
 * as the RAW broker `sudo/index.ts` selects: those three shared one shape
 * (compute the "Always" suggestion, bail early on an already-aborted
 * signal, run the topology-specific transport, fail closed on anything
 * malformed) and differed only in which transport they spoke — HTTP POST,
 * `chrome.runtime.sendMessage`, panel-RPC. Every slice-B adapter already
 * implements that exact transport step under `approvals.request`
 * (`ApprovalCapability`'s doc comment: "the native-gesture hop, and only
 * that"), including its OWN fail-closed decision normalization
 * (`normalizeApprovalDecision`, shared by the REST and extension adapters
 * specifically so this rule has one copy, not three chances to fail open) —
 * so `result.value` on success is already a clean `{decision, pattern?}`,
 * structurally a `SudoDecision` with no `reason`/`attestation` set, exactly
 * what the old raw brokers returned. This module adds nothing on top of
 * that; it only builds the request and fails closed on `!result.ok` or a
 * missing broker.
 *
 * `signal` is the ONLY deadline on this hop (`ApprovalCapability`'s own doc
 * comment) — this module adds none of its own. The 5-minute human-decision
 * budget (`withApprovalTimeout`) and tray-first delegation
 * (`createTrayFirstSudoBroker`) are POLICY layered on top in `sudo/index.ts`,
 * unchanged by this file.
 */

import { createLogger } from '../base/logger.js';
import type { CapabilityBroker } from '../work-unit/capability/index.js';
import { suggestPattern } from './suggest-pattern.js';
import type { SudoBroker, SudoDecision, SudoRequest, SudoRequestOptions } from './types.js';

const log = createLogger('sudo:capability-gesture');

/** Injection seams for tests. Production defaults compute a real suggestion. */
export interface CapabilityGestureSudoBrokerDeps {
  /** Pattern suggester. Defaults to {@link suggestPattern}. */
  suggest?: (req: SudoRequest, signal?: AbortSignal) => Promise<string>;
}

/**
 * Create the raw-gesture {@link SudoBroker}. `broker` is the float's ONE
 * composed `CapabilityBroker` (injected by the caller — see `sudo/index.ts`
 * for why it is a parameter, not a module-level fact). `null` — never
 * injected, a composition bug — fails closed to `deny` rather than
 * constructing any transport of its own: this hop must never guess.
 */
export function createCapabilityGestureSudoBroker(
  broker: CapabilityBroker | null,
  deps: CapabilityGestureSudoBrokerDeps = {}
): SudoBroker {
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
      // The suggester can outlive the caller's budget. Raising a native
      // modal now would prompt for an action that already timed out.
      if (signal?.aborted) {
        log.warn('sudo approval aborted before prompting — denying', { detail: req.detail });
        return { decision: 'deny' };
      }

      if (!broker) {
        log.warn(
          'no CapabilityBroker injected for the sudo gesture hop — denying (composition bug, never a guessed transport)',
          { detail: req.detail }
        );
        return { decision: 'deny' };
      }

      const result = await broker.approvals.request({
        kind: req.kind,
        detail: req.detail,
        suggestedPattern,
        ...(req.requester ? { requester: req.requester } : {}),
        ...(req.approver ? { approver: req.approver } : {}),
        ...(signal ? { signal } : {}),
      });
      if (!result.ok) {
        log.warn('capability broker approvals.request failed — denying', {
          message: result.message,
        });
        return { decision: 'deny' };
      }
      return result.value;
    },
  };
}
