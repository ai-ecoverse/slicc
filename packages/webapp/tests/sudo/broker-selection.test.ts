/**
 * Tests for `createSudoBroker` float selection. The three broker factories and
 * the proxied-fetch delegate-id accessor are mocked so the branch chosen for
 * each float — extension runtime, thin-bridge kernel worker (`ext=` delegate),
 * and the HTTP fallback — is asserted without a real `chrome` / panel-RPC.
 *
 * `createSudoBroker` wraps whichever factory it picks in `withApprovalTimeout`,
 * so the returned object is NOT the factory's sentinel. Selection is asserted
 * on which factory ran; the last case pins the wrap itself (an unanswered
 * prompt must settle as a timeout instead of blocking the agent forever).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Never-settling approval: stands in for a prompt nobody answers. */
const sentinel = (id: string) => ({
  requestApproval: vi.fn(() => new Promise<never>(() => {})),
  __id: id,
});

vi.mock('../../src/sudo/extension-broker.js', () => ({
  createExtensionSudoBroker: vi.fn(() => sentinel('extension')),
}));
vi.mock('../../src/sudo/panel-rpc-broker.js', () => ({
  createPanelRpcSudoBroker: vi.fn(() => sentinel('panel-rpc')),
}));
vi.mock('../../src/sudo/http-broker.js', () => ({
  createHttpSudoBroker: vi.fn(() => sentinel('http')),
}));

let delegateId: string | null = null;
vi.mock('../../src/shell/proxied-fetch.js', () => ({
  getExtensionDelegateId: () => delegateId,
}));

import { USER_SUDO_TIMEOUT_MS } from '../../src/sudo/approval-timeout.js';
import { createExtensionSudoBroker } from '../../src/sudo/extension-broker.js';
import { createHttpSudoBroker } from '../../src/sudo/http-broker.js';
import { createSudoBroker } from '../../src/sudo/index.js';
import { createPanelRpcSudoBroker } from '../../src/sudo/panel-rpc-broker.js';

const ORIGINAL_CHROME = (globalThis as { chrome?: unknown }).chrome;

function setChrome(value: unknown): void {
  (globalThis as { chrome?: unknown }).chrome = value;
}

beforeEach(() => {
  delegateId = null;
  setChrome(undefined);
});

afterEach(() => {
  setChrome(ORIGINAL_CHROME);
  vi.clearAllMocks();
});

describe('createSudoBroker selection', () => {
  it('picks the extension broker inside the extension runtime', () => {
    setChrome({ runtime: { id: 'abc' } });
    createSudoBroker();
    expect(createExtensionSudoBroker).toHaveBeenCalledTimes(1);
    expect(createPanelRpcSudoBroker).not.toHaveBeenCalled();
    expect(createHttpSudoBroker).not.toHaveBeenCalled();
  });

  it('picks the panel-RPC broker in the thin-bridge worker (ext= delegate, no chrome)', () => {
    setChrome(undefined);
    delegateId = 'ext-delegate-id';
    createSudoBroker();
    expect(createPanelRpcSudoBroker).toHaveBeenCalledTimes(1);
    expect(createExtensionSudoBroker).not.toHaveBeenCalled();
    expect(createHttpSudoBroker).not.toHaveBeenCalled();
  });

  it('falls back to the HTTP broker when no chrome and no delegate id', () => {
    setChrome(undefined);
    delegateId = null;
    createSudoBroker();
    expect(createHttpSudoBroker).toHaveBeenCalledTimes(1);
    expect(createExtensionSudoBroker).not.toHaveBeenCalled();
    expect(createPanelRpcSudoBroker).not.toHaveBeenCalled();
  });

  it('keeps the HTTP broker for a non-extension page realm even with a delegate id', () => {
    // A real `chrome` object without `runtime.id` is the thin-bridge PAGE
    // realm — it routes fetch itself, and the panel responder lives here, so
    // it must NOT pick the worker panel-RPC broker.
    setChrome({ runtime: { connect: () => {} } });
    delegateId = 'ext-delegate-id';
    createSudoBroker();
    expect(createHttpSudoBroker).toHaveBeenCalledTimes(1);
    expect(createPanelRpcSudoBroker).not.toHaveBeenCalled();
  });

  it('wraps the selected broker so an unanswered prompt times out', async () => {
    vi.useFakeTimers();
    try {
      setChrome(undefined);
      delegateId = null;
      const pending = createSudoBroker().requestApproval({ kind: 'command', detail: 'git push' });
      await vi.advanceTimersByTimeAsync(USER_SUDO_TIMEOUT_MS);
      await expect(pending).resolves.toEqual({ decision: 'deny', reason: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });
});
