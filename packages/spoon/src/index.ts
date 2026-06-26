// @ai-ecoverse/spoon — the injection web component. A self-contained package
// holding the `<slicc-launcher>` overlay element, its pure state helpers, and
// the inject/remove glue. Consumed by webapp, the chrome-extension, node-server,
// and swift-server (which embeds the built `dist/ui/electron-overlay-entry.js`
// IIFE). Importing the barrel registers the `<slicc-launcher>` custom element.

export {
  type InjectSliccLauncherOptions,
  injectSliccLauncher,
  removeSliccLauncher,
  SLICC_LAUNCHER_HOST_ID,
} from './inject.js';
export { define } from './internal/define.js';
export {
  DEFAULT_LAUNCHER_CORNER,
  DEFAULT_LAUNCHER_FOLLOWER_STATUS,
  LAUNCHER_CORNERS,
  LAUNCHER_FOLLOWER_STATUS_ATTR,
  LAUNCHER_FOLLOWER_STATUSES,
  type LauncherCorner,
  type LauncherFollowerStatus,
  normalizeLauncherCorner,
  normalizeLauncherFollowerStatus,
  resolveLauncherCorner,
  shouldSnapLauncher,
} from './launcher-state.js';
export {
  type LauncherMoveDetail,
  type LauncherToggleDetail,
  SliccLauncher,
} from './slicc-launcher.js';
