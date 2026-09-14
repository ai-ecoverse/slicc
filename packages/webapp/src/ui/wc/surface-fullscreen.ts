function quoteSurfaceId(id: string): string {
  return id.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

const PARKING_SELECTOR = '.dock-tree__parking, .slicc-layout__parking';

export function requestPlacedSurfaceFullscreen(root: ParentNode, surfaceId: string): boolean {
  const surface = root.querySelector<HTMLElement>(`[surface-id="${quoteSurfaceId(surfaceId)}"]`);
  if (!surface || surface.closest(PARKING_SELECTOR)) return false;
  void surface.requestFullscreen?.()?.catch(() => {});
  return true;
}
