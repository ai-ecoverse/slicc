// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import {
  buildTrustedLayers,
  isInTrustedLayer,
  mountTrusted,
  PANEL_HOST_CLASS,
  TRUSTED_LAYER_CLASS,
  TRUSTED_LAYER_CSS,
} from '../../../src/ui/wc/trusted-layer.js';

describe('buildTrustedLayers', () => {
  it('builds a panel host and a trusted layer with the canonical classes', () => {
    const { panelHost, trustedLayer } = buildTrustedLayers(document);
    expect(panelHost.className).toBe(PANEL_HOST_CLASS);
    expect(trustedLayer.className).toBe(TRUSTED_LAYER_CLASS);
  });

  it('marks the trusted layer with a data attribute so it is identifiable structurally', () => {
    const { trustedLayer } = buildTrustedLayers(document);
    expect(trustedLayer.hasAttribute('data-slicc-trusted')).toBe(true);
  });
});

describe('the clamp invariants (H2)', () => {
  it('declares isolation:isolate on the panel host — the stacking context that clamps panels', () => {
    expect(TRUSTED_LAYER_CSS).toContain(`.${PANEL_HOST_CLASS}{`);
    expect(TRUSTED_LAYER_CSS).toContain('isolation:isolate');
  });

  it('sizes the panel host by absolute inset, not flex — a block frame would collapse it to 0px', () => {
    expect(TRUSTED_LAYER_CSS).toContain(`.${PANEL_HOST_CLASS}{position:absolute;inset:0;`);
    expect(TRUSTED_LAYER_CSS).not.toContain('flex:1 1 auto');
  });

  it('does NOT give the trusted layer a z-index (ordering is sibling order, not a number race)', () => {
    const layerRule = TRUSTED_LAYER_CSS.slice(
      TRUSTED_LAYER_CSS.indexOf(`.${TRUSTED_LAYER_CLASS}{`)
    );
    expect(layerRule).not.toContain('z-index');
  });

  it('keeps the trusted layer AFTER the panel host in DOM order when composed', () => {
    const frame = document.createElement('div');
    const { panelHost, trustedLayer } = buildTrustedLayers(document);
    frame.append(panelHost, trustedLayer);
    expect(
      panelHost.compareDocumentPosition(trustedLayer) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('a panel with an absurd z-index is still a descendant of the clamped host', () => {
    const frame = document.createElement('div');
    const { panelHost, trustedLayer } = buildTrustedLayers(document);
    frame.append(panelHost, trustedLayer);

    const hostilePanel = document.createElement('div');
    hostilePanel.style.zIndex = '2147483647';
    hostilePanel.style.position = 'fixed';
    panelHost.append(hostilePanel);

    expect(hostilePanel.closest(`.${PANEL_HOST_CLASS}`)).toBe(panelHost);
    expect(isInTrustedLayer(hostilePanel)).toBe(false);
  });
});

describe('isInTrustedLayer', () => {
  it('is true for chrome inside the layer and false for panel content', () => {
    document.body.replaceChildren();
    const { panelHost, trustedLayer } = buildTrustedLayers(document);
    document.body.append(panelHost, trustedLayer);

    const trustedChrome = document.createElement('button');
    trustedLayer.append(trustedChrome);
    const panelContent = document.createElement('button');
    panelHost.append(panelContent);

    expect(isInTrustedLayer(trustedChrome)).toBe(true);
    expect(isInTrustedLayer(panelContent)).toBe(false);
  });

  it('resolves through a text node to its parent element', () => {
    document.body.replaceChildren();
    const { trustedLayer } = buildTrustedLayers(document);
    document.body.append(trustedLayer);
    const label = document.createElement('span');
    label.textContent = 'Approve?';
    trustedLayer.append(label);

    expect(isInTrustedLayer(label.firstChild)).toBe(true);
  });

  it('is false for a detached node and for null', () => {
    expect(isInTrustedLayer(document.createElement('div'))).toBe(false);
    expect(isInTrustedLayer(null)).toBe(false);
  });
});

describe('mountTrusted', () => {
  it('appends approval chrome into the trusted layer', () => {
    document.body.replaceChildren();
    const { panelHost, trustedLayer } = buildTrustedLayers(document);
    document.body.append(panelHost, trustedLayer);

    const dialog = document.createElement('div');
    mountTrusted(dialog, document);

    expect(dialog.parentElement).toBe(trustedLayer);
    expect(isInTrustedLayer(dialog)).toBe(true);
  });

  it('throws rather than silently falling back to document.body when the layer is missing', () => {
    document.body.replaceChildren();
    expect(() => mountTrusted(document.createElement('div'), document)).toThrow(
      /trusted layer not found/
    );
  });
});
