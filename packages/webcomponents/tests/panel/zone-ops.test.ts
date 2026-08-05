/**
 * The five-zone model's pure operations.
 *
 * These replaced a recursive split tree's algebra. The tree could express more, but
 * nothing a user could aim at — rearranging meant one of five positions relative to
 * some particular panel, times every panel on screen. Zones are plain lists, so
 * these are correspondingly small; that IS the point.
 */

import { describe, expect, it } from 'vitest';
import { liveArrangement } from '../../src/panel/center-ops.js';
import type { LayoutDocument } from '../../src/panel/layout-schema.js';
import {
  DEFAULT_ZONE_AXIS,
  moveToZone,
  removeFromZones,
  ZONE_NAMES,
  type ZonesSpec,
  zoneAxis,
  zoneOfPanel,
  zonesFromCenter,
} from '../../src/panel/layout-schema.js';

describe('the zone vocabulary', () => {
  it('is exactly the five BorderLayout regions', () => {
    expect(ZONE_NAMES).toEqual(['top', 'left', 'center', 'right', 'bottom']);
  });
});

describe('zoneOfPanel', () => {
  const zones: ZonesSpec = { left: ['chat', 'files'], center: ['term'] };

  it('finds a panel wherever it sits', () => {
    expect(zoneOfPanel(zones, 'chat')).toBe('left');
    expect(zoneOfPanel(zones, 'files')).toBe('left');
    expect(zoneOfPanel(zones, 'term')).toBe('center');
  });

  it('returns null for a panel in no zone', () => {
    expect(zoneOfPanel(zones, 'monitor')).toBeNull();
  });
});

describe('moveToZone', () => {
  it('moves a panel between zones', () => {
    const next = moveToZone({ left: ['chat'], center: ['files'] }, 'chat', 'right');
    expect(next.left).toEqual([]);
    expect(next.right).toEqual(['chat']);
    expect(next.center).toEqual(['files']);
  });

  it('APPENDS rather than replacing — a zone holds several panels', () => {
    // Two panels in one zone is the case that motivated keeping zones as lists:
    // "there can be two panels on the left side".
    const next = moveToZone({ left: ['chat'], center: ['files'] }, 'files', 'left');
    expect(next.left).toEqual(['chat', 'files']);
    expect(next.center).toEqual([]);
  });

  it('is a no-op for a move into the zone it already occupies', () => {
    const before: ZonesSpec = { left: ['chat'] };
    expect(moveToZone(before, 'chat', 'left')).toBe(before);
  });

  it('places a panel that was in no zone at all', () => {
    const next = moveToZone({ center: ['chat'] }, 'newcomer', 'bottom');
    expect(next.bottom).toEqual(['newcomer']);
  });

  it('does not mutate the input — a rejected move is a returned value', () => {
    const before: ZonesSpec = { left: ['chat'], center: ['files'] };
    moveToZone(before, 'chat', 'right');
    expect(before).toEqual({ left: ['chat'], center: ['files'] });
  });

  it('never leaves a panel in two zones', () => {
    let zones: ZonesSpec = { left: ['chat'] };
    for (const zone of ['top', 'right', 'bottom', 'center', 'left'] as const) {
      zones = moveToZone(zones, 'chat', zone);
      const homes = ZONE_NAMES.filter((z) => (zones[z] ?? []).includes('chat'));
      expect(homes).toEqual([zone]);
    }
  });

  it('preserves sizes and locks across a move', () => {
    const next = moveToZone(
      { left: ['chat'], sizes: { left: '30%' }, locked: ['top'] },
      'chat',
      'right'
    );
    expect(next.sizes).toEqual({ left: '30%' });
    expect(next.locked).toEqual(['top']);
  });
});

describe('removeFromZones', () => {
  it('drops the panel from whichever zone held it', () => {
    const next = removeFromZones({ left: ['chat', 'files'] }, 'chat');
    expect(next.left).toEqual(['files']);
  });

  it('leaves an unrelated spec alone', () => {
    expect(removeFromZones({ left: ['chat'] }, 'nope')).toEqual({ left: ['chat'] });
  });
});

describe('zoneAxis', () => {
  it('runs the wide bands as rows and the tall ones as columns', () => {
    // A default per zone SHAPE: stacking a full-width top band would waste it,
    // and a side-by-side left column would be two slivers.
    expect(zoneAxis({}, 'top')).toBe('row');
    expect(zoneAxis({}, 'bottom')).toBe('row');
    expect(zoneAxis({}, 'left')).toBe('col');
    expect(zoneAxis({}, 'right')).toBe('col');
    expect(zoneAxis({}, 'center')).toBe('col');
  });

  it('lets a document override per zone — side by side OR stacked', () => {
    expect(zoneAxis({ axes: { left: 'row' } }, 'left')).toBe('row');
    expect(zoneAxis({ axes: { top: 'col' } }, 'top')).toBe('col');
  });

  it('exposes the defaults as data', () => {
    expect(DEFAULT_ZONE_AXIS.left).toBe('col');
  });
});

describe('zonesFromCenter (legacy migration)', () => {
  it('flattens a split tree into the center zone', () => {
    // The tree's geometry has no faithful five-zone equivalent, so inventing one
    // would silently rearrange a saved layout. Everything in the center is honest:
    // the panels are all still there, in one region the user can redistribute.
    const zones = zonesFromCenter({
      split: 'row',
      children: [
        { panel: 'chat' },
        { split: 'col', children: [{ panel: 'files' }, { panel: 'term' }] },
      ],
    });
    expect(zones).toEqual({ center: ['chat', 'files', 'term'] });
  });

  it('handles an empty center', () => {
    expect(zonesFromCenter(null)).toEqual({ center: [] });
  });
});

describe('liveArrangement', () => {
  const doc: LayoutDocument = {
    version: 1,
    id: 'x',
    base: { zones: { center: ['wide'] } },
    variants: [
      { when: { maxWidth: 700 }, zones: { center: ['narrow'] } },
      { when: { maxWidth: 700 }, docks: [] },
    ],
  };

  it('returns base when no variant matches', () => {
    expect(liveArrangement(doc, { width: 1200, height: 800 })).toBe(doc.base);
  });

  it('returns the variant whose working area the user is actually looking at', () => {
    // Variants replace the working area, so an edit made at a narrow width has to
    // land on the variant — writing it to `base` would appear to do nothing.
    expect(liveArrangement(doc, { width: 500, height: 800 })).toBe(doc.variants?.[0]);
  });

  it('ignores a matching variant that supplies no working area', () => {
    expect(liveArrangement(doc, { width: 500, height: 800 })).not.toBe(doc.variants?.[1]);
  });

  it('recognizes a legacy variant that supplies a center tree', () => {
    const legacy: LayoutDocument = {
      version: 1,
      id: 'y',
      base: { center: { panel: 'wide' } },
      variants: [{ when: { maxWidth: 700 }, center: { panel: 'narrow' } }],
    };
    expect(liveArrangement(legacy, { width: 500, height: 800 })).toBe(legacy.variants?.[0]);
  });
});
