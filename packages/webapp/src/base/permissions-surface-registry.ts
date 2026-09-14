import type { SliccPermissions } from '@slicc/webcomponents';

let leaderSurface: SliccPermissions | null = null;

export function getLeaderPermissionsSurface(): SliccPermissions | null {
  return leaderSurface;
}

export function setLeaderPermissionsSurface(element: SliccPermissions | null): void {
  leaderSurface = element;
}
