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
  /** Grants that have not yet finished `device.claimInterface`. */
  pendingGrants: Map<string, string>;
  listeners: Set<UsbClaimEventListener>;
}

const byRegistry = new WeakMap<DeviceHandleRegistry, RegistryClaimState>();

function stateOf(registry: DeviceHandleRegistry): RegistryClaimState {
  let state = byRegistry.get(registry);
  if (!state) {
    state = {
      claims: new Map(),
      waiters: new Map(),
      pendingGrants: new Map(),
      listeners: new Set(),
    };
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
  wait = false,
  signal?: AbortSignal
): Promise<'held' | 'acquired'> {
  if (signal?.aborted) {
    throw abortError(handle, interfaceNumber, owner);
  }
  const current = claimOwner(registry, handle, interfaceNumber);
  if (current === owner) return 'held';
  if (!current) {
    setClaim(registry, handle, interfaceNumber, owner);
    markPendingGrant(registry, handle, interfaceNumber, owner);
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
  await enqueueClaim(registry, handle, interfaceNumber, owner, signal);
  return 'acquired';
}

/**
 * Remove a queued waiter without granting the claim. Used when the
 * waiting RPC times out or the consumer is disposed, so a later
 * release cannot grant a caller that already failed.
 */
export function cancelClaimWait(
  registry: DeviceHandleRegistry,
  handle: string,
  interfaceNumber: number,
  owner: string
): boolean {
  const key = claimWaitKey(handle, interfaceNumber);
  const waiters = stateOf(registry).waiters;
  const queue = waiters.get(key);
  if (!queue) return false;
  const idx = queue.findIndex((w) => w.owner === owner);
  if (idx < 0) return false;
  const [waiter] = queue.splice(idx, 1);
  if (queue.length === 0) waiters.delete(key);
  waiter?.reject(abortError(handle, interfaceNumber, owner));
  return true;
}

/**
 * Drop a grant that has not yet finished `device.claimInterface`.
 * Returns true when `owner` still had that pending grant. Does not
 * wake the next waiter — the in-flight claim path releases WebUSB
 * first, then {@link wakeInterfaceWaiter}.
 */
export function takePendingGrant(
  registry: DeviceHandleRegistry,
  handle: string,
  interfaceNumber: number,
  owner: string
): boolean {
  const key = claimWaitKey(handle, interfaceNumber);
  const pending = stateOf(registry).pendingGrants;
  if (pending.get(key) !== owner) return false;
  pending.delete(key);
  deleteClaim(registry, handle, interfaceNumber);
  return true;
}

/** The claim is live; a later cancel must not treat it as in-flight. */
export function clearPendingGrant(
  registry: DeviceHandleRegistry,
  handle: string,
  interfaceNumber: number,
  owner: string
): void {
  const key = claimWaitKey(handle, interfaceNumber);
  const pending = stateOf(registry).pendingGrants;
  if (pending.get(key) === owner) pending.delete(key);
}

/**
 * Drop every claim and queued wait belonging to `owner`. Does not
 * wake the next waiter — the caller must {@link wakeInterfaceWaiter}
 * after releasing the live WebUSB interface so a queued consumer
 * does not claimInterface while the previous holder still owns it.
 */
export function takeOwnerClaims(
  registry: DeviceHandleRegistry,
  owner: string
): UsbInterfaceClaim[] {
  const state = stateOf(registry);
  for (const [key, queue] of [...state.waiters]) {
    const remaining: ClaimWaiter[] = [];
    for (const waiter of queue) {
      if (waiter.owner === owner) {
        const [handle, iface] = splitWaitKey(key);
        waiter.reject(abortError(handle, iface, owner));
      } else {
        remaining.push(waiter);
      }
    }
    if (remaining.length === 0) state.waiters.delete(key);
    else state.waiters.set(key, remaining);
  }
  const dropped: UsbInterfaceClaim[] = [];
  for (const [handle, byIface] of [...state.claims]) {
    for (const [interfaceNumber, heldBy] of [...byIface]) {
      if (heldBy !== owner) continue;
      dropped.push({ handle, interfaceNumber, owner });
      byIface.delete(interfaceNumber);
      state.pendingGrants.delete(claimWaitKey(handle, interfaceNumber));
    }
    if (byIface.size === 0) state.claims.delete(handle);
  }
  return dropped;
}

/** Grant the next queued waiter for `(handle, interfaceNumber)`, if any. */
export function wakeInterfaceWaiter(
  registry: DeviceHandleRegistry,
  handle: string,
  interfaceNumber: number
): void {
  wakeNextWaiter(registry, handle, interfaceNumber);
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
  clearPendingGrant(registry, handle, interfaceNumber, owner);
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
  const state = stateOf(registry);
  const prefix = `${handle}:`;
  for (const key of [...state.pendingGrants.keys()]) {
    if (key.startsWith(prefix)) state.pendingGrants.delete(key);
  }
  state.claims.delete(handle);
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

export function claimWaitCancelledError(
  handle: string,
  interfaceNumber: number,
  owner: string
): Error {
  return new Error(
    `usb claim wait cancelled for '${handle}' interface ${interfaceNumber} (owner ${owner})`
  );
}

function abortError(handle: string, interfaceNumber: number, owner: string): Error {
  return claimWaitCancelledError(handle, interfaceNumber, owner);
}

function markPendingGrant(
  registry: DeviceHandleRegistry,
  handle: string,
  interfaceNumber: number,
  owner: string
): void {
  stateOf(registry).pendingGrants.set(claimWaitKey(handle, interfaceNumber), owner);
}

function splitWaitKey(key: string): [string, number] {
  const idx = key.lastIndexOf(':');
  return [key.slice(0, idx), Number(key.slice(idx + 1))];
}

function enqueueClaim(
  registry: DeviceHandleRegistry,
  handle: string,
  interfaceNumber: number,
  owner: string,
  signal?: AbortSignal
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const key = claimWaitKey(handle, interfaceNumber);
    const waiters = stateOf(registry).waiters;
    const queue = waiters.get(key) ?? [];
    const onAbort = () => {
      cancelClaimWait(registry, handle, interfaceNumber, owner);
    };
    const waiter: ClaimWaiter = {
      owner,
      resolve: () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      },
      reject: (err) => {
        signal?.removeEventListener('abort', onAbort);
        reject(err);
      },
    };
    queue.push(waiter);
    waiters.set(key, queue);
    if (!signal) return;
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
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
  markPendingGrant(registry, handle, interfaceNumber, next.owner);
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
