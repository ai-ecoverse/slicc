/** Leader-local model/thinking changes that followers need to observe. */
export const LEADER_LOCAL_MODEL_STATE_CHANGED_EVENT = 'slicc:leader-local-model-state-changed';

/** Notify the tray only after local model state is fresh. */
export function notifyLeaderLocalModelStateChanged(
  target: Pick<Window, 'dispatchEvent'> = window
): void {
  target.dispatchEvent(new Event(LEADER_LOCAL_MODEL_STATE_CHANGED_EVENT));
}
