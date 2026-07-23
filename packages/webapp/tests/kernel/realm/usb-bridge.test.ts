/**
 * Tests for the realm `usb` RPC channel + the kernel-side WebUSB
 * bridge. Wires the exported `createUsbBridge` factory through a real
 * `RealmRpcClient` connected to `attachRealmHost` with an injected
 * mock `UsbBackend`, so one round-trip exercises the realm device-
 * object surface, the realm-RPC envelope shape, binary transfer, and
 * error propagation without booting a worker.
 */

import type { CommandContext } from 'just-bash';
import { describe, expect, it } from 'vitest';
import { attachRealmHost } from '../../../src/kernel/realm/realm-host.js';
import { RealmRpcClient } from '../../../src/kernel/realm/realm-rpc.js';
import { createUsbBridge } from '../../../src/kernel/realm/realm-usb-bridge.js';
import type { UsbBackend } from '../../../src/shell/supplemental-commands/usb-backends.js';
import { makeCtx, makePortPair } from './device-bridge-test-helpers.js';

interface Recorded {
  op: string;
  args: unknown[];
}

function makeMockBackend(recorded: Recorded[], throwOn?: string): UsbBackend {
  const rec = (op: string, args: unknown[]) => recorded.push({ op, args });
  const guard = (op: string) => {
    if (throwOn === op) throw new Error(`backend ${op} boom`);
  };
  const info = (handle: string) => ({ handle, vendorId: 0x2e8a, productId: 0x0003, opened: false });
  return {
    list: async () => {
      rec('list', []);
      return [info('usb1'), info('usb2')];
    },
    request: async (filters) => {
      rec('request', [filters]);
      return info('usb1');
    },
    info: async (h) => {
      rec('info', [h]);
      return info(h);
    },
    open: async (h) => {
      rec('open', [h]);
      guard('open');
    },
    close: async (h) => rec('close', [h]) as unknown as void,
    reset: async (h) => rec('reset', [h]) as unknown as void,
    selectConfig: async (h, v) => rec('selectConfig', [h, v]) as unknown as void,
    claim: async (h, i) => rec('claim', [h, i]) as unknown as void,
    release: async (h, i) => rec('release', [h, i]) as unknown as void,
    controlIn: async (h, setup, length) => {
      rec('controlIn', [h, setup, length]);
      return { status: 'ok', bytes: new Uint8Array([1, 2, 3]) };
    },
    controlOut: async (h, setup, bytes) => {
      rec('controlOut', [h, setup, bytes]);
      return { status: 'ok', bytesWritten: bytes.byteLength };
    },
    transferIn: async (h, ep, length) => {
      rec('transferIn', [h, ep, length]);
      return { status: 'ok', bytes: new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]) };
    },
    transferOut: async (h, ep, bytes) => {
      rec('transferOut', [h, ep, bytes]);
      return { status: 'ok', bytesWritten: bytes.byteLength };
    },
  };
}

function setup(recorded: Recorded[], throwOn?: string) {
  const ctx: CommandContext = makeCtx();
  const { realm, host } = makePortPair();
  const handle = attachRealmHost(host, ctx, { usbBackend: makeMockBackend(recorded, throwOn) });
  const client = new RealmRpcClient(realm);
  const usb = createUsbBridge(client);
  return {
    usb,
    dispose: () => {
      client.dispose();
      handle.dispose();
    },
  };
}

describe('realm usb bridge', () => {
  it('lists granted devices as device objects with the right handle', async () => {
    const rec: Recorded[] = [];
    const { usb, dispose } = setup(rec);
    const devices = await usb.list();
    expect(devices.map((d) => d.handle)).toEqual(['usb1', 'usb2']);
    expect(typeof devices[0].transferIn).toBe('function');
    expect(rec).toContainEqual({ op: 'list', args: [] });
    dispose();
  });

  it('normalizes a single filter object into an array on request', async () => {
    const rec: Recorded[] = [];
    const { usb, dispose } = setup(rec);
    const device = await usb.request({ vendorId: 0x2e8a });
    expect(device.handle).toBe('usb1');
    expect(rec[0]).toEqual({ op: 'request', args: [[{ vendorId: 0x2e8a }]] });
    dispose();
  });

  it('forwards lifecycle ops keyed by the device handle', async () => {
    const rec: Recorded[] = [];
    const { usb, dispose } = setup(rec);
    const device = await usb.request([]);
    await device.open();
    await device.claimInterface(0);
    await device.selectConfiguration(1);
    expect(rec).toContainEqual({ op: 'open', args: ['usb1'] });
    expect(rec).toContainEqual({ op: 'claim', args: ['usb1', 0] });
    expect(rec).toContainEqual({ op: 'selectConfig', args: ['usb1', 1] });
    dispose();
  });

  it('round-trips an in-transfer as a DataView over the returned bytes', async () => {
    const rec: Recorded[] = [];
    const { usb, dispose } = setup(rec);
    const device = await usb.request([]);
    const result = await device.transferIn(1, 64);
    expect(result.status).toBe('ok');
    expect(result.data).toBeInstanceOf(DataView);
    const bytes = new Uint8Array(
      result.data.buffer,
      result.data.byteOffset,
      result.data.byteLength
    );
    expect([...bytes]).toEqual([0xaa, 0xbb, 0xcc, 0xdd]);
    expect(rec).toContainEqual({ op: 'transferIn', args: ['usb1', 1, 64] });
    dispose();
  });

  it('sends an out-transfer payload as Uint8Array bytes', async () => {
    const rec: Recorded[] = [];
    const { usb, dispose } = setup(rec);
    const device = await usb.request([]);
    const written = await device.transferOut(2, new Uint8Array([9, 8, 7]));
    expect(written).toEqual({ status: 'ok', bytesWritten: 3 });
    const sent = rec.find((r) => r.op === 'transferOut');
    expect(sent?.args[2]).toBeInstanceOf(Uint8Array);
    expect([...(sent?.args[2] as Uint8Array)]).toEqual([9, 8, 7]);
    dispose();
  });

  it('propagates backend errors to the realm caller', async () => {
    const rec: Recorded[] = [];
    const { usb, dispose } = setup(rec, 'open');
    const device = await usb.request([]);
    await expect(device.open()).rejects.toThrow(/backend open boom/);
    dispose();
  });

  it('rejects unknown usb ops with a clear error', async () => {
    const rec: Recorded[] = [];
    const ctx = makeCtx();
    const { realm, host } = makePortPair();
    const handle = attachRealmHost(host, ctx, { usbBackend: makeMockBackend(rec) });
    const client = new RealmRpcClient(realm);
    await expect(client.call('usb', 'bogusOp', [])).rejects.toThrow(/unknown usb op/);
    client.dispose();
    handle.dispose();
  });
});
