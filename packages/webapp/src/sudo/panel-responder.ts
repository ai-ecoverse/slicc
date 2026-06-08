/**
 * Side-panel responder for extension-mode sudo requests.
 *
 * Runs in the panel realm (which has a user-scriptable `window`). Listens for
 * the offscreen broker's `sudo-request` envelope (see `extension-broker.ts`),
 * raises genuine native modals, and returns the decision:
 *
 *   1. `window.confirm` — allow vs deny (Cancel = deny, fail closed).
 *   2. on allow, a second `window.confirm` — "Always" vs just-this-once.
 *   3. on "Always", `window.prompt(message, suggestedPattern)` — the editable
 *      generalized pattern. Cancelling the prompt falls back to the suggested
 *      default rather than widening or denying.
 *
 * `window.confirm`/`window.prompt` are not scriptable by the offscreen agent,
 * so the decision can only come from a real human gesture. Any unexpected
 * shape or error denies.
 */

import { createLogger } from '../core/logger.js';
import { SUDO_REQUEST_TYPE, type SudoDecision, type SudoRequest } from './types.js';

const log = createLogger('sudo-panel');

/** DOM seams so tests can drive the responder without a real `window`. */
export interface PanelResponderDeps {
  confirm?: (message: string) => boolean;
  prompt?: (message: string, defaultValue?: string) => string | null;
}

interface ChromeOnMessage {
  runtime: {
    onMessage: {
      addListener(
        cb: (
          message: unknown,
          sender: unknown,
          sendResponse: (response: unknown) => void
        ) => boolean | undefined
      ): void;
    };
  };
}

/** Compute a decision from native modals for one request. Exported for tests. */
export function resolveSudoRequest(req: SudoRequest, deps: PanelResponderDeps = {}): SudoDecision {
  const confirmFn = deps.confirm ?? ((m: string) => globalThis.confirm(m));
  const promptFn = deps.prompt ?? ((m: string, d?: string) => globalThis.prompt(m, d));

  const label = `Approve ${req.kind}:\n\n${req.detail}\n\nOK = allow · Cancel = deny`;
  if (!confirmFn(label)) return { decision: 'deny' };

  const suggested = req.suggestedPattern?.trim() || req.detail.trim();
  const alwaysLabel = `Always allow actions matching:\n\n${suggested}\n\nOK = always · Cancel = just this once`;
  if (!confirmFn(alwaysLabel)) return { decision: 'allow' };

  const edited = promptFn('Edit the "Always" allow pattern:', suggested);
  const pattern = edited && edited.trim().length > 0 ? edited.trim() : suggested;
  return { decision: 'always', pattern };
}

/**
 * Install the `chrome.runtime.onMessage` listener that handles offscreen sudo
 * requests in the panel realm. No-op (returns false) when `chrome.runtime` is
 * unavailable, so it is safe to call from the shared boot path.
 */
export function installPanelSudoResponder(deps: PanelResponderDeps = {}): boolean {
  const chromeGlobal = (globalThis as unknown as { chrome?: ChromeOnMessage }).chrome;
  const onMessage = chromeGlobal?.runtime?.onMessage;
  if (!onMessage || typeof onMessage.addListener !== 'function') {
    return false;
  }

  onMessage.addListener((message, _sender, sendResponse) => {
    if (!isSudoRequestEnvelope(message)) return undefined;
    const req = message.payload.request;
    try {
      const decision = resolveSudoRequest(req, deps);
      sendResponse({ ok: true, decision });
    } catch (err) {
      log.warn('panel responder threw — denying', {
        error: err instanceof Error ? err.message : String(err),
      });
      sendResponse({ ok: false, decision: { decision: 'deny' }, error: 'panel responder error' });
    }
    // Modals are synchronous; the response is already sent.
    return false;
  });
  return true;
}

interface SudoRequestEnvelope {
  source: 'offscreen';
  payload: { type: typeof SUDO_REQUEST_TYPE; request: SudoRequest };
}

function isSudoRequestEnvelope(message: unknown): message is SudoRequestEnvelope {
  if (!message || typeof message !== 'object') return false;
  const m = message as { source?: unknown; payload?: unknown };
  if (m.source !== 'offscreen') return false;
  const payload = m.payload as { type?: unknown; request?: unknown } | undefined;
  if (!payload || payload.type !== SUDO_REQUEST_TYPE) return false;
  const req = payload.request as { kind?: unknown; detail?: unknown } | undefined;
  return !!req && typeof req.kind === 'string' && typeof req.detail === 'string';
}
