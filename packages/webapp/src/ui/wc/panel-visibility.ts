import type { SliccLayout } from '@slicc/webcomponents';
import { liveArrangement } from '@slicc/webcomponents/panel/center-ops';
import { moveToZone, zoneOfPanel, zonesFromCenter } from '@slicc/webcomponents/panel/layout-schema';

export function setPanelVisible(layout: SliccLayout, panelId: string, visible: boolean): void {
  const next = layout.getLayout();

  const owner = liveArrangement(next, layout.environment());
  if (visible) {
    const zones = owner.zones ?? zonesFromCenter(owner.center ?? null);
    if (!zoneOfPanel(zones, panelId)) {
      owner.zones = moveToZone(zones, panelId, 'right');
      owner.center = null;
    } else if (!owner.zones) {
      owner.zones = zones;
      owner.center = null;
    }
  }
  next.panels = { ...next.panels, [panelId]: { ...next.panels?.[panelId], visible } };
  layout.setLayout(next);
}
