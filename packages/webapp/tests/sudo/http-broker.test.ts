/**
 * Tests for the CLI/standalone HTTP sudo broker. `fetch` and the pattern
 * suggester are injected so transport and fail-closed paths are deterministic.
 */

import { describe, expect, it, vi } from 'vitest';
import { createHttpSudoBroker } from '../../src/sudo/http-broker.js';
import { SUDO_APPROVE_PATH, type SudoRequest } from '../../src/sudo/types.js';

const REQ: SudoRequest = { kind: 'command', detail: 'git push origin main' };

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

const suggest = vi.fn(async () => 'git push*');

describe('createHttpSudoBroker', () => {
  it('POSTs the request with the suggested pattern and returns the decision', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ decision: 'allow' }));
    const broker = createHttpSudoBroker({ fetchImpl, suggest });
    expect(await broker.requestApproval(REQ)).toEqual({ decision: 'allow' });
    expect(fetchImpl).toHaveBeenCalledWith(
      SUDO_APPROVE_PATH,
      expect.objectContaining({ method: 'POST' })
    );
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({
      kind: 'command',
      detail: 'git push origin main',
      suggestedPattern: 'git push*',
    });
  });

  it('passes through an always decision with its pattern', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ decision: 'always', pattern: 'git push*' }));
    const broker = createHttpSudoBroker({ fetchImpl, suggest });
    expect(await broker.requestApproval(REQ)).toEqual({ decision: 'always', pattern: 'git push*' });
  });

  it('fills an always decision missing a pattern with the suggested default', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ decision: 'always' }));
    const broker = createHttpSudoBroker({ fetchImpl, suggest });
    expect(await broker.requestApproval(REQ)).toEqual({ decision: 'always', pattern: 'git push*' });
  });

  it('denies on a non-OK status', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ decision: 'allow' }, false, 500));
    const broker = createHttpSudoBroker({ fetchImpl, suggest });
    expect(await broker.requestApproval(REQ)).toEqual({ decision: 'deny' });
  });

  it('denies on a transport error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    const broker = createHttpSudoBroker({ fetchImpl, suggest });
    expect(await broker.requestApproval(REQ)).toEqual({ decision: 'deny' });
  });

  it('denies on an unrecognized decision shape', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ decision: 'maybe' }));
    const broker = createHttpSudoBroker({ fetchImpl, suggest });
    expect(await broker.requestApproval(REQ)).toEqual({ decision: 'deny' });
  });

  it('still POSTs when the suggester throws (uses detail)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ decision: 'allow' }));
    const broker = createHttpSudoBroker({
      fetchImpl,
      suggest: vi.fn(async () => {
        throw new Error('llm down');
      }),
    });
    await broker.requestApproval(REQ);
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body.suggestedPattern).toBe('git push origin main');
  });
});
