// @vitest-environment jsdom

import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { SudoRequest } from '../../src/sudo/types.js';

const REQ: SudoRequest = {
  kind: 'command',
  detail: 'git push origin main',
  suggestedPattern: 'git push*',
};

const capturedConfirm = vi.fn(() => false);
const capturedPrompt = vi.fn(() => null);

let resolveSudoRequest: typeof import('../../src/sudo/panel-responder.js').resolveSudoRequest;

beforeAll(async () => {
  window.confirm = capturedConfirm as unknown as typeof window.confirm;
  window.prompt = capturedPrompt as unknown as typeof window.prompt;

  ({ resolveSudoRequest } = await import('../../src/sudo/panel-responder.js'));
});

describe('panel responder native capture (H1)', () => {
  it('calls the captured native, not a later globalThis.confirm override', () => {
    capturedConfirm.mockClear();
    const hijack = vi.fn(() => true);

    window.confirm = hijack as unknown as typeof window.confirm;
    globalThis.confirm = hijack as unknown as typeof globalThis.confirm;

    const decision = resolveSudoRequest(REQ);

    expect(decision).toEqual({ decision: 'deny' });
    expect(capturedConfirm).toHaveBeenCalledTimes(1);
    expect(hijack).not.toHaveBeenCalled();
  });

  it('the captured native is invocable without an Illegal-invocation throw', () => {
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
