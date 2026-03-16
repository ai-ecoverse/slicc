/**
 * Tab grouping — adds agent-created tabs to a persistent "slicc" Chrome tab group.
 *
 * Extension-mode only. Creates the group lazily on first tab creation and reuses
 * it for the session. If the user ungroups tabs, a new group is created on the
 * next tab open. Best-effort: failures are silently ignored.
 */

let sliccGroupId: number | null = null;

/**
 * Add a tab to the "slicc" tab group. Creates the group on first call.
 * Best-effort — silently ignores failures (tab closed, API unavailable, etc.).
 */
export async function addToSliccGroup(tabId: number): Promise<void> {
  try {
    if (sliccGroupId !== null) {
      try {
        await chrome.tabs.group({ tabIds: tabId, groupId: sliccGroupId });
        return;
      } catch {
        // Group was removed by user, create a new one
        sliccGroupId = null;
      }
    }
    sliccGroupId = await chrome.tabs.group({ tabIds: tabId });
    await chrome.tabGroups.update(sliccGroupId, {
      title: 'slicc',
      color: 'pink',
      collapsed: false,
    });
  } catch {
    // Best-effort — tab may have been closed or API unavailable
  }
}

/** Reset internal state. Exported for testing only. */
export function _resetGroupState(): void {
  sliccGroupId = null;
}
