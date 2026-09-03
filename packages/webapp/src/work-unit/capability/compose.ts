/**
 * The shared broker skeleton every adapter is built from (#2276 slice B).
 *
 * An adapter supplies only the operations its transport actually has, by
 * name — never a string-keyed handler map. Everything it omits denies with
 * {@link CapabilityUnavailable}, and each domain's `allowlist` / `supports()`
 * is DERIVED from what was supplied, so "listed but unimplemented" and
 * "implemented but unlisted" are both unrepresentable.
 *
 * `pageGestures` is layered on top of the adapter rather than inside it: a
 * directory picker and the WebUSB / WebSerial / WebHID choosers need a
 * page-realm user gesture in every topology, so the host injects one channel
 * for all four adapters.
 */

import {
  APPROVAL_OPERATIONS,
  type ApprovalCapability,
  type ApprovalOperation,
  BROWSER_OPERATIONS,
  type BrowserCapability,
  type BrowserOperation,
  type CapabilityAdapterId,
  type CapabilityBroker,
  type CapabilityDomain,
  type CapabilityResult,
  capabilityUnavailable,
  DEVICE_OPERATIONS,
  type DeviceCapability,
  type DeviceOperation,
  MOUNT_OPERATIONS,
  type MountCapability,
  type MountOperation,
  NETWORK_OPERATIONS,
  type NetworkCapability,
  type NetworkOperation,
  type PageGestureChannel,
  SECRET_OPERATIONS,
  type SecretCapability,
  type SecretOperation,
} from './types.js';

/** The callable half of a capability interface — its operations, minus the metadata. */
type Operations<TCapability> = Omit<TCapability, 'allowlist' | 'supports'>;

/** What an adapter supplies: any subset of each domain's operations. */
export interface CapabilityImplementations {
  browser?: Partial<Operations<BrowserCapability>>;
  network?: Partial<Operations<NetworkCapability>>;
  secrets?: Partial<Operations<SecretCapability>>;
  devices?: Partial<Operations<DeviceCapability>>;
  mounts?: Partial<Operations<MountCapability>>;
  approvals?: Partial<Operations<ApprovalCapability>>;
}

export interface ComposeCapabilityBrokerOptions extends CapabilityImplementations {
  adapter: CapabilityAdapterId;
  /** Gesture-bound ops, identical across topologies. Omitted → unavailable. */
  pageGestures?: PageGestureChannel;
}

function deny(
  adapter: string,
  capability: CapabilityDomain,
  operation: string
): CapabilityResult<never> {
  return capabilityUnavailable(
    capability,
    operation,
    `${adapter} adapter does not implement ${capability}.${operation}`
  );
}

/**
 * Build one domain: the allowlist is every canonical operation an
 * implementation was supplied for (in canonical order), and every other
 * operation resolves the typed miss.
 */
function domain<TOp extends string, TCapability extends { allowlist: readonly TOp[] }>(
  adapter: string,
  capability: CapabilityDomain,
  operations: readonly TOp[],
  impl: Partial<Record<TOp, unknown>> | undefined
): TCapability {
  const allowlist = operations.filter((op) => typeof impl?.[op] === 'function');
  const entries: Array<[TOp, unknown]> = operations.map((op) => {
    const supplied = impl?.[op];
    return [
      op,
      typeof supplied === 'function'
        ? (supplied as (...args: unknown[]) => unknown)
        : () => Promise.resolve(deny(adapter, capability, op)),
    ];
  });
  // The keys come from the canonical operation list, so the built object is
  // exactly `TCapability` by construction — but TypeScript cannot see that
  // through `Object.fromEntries`, hence the widening cast.
  const built = {
    ...Object.fromEntries(entries),
    allowlist,
    supports: (op: TOp) => allowlist.includes(op),
  };
  return built as unknown as TCapability;
}

/** Compose a {@link CapabilityBroker} from the operations an adapter has. */
export function composeCapabilityBroker(options: ComposeCapabilityBrokerOptions): CapabilityBroker {
  const { adapter, pageGestures } = options;
  const gestures: Partial<PageGestureChannel> = pageGestures ?? {};

  return {
    adapter,
    browser: domain<BrowserOperation, BrowserCapability>(
      adapter,
      'browser',
      BROWSER_OPERATIONS,
      options.browser
    ),
    network: domain<NetworkOperation, NetworkCapability>(
      adapter,
      'network',
      NETWORK_OPERATIONS,
      options.network
    ),
    secrets: domain<SecretOperation, SecretCapability>(
      adapter,
      'secrets',
      SECRET_OPERATIONS,
      options.secrets
    ),
    devices: domain<DeviceOperation, DeviceCapability>(adapter, 'devices', DEVICE_OPERATIONS, {
      usbRequest: gestures.usbRequest,
      serialRequest: gestures.serialRequest,
      hidRequest: gestures.hidRequest,
      ...options.devices,
    }),
    mounts: domain<MountOperation, MountCapability>(adapter, 'mounts', MOUNT_OPERATIONS, {
      pickDirectory: gestures.pickDirectory,
      ...options.mounts,
    }),
    approvals: domain<ApprovalOperation, ApprovalCapability>(
      adapter,
      'approvals',
      APPROVAL_OPERATIONS,
      options.approvals
    ),
  };
}
