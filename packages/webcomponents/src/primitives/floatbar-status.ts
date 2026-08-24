/**
 * Floatbar status vocabulary — connection health, float kind, and tray role
 * are orthogonal. Follower count lives in the pill's followers segment, not
 * here. Pure/DOM-free so Storybook matrices and app wiring share one mapper.
 */

export type FloatbarConnection =
  | 'offline'
  | 'connecting'
  | 'live'
  | 'stalled'
  | 'reconnecting'
  | 'error';

export type FloatbarFloatKind =
  | 'npx'
  | 'sliccstart'
  | 'extension'
  | 'standalone'
  | 'cherry'
  | 'electron'
  | 'hosted';

export type FloatbarTrayRole = 'none' | 'leader' | 'follower';

export interface FloatbarStatus {
  connection: FloatbarConnection;
  floatKind: FloatbarFloatKind;
  trayRole: FloatbarTrayRole;
}

export const FLOATBAR_CONNECTIONS: readonly FloatbarConnection[] = [
  'offline',
  'connecting',
  'live',
  'stalled',
  'reconnecting',
  'error',
];

export const FLOATBAR_FLOAT_KINDS: readonly FloatbarFloatKind[] = [
  'npx',
  'sliccstart',
  'extension',
  'standalone',
  'cherry',
  'electron',
  'hosted',
];

export const FLOATBAR_TRAY_ROLES: readonly FloatbarTrayRole[] = ['none', 'leader', 'follower'];

const CONNECTION_FILL: Record<FloatbarConnection, string> = {
  offline: '#94a3b8',
  connecting: '#f59e0b',
  live: '#22c55e',
  stalled: '#eab308',
  reconnecting: '#f97316',
  error: '#ef4444',
};

const CONNECTION_GLOW: Record<FloatbarConnection, string> = {
  offline: 'color-mix(in srgb, #94a3b8 18%, transparent)',
  connecting: 'color-mix(in srgb, #f59e0b 28%, transparent)',
  live: 'color-mix(in srgb, #22c55e 22%, transparent)',
  stalled: 'color-mix(in srgb, #eab308 26%, transparent)',
  reconnecting: 'color-mix(in srgb, #f97316 28%, transparent)',
  error: 'color-mix(in srgb, #ef4444 24%, transparent)',
};

const CONNECTION_LABEL: Record<FloatbarConnection, string> = {
  offline: 'offline',
  connecting: 'connecting',
  live: 'live',
  stalled: 'leader busy',
  reconnecting: 'reconnecting',
  error: 'connection error',
};

const FLOAT_KIND_ICON: Record<FloatbarFloatKind, string> = {
  npx: 'terminal',
  sliccstart: 'monitor',
  extension: 'blocks',
  standalone: 'monitor',
  cherry: 'frame',
  electron: 'laptop',
  hosted: 'cloud',
};

const FLOAT_KIND_LABEL: Record<FloatbarFloatKind, string> = {
  npx: 'npx',
  sliccstart: 'sliccstart',
  extension: 'extension',
  standalone: 'standalone',
  cherry: 'cherry',
  electron: 'electron',
  hosted: 'hosted',
};

const TRAY_ROLE_ICON: Record<Exclude<FloatbarTrayRole, 'none'>, string> = {
  leader: 'crown',
  follower: 'radio',
};

const TRAY_ROLE_LABEL: Record<FloatbarTrayRole, string> = {
  none: 'local',
  leader: 'leading tray',
  follower: 'following tray',
};

export function floatKindIcon(kind: FloatbarFloatKind): string {
  return FLOAT_KIND_ICON[kind];
}

export function floatKindLabel(kind: FloatbarFloatKind): string {
  return FLOAT_KIND_LABEL[kind];
}

export function connectionFill(connection: FloatbarConnection): string {
  return CONNECTION_FILL[connection];
}

export function connectionGlow(connection: FloatbarConnection): string {
  return CONNECTION_GLOW[connection];
}

export function connectionLabel(connection: FloatbarConnection): string {
  return CONNECTION_LABEL[connection];
}

export function trayRoleIcon(role: FloatbarTrayRole): string | null {
  return role === 'none' ? null : TRAY_ROLE_ICON[role];
}

export function trayRoleLabel(role: FloatbarTrayRole): string {
  return TRAY_ROLE_LABEL[role];
}

export function connectionPulses(connection: FloatbarConnection): boolean {
  return connection === 'connecting' || connection === 'reconnecting';
}

/** Default status when nothing is wired yet. */
export function defaultFloatbarStatus(): FloatbarStatus {
  return { connection: 'offline', floatKind: 'standalone', trayRole: 'none' };
}

/** Human-readable beacon tooltip fragment. */
export function statusTipFragment(status: FloatbarStatus): string {
  return [
    floatKindLabel(status.floatKind),
    trayRoleLabel(status.trayRole),
    connectionLabel(status.connection),
  ].join(' · ');
}

/** Recommended float label: float kind only — never encodes follower count. */
export function defaultFloatLabel(kind: FloatbarFloatKind): string {
  return floatKindLabel(kind);
}
