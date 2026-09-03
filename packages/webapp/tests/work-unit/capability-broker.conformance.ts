/**
 * Reusable conformance suite for any {@link CapabilityBroker} adapter
 * (#2276). Every adapter must pass — the fully-unavailable `connect` one
 * included.
 *
 * The load-bearing invariant is the two-way agreement between an adapter's
 * allowlist and its behaviour: an operation that is NOT allowlisted must
 * answer `CapabilityUnavailable`, and one that IS must never answer
 * `CapabilityUnavailable` (it succeeds, or it reports a `CapabilityFailure`).
 * That is what lets a caller branch on `supports()` once at composition time
 * instead of re-deciding on every call.
 *
 * `transport` says which half of an adapter's pair is running, and turns two
 * otherwise-untested holes into failures:
 *
 *   - `'failing'` — every transport-backed op must report a
 *     `CapabilityFailure`. Without this an adapter could swallow a dead
 *     socket into `{ ok: true, value: { entries: [] } }` and pass, and
 *     `fetchSecretEnvVars` would then seed a scoop with an empty env instead
 *     of reporting that secrets are unreachable.
 *   - `'answering'` — every transport-backed op must succeed AND return a
 *     value of its declared shape, so `{ ok: true, value: undefined }` from a
 *     half-wired op cannot pass either.
 *
 * Composition-time answers (`network.localNodeServer`) and page-gesture ops
 * are exempt: they never touch the adapter's transport, so a broken transport
 * says nothing about them.
 */

import { describe, expect, it } from 'vitest';
import {
  APPROVAL_OPERATIONS,
  BROWSER_OPERATIONS,
  CAPABILITY_ADAPTERS,
  CAPABILITY_DOMAINS,
  type CapabilityBroker,
  type CapabilityDomain,
  type CapabilityResult,
  DEVICE_OPERATIONS,
  isCapabilityFailure,
  isCapabilityUnavailable,
  MOUNT_OPERATIONS,
  NETWORK_OPERATIONS,
  SECRET_OPERATIONS,
} from '../../src/work-unit/capability/index.js';

interface Invocation {
  domain: CapabilityDomain;
  operation: string;
  result: CapabilityResult<unknown>;
}

async function invokeEveryOperation(broker: CapabilityBroker): Promise<Invocation[]> {
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
    {
      domain: 'secrets',
      operation: 'getMasked',
      result: await broker.secrets.getMasked({ name: 'X' }),
    },
    {
      domain: 'secrets',
      operation: 'set',
      result: await broker.secrets.set({ name: 'X', value: 'y', domains: ['example.test'] }),
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
      result: await broker.mounts.signRequest({
        backend: 's3',
        envelope: { profile: 'p', method: 'GET', bucket: 'b', key: 'k' },
      }),
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

/** Every domain's allowlist, flattened to `domain.operation` strings. */
function allowlistOf(broker: CapabilityBroker): Set<string> {
  const allowed = new Set<string>();
  for (const op of broker.browser.allowlist) allowed.add(`browser.${op}`);
  for (const op of broker.network.allowlist) allowed.add(`network.${op}`);
  for (const op of broker.secrets.allowlist) allowed.add(`secrets.${op}`);
  for (const op of broker.devices.allowlist) allowed.add(`devices.${op}`);
  for (const op of broker.mounts.allowlist) allowed.add(`mounts.${op}`);
  for (const op of broker.approvals.allowlist) allowed.add(`approvals.${op}`);
  return allowed;
}

/** Which half of an adapter's transport pair a run exercises. */
export type ConformanceTransport = 'answering' | 'failing' | 'none';

export interface ConformanceOptions {
  /**
   * `'answering'` — the transport replies to everything.
   * `'failing'` — every transport call rejects.
   * `'none'` (the default) — the adapter has no transport-backed ops.
   */
  transport?: ConformanceTransport;
}

/** Ops answered without ever touching the adapter's transport. */
const COMPOSITION_TIME_OPS = new Set([
  'network.localNodeServer',
  'mounts.pickDirectory',
  'devices.usbRequest',
  'devices.serialRequest',
  'devices.hidRequest',
]);

/** A value that could carry named fields. */
function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null;
}

/**
 * The declared shape of each operation's success value, one predicate per
 * operation. A value that does not match is as much a bug as a rejected
 * promise — it is what a caller reads, and `{ ok: true, value: undefined }`
 * from a half-wired op would otherwise pass every other assertion here.
 */
const VALUE_SHAPES: Record<string, { label: string; matches: (value: unknown) => boolean }> = {
  localNodeServer: {
    label: 'LocalNodeServerStatus',
    matches: (v) => isRecord(v) && v.available === true,
  },
  crossOriginFetch: {
    label: 'NetworkFetchResponse',
    matches: (v) =>
      isRecord(v) &&
      typeof v.status === 'number' &&
      typeof v.body === 'string' &&
      (v.bodyEncoding === 'text' || v.bodyEncoding === 'base64'),
  },
  listMaskedEnv: {
    label: 'SecretListResult',
    matches: (v) => isRecord(v) && Array.isArray(v.entries),
  },
  getMasked: {
    label: 'SecretMaskedEnvEntry',
    matches: (v) => isRecord(v) && typeof v.name === 'string' && typeof v.maskedValue === 'string',
  },
  set: { label: 'no value', matches: (v) => v === undefined },
  delete: {
    label: 'SecretDeleteResult',
    matches: (v) =>
      isRecord(v) && typeof v.removed === 'boolean' && typeof v.fromSession === 'boolean',
  },
  signRequest: {
    label: 'SignAndForwardReply',
    matches: (v) => isRecord(v) && typeof v.ok === 'boolean',
  },
  request: {
    label: 'ApprovalDecision',
    matches: (v) => isRecord(v) && typeof v.decision === 'string',
  },
  resolve: {
    label: 'ApprovalDecision',
    matches: (v) => isRecord(v) && typeof v.decision === 'string',
  },
  pickDirectory: {
    label: 'MountDirectoryHandle',
    matches: (v) => isRecord(v) && typeof v.id === 'string',
  },
  usbRequest: { label: 'DeviceHandle', matches: (v) => isRecord(v) && typeof v.kind === 'string' },
  serialRequest: {
    label: 'DeviceHandle',
    matches: (v) => isRecord(v) && typeof v.kind === 'string',
  },
  hidRequest: { label: 'DeviceHandle', matches: (v) => isRecord(v) && typeof v.kind === 'string' },
};

/** `'ok'`, or what the value should have been. */
function describeValue(operation: string, value: unknown): string {
  const shape = VALUE_SHAPES[operation];
  if (!shape) return 'ok';
  return shape.matches(value) ? 'ok' : `bad ${shape.label}`;
}

export function runCapabilityBrokerConformance(
  name: string,
  make: () => CapabilityBroker,
  options: ConformanceOptions = {}
): void {
  const transport = options.transport ?? 'none';

  describe(`CapabilityBroker conformance: ${name}`, () => {
    it('names one of the four float-topology adapters', () => {
      const broker = make();
      expect(CAPABILITY_ADAPTERS as readonly string[]).toContain(broker.adapter);
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
        expect(isCapabilityUnavailable(result) || isCapabilityFailure(result)).toBe(true);
        expect(result.capability).toBe(domain);
        expect(result.operation).toBe(operation);
        expect(result.message.length).toBeGreaterThan(0);
      }
    });

    it('an unlisted operation is CapabilityUnavailable, never a failure or a success', async () => {
      const broker = make();
      const allowed = allowlistOf(broker);
      const rows = await invokeEveryOperation(broker);
      const unlisted = rows.filter(
        ({ domain, operation }) => !allowed.has(`${domain}.${operation}`)
      );
      expect(unlisted.length).toBeGreaterThan(0);
      for (const { domain, operation, result } of unlisted) {
        expect({ domain, operation, unavailable: isCapabilityUnavailable(result) }).toEqual({
          domain,
          operation,
          unavailable: true,
        });
      }
    });

    it('an allowlisted operation never answers CapabilityUnavailable', async () => {
      const broker = make();
      const allowed = allowlistOf(broker);
      const rows = await invokeEveryOperation(broker);
      for (const { domain, operation, result } of rows) {
        if (!allowed.has(`${domain}.${operation}`)) continue;
        expect({ domain, operation, unavailable: isCapabilityUnavailable(result) }).toEqual({
          domain,
          operation,
          unavailable: false,
        });
      }
    });

    if (transport === 'failing') {
      it('reports a dead transport as a failure — never as an empty success', async () => {
        const broker = make();
        const allowed = allowlistOf(broker);
        const rows = await invokeEveryOperation(broker);
        const transportBacked = rows.filter(
          ({ domain, operation }) =>
            allowed.has(`${domain}.${operation}`) &&
            !COMPOSITION_TIME_OPS.has(`${domain}.${operation}`)
        );
        expect(transportBacked.length).toBeGreaterThan(0);
        for (const { domain, operation, result } of transportBacked) {
          expect({ domain, operation, failure: isCapabilityFailure(result) }).toEqual({
            domain,
            operation,
            failure: true,
          });
        }
      });
    }

    if (transport === 'answering') {
      it('returns a value of the declared shape for every answered operation', async () => {
        const broker = make();
        const allowed = allowlistOf(broker);
        const rows = await invokeEveryOperation(broker);
        const answered = rows.filter(({ domain, operation }) =>
          allowed.has(`${domain}.${operation}`)
        );
        expect(answered.length).toBeGreaterThan(0);
        for (const { domain, operation, result } of answered) {
          expect({ domain, operation, ok: result.ok }).toEqual({ domain, operation, ok: true });
          if (!result.ok) continue;
          expect({ domain, operation, shape: describeValue(operation, result.value) }).toEqual({
            domain,
            operation,
            shape: 'ok',
          });
        }
      });
    }
  });
}
