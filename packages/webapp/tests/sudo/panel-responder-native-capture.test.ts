// @vitest-environment jsdom
/**
 * H1 regression: the panel sudo responder must call the native `confirm` /
 * `prompt` captured at MODULE INIT, never the live `globalThis` properties.
 *
 * Lives in its own file (and its own jsdom environment) because the assertion
 * only means anything when a real native modal EXISTS to capture — the default
 * webapp `node` project has none, so an override test there can only prove the
 * fail-closed path, not that the capture actually wins. Here jsdom supplies
 * `window.confirm`/`window.prompt`, we stub them BEFORE importing the module
 * under test (so those stubs are what gets captured), then reassign the globals
 * afterwards to simulate a dynamically registered panel trying to self-approve.
 *
 * Why this matters: a page-realm `globalThis.confirm = () => true` would
 * otherwise auto-answer every approval, including the writes to /etc/sudoers
 * that `matchPath` always gates and no NOPASSWD rule can override.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { SudoRequest } from '../../src/sudo/types.js';

const REQ: SudoRequest = {
  kind: 'command',
  detail: 'git push origin main',
  suggestedPattern: 'git push*',
};

/** The natives present at capture time — deny, so an override flips the outcome. */
const capturedConfirm = vi.fn(() => false);
const capturedPrompt = vi.fn(() => null);

let resolveSudoRequest: typeof import('../../src/sudo/panel-responder.js').resolveSudoRequest;

beforeAll(async () => {
  // Install the "natives" first: the module binds these at evaluation.
  window.confirm = capturedConfirm as unknown as typeof window.confirm;
  window.prompt = capturedPrompt as unknown as typeof window.prompt;
  // Dynamic import so the capture happens AFTER the stubs are in place.
  ({ resolveSudoRequest } = await import('../../src/sudo/panel-responder.js'));
});

describe('panel responder native capture (H1)', () => {
  it('calls the captured native, not a later globalThis.confirm override', () => {
    capturedConfirm.mockClear();
    const hijack = vi.fn(() => true);
    // A dynamically registered panel reassigns the global AFTER boot.
    window.confirm = hijack as unknown as typeof window.confirm;
    globalThis.confirm = hijack as unknown as typeof globalThis.confirm;

    const decision = resolveSudoRequest(REQ);

    // The captured (deny) native decided; the hijack never ran.
    expect(decision).toEqual({ decision: 'deny' });
    expect(capturedConfirm).toHaveBeenCalledTimes(1);
    expect(hijack).not.toHaveBeenCalled();
  });

  it('the captured native is invocable without an Illegal-invocation throw', () => {
    // Regression guard for the `.bind(globalThis)` in the capture: `confirm`
    // and `prompt` are [[Call]]-on-window intrinsics and throw a TypeError if
    // captured detached and then invoked.
    capturedConfirm.mockClear();
    capturedConfirm.mockReturnValue(false);
    expect(() => resolveSudoRequest(REQ)).not.toThrow();
    expect(capturedConfirm).toHaveBeenCalled();
  });

  it('an explicitly injected seam still overrides the capture (DI path intact)', () => {
    const decision = resolveSudoRequest(REQ, { confirm: () => true, prompt: () => 'edited*' });
    expect(decision).toEqual({ decision: 'always', pattern: 'edited*' });
  });
});
