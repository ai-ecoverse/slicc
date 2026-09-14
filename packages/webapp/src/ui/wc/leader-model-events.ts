export const LEADER_LOCAL_MODEL_STATE_CHANGED_EVENT = 'slicc:leader-local-model-state-changed';

export function notifyLeaderLocalModelStateChanged(
  target: Pick<Window, 'dispatchEvent'> = window
): void {
  target.dispatchEvent(new Event(LEADER_LOCAL_MODEL_STATE_CHANGED_EVENT));
}

export const LEADER_MODEL_CATALOG_CHANGED_EVENT = 'slicc:leader-model-catalog-changed';

export function notifyLeaderModelCatalogChanged(
  target: Pick<Window, 'dispatchEvent'> = window
): void {
  target.dispatchEvent(new Event(LEADER_MODEL_CATALOG_CHANGED_EVENT));
}
