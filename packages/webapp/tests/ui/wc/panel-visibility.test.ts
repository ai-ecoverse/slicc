// @vitest-environment jsdom
/**
 * Showing and hiding a panel.
 *
 * The two failure modes here are opposites, and each shipped in a different copy of
 * this logic before it was unified — so both get a regression test:
 *
 *   - "show" that only flips `visible` renders NOTHING for an unplaced panel.
 *   - "show" that always appends DUPLICATES a panel the document already has.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import { LAYOUT_SCHEMA_VERSION, type LayoutDocument, SliccLayout } from '@slicc/webcomponents';
import { setPanelVisible } from '../../../src/ui/wc/panel-visibility.js';

function doc(base: LayoutDocument['base'], over: Partial<LayoutDocument> = {}): LayoutDocument {
  return { version: LAYOUT_SCHEMA_VERSION, id: 'test', base, ...over };
}

/** A mounted layout holding the given document. No panel ELEMENTS — see below. */
function mount(document_: LayoutDocument): SliccLayout {
  const layout = new SliccLayout();
  document.body.appendChild(layout);
  layout.setLayout(document_);
  return layout;
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe('setPanelVisible', () => {
  it('ADDS an unplaced panel to a zone, not just a visible flag', () => {
    // Tool panels and sprinkles start unplaced, so flipping `visible` alone marked
    // an absent panel visible and rendered nothing — `layout show files` reported
    // success and put nothing on screen.
    const layout = mount(doc({ zones: { center: ['chat'] } }));

    setPanelVisible(layout, 'files', true);

    // `right` is where the tool rail's panels have always opened, and it does not
    // displace chat.
    expect(layout.getLayout().base.zones?.right).toEqual(['files']);
    expect(layout.getLayout().base.zones?.center).toEqual(['chat']);
    expect(layout.getLayout().panels?.files?.visible).toBe(true);
  });

  it('does NOT duplicate a panel the document already places', () => {
    // The boot-order bug: this check has to ask the DOCUMENT, because a restored
    // layout names panels whose elements haven't mounted yet — so anything asking
    // "is it rendered?" answers no for all of them. Measured before the fix: three
    // sprinkles appeared twice each, growing the layout on every reload.
    const before = doc({ zones: { center: ['chat'], right: ['files'] } });
    const layout = mount(before);

    setPanelVisible(layout, 'files', true);

    expect(layout.getLayout().base.zones).toEqual(before.base.zones);
  });

  it('stays idempotent across repeated shows — no duplication', () => {
    const layout = mount(doc({ zones: { center: ['chat'] } }));
    for (let i = 0; i < 5; i++) setPanelVisible(layout, 'files', true);

    expect(layout.getLayout().base.zones?.right).toEqual(['files']);
  });

  it('places into an empty arrangement', () => {
    const layout = mount(doc({}));
    setPanelVisible(layout, 'chat', true);
    expect(layout.getLayout().base.zones?.right).toEqual(['chat']);
  });

  it('MIGRATES a legacy center tree instead of refusing to place into it', () => {
    // A document saved before the zone model must stay usable.
    const layout = mount(doc({ center: { panel: 'chat' } }));
    setPanelVisible(layout, 'files', true);

    const saved = layout.getLayout();
    expect(saved.base.center).toBeNull();
    expect(saved.base.zones?.center).toEqual(['chat']);
    expect(saved.base.zones?.right).toEqual(['files']);
  });

  it('hides by flipping the override and LEAVES the panel in its zone', () => {
    // Keeping it placed is what lets showing it again restore its old position
    // instead of re-appending it somewhere else.
    const before = doc({ zones: { center: ['chat'], left: ['files'] } });
    const layout = mount(before);

    setPanelVisible(layout, 'files', false);

    expect(layout.getLayout().base.zones).toEqual(before.base.zones);
    expect(layout.getLayout().panels?.files?.visible).toBe(false);
  });

  it('re-shows a hidden panel IN ITS OLD ZONE, not wherever new panels go', () => {
    const layout = mount(
      doc(
        { zones: { center: ['chat'], left: ['files'] } },
        { panels: { files: { visible: false } } }
      )
    );

    setPanelVisible(layout, 'files', true);

    expect(layout.getLayout().base.zones?.left).toEqual(['files']);
    expect(layout.getLayout().base.zones?.right ?? []).toEqual([]);
    expect(layout.getLayout().panels?.files?.visible).toBe(true);
  });

  it('preserves other overrides on the same panel', () => {
    const layout = mount(
      doc({ center: { panel: 'chat' } }, { panels: { chat: { locked: true, size: 2 } } })
    );
    setPanelVisible(layout, 'chat', false);
    expect(layout.getLayout().panels?.chat).toEqual({ locked: true, size: 2, visible: false });
  });

  it('adds to the matched VARIANT, not base, when one owns the working area', () => {
    // A variant replaces the working area wholesale, so writing to `base` while the
    // narrow arrangement is on screen would place the panel nowhere visible.
    const layout = new SliccLayout();
    // jsdom reports a 0×0 box, which matches `maxWidth: 700`.
    document.body.appendChild(layout);
    layout.setLayout(
      doc(
        { zones: { center: ['chat'] } },
        { variants: [{ when: { maxWidth: 700 }, zones: { center: ['chat'] } }] }
      )
    );

    setPanelVisible(layout, 'files', true);

    const saved = layout.getLayout();
    expect(saved.base.zones?.right ?? []).toEqual([]);
    expect(saved.variants?.[0].zones?.right).toEqual(['files']);
  });
});
