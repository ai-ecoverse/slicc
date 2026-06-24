/**
 * Tests for `createSudoBroker` float selection. The three broker factories and
 * the proxied-fetch delegate-id accessor are mocked so the branch chosen for
 * each float — extension runtime, thin-bridge kernel worker (`ext=` delegate),
 * and the HTTP fallback — is asserted without a real `chrome` / panel-RPC.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sentinel = (id: string) => ({ requestApproval: vi.fn(), __id: id });

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

import { createSudoBroker } from '../../src/sudo/index.js';

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
    expect((createSudoBroker() as { __id: string }).__id).toBe('extension');
  });

  it('picks the panel-RPC broker in the thin-bridge worker (ext= delegate, no chrome)', () => {
    setChrome(undefined);
    delegateId = 'ext-delegate-id';
    expect((createSudoBroker() as { __id: string }).__id).toBe('panel-rpc');
  });

  it('falls back to the HTTP broker when no chrome and no delegate id', () => {
    setChrome(undefined);
    delegateId = null;
    expect((createSudoBroker() as { __id: string }).__id).toBe('http');
  });

  it('keeps the HTTP broker for a non-extension page realm even with a delegate id', () => {
    // A real `chrome` object without `runtime.id` is the thin-bridge PAGE
    // realm — it routes fetch itself, and the panel responder lives here, so
    // it must NOT pick the worker panel-RPC broker.
    setChrome({ runtime: { connect: () => {} } });
    delegateId = 'ext-delegate-id';
    expect((createSudoBroker() as { __id: string }).__id).toBe('http');
  });
});
