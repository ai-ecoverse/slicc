import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { loadAndClearPendingHandle } from '../../../src/fs/mount-picker-popup.js';
import { getSharedHidRegistry } from '../../../src/kernel/hid-device-registry.js';
import { getSharedSerialRegistry } from '../../../src/kernel/serial-port-registry.js';
import { getSharedUsbRegistry } from '../../../src/kernel/usb-device-registry.js';
import { createStandalonePanelRpcHandlers } from '../../../src/ui/panel-rpc-handlers.js';

describe('createStandalonePanelRpcHandlers — list-remote-targets', () => {
  it('returns empty targets when no listRemoteTargets callback wired', async () => {
    const handlers = createStandalonePanelRpcHandlers({});
    const result = await handlers['list-remote-targets']!(undefined);
    expect(result).toEqual({ targets: [] });
  });

  it('filters to composite targetIds only', async () => {
    const handlers = createStandalonePanelRpcHandlers({
      listRemoteTargets: () => [
        { targetId: 'local-1', title: 'Local Tab', url: 'https://local.example.com' },
        {
          targetId: 'runtime-abc:tab-1',
          title: 'Follower Tab',
          url: 'https://follower.example.com',
        },
      ],
    });
    const result = await handlers['list-remote-targets']!(undefined);
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0].targetId).toBe('runtime-abc:tab-1');
  });
});

describe('createStandalonePanelRpcHandlers — remote-cdp', () => {
  const makeBridge = () => {
    const calls: string[] = [];
    return {
      calls,
      bridge: {
        send: vi.fn(async (p: { method: string }) => {
          calls.push(`send:${p.method}`);
          return { echoed: p.method };
        }),
        subscribe: vi.fn(async () => {
          calls.push('subscribe');
          return { ok: true as const };
        }),
        unsubscribe: vi.fn(async () => {
          calls.push('unsubscribe');
          return { ok: true as const };
        }),
        detach: vi.fn(async () => {
          calls.push('detach');
          return { ok: true as const };
        }),
        openTab: vi.fn(async () => {
          calls.push('openTab');
          return { targetId: 'follower-1:new' };
        }),
        cleanupRuntime: vi.fn(),
        disposeAll: vi.fn(),
      },
    };
  };

  it('routes remote-cdp-send to the bridge', async () => {
    const { bridge } = makeBridge();
    const handlers = createStandalonePanelRpcHandlers({ remoteCdp: bridge });
    const result = await handlers['remote-cdp-send']!({
      runtimeId: 'follower-1',
      localTargetId: 'tgt-1',
      method: 'Page.captureScreenshot',
    });
    expect(result).toEqual({ echoed: 'Page.captureScreenshot' });
    expect(bridge.send).toHaveBeenCalledOnce();
  });

  it('routes subscribe / unsubscribe / detach / open-tab to the bridge', async () => {
    const { bridge } = makeBridge();
    const handlers = createStandalonePanelRpcHandlers({ remoteCdp: bridge });
    expect(
      await handlers['remote-cdp-subscribe']!({
        runtimeId: 'f',
        localTargetId: 't',
        event: 'Page.loadEventFired',
      })
    ).toEqual({ ok: true });
    expect(
      await handlers['remote-cdp-unsubscribe']!({
        runtimeId: 'f',
        localTargetId: 't',
        event: 'Page.loadEventFired',
      })
    ).toEqual({ ok: true });
    expect(await handlers['remote-cdp-detach']!({ runtimeId: 'f', localTargetId: 't' })).toEqual({
      ok: true,
    });
    expect(await handlers['remote-open-tab']!({ runtimeId: 'f', url: 'about:blank' })).toEqual({
      targetId: 'follower-1:new',
    });
  });

  it('rejects remote-cdp-send when no bridge is wired', async () => {
    const handlers = createStandalonePanelRpcHandlers({});
    await expect(
      handlers['remote-cdp-send']!({ runtimeId: 'f', localTargetId: 't', method: 'Page.enable' })
    ).rejects.toThrow(/remote-cdp bridge not available/);
  });
});

/**
 * `secrets-bridge` is the panel-RPC op that lets a kernel-worker `secrets.crud`
 * call (no `chrome` in the worker) reach the thin-bridge extension. The handler
 * runs in the PAGE realm, where `callSecretsBridge` takes its direct-Port
 * branch (covered by `tests/core/secrets-bridge-client.test.ts`); here we
 * assert the handler forwards the `{ type, payload }` it received and wraps the
 * SW response in `{ response }` verbatim.
 */

describe('createStandalonePanelRpcHandlers — permission-request', () => {
  function fakeUsbDevice(vendorId: number, productId: number, serialNumber: string) {
    return {
      vendorId,
      productId,
      productName: 'fake',
      serialNumber,
      opened: false,
      open: async () => {},
      close: async () => {},
      selectConfiguration: async () => {},
      claimInterface: async () => {},
      releaseInterface: async () => {},
      controlTransferIn: async () => ({}),
      controlTransferOut: async () => ({ bytesWritten: 0 }),
      transferIn: async () => ({}),
      transferOut: async () => ({ bytesWritten: 0 }),
      reset: async () => {},
    };
  }
  function fakeFsHandle(name: string) {
    return { kind: 'directory', name } as unknown as FileSystemDirectoryHandle;
  }

  it('rejects when no permission surface is registered', async () => {
    const handlers = createStandalonePanelRpcHandlers({});
    await expect(
      handlers['permission-request']!({ kinds: ['usb'], description: 'pls' })
    ).rejects.toThrow(/permission surface unavailable/i);
  });

  it('registers usb grants into the shared registry and returns the handle', async () => {
    const device = fakeUsbDevice(0x1234, 0x5678, 'rpc-test-a');
    const surface = {
      prompt: vi.fn().mockResolvedValue({
        status: 'granted',
        grants: [{ kind: 'usb', device }],
      }),
    };
    const handlers = createStandalonePanelRpcHandlers({
      getPermissionsSurface: () => surface as never,
    });
    const result = await handlers['permission-request']!({
      kinds: ['usb'],
      description: 'Pick a USB device',
    });
    expect(surface.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ kinds: ['usb'], skipIfGranted: false })
    );
    expect(result.grants).toHaveLength(1);
    const grant = result.grants[0];
    expect(grant.kind).toBe('usb');
    if (grant.kind !== 'usb') throw new Error('unreachable');
    expect(grant.handle).toMatch(/^usb\d+$/);
    // The shared registry returned the same handle the picker path would.
    expect(getSharedUsbRegistry().get(grant.handle)).toBe(device);
  });

  it('stashes filesystem grants via storePendingHandle and returns the IDB key', async () => {
    const handle = fakeFsHandle('rpc-dir');
    const surface = {
      prompt: vi.fn().mockResolvedValue({
        status: 'granted',
        grants: [{ kind: 'filesystem', handle, source: 'picker', permission: 'granted' }],
      }),
    };
    const handlers = createStandalonePanelRpcHandlers({
      getPermissionsSurface: () => surface as never,
    });
    const result = await handlers['permission-request']!({
      kinds: ['filesystem'],
      description: 'Pick a folder',
    });
    expect(result.grants).toHaveLength(1);
    const grant = result.grants[0];
    if (grant.kind !== 'filesystem') throw new Error('unreachable');
    expect(grant.idbKey).toMatch(/^pendingMount:rpc-/);
    expect(grant.dirName).toBe('rpc-dir');
    const round = await loadAndClearPendingHandle(grant.idbKey);
    expect(round).toStrictEqual(handle);
  });

  it('reports media / screenshare grants as ok-only and stops the probe stream tracks', async () => {
    // The probe MediaStream can't cross the bridge and the worker opens its
    // own capture stream downstream, so the handler MUST stop these tracks
    // or a duplicate camera/mic capture leaks alive on the page.
    const camTrack = { stop: vi.fn() };
    const micTrack = { stop: vi.fn() };
    const surface = {
      prompt: vi.fn().mockResolvedValue({
        status: 'granted',
        grants: [
          { kind: 'camera', stream: { getTracks: () => [camTrack] } },
          { kind: 'microphone', stream: { getTracks: () => [micTrack] } },
        ],
      }),
    };
    const handlers = createStandalonePanelRpcHandlers({
      getPermissionsSurface: () => surface as never,
    });
    const result = await handlers['permission-request']!({
      kinds: ['camera', 'microphone'],
      description: 'cam+mic',
    });
    expect(result.grants).toEqual([
      { kind: 'camera', ok: true },
      { kind: 'microphone', ok: true },
    ]);
    expect(surface.prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        kinds: ['camera', 'microphone'],
        skipIfGranted: true,
      })
    );
    expect(camTrack.stop).toHaveBeenCalledTimes(1);
    expect(micTrack.stop).toHaveBeenCalledTimes(1);
  });

  it('forwards an explicit skipIfGranted=false even for camera/mic payloads', async () => {
    const surface = {
      prompt: vi.fn().mockResolvedValue({
        status: 'granted',
        grants: [{ kind: 'camera', stream: { getTracks: () => [{ stop: vi.fn() }] } }],
      }),
    };
    const handlers = createStandalonePanelRpcHandlers({
      getPermissionsSurface: () => surface as never,
    });
    await handlers['permission-request']!({
      kinds: ['camera'],
      description: 'cam',
      skipIfGranted: false,
    });
    expect(surface.prompt).toHaveBeenCalledWith(expect.objectContaining({ skipIfGranted: false }));
  });

  it('does not auto-skip gesture-bound kinds such as screenshare', async () => {
    const surface = {
      prompt: vi.fn().mockResolvedValue({
        status: 'granted',
        grants: [{ kind: 'screenshare', stream: { getTracks: () => [{ stop: vi.fn() }] } }],
      }),
    };
    const handlers = createStandalonePanelRpcHandlers({
      getPermissionsSurface: () => surface as never,
    });
    await handlers['permission-request']!({
      kinds: ['screenshare'],
      description: 'share',
    });
    expect(surface.prompt).toHaveBeenCalledWith(expect.objectContaining({ skipIfGranted: false }));
  });

  it('rejects with the surface reason when the user cancels', async () => {
    const surface = {
      prompt: vi.fn().mockResolvedValue({
        status: 'cancelled',
        grants: [],
        reason: 'cancelled',
      }),
    };
    const handlers = createStandalonePanelRpcHandlers({
      getPermissionsSurface: () => surface as never,
    });
    await expect(
      handlers['permission-request']!({ kinds: ['usb'], description: 'pls' })
    ).rejects.toThrow(/cancelled/i);
  });

  it('registers hid + serial grants into the shared registries', async () => {
    const hidDevice = {
      vendorId: 1,
      productId: 2,
      productName: 'kbd',
      opened: false,
      collections: [],
      open: async () => {},
      close: async () => {},
      sendReport: async () => {},
      sendFeatureReport: async () => {},
      receiveFeatureReport: async () => new DataView(new ArrayBuffer(0)),
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    const serialPort = {
      readable: null,
      writable: null,
      getInfo: () => ({}),
      open: async () => {},
      close: async () => {},
      setSignals: async () => {},
      getSignals: async () => ({
        clearToSend: false,
        dataCarrierDetect: false,
        dataSetReady: false,
        ringIndicator: false,
      }),
    };
    const surface = {
      prompt: vi.fn().mockResolvedValue({
        status: 'granted',
        grants: [
          { kind: 'hid', device: hidDevice, devices: [hidDevice] },
          { kind: 'serial', port: serialPort },
        ],
      }),
    };
    const handlers = createStandalonePanelRpcHandlers({
      getPermissionsSurface: () => surface as never,
    });
    const result = await handlers['permission-request']!({
      kinds: ['hid', 'serial'],
      description: 'both',
    });
    expect(result.grants).toHaveLength(2);
    const [hidGrant, serialGrant] = result.grants;
    if (hidGrant.kind !== 'hid' || serialGrant.kind !== 'serial') {
      throw new Error('unreachable');
    }
    expect(hidGrant.handle).toMatch(/^hid\d+$/);
    expect(serialGrant.handle).toMatch(/^serial\d+$/);
    expect(getSharedHidRegistry().get(hidGrant.handle)).toBe(hidDevice);
    expect(getSharedSerialRegistry().get(serialGrant.handle)?.port).toBe(serialPort);
  });
});
