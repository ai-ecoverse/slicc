/**
 * Reusable conformance suite for any {@link CapabilityBroker} adapter
 * (#2276). Every adapter must pass — including stubs whose ops are
 * unavailable.
 */

import { describe, expect, it } from 'vitest';
import {
  APPROVAL_OPERATIONS,
  BROWSER_OPERATIONS,
  CAPABILITY_DOMAINS,
  type CapabilityBroker,
  type CapabilityDomain,
  type CapabilityResult,
  DEVICE_OPERATIONS,
  isCapabilityUnavailable,
  MOUNT_OPERATIONS,
  NETWORK_OPERATIONS,
  SECRET_OPERATIONS,
} from '../../src/work-unit/capability/index.js';

async function invokeEveryOperation(
  broker: CapabilityBroker
): Promise<
  Array<{ domain: CapabilityDomain; operation: string; result: CapabilityResult<unknown> }>
> {
  return [
    { domain: 'browser', operation: 'listTargets', result: await broker.browser.listTargets() },
    {
      domain: 'browser',
      operation: 'createTarget',
      result: await broker.browser.createTarget({ url: 'about:blank' }),
    },
    {
      domain: 'browser',
      operation: 'navigate',
      result: await broker.browser.navigate({ targetId: 't', url: 'about:blank' }),
    },
    {
      domain: 'browser',
      operation: 'screenshot',
      result: await broker.browser.screenshot({ targetId: 't' }),
    },
    {
      domain: 'browser',
      operation: 'evaluate',
      result: await broker.browser.evaluate({ targetId: 't', expression: '1' }),
    },
    {
      domain: 'network',
      operation: 'localNodeServer',
      result: await broker.network.localNodeServer(),
    },
    {
      domain: 'network',
      operation: 'crossOriginFetch',
      result: await broker.network.crossOriginFetch({ url: 'https://example.test/' }),
    },
    {
      domain: 'network',
      operation: 'websocket',
      result: await broker.network.websocket({ url: 'wss://example.test/' }),
    },
    { domain: 'secrets', operation: 'listMaskedEnv', result: await broker.secrets.listMaskedEnv() },
    { domain: 'secrets', operation: 'get', result: await broker.secrets.get({ name: 'X' }) },
    {
      domain: 'secrets',
      operation: 'set',
      result: await broker.secrets.set({ name: 'X', value: 'y' }),
    },
    { domain: 'secrets', operation: 'delete', result: await broker.secrets.delete({ name: 'X' }) },
    { domain: 'devices', operation: 'usbRequest', result: await broker.devices.usbRequest({}) },
    {
      domain: 'devices',
      operation: 'serialRequest',
      result: await broker.devices.serialRequest({}),
    },
    { domain: 'devices', operation: 'hidRequest', result: await broker.devices.hidRequest({}) },
    {
      domain: 'mounts',
      operation: 'signRequest',
      result: await broker.mounts.signRequest({ url: 'https://example.test/' }),
    },
    { domain: 'mounts', operation: 'pickDirectory', result: await broker.mounts.pickDirectory() },
    { domain: 'mounts', operation: 'recover', result: await broker.mounts.recover() },
    {
      domain: 'approvals',
      operation: 'request',
      result: await broker.approvals.request({ kind: 'command', detail: 'ls' }),
    },
    {
      domain: 'approvals',
      operation: 'resolve',
      result: await broker.approvals.resolve({ kind: 'command', detail: 'ls' }),
    },
  ];
}

export function runCapabilityBrokerConformance(name: string, make: () => CapabilityBroker): void {
  describe(`CapabilityBroker conformance: ${name}`, () => {
    it('names a page or node adapter', () => {
      const broker = make();
      expect(['page', 'node']).toContain(broker.adapter);
    });

    it('exposes every capability domain with an explicit allowlist', () => {
      const broker = make();
      expect(CAPABILITY_DOMAINS).toEqual([
        'browser',
        'network',
        'secrets',
        'devices',
        'mounts',
        'approvals',
      ]);
      expect(
        broker.browser.allowlist.every((op) =>
          (BROWSER_OPERATIONS as readonly string[]).includes(op)
        )
      ).toBe(true);
      expect(
        broker.network.allowlist.every((op) =>
          (NETWORK_OPERATIONS as readonly string[]).includes(op)
        )
      ).toBe(true);
      expect(
        broker.secrets.allowlist.every((op) =>
          (SECRET_OPERATIONS as readonly string[]).includes(op)
        )
      ).toBe(true);
      expect(
        broker.devices.allowlist.every((op) =>
          (DEVICE_OPERATIONS as readonly string[]).includes(op)
        )
      ).toBe(true);
      expect(
        broker.mounts.allowlist.every((op) => (MOUNT_OPERATIONS as readonly string[]).includes(op))
      ).toBe(true);
      expect(
        broker.approvals.allowlist.every((op) =>
          (APPROVAL_OPERATIONS as readonly string[]).includes(op)
        )
      ).toBe(true);
    });

    it('supports() agrees with the allowlist and never invents operations', () => {
      const broker = make();
      for (const op of BROWSER_OPERATIONS) {
        expect(broker.browser.supports(op)).toBe(broker.browser.allowlist.includes(op));
      }
      for (const op of NETWORK_OPERATIONS) {
        expect(broker.network.supports(op)).toBe(broker.network.allowlist.includes(op));
      }
      for (const op of SECRET_OPERATIONS) {
        expect(broker.secrets.supports(op)).toBe(broker.secrets.allowlist.includes(op));
      }
      for (const op of DEVICE_OPERATIONS) {
        expect(broker.devices.supports(op)).toBe(broker.devices.allowlist.includes(op));
      }
      for (const op of MOUNT_OPERATIONS) {
        expect(broker.mounts.supports(op)).toBe(broker.mounts.allowlist.includes(op));
      }
      for (const op of APPROVAL_OPERATIONS) {
        expect(broker.approvals.supports(op)).toBe(broker.approvals.allowlist.includes(op));
      }
    });

    it('every operation returns a typed result and never throws a string', async () => {
      const broker = make();
      const rows = await invokeEveryOperation(broker);
      expect(rows).toHaveLength(
        BROWSER_OPERATIONS.length +
          NETWORK_OPERATIONS.length +
          SECRET_OPERATIONS.length +
          DEVICE_OPERATIONS.length +
          MOUNT_OPERATIONS.length +
          APPROVAL_OPERATIONS.length
      );
      for (const { domain, operation, result } of rows) {
        if (result.ok) {
          // `CapabilityResult<void>` success is `{ ok: true, value: undefined }`.
          // Assert the envelope, not that `value` is defined.
          expect(result).toEqual(expect.objectContaining({ ok: true }));
          expect('value' in result).toBe(true);
          continue;
        }
        expect(isCapabilityUnavailable(result)).toBe(true);
        expect(result.reason).toBe('unavailable');
        expect(result.capability).toBe(domain);
        expect(result.operation).toBe(operation);
        expect(result.message.length).toBeGreaterThan(0);
      }
    });

    it('an unsupported op is CapabilityUnavailable, not a thrown string', async () => {
      const broker = make();
      if (broker.browser.supports('screenshot')) return;
      const result = await broker.browser.screenshot({ targetId: 't' });
      expect(isCapabilityUnavailable(result)).toBe(true);
      if (isCapabilityUnavailable(result)) {
        expect(result.capability).toBe('browser');
        expect(result.operation).toBe('screenshot');
      }
    });
  });
}
