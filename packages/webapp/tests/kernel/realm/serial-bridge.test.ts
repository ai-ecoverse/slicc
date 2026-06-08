/**
 * Tests for the realm `serial` RPC channel + the kernel-side Web Serial
 * bridge. Wires `createSerialBridge` through a real `RealmRpcClient`
 * connected to `attachRealmHost` with an injected mock `SerialBackend`,
 * covering the realm port-object surface, the realm-RPC envelope shape,
 * binary read/write transfer, and error propagation.
 */

import type { CommandContext } from 'just-bash';
import { describe, expect, it } from 'vitest';
import { createSerialBridge } from '../../../src/kernel/realm/js-realm-shared.js';
import { attachRealmHost } from '../../../src/kernel/realm/realm-host.js';
import { RealmRpcClient } from '../../../src/kernel/realm/realm-rpc.js';
import type { SerialBackend } from '../../../src/shell/supplemental-commands/serial-backends.js';
import { makeCtx, makePortPair } from './device-bridge-test-helpers.js';

interface Recorded {
  op: string;
  args: unknown[];
}

function makeMockBackend(recorded: Recorded[], throwOn?: string): SerialBackend {
  const rec = (op: string, args: unknown[]) => recorded.push({ op, args });
  const guard = (op: string) => {
    if (throwOn === op) throw new Error(`backend ${op} boom`);
  };
  const info = (handle: string) => ({ handle, usbVendorId: 0x2e8a, opened: false });
  return {
    list: async () => {
      rec('list', []);
      return [info('serial1')];
    },
    request: async (filters) => {
      rec('request', [filters]);
      return info('serial1');
    },
    info: async (h) => {
      rec('info', [h]);
      return info(h);
    },
    open: async (h, options) => {
      rec('open', [h, options]);
      guard('open');
    },
    close: async (h) => rec('close', [h]) as unknown as void,
    read: async (h, params) => {
      rec('read', [h, params]);
      return new Uint8Array([0x68, 0x69]);
    },
    write: async (h, bytes) => {
      rec('write', [h, bytes]);
      return bytes.byteLength;
    },
    getSignals: async (h) => {
      rec('getSignals', [h]);
      return {
        clearToSend: true,
        dataCarrierDetect: false,
        dataSetReady: true,
        ringIndicator: false,
      };
    },
    setSignals: async (h, signals) => rec('setSignals', [h, signals]) as unknown as void,
  };
}

function setup(recorded: Recorded[], throwOn?: string) {
  const ctx: CommandContext = makeCtx();
  const { realm, host } = makePortPair();
  const handle = attachRealmHost(host, ctx, { serialBackend: makeMockBackend(recorded, throwOn) });
  const client = new RealmRpcClient(realm);
  const serial = createSerialBridge(client);
  return { serial, dispose: () => (client.dispose(), handle.dispose()) };
}

describe('realm serial bridge', () => {
  it('lists granted ports as port objects with the right handle', async () => {
    const rec: Recorded[] = [];
    const { serial, dispose } = setup(rec);
    const ports = await serial.list();
    expect(ports.map((p) => p.handle)).toEqual(['serial1']);
    expect(typeof ports[0].read).toBe('function');
    dispose();
  });

  it('normalizes a single filter object into an array on request', async () => {
    const rec: Recorded[] = [];
    const { serial, dispose } = setup(rec);
    await serial.request({ usbVendorId: 0x2e8a });
    expect(rec[0]).toEqual({ op: 'request', args: [[{ usbVendorId: 0x2e8a }]] });
    dispose();
  });

  it('forwards open options keyed by the port handle', async () => {
    const rec: Recorded[] = [];
    const { serial, dispose } = setup(rec);
    const port = await serial.request([]);
    await port.open({ baudRate: 115200 });
    expect(rec).toContainEqual({ op: 'open', args: ['serial1', { baudRate: 115200 }] });
    dispose();
  });

  it('maps read({ bytes }) → maxBytes and returns raw bytes', async () => {
    const rec: Recorded[] = [];
    const { serial, dispose } = setup(rec);
    const port = await serial.request([]);
    const data = await port.read({ bytes: 16, timeoutMs: 500 });
    expect(data).toBeInstanceOf(Uint8Array);
    expect([...data]).toEqual([0x68, 0x69]);
    const read = rec.find((r) => r.op === 'read');
    expect(read?.args[1]).toMatchObject({ maxBytes: 16, timeoutMs: 500 });
    dispose();
  });

  it('passes an `until` delimiter as Uint8Array bytes', async () => {
    const rec: Recorded[] = [];
    const { serial, dispose } = setup(rec);
    const port = await serial.request([]);
    await port.read({ until: new Uint8Array([0x0a]) });
    const read = rec.find((r) => r.op === 'read');
    const until = (read?.args[1] as { until: Uint8Array }).until;
    expect(until).toBeInstanceOf(Uint8Array);
    expect([...until]).toEqual([0x0a]);
    dispose();
  });

  it('writes a payload as Uint8Array bytes and returns the count', async () => {
    const rec: Recorded[] = [];
    const { serial, dispose } = setup(rec);
    const port = await serial.request([]);
    const written = await port.write(new Uint8Array([1, 2, 3, 4]));
    expect(written).toBe(4);
    const write = rec.find((r) => r.op === 'write');
    expect(write?.args[1]).toBeInstanceOf(Uint8Array);
    dispose();
  });

  it('reads and sets control signals', async () => {
    const rec: Recorded[] = [];
    const { serial, dispose } = setup(rec);
    const port = await serial.request([]);
    const signals = await port.getSignals();
    expect(signals.clearToSend).toBe(true);
    await port.setSignals({ dataTerminalReady: true });
    expect(rec).toContainEqual({
      op: 'setSignals',
      args: ['serial1', { dataTerminalReady: true }],
    });
    dispose();
  });

  it('propagates backend errors to the realm caller', async () => {
    const rec: Recorded[] = [];
    const { serial, dispose } = setup(rec, 'open');
    const port = await serial.request([]);
    await expect(port.open({ baudRate: 9600 })).rejects.toThrow(/backend open boom/);
    dispose();
  });

  it('rejects unknown serial ops with a clear error', async () => {
    const ctx = makeCtx();
    const { realm, host } = makePortPair();
    const handle = attachRealmHost(host, ctx, { serialBackend: makeMockBackend([]) });
    const client = new RealmRpcClient(realm);
    await expect(client.call('serial', 'bogusOp', [])).rejects.toThrow(/unknown serial op/);
    client.dispose();
    handle.dispose();
  });
});
