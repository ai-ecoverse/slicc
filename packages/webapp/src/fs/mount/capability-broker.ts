/**
 * The float's one composed `CapabilityBroker`, for `fs/mount/` transports
 * (#2276 slice C).
 *
 * Its own tiny module, separate from `signed-fetch.ts`, for the same reason
 * `rest-paths.ts` holds `REST_CONTROL_CALL_TIMEOUT_MS` instead of
 * `rest-ops.ts`: `kernel/host.ts` needs to set the broker EAGERLY (right
 * next to `orchestrator.setCapabilityBroker`, before `orchestrator.init()`
 * mounts the shared FS), but `signed-fetch.ts` — and everything it pulls in
 * (`backend-s3.js`, `backend-da.js`, `profile.js`) — stays behind
 * `virtual-fs.ts`'s existing first-use dynamic `import()`. A static import
 * of `signed-fetch.ts` itself from `kernel/host.ts` would drag that whole
 * lazy chunk onto the eager boot graph for a float that may never mount an
 * S3/DA remote.
 *
 * `fs/` sits at the BOTTOM of the layer stack (`LAYER_RANK.fs === 0`) and
 * mount construction happens far from any composition root — deep inside
 * `VirtualFS.mount()`, `mount-commands.ts`, `mount-recovery.ts` — so a
 * constructor-injected broker would have to thread through every one of
 * those call sites. A lazily-set module-level fact, mirroring
 * `base/api-endpoint.ts`'s `chromeExtensionRealm` / `bridgeToken` idiom, is
 * the composition-time answer without that fan-out: resolved once at boot,
 * read many times.
 *
 * `undefined` (never set — a test, or a boot ordering bug) is NOT a
 * fallback-to-`node-rest` case, on purpose (round-1 review finding 2). A
 * silent REST default would let a composition miss on an EXTENSION topology
 * POST a sign-and-forward envelope — the S3/DA credentials' IMS bearer
 * included — to the hosted origin's `/api/*` routes, which is not a
 * node-rest server at all on that float: exactly the "leaks into the
 * tray-hub catch-all" bug (#EXT8-shaped) the old `isExtensionRealm()`
 * branch existed to prevent. The caller (`signed-fetch.ts`) is responsible
 * for turning "unset" into `CapabilityUnavailable`, not this module for
 * guessing a transport.
 *
 * Only the TYPE is imported, not `createRestCapabilityBroker` — `fs/` (layer
 * 0) stays free of any VALUE dependency on the capability package; the
 * layer-back-edge ratchet does not see `work-unit/` at all (unranked), so
 * this is enforced by convention here, not the lint gate.
 */
import type { CapabilityBroker } from '../../work-unit/capability/index.js';

let mountCapabilityBroker: CapabilityBroker | undefined;

export function setMountCapabilityBroker(broker: CapabilityBroker | undefined): void {
  mountCapabilityBroker = broker;
}

/** `undefined` when no broker was ever set — the caller must fail closed, never guess a transport. */
export function getMountCapabilityBroker(): CapabilityBroker | undefined {
  return mountCapabilityBroker;
}
