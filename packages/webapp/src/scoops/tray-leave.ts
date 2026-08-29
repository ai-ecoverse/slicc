/**
 * Tray-leave wire dispatcher — relocated to `base/tray-leave.ts` so `shell/`
 * (the `host leave` command) can drive it without importing UP the layer
 * stack (#2537). It never touched an orchestrator: it resolves an ambient
 * transport and dispatches a page `CustomEvent` or a panel-RPC call, which is
 * bottom-rung work. Re-exported here under the established names.
 */

export {
  type LeaveTrayOptions,
  type LeaveTrayStorage,
  type LeaveTrayTransport,
  type LeaveTrayWire,
  leaveTray,
  resolveAmbientLeaveTrayTransport,
  type TrayLeaveResult,
} from '../base/tray-leave.js';
