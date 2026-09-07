/**
 * The "slicc" tab-grouping helper. This is the only copy; the former shared
 * tab-group.ts module was deleted.
 *
 * Chrome extension API types provided by ./chrome.d.ts
 */

let sliccGroupId: number | null = null;

/** Best-effort: move `tabId` into the pink "slicc" tab group, recreating the
 *  group when the user has dismissed it. Never throws — grouping is cosmetic,
 *  so a failure must not fail the CDP target creation that requested it. */
export async function addToSliccGroup(tabId: number): Promise<void> {
  try {
    if (sliccGroupId !== null) {
      try {
        await chrome.tabs.group({ tabIds: tabId, groupId: sliccGroupId });
        return;
      } catch (err) {
        console.info('[slicc-tab-group] Tab group removed by user, recreating', {
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
    console.warn('[slicc-tab-group] Tab grouping failed (best-effort, continuing without group)', {
      tabId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
