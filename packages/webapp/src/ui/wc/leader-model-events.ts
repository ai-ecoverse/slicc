/** Leader-local model/thinking changes that followers need to observe. */
export const LEADER_LOCAL_MODEL_STATE_CHANGED_EVENT = 'slicc:leader-local-model-state-changed';

/** Notify the tray only after local model state is fresh. */
export function notifyLeaderLocalModelStateChanged(
  target: Pick<Window, 'dispatchEvent'> = window
): void {
  target.dispatchEvent(new Event(LEADER_LOCAL_MODEL_STATE_CHANGED_EVENT));
}

/**
 * The leader's own model catalog changed — an account resolved, a provider's
 * dynamic model list landed. Followers that attached during warm-up are still
 * waiting for their first real `models.list` (#2329).
 */
export const LEADER_MODEL_CATALOG_CHANGED_EVENT = 'slicc:leader-model-catalog-changed';

/** Notify the tray that the leader's model catalog may have become available. */
export function notifyLeaderModelCatalogChanged(
  target: Pick<Window, 'dispatchEvent'> = window
): void {
  target.dispatchEvent(new Event(LEADER_MODEL_CATALOG_CHANGED_EVENT));
}
