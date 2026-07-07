/**
 * Tests for the side-panel sudo responder: the native-modal decision logic and
 * the chrome.runtime.onMessage listener routing.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { installPanelSudoResponder, resolveSudoRequest } from '../../src/sudo/panel-responder.js';
import { SUDO_REQUEST_TYPE, type SudoRequest } from '../../src/sudo/types.js';

const REQ: SudoRequest = {
  kind: 'command',
  detail: 'git push origin main',
  suggestedPattern: 'git push*',
};

afterEach(() => {
  delete (globalThis as Record<string, unknown>).chrome;
});

describe('resolveSudoRequest', () => {
  it('denies when the first confirm is cancelled', () => {
    const decision = resolveSudoRequest(REQ, { confirm: () => false, prompt: () => null });
    expect(decision).toEqual({ decision: 'deny' });
  });

  it('allows when the first confirm passes and the second is cancelled', () => {
    let call = 0;
    const decision = resolveSudoRequest(REQ, {
      confirm: () => call++ === 0,
      prompt: () => null,
    });
    expect(decision).toEqual({ decision: 'allow' });
  });

  it('captures an edited Always pattern', () => {
    const decision = resolveSudoRequest(REQ, {
      confirm: () => true,
      prompt: () => 'git push --force*',
    });
    expect(decision).toEqual({ decision: 'always', pattern: 'git push --force*' });
  });

  it('falls back to the suggested pattern when the prompt is cancelled', () => {
    const decision = resolveSudoRequest(REQ, { confirm: () => true, prompt: () => null });
    expect(decision).toEqual({ decision: 'always', pattern: 'git push*' });
  });
});

describe('installPanelSudoResponder', () => {
  it('returns false when chrome.runtime is unavailable', () => {
    expect(installPanelSudoResponder()).toBe(false);
  });

  it('registers a listener that answers sudo-request envelopes', () => {
    let listener:
      | ((m: unknown, s: unknown, send: (r: unknown) => void) => boolean | undefined)
      | null = null;
    (globalThis as Record<string, unknown>).chrome = {
      runtime: { onMessage: { addListener: (cb: typeof listener) => (listener = cb) } },
    };

    const ok = installPanelSudoResponder({ confirm: () => true, prompt: () => 'edited*' });
    expect(ok).toBe(true);
    expect(listener).toBeTypeOf('function');

    const sendResponse = vi.fn();
    const handled = (
      listener as
        | ((m: unknown, s: unknown, send: (r: unknown) => void) => boolean | undefined)
        | null
    )?.(
      { source: 'offscreen', payload: { type: SUDO_REQUEST_TYPE, request: REQ } },
      {},
      sendResponse
    );
    expect(handled).toBe(false);
    expect(sendResponse).toHaveBeenCalledWith({
      ok: true,
      decision: { decision: 'always', pattern: 'edited*' },
    });
  });

  it('ignores envelopes that are not sudo requests', () => {
    let listener:
      | ((m: unknown, s: unknown, send: (r: unknown) => void) => boolean | undefined)
      | null = null;
    (globalThis as Record<string, unknown>).chrome = {
      runtime: { onMessage: { addListener: (cb: typeof listener) => (listener = cb) } },
    };
    installPanelSudoResponder({ confirm: () => true, prompt: () => null });

    const sendResponse = vi.fn();
    const result = (
      listener as
        | ((m: unknown, s: unknown, send: (r: unknown) => void) => boolean | undefined)
        | null
    )?.({ source: 'panel', payload: { type: 'other' } }, {}, sendResponse);
    expect(result).toBeUndefined();
    expect(sendResponse).not.toHaveBeenCalled();
  });
});
