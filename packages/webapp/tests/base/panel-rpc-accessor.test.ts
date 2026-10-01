import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPanelRpcClient, hasLocalDom } from '../../src/base/panel-rpc-accessor.js';
import * as panelRpc from '../../src/kernel/panel-rpc.js';

describe('base/panel-rpc-accessor', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null when no bridge client is published', () => {
    vi.stubGlobal('__slicc_panelRpc', undefined);
    expect(getPanelRpcClient()).toBeNull();
  });

  it('returns the client published on globalThis.__slicc_panelRpc', () => {
    const client = { call: vi.fn() };
    vi.stubGlobal('__slicc_panelRpc', client);
    expect(getPanelRpcClient()).toBe(client);
  });

  it('hasLocalDom is false without window/document and true with both', () => {
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('document', undefined);
    expect(hasLocalDom()).toBe(false);
    vi.stubGlobal('window', {});
    expect(hasLocalDom()).toBe(false);
    vi.stubGlobal('document', {});
    expect(hasLocalDom()).toBe(true);
  });

  it('kernel/panel-rpc re-exports the same functions (#3728)', () => {
    expect(panelRpc.getPanelRpcClient).toBe(getPanelRpcClient);
    expect(panelRpc.hasLocalDom).toBe(hasLocalDom);
  });
});
