import { createLogger } from '../base/logger.js';
import { hasLocalNodeServer } from '../core/float-topology.js';
import { resolveSudoRequest } from './panel-responder.js';
import type { SudoDecision, SudoRequest } from './types.js';

const log = createLogger('sudo:page');

export interface SudoTrayDelegate {
  shouldDelegate(): boolean;

  requestApproval(req: SudoRequest): Promise<SudoDecision>;
}

export type SudoPagePrompt = (req: SudoRequest) => Promise<SudoDecision>;

let trayDelegate: SudoTrayDelegate | null = null;
let pagePrompt: SudoPagePrompt | null = null;

export function setSudoTrayDelegate(delegate: SudoTrayDelegate | null): void {
  trayDelegate = delegate;
}

export function setSudoPagePrompt(prompt: SudoPagePrompt | null): void {
  pagePrompt = prompt;
}

export function resetSudoPageServiceForTests(): void {
  trayDelegate = null;
  pagePrompt = null;
}

export interface PageSudoOutcome {
  decision: SudoDecision;

  handled: boolean;
}

export interface PageSudoDeps {
  hasLocalNodeServer?: () => boolean;
  nativeResolve?: (req: SudoRequest) => SudoDecision;
}

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
