/**
 * Page-realm sudo approval service (issue #2062).
 *
 * The kernel worker owns the sudo policy but cannot see the tray: the leader
 * sync manager — and therefore every connected follower's human — lives in
 * the page realm. This module is the page-side seam the worker's broker calls
 * over panel-RPC (`sudo-request`). It picks the approver:
 *
 *   1. **Tray delegate** — when a registered {@link SudoTrayDelegate} says the
 *      human is demonstrably elsewhere (headless leader, or the last user
 *      message came from a follower) and a `sudoApproval`-capable follower is
 *      connected. The prompt goes out over the data channel; an iOS follower
 *      gates it behind Face ID.
 *   2. **Worker's native broker** — in `tray-first` mode, when this float has
 *      a local node-server, the service declines (`handled: false`) so the
 *      worker raises the genuine OS dialog it always has.
 *   3. **In-page dialog** — otherwise (`resolve` mode, or no node-server):
 *      the registered {@link SudoPagePrompt} (the `<slicc-dialog>` shell UI)
 *      or, failing that, the captured native `confirm`/`prompt`.
 *
 * Fail closed everywhere: a throwing delegate or prompt denies.
 */

import { createLogger } from '../base/logger.js';
import { hasLocalNodeServer } from '../core/float-topology.js';
import { resolveSudoRequest } from './panel-responder.js';
import type { SudoDecision, SudoRequest } from './types.js';

const log = createLogger('sudo:page');

/** The tray leader's view of "should a follower's human answer this?". */
export interface SudoTrayDelegate {
  /** True when a connected follower's human should get this prompt. */
  shouldDelegate(): boolean;
  /** Ship the prompt to the capable followers; resolves with the first verdict. */
  requestApproval(req: SudoRequest): Promise<SudoDecision>;
}

/** A page-realm dialog (the wc shell's `<slicc-dialog>`), registered at boot. */
export type SudoPagePrompt = (req: SudoRequest) => Promise<SudoDecision>;

let trayDelegate: SudoTrayDelegate | null = null;
let pagePrompt: SudoPagePrompt | null = null;

/** Register (or clear, with `null`) the tray delegate. Called when a leader starts/stops. */
export function setSudoTrayDelegate(delegate: SudoTrayDelegate | null): void {
  trayDelegate = delegate;
}

/** Register (or clear) the in-page dialog used when no native modal exists. */
export function setSudoPagePrompt(prompt: SudoPagePrompt | null): void {
  pagePrompt = prompt;
}

/** Test seam: reset both registrations. */
export function resetSudoPageServiceForTests(): void {
  trayDelegate = null;
  pagePrompt = null;
}

export interface PageSudoOutcome {
  decision: SudoDecision;
  /** False only in `tray-first` mode when the worker should run its own broker. */
  handled: boolean;
}

/** Injection seams for tests. */
export interface PageSudoDeps {
  hasLocalNodeServer?: () => boolean;
  nativeResolve?: (req: SudoRequest) => SudoDecision;
}

/** Run the tray delegate when it claims the prompt; `null` when it does not apply. */
async function tryTrayDelegate(req: SudoRequest): Promise<PageSudoOutcome | null> {
  const delegate = trayDelegate;
  if (!delegate) return null;
  let shouldDelegate = false;
  try {
    shouldDelegate = delegate.shouldDelegate();
  } catch (err) {
    log.warn('tray delegate probe threw — treating as not delegable', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (!shouldDelegate) return null;
  try {
    return { decision: await delegate.requestApproval(req), handled: true };
  } catch (err) {
    log.warn('tray-delegated sudo approval threw — denying', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { decision: { decision: 'deny' }, handled: true };
  }
}

/** The in-page dialog, or the captured native modal; both fail closed. */
async function promptInPage(
  req: SudoRequest,
  native: (req: SudoRequest) => SudoDecision
): Promise<PageSudoOutcome> {
  try {
    const decision = pagePrompt ? await pagePrompt(req) : native(req);
    return { decision, handled: true };
  } catch (err) {
    log.warn('in-page sudo prompt threw — denying', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { decision: { decision: 'deny' }, handled: true };
  }
}

/**
 * Settle a sudo request in the page realm. See the module doc for the
 * approver order. Never throws.
 */
export async function resolveSudoApprovalInPage(
  req: SudoRequest,
  mode: 'resolve' | 'tray-first' = 'resolve',
  deps: PageSudoDeps = {}
): Promise<PageSudoOutcome> {
  const delegated = await tryTrayDelegate(req);
  if (delegated) return delegated;

  const localServer = deps.hasLocalNodeServer ?? hasLocalNodeServer;
  if (mode === 'tray-first' && localServer()) {
    return { decision: { decision: 'deny' }, handled: false };
  }
  return promptInPage(req, deps.nativeResolve ?? resolveSudoRequest);
}
