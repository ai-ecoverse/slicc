// Unit tests for the shared federated-target listing helper.
//
// Covers:
// - runtimeIdFromTargetId: local (no colon) vs composite "{runtime}:{local}"
// - isTrayConfigured: reads the localStorage shim tray keys
// - listFederatedTargets: listAllTargets path + panel-RPC supplement, the
//   listPages fallback when listAllTargets is absent, the tray gate, dedup,
//   and graceful degradation when the supplement rejects.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserAPI } from '../../src/cdp/browser-api.js';
import type { PanelRpcClient } from '../../src/kernel/panel-rpc.js';
import {
  isTrayConfigured,
  listFederatedTargets,
  runtimeIdFromTargetId,
} from '../../src/scoops/federated-targets.js';
import {
  TRAY_JOIN_STORAGE_KEY,
  TRAY_WORKER_STORAGE_KEY,
} from '../../src/scoops/tray-runtime-config.js';

function setLocalStorage(value: unknown): void {
  (globalThis as { localStorage?: unknown }).localStorage = value;
}

function rpc(call: ReturnType<typeof vi.fn>): () => PanelRpcClient {
  return () => ({ call }) as unknown as PanelRpcClient;
}

afterEach(() => {
  setLocalStorage(undefined);
});

describe('runtimeIdFromTargetId', () => {
  it('returns null for a local (colon-free) target id', () => {
    expect(runtimeIdFromTargetId('local-target-1')).toBeNull();
  });

  it('returns the runtime id for a composite target id', () => {
    expect(runtimeIdFromTargetId('follower-abc:remote-tab')).toBe('follower-abc');
  });

  it('splits on the FIRST colon only', () => {
    expect(runtimeIdFromTargetId('follower-abc:tab:weird')).toBe('follower-abc');
  });
});

describe('isTrayConfigured', () => {
  it('is false when there is no localStorage', () => {
    setLocalStorage(undefined);
    expect(isTrayConfigured()).toBe(false);
  });

  it('is false when neither tray key is set', () => {
    setLocalStorage({ getItem: () => null });
    expect(isTrayConfigured()).toBe(false);
  });

  it('is true when the leader worker key is set', () => {
    setLocalStorage({ getItem: (k: string) => (k === TRAY_WORKER_STORAGE_KEY ? 'x' : null) });
    expect(isTrayConfigured()).toBe(true);
  });

  it('is true when the follower join key is set', () => {
    setLocalStorage({ getItem: (k: string) => (k === TRAY_JOIN_STORAGE_KEY ? 'x' : null) });
    expect(isTrayConfigured()).toBe(true);
  });

  it('is false when getItem throws', () => {
    setLocalStorage({
      getItem: () => {
        throw new Error('boom');
      },
    });
    expect(isTrayConfigured()).toBe(false);
  });
});

describe('listFederatedTargets', () => {
  it('falls back to listPages when listAllTargets is absent', async () => {
    const browser = {
      listPages: vi
        .fn()
        .mockResolvedValue([{ targetId: 'p1', url: 'https://a.example', title: 'A' }]),
    } as unknown as BrowserAPI;
    const result = await listFederatedTargets(browser, () => null);
    expect(result).toEqual([{ targetId: 'p1', url: 'https://a.example', title: 'A' }]);
  });

  it('returns local-only when no tray is configured (supplement gated out)', async () => {
    setLocalStorage({ getItem: () => null });
    const call = vi.fn().mockResolvedValue({ targets: [] });
    const browser = {
      listAllTargets: vi
        .fn()
        .mockResolvedValue([{ targetId: 'local-1', url: 'https://l.example', title: 'L' }]),
    } as unknown as BrowserAPI;
    const result = await listFederatedTargets(browser, rpc(call));
    expect(call).not.toHaveBeenCalled();
    expect(result).toEqual([{ targetId: 'local-1', url: 'https://l.example', title: 'L' }]);
  });

  it('returns local-only when a tray is configured but no panel-RPC client is available', async () => {
    setLocalStorage({ getItem: (k: string) => (k === TRAY_WORKER_STORAGE_KEY ? 'x' : null) });
    const browser = {
      listAllTargets: vi
        .fn()
        .mockResolvedValue([{ targetId: 'local-1', url: 'https://l.example', title: 'L' }]),
    } as unknown as BrowserAPI;
    const result = await listFederatedTargets(browser, () => null);
    expect(result).toEqual([{ targetId: 'local-1', url: 'https://l.example', title: 'L' }]);
  });

  it('merges and dedupes the federated supplement when a tray is configured', async () => {
    setLocalStorage({ getItem: (k: string) => (k === TRAY_WORKER_STORAGE_KEY ? 'x' : null) });
    const browser = {
      listAllTargets: vi
        .fn()
        .mockResolvedValue([{ targetId: 'local-1', url: 'https://l.example', title: 'L' }]),
    } as unknown as BrowserAPI;
    const call = vi.fn().mockResolvedValue({
      targets: [
        { targetId: 'f:1', url: 'https://f1.example', title: 'F1' },
        { targetId: 'f:1', url: 'https://f1.example', title: 'F1' }, // dup within reply
        { targetId: 'local-1', url: 'https://l.example', title: 'L' }, // dup of local
      ],
    });
    const result = await listFederatedTargets(browser, rpc(call));
    expect(result).toEqual([
      { targetId: 'local-1', url: 'https://l.example', title: 'L' },
      { targetId: 'f:1', url: 'https://f1.example', title: 'F1' },
    ]);
  });

  it('degrades to local-only when the supplement rejects', async () => {
    setLocalStorage({ getItem: (k: string) => (k === TRAY_WORKER_STORAGE_KEY ? 'x' : null) });
    const browser = {
      listAllTargets: vi
        .fn()
        .mockResolvedValue([{ targetId: 'local-1', url: 'https://l.example', title: 'L' }]),
    } as unknown as BrowserAPI;
    const call = vi.fn().mockRejectedValue(new Error('rpc down'));
    const result = await listFederatedTargets(browser, rpc(call));
    expect(result).toEqual([{ targetId: 'local-1', url: 'https://l.example', title: 'L' }]);
  });
});
