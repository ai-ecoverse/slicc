/**
 * Tab grouping — adds agent-created tabs to a persistent "slicc" Chrome tab group.
 *
 * Extension-mode only. Creates the group lazily on first tab creation and reuses
 * it for the session. If the user ungroups tabs, a new group is created on the
 * next tab open. Best-effort: failures are logged but never block tab creation.
 */

import { createLogger } from '../core/logger.js';

const log = createLogger('extension:tab-group');

let sliccGroupId: number | null = null;

/**
 * Add a tab to the "slicc" tab group. Creates the group on first call.
 * Best-effort — failures are logged but never propagated.
 */
export async function addToSliccGroup(tabId: number): Promise<void> {
  try {
    if (sliccGroupId !== null) {
      try {
        await chrome.tabs.group({ tabIds: tabId, groupId: sliccGroupId });
        return;
      } catch (err) {
        log.info('Tab group removed by user, recreating', {
          tabId,
          previousGroupId: sliccGroupId,
          error: err instanceof Error ? err.message : String(err),
        });
        sliccGroupId = null;
      }
    }
    sliccGroupId = await chrome.tabs.group({ tabIds: tabId });
    await chrome.tabGroups.update(sliccGroupId, {
      title: 'slicc',
      color: 'pink',
      collapsed: false,
    });
  } catch (err) {
    log.warn('Tab grouping failed (best-effort, continuing without group)', {
      tabId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Reset internal state. Exported for testing only. */
export function _resetGroupState(): void {
  sliccGroupId = null;
}
