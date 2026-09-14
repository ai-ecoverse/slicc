







import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export const WIDGET_APPEX_NAME = 'SliccstartWidgets.appex';









export function stageWidgetAppex({ appexSource, plugInsDir }) {
  if (!existsSync(appexSource)) {
    throw new Error(`ERROR: ${WIDGET_APPEX_NAME} not found at ${appexSource}`);
  }
  mkdirSync(plugInsDir, { recursive: true });
  const dest = resolve(plugInsDir, WIDGET_APPEX_NAME);
  cpSync(appexSource, dest, { recursive: true });
  return dest;
}
