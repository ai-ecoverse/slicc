/**
 * Showing and hiding a panel in a `<slicc-layout>`.
 *
 * One implementation shared by every caller — the add-panel menu, the dock rail,
 * the `layout show`/`layout hide` shell verbs, and sprinkle hosting — because the
 * two ways to get this wrong are opposites and each was live in a different copy:
 *
 *   - Flipping `visible` alone renders NOTHING for a panel the arrangement doesn't
 *     mention. Tool panels and sprinkles start unplaced, so "show" has to add them.
 *   - Adding unconditionally DUPLICATES a panel the arrangement already has.
 *
 * The dividing question is whether the DOCUMENT already references the panel, which
 * is the only check that's right at boot: a restored layout names panels whose
 * elements haven't mounted yet, so anything asking "is it rendered?" answers no for
 * every one of them and appends a second copy on every reload.
 */

import type { SliccLayout } from '@slicc/webcomponents';
import { liveArrangement } from '@slicc/webcomponents/panel/center-ops';
import { moveToZone, zoneOfPanel, zonesFromCenter } from '@slicc/webcomponents/panel/layout-schema';

/**
 * Show or hide `panelId`, adding it to a zone when showing something not placed yet.
 *
 * Edits the document and re-applies it, rather than poking the element's `hidden`
 * attribute: the next re-render rebuilds from the document, so an attribute write
 * would simply be undone — and the change has to be in the document to be saveable.
 *
 * A newly shown panel joins the `right` zone — where the tool rail's panels have
 * always appeared, and the choice that does not displace chat. The user can then
 * drag it to any of the five zones.
 */
export function setPanelVisible(layout: SliccLayout, panelId: string, visible: boolean): void {
  const next = layout.getLayout();
  // Target the arrangement the current environment RENDERS, which may be a variant
  // rather than `base`: a variant replaces the center wholesale, so appending to
  // `base` while a narrow variant is on screen places the panel nowhere visible.
  const owner = liveArrangement(next, layout.environment());
  if (visible) {
    // Migrate a legacy center tree rather than refusing to place into it.
    const zones = owner.zones ?? zonesFromCenter(owner.center ?? null);
    if (!zoneOfPanel(zones, panelId)) {
      // New panels open in `right`: it is the zone the tool rail's panels have
      // always used, and putting them in `center` would displace chat.
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
