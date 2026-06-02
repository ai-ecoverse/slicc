/**
 * Tests for the extension (offscreen → panel) sudo broker. A fake
 * `chrome.runtime.sendMessage` stands in for the relay.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExtensionSudoBroker } from '../../src/sudo/extension-broker.js';
import { SUDO_REQUEST_TYPE, type SudoRequest } from '../../src/sudo/types.js';

const REQ: SudoRequest = { kind: 'command', detail: 'git push origin main' };
const suggest = vi.fn(async () => 'git push*');

interface FakeChrome {
  runtime: {
    lastError?: { message?: string } | null;
    sendMessage: ReturnType<typeof vi.fn>;
  };
}

function installChrome(chrome: FakeChrome | undefined): void {
  (globalThis as Record<string, unknown>).chrome = chrome;
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).chrome;
});

describe('createExtensionSudoBroker', () => {
  it('relays the request and resolves the panel decision', async () => {
    const sendMessage = vi.fn((_msg: unknown, cb: (r: unknown) => void) =>
      cb({ ok: true, decision: { decision: 'allow' } })
    );
    installChrome({ runtime: { lastError: null, sendMessage } });

    const broker = createExtensionSudoBroker({ suggest });
    expect(await broker.requestApproval(REQ)).toEqual({ decision: 'allow' });

    const [msg] = sendMessage.mock.calls[0];
    expect(msg).toMatchObject({
      source: 'offscreen',
      payload: { type: SUDO_REQUEST_TYPE, request: { suggestedPattern: 'git push*' } },
    });
  });

  it('fills an always decision missing a pattern from the suggestion', async () => {
    const sendMessage = vi.fn((_msg: unknown, cb: (r: unknown) => void) =>
      cb({ ok: true, decision: { decision: 'always' } })
    );
    installChrome({ runtime: { lastError: null, sendMessage } });
    const broker = createExtensionSudoBroker({ suggest });
    expect(await broker.requestApproval(REQ)).toEqual({ decision: 'always', pattern: 'git push*' });
  });

  it('denies when chrome.runtime is unavailable', async () => {
    installChrome(undefined);
    const broker = createExtensionSudoBroker({ suggest });
    expect(await broker.requestApproval(REQ)).toEqual({ decision: 'deny' });
  });

  it('denies on a lastError', async () => {
    const sendMessage = vi.fn((_msg: unknown, cb: (r: unknown) => void) => cb(undefined));
    installChrome({ runtime: { lastError: { message: 'boom' }, sendMessage } });
    const broker = createExtensionSudoBroker({ suggest });
    expect(await broker.requestApproval(REQ)).toEqual({ decision: 'deny' });
  });

  it('denies on an error response', async () => {
    const sendMessage = vi.fn((_msg: unknown, cb: (r: unknown) => void) =>
      cb({ ok: false, error: 'panel error' })
    );
    installChrome({ runtime: { lastError: null, sendMessage } });
    const broker = createExtensionSudoBroker({ suggest });
    expect(await broker.requestApproval(REQ)).toEqual({ decision: 'deny' });
  });

  it('denies when sendMessage throws', async () => {
    const sendMessage = vi.fn(() => {
      throw new Error('relay down');
    });
    installChrome({ runtime: { lastError: null, sendMessage } });
    const broker = createExtensionSudoBroker({ suggest });
    expect(await broker.requestApproval(REQ)).toEqual({ decision: 'deny' });
  });
});
