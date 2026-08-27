/**
 * Side-panel responder for extension-mode sudo requests.
 *
 * Runs in the panel realm (which has a user-scriptable `window`). Listens for
 * the offscreen broker's `sudo-request` envelope (see `extension-broker.ts`),
 * raises genuine native modals, and returns the decision:
 *
 *   1. `confirm` — allow vs deny (Cancel = deny, fail closed).
 *   2. on allow, a second `confirm` — "Always" vs just-this-once.
 *   3. on "Always", `prompt(message, suggestedPattern)` — the editable
 *      generalized pattern. Cancelling the prompt falls back to the suggested
 *      default rather than widening or denying.
 *
 * Native modals cannot be answered by the **offscreen agent** — the decision
 * has to come from a real human gesture in this realm. That is the security
 * property this responder rests on, and it is scoped precisely: it holds
 * against the agent's own realm, NOT against arbitrary code running in THIS
 * page realm. Page-realm JS can assign `globalThis.confirm = () => true`, at
 * which point every subsequent approval self-answers — including the writes to
 * `/etc/sudoers` that `matchPath` always gates and no `NOPASSWD` rule can
 * override.
 *
 * Mitigation: the native `confirm`/`prompt` are captured ONCE at module
 * evaluation (see `NATIVE_CONFIRM`/`NATIVE_PROMPT` below) and every call goes
 * through the captured reference, never the live global. Module init happens
 * during boot, before any dynamically registered UI component can run, so a
 * later override of the global is inert here. This is defense-in-depth, not a
 * hard boundary — code that runs in this realm before the module loads, or that
 * patches the captured function's own prototype chain, is still out of scope;
 * the trust model, not this capture, is the real boundary (same posture as
 * `sprinkle-renderer.ts`'s sandbox note).
 *
 * Any unexpected shape or error denies.
 */

import { createLogger } from '../base/logger.js';
import { SUDO_REQUEST_TYPE, type SudoDecision, type SudoRequest } from './types.js';

const log = createLogger('sudo-panel');

/**
 * The native modal functions, captured at module evaluation — BEFORE any
 * dynamically registered panel/sprinkle code can reassign the globals. Bound to
 * `globalThis` because `confirm`/`prompt` are `[[Call]]`-on-window intrinsics
 * that throw an Illegal-invocation TypeError when invoked detached.
 *
 * `undefined` in a non-DOM realm (node tests, the kernel worker); callers fall
 * back to a fail-closed deny, matching the "any unexpected shape denies" rule.
 */
const NATIVE_CONFIRM: ((message?: string) => boolean) | undefined =
  typeof globalThis.confirm === 'function' ? globalThis.confirm.bind(globalThis) : undefined;
const NATIVE_PROMPT: ((message?: string, defaultValue?: string) => string | null) | undefined =
  typeof globalThis.prompt === 'function' ? globalThis.prompt.bind(globalThis) : undefined;

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
  // Injected seams win (tests); otherwise the module-init capture — NOT the
  // live `globalThis.confirm`, which page-realm code can reassign. A realm with
  // no native modal at all denies rather than silently allowing.
  const confirmFn = deps.confirm ?? NATIVE_CONFIRM;
  const promptFn = deps.prompt ?? NATIVE_PROMPT;
  if (!confirmFn) {
    log.warn('no native confirm available in this realm — denying');
    return { decision: 'deny' };
  }

  // The requester line comes FIRST and is system-derived. `detail` may be
  // attacker-chosen prose (a guest message), so a reviewer needs the
  // authenticated identity before they read a word the requester wrote.
  const who = req.requester ? `Requested by: ${req.requester}\n\n` : '';
  const label = `Approve ${req.kind}:\n\n${who}${req.detail}\n\nOK = allow · Cancel = deny`;
  if (!confirmFn(label)) return { decision: 'deny' };

  const suggested = req.suggestedPattern?.trim() || req.detail.trim();
  const alwaysLabel = `Always allow actions matching:\n\n${suggested}\n\nOK = always · Cancel = just this once`;
  if (!confirmFn(alwaysLabel)) return { decision: 'allow' };

  // No native prompt (or a cancelled one) keeps the SUGGESTED pattern rather
  // than widening: the user already consented to "always" for this action, and
  // the suggestion is the narrow generalization `suggest-pattern.ts` derived.
  const edited = promptFn?.('Edit the "Always" allow pattern:', suggested);
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
