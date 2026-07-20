/**
 * `realm-browser-shared.ts` — leaf helpers shared by the realm browser
 * modules (`realm-browser-bridge.ts` and `realm-ws-observer.ts`) without
 * creating an import cycle between them.
 */
import type { TabHandle } from './realm-types.js';

export function resolveTargetId(tab: TabHandle | string): string {
  if (typeof tab === 'string') return tab;
  if (tab && typeof tab === 'object' && typeof tab.targetId === 'string') return tab.targetId;
  throw new TypeError('browser: expected a tab handle or targetId string');
}
