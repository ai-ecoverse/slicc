export const ELECTRON_OVERLAY_APP_PATH = '/electron';

export const BRIDGE_ROLE_QUERY_PARAM = 'role';

export const BRIDGE_ROLE_LEADER = 'leader';

export const BRIDGE_ROLE_FOLLOWER = 'follower';

export type BridgeRole = typeof BRIDGE_ROLE_LEADER | typeof BRIDGE_ROLE_FOLLOWER;
