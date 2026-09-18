import { createLogger } from '../base/logger.js';
import { SUDO_REQUEST_TYPE, type SudoDecision, type SudoRequest } from './types.js';

const log = createLogger('sudo-panel');

const NATIVE_CONFIRM: ((message?: string) => boolean) | undefined =
  typeof globalThis.confirm === 'function' ? globalThis.confirm.bind(globalThis) : undefined;
const NATIVE_PROMPT: ((message?: string, defaultValue?: string) => string | null) | undefined =
  typeof globalThis.prompt === 'function' ? globalThis.prompt.bind(globalThis) : undefined;

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

export function resolveSudoRequest(req: SudoRequest, deps: PanelResponderDeps = {}): SudoDecision {
  const confirmFn = deps.confirm ?? NATIVE_CONFIRM;
  const promptFn = deps.prompt ?? NATIVE_PROMPT;
  if (!confirmFn) {
    log.warn('no native confirm available in this realm — denying');
    return { decision: 'deny' };
  }

  const who = req.requester ? `Requested by: ${req.requester}\n\n` : '';

  const why = req.reason ? `\n\nReason given: ${req.reason}` : '';
  const label = `Approve ${req.kind}:\n\n${who}${req.detail}${why}\n\nOK = allow · Cancel = deny`;
  if (!confirmFn(label)) return { decision: 'deny' };

  const suggested = req.suggestedPattern?.trim() || req.detail.trim();
  const alwaysLabel = `Always allow actions matching:\n\n${suggested}\n\nOK = always · Cancel = just this once`;
  if (!confirmFn(alwaysLabel)) return { decision: 'allow' };

  const edited = promptFn?.('Edit the "Always" allow pattern:', suggested);
  const pattern = edited && edited.trim().length > 0 ? edited.trim() : suggested;
  return { decision: 'always', pattern };
}

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
