/**
 * Chrome-extension sudo broker (offscreen → side-panel relay).
 *
 * The agent runs in the offscreen document, where `window.confirm` /
 * `window.prompt` are not user-scriptable native gestures the way they are in
 * the side-panel realm. So the offscreen broker forwards the request to the
 * panel via `chrome.runtime.sendMessage`; the panel's responder (see
 * `panel-responder.ts`) raises the real native modals and sends the decision
 * back.
 *
 * The "Always" pattern suggestion is computed here in the offscreen realm
 * (where `quickLabel` can reach the provider) and shipped as the editable
 * default. Fail closed: no `chrome.runtime`, a `lastError`, an empty/garbled
 * response, or any thrown error resolves to `deny`.
 */

import { createLogger } from '../core/logger.js';
import { suggestPattern } from './suggest-pattern.js';
import {
  SUDO_REQUEST_TYPE,
  type SudoBroker,
  type SudoDecision,
  type SudoRequest,
} from './types.js';

const log = createLogger('sudo-ext');

/** Narrow Chrome runtime surface the broker relies on. */
interface ChromeRuntimeForSudo {
  runtime: {
    lastError?: { message?: string } | null;
    sendMessage(message: unknown, callback?: (response: unknown) => void): unknown;
  };
}

/** Response envelope the panel responder returns via `sendResponse`. */
interface SudoProxyResponse {
  ok: boolean;
  decision?: SudoDecision;
  error?: string;
}

/** Injection seams for tests. */
export interface ExtensionSudoBrokerDeps {
  suggest?: (req: SudoRequest, signal?: AbortSignal) => Promise<string>;
}

/** Create a {@link SudoBroker} that relays to the side-panel responder. */
export function createExtensionSudoBroker(deps: ExtensionSudoBrokerDeps = {}): SudoBroker {
  const suggest = deps.suggest ?? suggestPattern;

  return {
    async requestApproval(req: SudoRequest): Promise<SudoDecision> {
      let suggestedPattern: string;
      try {
        suggestedPattern = await suggest(req);
      } catch {
        suggestedPattern = req.detail;
      }

      const enriched: SudoRequest = { ...req, suggestedPattern };
      return sendToPanel(enriched);
    },
  };
}

/** One isolated `chrome.runtime.sendMessage` round-trip to the panel. */
function sendToPanel(req: SudoRequest): Promise<SudoDecision> {
  return new Promise<SudoDecision>((resolve) => {
    const chromeGlobal = (globalThis as unknown as { chrome?: ChromeRuntimeForSudo }).chrome;
    const runtime = chromeGlobal?.runtime;
    if (!runtime || typeof runtime.sendMessage !== 'function') {
      log.warn('chrome.runtime.sendMessage unavailable — denying');
      resolve({ decision: 'deny' });
      return;
    }

    const handleResponse = (response: unknown): void => {
      const lastError = runtime.lastError;
      if (lastError) {
        log.warn('sudo relay lastError — denying', { error: lastError.message });
        resolve({ decision: 'deny' });
        return;
      }
      if (!response || typeof response !== 'object') {
        log.warn('sudo relay empty response — denying');
        resolve({ decision: 'deny' });
        return;
      }
      const resp = response as SudoProxyResponse;
      if (!resp.ok || !resp.decision) {
        log.warn('sudo relay error response — denying', { error: resp.error });
        resolve({ decision: 'deny' });
        return;
      }
      resolve(normalizeDecision(resp.decision, req.suggestedPattern ?? req.detail));
    };

    try {
      runtime.sendMessage(
        { source: 'offscreen' as const, payload: { type: SUDO_REQUEST_TYPE, request: req } },
        handleResponse
      );
    } catch (err) {
      log.warn('sudo relay threw — denying', {
        error: err instanceof Error ? err.message : String(err),
      });
      resolve({ decision: 'deny' });
    }
  });
}

/** Fail-closed coercion of the panel's decision. */
function normalizeDecision(decision: SudoDecision, suggested: string): SudoDecision {
  if (decision.decision === 'allow') return { decision: 'allow' };
  if (decision.decision === 'always') {
    const pattern =
      typeof decision.pattern === 'string' && decision.pattern.trim().length > 0
        ? decision.pattern.trim()
        : suggested;
    return { decision: 'always', pattern };
  }
  return { decision: 'deny' };
}
