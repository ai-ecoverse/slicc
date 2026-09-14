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

type Operations<TCapability> = Omit<TCapability, 'allowlist' | 'supports'>;

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

  const built = {
    ...Object.fromEntries(entries),
    allowlist,
    supports: (op: TOp) => allowlist.includes(op),
  };
  return built as unknown as TCapability;
}

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
