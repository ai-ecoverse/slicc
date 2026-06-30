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
import type { PageInfo } from '../../src/cdp/index.js';
import type { PanelRpcClient } from '../../src/kernel/panel-rpc.js';
import {
  filterActionableTargets,
  findAppTabId,
  isChromeInternalUiTarget,
  isTrayConfigured,
  listFederatedTargets,
  resolveAppOrigin,
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

// ---------------------------------------------------------------------------
// Actionable-target filtering (F4-code) — the parity primitive shared by
// `playwright tab-list` and the cup `/api/targets` bridge.
// ---------------------------------------------------------------------------

function page(p: Partial<PageInfo> & { targetId: string }): PageInfo {
  return { url: '', title: '', ...p };
}

describe('isChromeInternalUiTarget', () => {
  it('flags the omnibox popup, chrome://, devtools://, and untrusted/search schemes', () => {
    expect(isChromeInternalUiTarget(page({ targetId: 'a', title: 'Omnibox Popup' }))).toBe(true);
    expect(isChromeInternalUiTarget(page({ targetId: 'b', url: 'chrome://settings/' }))).toBe(true);
    expect(isChromeInternalUiTarget(page({ targetId: 'c', url: 'devtools://devtools/' }))).toBe(
      true
    );
    expect(
      isChromeInternalUiTarget(page({ targetId: 'd', url: 'chrome-search://local-ntp/' }))
    ).toBe(true);
    expect(
      isChromeInternalUiTarget(page({ targetId: 'e', url: 'chrome-untrusted://print/' }))
    ).toBe(true);
    expect(isChromeInternalUiTarget(page({ targetId: 'f', url: '', title: 'Some Popup' }))).toBe(
      true
    );
  });

  it('does not flag a real http(s) page', () => {
    expect(isChromeInternalUiTarget(page({ targetId: 'x', url: 'https://example.com' }))).toBe(
      false
    );
  });
});

describe('findAppTabId', () => {
  const pages: PageInfo[] = [
    page({ targetId: 'app', url: 'http://localhost:5710/?cup=1', title: 'App' }),
    page({ targetId: 'real', url: 'https://example.com', title: 'Example' }),
    page({ targetId: 'follower-x:tab', url: 'http://localhost:5710/page', title: 'Follower' }),
  ];

  it('returns the local app-origin tab targetId', () => {
    expect(findAppTabId(pages, 'http://localhost:5710')).toBe('app');
  });

  it('never matches a federated (composite) target even if its url shares the origin', () => {
    const onlyFollower = [pages[2]];
    expect(findAppTabId(onlyFollower, 'http://localhost:5710')).toBeNull();
  });

  it('ignores local /preview/* service-worker pages', () => {
    const preview = [page({ targetId: 'pv', url: 'http://localhost:5710/preview/x.html' })];
    expect(findAppTabId(preview, 'http://localhost:5710')).toBeNull();
  });

  it('returns null when no app tab is present', () => {
    expect(findAppTabId([pages[1]], 'http://localhost:5710')).toBeNull();
  });
});

describe('filterActionableTargets', () => {
  it('drops the app tab + chrome-internal, keeps real local + follower targets', () => {
    const pages: PageInfo[] = [
      page({ targetId: 'app', url: 'http://localhost:5710/?cup=1', title: 'App' }),
      page({ targetId: 'omni', url: 'chrome://new-tab-page/', title: 'Omnibox Popup' }),
      page({ targetId: 'real', url: 'https://example.com', title: 'Example' }),
      page({ targetId: 'follower-x:tab', url: 'https://mail.google.com/', title: 'Gmail' }),
    ];
    const result = filterActionableTargets(pages, 'app');
    expect(result.map((p) => p.targetId)).toEqual(['real', 'follower-x:tab']);
  });

  it('drops nothing extra when appTabId is null (still removes chrome-internal)', () => {
    const pages: PageInfo[] = [
      page({ targetId: 'omni', url: 'chrome://history/', title: 'History' }),
      page({ targetId: 'real', url: 'https://example.com', title: 'Example' }),
    ];
    expect(filterActionableTargets(pages, null).map((p) => p.targetId)).toEqual(['real']);
  });
});

describe('resolveAppOrigin', () => {
  it('falls back to the default origin when no panel-RPC client is available', async () => {
    expect(await resolveAppOrigin(() => null)).toBe('http://localhost:5710');
  });

  it('uses the panel-RPC page-info origin when available', async () => {
    const call = vi.fn().mockResolvedValue({
      origin: 'http://localhost:5720',
      href: 'http://localhost:5720/?cup=1',
      title: 'App',
    });
    expect(await resolveAppOrigin(rpc(call))).toBe('http://localhost:5720');
    expect(call).toHaveBeenCalledWith('page-info', undefined, { timeoutMs: 2000 });
  });

  it('falls back to the default origin when page-info rejects', async () => {
    const call = vi.fn().mockRejectedValue(new Error('rpc down'));
    expect(await resolveAppOrigin(rpc(call))).toBe('http://localhost:5710');
  });
});
