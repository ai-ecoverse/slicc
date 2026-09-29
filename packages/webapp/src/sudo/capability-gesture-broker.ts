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
 * (`normalizeApprovalDecision`) before returning — so `result.value` on
 * success is normally already clean. This module runs `normalizeApprovalDecision`
 * on it AGAIN anyway: `SudoFS` / `enforceCommandSudo` only ever check
 * `decision === 'deny'`, so a non-canonical shape a future (or buggy)
 * adapter lets through would otherwise fail OPEN at the enforcement layer,
 * not just look wrong here. Cheap and idempotent when the adapter already
 * did it right, load-bearing when one doesn't (round-1 review finding 1).
 *
 * `signal` is the ONLY deadline on this hop (`ApprovalCapability`'s own doc
 * comment) — this module adds none of its own. The 5-minute human-decision
 * budget (`withApprovalTimeout`) and tray-first delegation
 * (`createTrayFirstSudoBroker`) are POLICY layered on top in `sudo/index.ts`,
 * unchanged by this file.
 */

import { createLogger } from '../base/logger.js';
import { type CapabilityBroker, normalizeApprovalDecision } from '../work-unit/capability/index.js';
import { suggestPattern } from './suggest-pattern.js';
import {
  type SudoBroker,
  type SudoDecision,
  type SudoRequest,
  type SudoRequestOptions,
  unavailableDecision,
} from './types.js';

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
        return unavailableDecision();
      }

      if (!broker) {
        log.warn(
          'no CapabilityBroker injected for the sudo gesture hop — denying (composition bug, never a guessed transport)',
          { detail: req.detail }
        );
        return unavailableDecision();
      }

      const result = await broker.approvals.request({
        kind: req.kind,
        detail: req.detail,
        suggestedPattern,
        ...(req.requester ? { requester: req.requester } : {}),
        ...(req.reason ? { reason: req.reason } : {}),
        ...(req.approver ? { approver: req.approver } : {}),
        ...(signal ? { signal } : {}),
      });
      if (!result.ok) {
        // A `CapabilityFailure` is a dead or refusing transport, never a
        // human's refusal: the endpoint 400'd a kind it does not know, the
        // hosted origin had no approval route, the relay broke. It carries
        // `reason: 'unavailable'` so every consumer can tell it from a click on
        // "Deny" — a bare deny here is how a guest was once told "the host
        // refused" when no prompt had ever been shown.
        log.warn('capability broker approvals.request failed — denying', {
          message: result.message,
        });
        return unavailableDecision();
      }
      // Defence in depth: `SudoFS` / `enforceCommandSudo` only ever check
      // `decision === 'deny'`, so any non-canonical shape a future (or
      // buggy) adapter lets through — 'ALLOW', 'ok', an `always` with no
      // pattern — would otherwise be treated as allow-once, and `always`
      // would persist `pattern ?? subject` verbatim. Every adapter already
      // runs this same rule before returning, so this re-run is normally a
      // no-op; it exists so the enforcement layer's safety never DEPENDS on
      // that (round-1 review finding 1).
      return normalizeApprovalDecision(result.value, suggestedPattern);
    },
  };
}
