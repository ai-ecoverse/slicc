/**
 * localStorage keys for the tray runtime configuration.
 *
 * Declared in `base/` (bottom rung of the layer stack) so shell-layer modules
 * can read them without an up-stack import into `scoops/`;
 * `scoops/tray-runtime-config.ts` re-exports them for its existing callers.
 */

export const TRAY_WORKER_STORAGE_KEY = 'slicc.trayWorkerBaseUrl';
export const TRAY_JOIN_STORAGE_KEY = 'slicc.trayJoinUrl';
