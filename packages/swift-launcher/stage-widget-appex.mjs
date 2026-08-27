// Stage the widget appex inside Sliccstart.app.
//
// Simpler than its File Provider sibling: the widget links no third-party
// framework (no WebRTC — it holds no tray connection by design) and Notification
// Centre draws the HOST app's icon on the widget's gallery entry, so there is
// nothing to embed. It is a plain copy with a guard, kept as its own module so
// assemble-app.mjs stays a list of steps.

import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export const WIDGET_APPEX_NAME = 'SliccstartWidgets.appex';

/**
 * Copy the built widget appex into `Contents/PlugIns/`.
 *
 * @param {object} opts
 * @param {string} opts.appexSource Built `.appex` bundle from xcodebuild.
 * @param {string} opts.plugInsDir  Host `Contents/PlugIns` directory.
 * @returns {string} Absolute path of the staged appex.
 */
export function stageWidgetAppex({ appexSource, plugInsDir }) {
  if (!existsSync(appexSource)) {
    throw new Error(`ERROR: ${WIDGET_APPEX_NAME} not found at ${appexSource}`);
  }
  mkdirSync(plugInsDir, { recursive: true });
  const dest = resolve(plugInsDir, WIDGET_APPEX_NAME);
  cpSync(appexSource, dest, { recursive: true });
  return dest;
}
