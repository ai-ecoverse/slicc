/**
 * Tests for the realm `hid` RPC channel + the kernel-side WebHID
 * bridge. Wires `createHidBridge` through a real `RealmRpcClient`
 * connected to `attachRealmHost` with an injected mock `HidBackend`,
 * covering the realm device-object surface, the realm-RPC envelope
 * shape, binary report transfer, error propagation, and the
 * `addEventListener('inputreport', …)` event-driven path the VIA-style
 * request/response runs sit on top of.
 */

import type { CommandContext } from 'just-bash';
import { describe, expect, it } from 'vitest';
import {
  createHidBridge,
  type RealmHidInputReportEvent,
  type RealmHidInputReportListener,
} from '../../../src/kernel/realm/realm-hid-bridge.js';
import { attachRealmHost } from '../../../src/kernel/realm/realm-host.js';
import { RealmRpcClient } from '../../../src/kernel/realm/realm-rpc.js';
import type {
  HidBackend,
  HidInputReport,
} from '../../../src/shell/supplemental-commands/hid-backends.js';
import { makeCtx, makePortPair } from './device-bridge-test-helpers.js';

interface Recorded {
  op: string;
  args: unknown[];
}

interface MockBackendOpts {
  throwOn?: string;
  /** Receive the emit hook the backend uses to fan a fake report. */
  onEmit?(emit: (handle: string, report: HidInputReport) => void): void;
}

function makeMockBackend(recorded: Recorded[], opts: MockBackendOpts = {}): HidBackend {
  const rec = (op: string, args: unknown[]) => recorded.push({ op, args });
  const guard = (op: string) => {
    if (opts.throwOn === op) throw new Error(`backend ${op} boom`);
  };
  const info = (handle: string) => ({ handle, vendorId: 0x046d, productId: 0xc52b, opened: false });
  // Per-handle subscriber registry so a test can emit a fake report after
  // `subscribeInputReports` resolves and assert the listener received it.
  const subs = new Map<string, (report: HidInputReport) => void>();
  opts.onEmit?.((handle, report) => {
    const cb = subs.get(handle);
    cb?.(report);
  });
  return {
    list: async () => {
      rec('list', []);
      return [info('hid1')];
    },
    request: async (filters) => {
      rec('request', [filters]);
      return [info('hid1')];
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
    subscribeInputReports: async (h, onReport) => {
      rec('subscribeInputReports', [h]);
      subs.set(h, onReport);
      return async () => {
        rec('unsubscribeInputReports', [h]);
        subs.delete(h);
      };
    },
  };
}

function setup(recorded: Recorded[], opts: MockBackendOpts = {}) {
  const ctx: CommandContext = makeCtx();
  const { realm, host } = makePortPair();
  const handle = attachRealmHost(host, ctx, { hidBackend: makeMockBackend(recorded, opts) });
  const client = new RealmRpcClient(realm);
  const hid = createHidBridge(client);
  return { hid, client, handle, dispose: () => (client.dispose(), handle.dispose()) };
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
    const { hid, dispose } = setup(rec, { throwOn: 'open' });
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

  describe('addEventListener(inputreport)', () => {
    function withEmit() {
      const rec: Recorded[] = [];
      let emit: (handle: string, report: HidInputReport) => void = () => {};
      const ctx = setup(rec, {
        onEmit: (e) => {
          emit = e;
        },
      });
      return { ...ctx, rec, emit: (h: string, r: HidInputReport) => emit(h, r) };
    }

    it('subscribes on first listener and delivers reports as DataView events', async () => {
      const { hid, rec, emit, dispose } = withEmit();
      const device = await hid.request([]);
      const received: Array<{ reportId: number; bytes: number[] }> = [];
      device.addEventListener('inputreport', (event) => {
        const view = event.data;
        const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
        received.push({ reportId: event.reportId, bytes: [...bytes] });
      });
      // Let the subscribe RPC round-trip before emitting.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(rec).toContainEqual({ op: 'subscribeInputReports', args: ['hid1'] });
      emit('hid1', { reportId: 3, bytes: new Uint8Array([0xaa, 0xbb]) });
      expect(received).toEqual([{ reportId: 3, bytes: [0xaa, 0xbb] }]);
      dispose();
    });

    it('coalesces multiple listeners into one backend subscription', async () => {
      const { hid, rec, emit, dispose } = withEmit();
      const device = await hid.request([]);
      const a: number[][] = [];
      const b: number[][] = [];
      device.addEventListener('inputreport', (e) =>
        a.push([...new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength)])
      );
      device.addEventListener('inputreport', (e) =>
        b.push([...new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength)])
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const subscribes = rec.filter((r) => r.op === 'subscribeInputReports');
      expect(subscribes).toHaveLength(1);
      emit('hid1', { reportId: 0, bytes: new Uint8Array([0x11]) });
      expect(a).toEqual([[0x11]]);
      expect(b).toEqual([[0x11]]);
      dispose();
    });

    it('unsubscribes the backend once the last listener is removed', async () => {
      const { hid, rec, dispose } = withEmit();
      const device = await hid.request([]);
      const cb = (): void => {};
      device.addEventListener('inputreport', cb);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      device.removeEventListener('inputreport', cb);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(rec).toContainEqual({ op: 'unsubscribeInputReports', args: ['hid1'] });
      dispose();
    });

    it('completes a VIA-style send→input-report round trip via addEventListener', async () => {
      const { hid, rec, emit, dispose } = withEmit();
      const device = await hid.request([]);
      const reply = new Promise<RealmHidInputReportEvent>((resolve) => {
        const handler: RealmHidInputReportListener = (event) => {
          device.removeEventListener('inputreport', handler);
          resolve(event);
        };
        device.addEventListener('inputreport', handler);
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await device.sendReport(0, new Uint8Array([0x01]));
      emit('hid1', { reportId: 0, bytes: new Uint8Array([0x01, 0x42]) });
      const event = await reply;
      const echoed = new Uint8Array(
        event.data.buffer,
        event.data.byteOffset,
        event.data.byteLength
      );
      expect([...echoed]).toEqual([0x01, 0x42]);
      // After the response handler self-detaches the listener count drops
      // to zero, which kicks the unsubscribe.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(rec).toContainEqual({ op: 'unsubscribeInputReports', args: ['hid1'] });
      dispose();
    });

    it('onInputReport is an alias for addEventListener("inputreport")', async () => {
      const { hid, rec, emit, dispose } = withEmit();
      const device = await hid.request([]);
      const seen: number[] = [];
      device.onInputReport((event) => seen.push(event.reportId));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(rec).toContainEqual({ op: 'subscribeInputReports', args: ['hid1'] });
      emit('hid1', { reportId: 7, bytes: new Uint8Array([0]) });
      expect(seen).toEqual([7]);
      dispose();
    });

    it('ignores events keyed to another device handle', async () => {
      const { hid, emit, dispose } = withEmit();
      const device = await hid.request([]);
      const seen: number[] = [];
      device.addEventListener('inputreport', (e) => seen.push(e.reportId));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      emit('hid-other', { reportId: 99, bytes: new Uint8Array([0]) });
      expect(seen).toEqual([]);
      dispose();
    });

    it('accepts disconnect listeners as a valid registration type', async () => {
      const { hid, dispose } = withEmit();
      const device = await hid.request([]);
      const cb = (): void => {};
      // Registration must not throw and must accept removal symmetrically.
      device.addEventListener('disconnect', cb);
      device.removeEventListener('disconnect', cb);
      dispose();
    });

    it('throws on unknown event types', async () => {
      const { hid, dispose } = withEmit();
      const device = await hid.request([]);
      expect(() =>
        (
          device as unknown as { addEventListener: (t: string, c: () => void) => void }
        ).addEventListener('not-a-real-event', () => {})
      ).toThrow(/unknown event type/);
      dispose();
    });

    it('drains outstanding subscriptions on realm-host dispose', async () => {
      const { hid, rec, handle, dispose } = withEmit();
      const device = await hid.request([]);
      device.addEventListener('inputreport', () => {});
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(rec.filter((r) => r.op === 'subscribeInputReports')).toHaveLength(1);
      handle.dispose();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      // The host-side disposer drains the backend unsubscribe.
      expect(rec.filter((r) => r.op === 'unsubscribeInputReports')).toHaveLength(1);
      dispose();
    });
  });
});
