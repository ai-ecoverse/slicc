/**
 * Exclusive USB interface-claim bookkeeping, loaded on first claim /
 * close / reset so the kernel-worker's eager boot graph does not pay
 * for arbitration until a consumer actually touches a claimed device.
 *
 * State is keyed by {@link DeviceHandleRegistry} identity (WeakMap) so
 * the page-side singleton and per-test registries stay isolated.
 */

import {
  type DeviceHandleRegistry,
  type UsbClaimEvent,
  type UsbClaimEventListener,
  type UsbInterfaceClaim,
  UsbInterfaceClaimError,
} from './usb-device-registry.js';

interface ClaimWaiter {
  owner: string;
  resolve: () => void;
  reject: (err: Error) => void;
}

interface RegistryClaimState {
  claims: Map<string, Map<number, string>>;
  waiters: Map<string, ClaimWaiter[]>;
  listeners: Set<UsbClaimEventListener>;
}

const byRegistry = new WeakMap<DeviceHandleRegistry, RegistryClaimState>();

function stateOf(registry: DeviceHandleRegistry): RegistryClaimState {
  let state = byRegistry.get(registry);
  if (!state) {
    state = { claims: new Map(), waiters: new Map(), listeners: new Set() };
    byRegistry.set(registry, state);
  }
  return state;
}

function claimWaitKey(handle: string, interfaceNumber: number): string {
  return `${handle}:${interfaceNumber}`;
}

function formatHolders(claims: readonly UsbInterfaceClaim[]): string {
  return claims.map((c) => `interface ${c.interfaceNumber} held by ${c.owner}`).join(', ');
}

/** Current owner of `(handle, interfaceNumber)`, if any. */
export function claimOwner(
  registry: DeviceHandleRegistry,
  handle: string,
  interfaceNumber: number
): string | undefined {
  return stateOf(registry).claims.get(handle)?.get(interfaceNumber);
}

/** Every recorded claim on `handle`. */
export function listClaims(registry: DeviceHandleRegistry, handle: string): UsbInterfaceClaim[] {
  const byIface = stateOf(registry).claims.get(handle);
  if (!byIface) return [];
  return [...byIface].map(([interfaceNumber, owner]) => ({
    handle,
    interfaceNumber,
    owner,
  }));
}

/**
 * Subscribe to `claim-lost` / `disconnect`. Returns an unsubscribe
 * function. Listener faults are swallowed so one consumer cannot
 * break fan-out to the rest.
 */
export function addClaimListener(
  registry: DeviceHandleRegistry,
  listener: UsbClaimEventListener
): () => void {
  const listeners = stateOf(registry).listeners;
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Take exclusive ownership of an interface.
 *
 * - Already held by `owner` → `'held'` (idempotent).
 * - Free → `'acquired'`.
 * - Held by someone else + `wait` → queue FIFO, then `'acquired'`.
 * - Held by someone else, no wait → {@link UsbInterfaceClaimError}.
 */
export async function acquireInterfaceClaim(
  registry: DeviceHandleRegistry,
  handle: string,
  interfaceNumber: number,
  owner: string,
  wait = false
): Promise<'held' | 'acquired'> {
  const current = claimOwner(registry, handle, interfaceNumber);
  if (current === owner) return 'held';
  if (!current) {
    setClaim(registry, handle, interfaceNumber, owner);
    return 'acquired';
  }
  if (!wait) {
    throw new UsbInterfaceClaimError({
      handle,
      holder: current,
      op: 'claim',
      interfaceNumber,
    });
  }
  await enqueueClaim(registry, handle, interfaceNumber, owner);
  return 'acquired';
}

/**
 * Drop `owner`'s claim and wake the next waiter. Throws if another
 * consumer holds the interface. No-op when nothing is recorded.
 */
export function releaseInterfaceClaim(
  registry: DeviceHandleRegistry,
  handle: string,
  interfaceNumber: number,
  owner: string
): void {
  const current = claimOwner(registry, handle, interfaceNumber);
  if (!current) return;
  if (current !== owner) {
    throw new UsbInterfaceClaimError({
      handle,
      holder: current,
      op: 'release',
      interfaceNumber,
    });
  }
  deleteClaim(registry, handle, interfaceNumber);
  wakeNextWaiter(registry, handle, interfaceNumber);
}

/**
 * Refuse close/reset while another consumer holds a claim, unless
 * `force`. Returns the claims that will be displaced (every claim
 * on the handle except those already owned by `owner`).
 */
export function assertExclusive(
  registry: DeviceHandleRegistry,
  handle: string,
  owner: string,
  force: boolean,
  op: 'close' | 'reset'
): UsbInterfaceClaim[] {
  const held = listClaims(registry, handle);
  const others = held.filter((c) => c.owner !== owner);
  if (others.length > 0 && !force) {
    throw new UsbInterfaceClaimError({
      handle,
      holder: formatHolders(others),
      op,
      interfaceNumber: others[0]?.interfaceNumber,
    });
  }
  return others;
}

/**
 * Drop every claim on `handle`, reject queued waiters, and emit
 * `claim-lost` + `disconnect` for each displaced holder.
 */
export function displaceHandle(
  registry: DeviceHandleRegistry,
  handle: string,
  opts: { reason: 'close' | 'reset'; displacedBy: string; displaced: UsbInterfaceClaim[] }
): void {
  rejectWaiters(registry, handle, opts.reason, opts.displacedBy);
  stateOf(registry).claims.delete(handle);
  const seen = new Set<string>();
  for (const claim of opts.displaced) {
    emitClaimEvent(registry, {
      type: 'claim-lost',
      handle,
      interfaceNumber: claim.interfaceNumber,
      holder: claim.owner,
      displacedBy: opts.displacedBy,
      reason: opts.reason,
    });
    if (seen.has(claim.owner)) continue;
    seen.add(claim.owner);
    emitClaimEvent(registry, {
      type: 'disconnect',
      handle,
      holder: claim.owner,
      displacedBy: opts.displacedBy,
      reason: opts.reason,
    });
  }
}

function setClaim(
  registry: DeviceHandleRegistry,
  handle: string,
  interfaceNumber: number,
  owner: string
): void {
  const claims = stateOf(registry).claims;
  let byIface = claims.get(handle);
  if (!byIface) {
    byIface = new Map();
    claims.set(handle, byIface);
  }
  byIface.set(interfaceNumber, owner);
}

function deleteClaim(
  registry: DeviceHandleRegistry,
  handle: string,
  interfaceNumber: number
): void {
  const claims = stateOf(registry).claims;
  const byIface = claims.get(handle);
  if (!byIface) return;
  byIface.delete(interfaceNumber);
  if (byIface.size === 0) claims.delete(handle);
}

function enqueueClaim(
  registry: DeviceHandleRegistry,
  handle: string,
  interfaceNumber: number,
  owner: string
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const key = claimWaitKey(handle, interfaceNumber);
    const waiters = stateOf(registry).waiters;
    const queue = waiters.get(key) ?? [];
    queue.push({ owner, resolve, reject });
    waiters.set(key, queue);
  });
}

function wakeNextWaiter(
  registry: DeviceHandleRegistry,
  handle: string,
  interfaceNumber: number
): void {
  const key = claimWaitKey(handle, interfaceNumber);
  const waiters = stateOf(registry).waiters;
  const queue = waiters.get(key);
  const next = queue?.shift();
  if (!next) {
    waiters.delete(key);
    return;
  }
  if (queue && queue.length === 0) waiters.delete(key);
  setClaim(registry, handle, interfaceNumber, next.owner);
  next.resolve();
}

function rejectWaiters(
  registry: DeviceHandleRegistry,
  handle: string,
  reason: 'close' | 'reset',
  displacedBy: string
): void {
  const prefix = `${handle}:`;
  const waiters = stateOf(registry).waiters;
  for (const [key, queue] of [...waiters]) {
    if (!key.startsWith(prefix)) continue;
    waiters.delete(key);
    const err = new UsbInterfaceClaimError({
      handle,
      holder: displacedBy,
      op: reason,
    });
    for (const waiter of queue) waiter.reject(err);
  }
}

function emitClaimEvent(registry: DeviceHandleRegistry, event: UsbClaimEvent): void {
  for (const listener of [...stateOf(registry).listeners]) {
    try {
      listener(event);
    } catch {
      // Fan-out must not die on a single listener fault.
    }
  }
}
