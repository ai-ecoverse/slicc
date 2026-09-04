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
 * read many times. `undefined` (never set — a test, or a boot ordering bug)
 * falls back to the `node-rest` adapter, matching every other
 * broker-consuming module's test-time default.
 */
import {
  type CapabilityBroker,
  createRestCapabilityBroker,
} from '../../work-unit/capability/index.js';

let mountCapabilityBroker: CapabilityBroker | undefined;

export function setMountCapabilityBroker(broker: CapabilityBroker | undefined): void {
  mountCapabilityBroker = broker;
}

export function getMountCapabilityBroker(): CapabilityBroker {
  return mountCapabilityBroker ?? createRestCapabilityBroker();
}
