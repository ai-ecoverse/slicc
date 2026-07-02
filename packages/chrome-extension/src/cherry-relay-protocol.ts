// Shared names/types for the cherry-relay Port (SW ↔ ISOLATED relay) and the
// window CustomEvents (ISOLATED relay ↔ MAIN launcher entry). One source of truth.
export const CHERRY_RELAY_PORT_NAME = 'cherry-relay';

export type SwToRelayMessage = { kind: 'join-url'; joinUrl: string | null } | { kind: 'teardown' };
export type RelayToSwMessage = { kind: 'close' };

export const CHERRY_EVT = {
  joinUrl: 'slicc:cherry-joinurl',
  teardown: 'slicc:cherry-teardown',
  close: 'slicc:cherry-close',
  mounted: 'slicc:cherry-mounted',
} as const;

export interface CherryJoinUrlDetail {
  joinUrl: string;
}
