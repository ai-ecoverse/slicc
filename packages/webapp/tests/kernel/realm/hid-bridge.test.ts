/**
 * Tests for the realm `hid` RPC channel + the kernel-side WebHID
 * bridge. Wires `createHidBridge` through a real `RealmRpcClient`
 * connected to `attachRealmHost` with an injected mock `HidBackend`,
 * covering the realm device-object surface, the realm-RPC envelope
 * shape, binary report transfer, and error propagation. Input-report
 * subscriptions are out of scope for v1 (no realm-side `hid.watch`).
 */

import type { CommandContext } from 'just-bash';
import { describe, expect, it } from 'vitest';
import { createHidBridge } from '../../../src/kernel/realm/js-realm-shared.js';
import { attachRealmHost } from '../../../src/kernel/realm/realm-host.js';
import { RealmRpcClient } from '../../../src/kernel/realm/realm-rpc.js';
import type { HidBackend } from '../../../src/shell/supplemental-commands/hid-backends.js';
import { makeCtx, makePortPair } from './device-bridge-test-helpers.js';

interface Recorded {
  op: string;
  args: unknown[];
}

function makeMockBackend(recorded: Recorded[], throwOn?: string): HidBackend {
  const rec = (op: string, args: unknown[]) => recorded.push({ op, args });
  const guard = (op: string) => {
    if (throwOn === op) throw new Error(`backend ${op} boom`);
  };
  const info = (handle: string) => ({ handle, vendorId: 0x046d, productId: 0xc52b, opened: false });
  return {
    list: async () => {
      rec('list', []);
      return [info('hid1')];
    },
    request: async (filters) => {
      rec('request', [filters]);
      return info('hid1');
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
    sendReport: async (h, reportId, bytes) =>
      rec('sendReport', [h, reportId, bytes]) as unknown as void,
    sendFeatureReport: async (h, reportId, bytes) =>
      rec('sendFeatureReport', [h, reportId, bytes]) as unknown as void,
    receiveFeatureReport: async (h, reportId) => {
      rec('receiveFeatureReport', [h, reportId]);
      return { reportId, bytes: new Uint8Array([0x01, 0x02, 0x03]) };
    },
    subscribeInputReports: async () => async () => {},
  };
}

function setup(recorded: Recorded[], throwOn?: string) {
  const ctx: CommandContext = makeCtx();
  const { realm, host } = makePortPair();
  const handle = attachRealmHost(host, ctx, { hidBackend: makeMockBackend(recorded, throwOn) });
  const client = new RealmRpcClient(realm);
  const hid = createHidBridge(client);
  return { hid, dispose: () => (client.dispose(), handle.dispose()) };
}

describe('realm hid bridge', () => {
  it('lists granted devices as device objects with the right handle', async () => {
    const rec: Recorded[] = [];
    const { hid, dispose } = setup(rec);
    const devices = await hid.list();
    expect(devices.map((d) => d.handle)).toEqual(['hid1']);
    expect(typeof devices[0].sendReport).toBe('function');
    dispose();
  });

  it('normalizes a single filter object into an array on request', async () => {
    const rec: Recorded[] = [];
    const { hid, dispose } = setup(rec);
    await hid.request({ vendorId: 0x046d });
    expect(rec[0]).toEqual({ op: 'request', args: [[{ vendorId: 0x046d }]] });
    dispose();
  });

  it('sends a report as Uint8Array bytes keyed by the device handle', async () => {
    const rec: Recorded[] = [];
    const { hid, dispose } = setup(rec);
    const device = await hid.request([]);
    await device.sendReport(0, new Uint8Array([0xde, 0xad]));
    const sent = rec.find((r) => r.op === 'sendReport');
    expect(sent?.args[0]).toBe('hid1');
    expect(sent?.args[1]).toBe(0);
    expect(sent?.args[2]).toBeInstanceOf(Uint8Array);
    expect([...(sent?.args[2] as Uint8Array)]).toEqual([0xde, 0xad]);
    dispose();
  });

  it('sends a feature report as Uint8Array bytes', async () => {
    const rec: Recorded[] = [];
    const { hid, dispose } = setup(rec);
    const device = await hid.request([]);
    await device.sendFeatureReport(2, new Uint8Array([0xff]));
    const sent = rec.find((r) => r.op === 'sendFeatureReport');
    expect(sent?.args[1]).toBe(2);
    expect([...(sent?.args[2] as Uint8Array)]).toEqual([0xff]);
    dispose();
  });

  it('round-trips a received feature report as a DataView', async () => {
    const rec: Recorded[] = [];
    const { hid, dispose } = setup(rec);
    const device = await hid.request([]);
    const data = await device.receiveFeatureReport(0);
    expect(data).toBeInstanceOf(DataView);
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    expect([...bytes]).toEqual([0x01, 0x02, 0x03]);
    expect(rec).toContainEqual({ op: 'receiveFeatureReport', args: ['hid1', 0] });
    dispose();
  });

  it('propagates backend errors to the realm caller', async () => {
    const rec: Recorded[] = [];
    const { hid, dispose } = setup(rec, 'open');
    const device = await hid.request([]);
    await expect(device.open()).rejects.toThrow(/backend open boom/);
    dispose();
  });

  it('rejects unknown hid ops with a clear error', async () => {
    const ctx = makeCtx();
    const { realm, host } = makePortPair();
    const handle = attachRealmHost(host, ctx, { hidBackend: makeMockBackend([]) });
    const client = new RealmRpcClient(realm);
    await expect(client.call('hid', 'bogusOp', [])).rejects.toThrow(/unknown hid op/);
    client.dispose();
    handle.dispose();
  });
});
