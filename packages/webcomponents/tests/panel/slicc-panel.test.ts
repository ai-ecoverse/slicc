import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isPanelAnchor,
  PANEL_MARKER_ATTR,
  type PanelMeta,
  panelMetaOf,
  SliccPanel,
} from '../../src/panel/slicc-panel.js';

/** A subclass declaring full metadata — the built-in registration shape. */
class ProbePanel extends SliccPanel {
  static readonly panelMeta: PanelMeta = {
    id: 'probe',
    title: 'Probe',
    icon: 'activity',
    minWidth: 240,
    preferredSize: '320px',
  };
}

/** A subclass that defaults to floating, to test meta-driven presentation. */
class FloatProbePanel extends SliccPanel {
  static readonly panelMeta: PanelMeta = {
    id: 'float-probe',
    title: 'Float probe',
    presentation: 'floating',
    anchor: 'right',
  };
}

/** A subclass with lifecycle hooks, to test the callback wiring. */
class LifecyclePanel extends SliccPanel {
  static readonly panelMeta: PanelMeta = { id: 'lifecycle', title: 'Lifecycle' };
  shows = 0;
  hides = 0;
  resizes = 0;
  onPanelShow(): void {
    this.shows++;
  }
  onPanelHide(): void {
    this.hides++;
  }
  onPanelResize(): void {
    this.resizes++;
  }
}

/** A subclass with NO lifecycle hooks — the ResizeObserver must be skipped. */
class BarePanel extends SliccPanel {
  static readonly panelMeta: PanelMeta = { id: 'bare', title: 'Bare' };
}

customElements.define('probe-panel', ProbePanel);
customElements.define('float-probe-panel', FloatProbePanel);
customElements.define('lifecycle-panel', LifecyclePanel);
customElements.define('bare-panel', BarePanel);

/** Mount a panel of `tag` into a sized host so flex/absolute geometry resolves. */
function mount<T extends SliccPanel>(tag: string): T {
  const host = document.createElement('div');
  host.style.cssText = 'position:relative;display:flex;width:600px;height:400px;';
  const panel = document.createElement(tag) as T;
  host.appendChild(panel);
  document.body.appendChild(host);
  return panel;
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe('slicc-panel', () => {
  it('registers the base element', () => {
    expect(customElements.get('slicc-panel')).toBe(SliccPanel);
  });

  it('renders in light DOM (layout/slotting host convention — no shadow root)', () => {
    const panel = mount('probe-panel');
    expect(panel.shadowRoot).toBeNull();
  });

  it('marks itself so the shared stylesheet applies to every subclass tag', () => {
    // The stylesheet keys on the marker, not the tag, precisely so a
    // runtime-registered subclass gets styled without touching the CSS.
    const panel = mount('probe-panel');
    expect(panel.hasAttribute(PANEL_MARKER_ATTR)).toBe(true);
    expect(panel.getAttribute('part')).toBe('panel');
    const cs = getComputedStyle(panel);
    expect(cs.display).toBe('flex');
    expect(cs.flexDirection).toBe('column');
  });

  it('is VISIBLE by default — the opposite polarity from slicc-surface', () => {
    // A surface was hidden until `[active]` because it was one of a show-one
    // stack; a panel is placed by the layout, so being in the tree means render.
    const panel = mount('probe-panel');
    expect(panel.visible).toBe(true);
    expect(getComputedStyle(panel).display).toBe('flex');
  });

  it('hides via the native hidden attribute, beating the host display rule', () => {
    const panel = mount('probe-panel');
    panel.visible = false;
    expect(panel.hasAttribute('hidden')).toBe(true);
    // An author `display:flex` on the host would otherwise outrank the UA's
    // `[hidden]{display:none}` — the stylesheet restates it for that reason.
    expect(getComputedStyle(panel).display).toBe('none');
    panel.visible = true;
    expect(getComputedStyle(panel).display).toBe('flex');
  });

  it('reflects locked as an attribute (the layout engine reads it to suppress handles)', () => {
    const panel = mount('probe-panel');
    expect(panel.locked).toBe(false);
    panel.locked = true;
    expect(panel.hasAttribute('locked')).toBe(true);
    panel.locked = false;
    expect(panel.hasAttribute('locked')).toBe(false);
  });

  describe('panelId', () => {
    it('falls back to the subclass panelMeta id', () => {
      expect(mount('probe-panel').panelId).toBe('probe');
    });

    it('prefers an explicit panel-id so one class can back many ids', () => {
      // Every sprinkle panel shares an implementation but needs its own id.
      const panel = mount<SliccPanel>('probe-panel');
      panel.panelId = 'sprinkle:weather';
      expect(panel.panelId).toBe('sprinkle:weather');
      panel.panelId = null;
      expect(panel.panelId).toBe('probe'); // back to the meta default
    });

    it('is null for a subclass with no metadata and no attribute', () => {
      const bare = document.createElement('slicc-panel') as SliccPanel;
      document.body.appendChild(bare);
      expect(bare.panelId).toBeNull();
    });
  });

  describe('presentation', () => {
    it('defaults to docked and takes layout space', () => {
      const panel = mount('probe-panel');
      expect(panel.presentation).toBe('docked');
      expect(getComputedStyle(panel).position).toBe('relative');
    });

    it('honors a floating default from panelMeta, reflecting it so the CSS matches', () => {
      // Reflection matters: the floating rules are attribute selectors, so a
      // meta-only presentation would style nothing without this.
      const panel = mount('float-probe-panel');
      expect(panel.presentation).toBe('floating');
      expect(panel.getAttribute('presentation')).toBe('floating');
      expect(panel.getAttribute('anchor')).toBe('right');
      expect(getComputedStyle(panel).position).toBe('absolute');
    });

    it('lets an explicit attribute override the panelMeta default (layout wins)', () => {
      const host = document.createElement('div');
      host.style.cssText = 'position:relative;display:flex;width:600px;height:400px;';
      const panel = document.createElement('float-probe-panel') as SliccPanel;
      panel.setAttribute('presentation', 'docked'); // set BEFORE connect
      host.appendChild(panel);
      document.body.appendChild(host);

      expect(panel.presentation).toBe('docked');
      expect(getComputedStyle(panel).position).toBe('relative');
    });

    it('a floating panel does not reflow its docked sibling', () => {
      // The whole point of floating: chat keeps its width when a monitor opens.
      const host = document.createElement('div');
      host.style.cssText = 'position:relative;display:flex;width:600px;height:400px;';
      const docked = document.createElement('probe-panel') as SliccPanel;
      host.appendChild(docked);
      document.body.appendChild(host);
      const widthAlone = docked.getBoundingClientRect().width;

      const floating = document.createElement('float-probe-panel') as SliccPanel;
      floating.style.width = '200px';
      host.appendChild(floating);

      expect(docked.getBoundingClientRect().width).toBe(widthAlone);
    });

    it('anchors a floating panel to the requested edge', () => {
      const host = document.createElement('div');
      host.style.cssText = 'position:relative;display:flex;width:600px;height:400px;';
      const panel = document.createElement('float-probe-panel') as SliccPanel;
      panel.setAttribute('anchor', 'bottom');
      panel.style.height = '80px';
      host.appendChild(panel);
      document.body.appendChild(host);

      const hostRect = host.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      expect(panelRect.bottom).toBeCloseTo(hostRect.bottom, 0);
      expect(panelRect.width).toBeCloseTo(hostRect.width, 0);
    });

    it('keeps a floating panel z-index low — it orders against siblings, not the trusted layer', () => {
      // A big number here would be a false sense of power: the panel host is a
      // stacking context, so this only ever orders within it (see H2).
      const panel = mount('float-probe-panel');
      expect(getComputedStyle(panel).zIndex).toBe('1');
    });

    it('the presentation setter switches a live panel between docked and floating', () => {
      // The layout engine flips this at runtime (e.g. a responsive variant
      // floating a rail on a narrow viewport), so it must restyle in place.
      const panel = mount('probe-panel');
      panel.presentation = 'floating';
      expect(panel.getAttribute('presentation')).toBe('floating');
      expect(getComputedStyle(panel).position).toBe('absolute');

      panel.presentation = 'docked';
      expect(getComputedStyle(panel).position).toBe('relative');
    });

    it('the anchor setter moves a floating panel, and null falls back to the meta default', () => {
      const panel = mount<SliccPanel>('float-probe-panel');
      panel.anchor = 'left';
      expect(panel.anchor).toBe('left');
      expect(panel.getAttribute('anchor')).toBe('left');

      panel.anchor = null;
      expect(panel.hasAttribute('anchor')).toBe(false);
      // Attribute gone → the class's own `panelMeta.anchor` again.
      expect(panel.anchor).toBe('right');
    });

    it('ignores a malformed anchor attribute rather than trusting it', () => {
      const panel = mount<SliccPanel>('float-probe-panel');
      panel.setAttribute('anchor', 'sideways');
      expect(panel.anchor).toBe('right'); // meta default, not the junk value
    });

    it('anchor is null when neither the attribute nor the meta supplies one', () => {
      expect(mount<SliccPanel>('probe-panel').anchor).toBeNull();
    });
  });

  describe('meta', () => {
    it('exposes the instance type’s static metadata', () => {
      const panel = mount('probe-panel');
      expect(panel.meta?.id).toBe('probe');
      expect(panel.meta?.preferredSize).toBe('320px');
    });

    it('is undefined on the bare base element', () => {
      const bare = document.createElement('slicc-panel') as SliccPanel;
      document.body.appendChild(bare);
      expect(bare.meta).toBeUndefined();
    });
  });

  describe('lifecycle callbacks', () => {
    it('fires onPanelShow when mounted already-visible', () => {
      // The engine mounts and reveals in one step, so there is no attribute
      // change to hang the callback off — connect has to do it.
      const panel = mount<LifecyclePanel>('lifecycle-panel');
      expect(panel.shows).toBe(1);
      expect(panel.hides).toBe(0);
    });

    it('fires onPanelHide / onPanelShow as visibility toggles', () => {
      const panel = mount<LifecyclePanel>('lifecycle-panel');
      panel.visible = false;
      expect(panel.hides).toBe(1);
      panel.visible = true;
      expect(panel.shows).toBe(2);
    });

    it('fires for a raw hidden attribute write, not just the setter', () => {
      // A host may toggle `hidden` directly; the panel must still react.
      const panel = mount<LifecyclePanel>('lifecycle-panel');
      panel.setAttribute('hidden', '');
      expect(panel.hides).toBe(1);
      panel.removeAttribute('hidden');
      expect(panel.shows).toBe(2);
    });

    it('does not re-fire when the hidden attribute is set to the same value', () => {
      const panel = mount<LifecyclePanel>('lifecycle-panel');
      panel.visible = false;
      panel.setAttribute('hidden', '');
      expect(panel.hides).toBe(1);
    });

    it('emits slicc-panel-visibility (composed + bubbling) with the panel id', () => {
      const panel = mount<LifecyclePanel>('lifecycle-panel');
      const seen: Array<{ panelId: string | null; visible: boolean }> = [];
      let composed = false;
      document.body.addEventListener('slicc-panel-visibility', (e) => {
        const ce = e as CustomEvent<{ panelId: string | null; visible: boolean }>;
        seen.push(ce.detail);
        composed = ce.composed && ce.bubbles;
      });

      panel.visible = false;
      panel.visible = true;

      expect(seen).toEqual([
        { panelId: 'lifecycle', visible: false },
        { panelId: 'lifecycle', visible: true },
      ]);
      expect(composed).toBe(true);
    });

    it('calls onPanelResize when the box changes', async () => {
      const panel = mount<LifecyclePanel>('lifecycle-panel');
      const before = panel.resizes;
      panel.style.width = '123px';
      // ResizeObserver delivers asynchronously.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      expect(panel.resizes).toBeGreaterThan(before);
    });

    it('does NOT observe resize for a subclass that has no onPanelResize', () => {
      // An observer per panel is not free and most panels do not care, so the
      // base class only wires one when the hook exists.
      const spy = vi.spyOn(globalThis, 'ResizeObserver');
      mount('bare-panel');
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('disconnects its observer on unmount (no leak across remounts)', async () => {
      const panel = mount<LifecyclePanel>('lifecycle-panel');
      panel.remove();
      const after = panel.resizes;
      panel.style.width = '321px';
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      expect(panel.resizes).toBe(after);
    });
  });
});

describe('panelMetaOf', () => {
  it('reads a declared panelMeta', () => {
    expect(panelMetaOf(ProbePanel)?.id).toBe('probe');
    expect(panelMetaOf(ProbePanel)?.minWidth).toBe(240);
  });

  it('returns undefined for a class without one, rather than throwing', () => {
    // A subclass that forgets `panelMeta` must degrade, not break boot — the
    // registry validates constructors it has never instantiated.
    class NoMeta extends SliccPanel {}
    expect(panelMetaOf(NoMeta)).toBeUndefined();
    expect(panelMetaOf(SliccPanel)).toBeUndefined();
  });

  it('rejects a malformed panelMeta (missing/non-string id)', () => {
    class BadMeta extends SliccPanel {
      static readonly panelMeta = { title: 'no id' } as unknown as PanelMeta;
    }
    expect(panelMetaOf(BadMeta)).toBeUndefined();
  });

  it('is null-safe', () => {
    expect(panelMetaOf(null)).toBeUndefined();
    expect(panelMetaOf(undefined)).toBeUndefined();
  });
});

describe('isPanelAnchor', () => {
  it('accepts the five anchors and rejects anything else', () => {
    for (const a of ['top', 'right', 'bottom', 'left', 'center']) {
      expect(isPanelAnchor(a)).toBe(true);
    }
    expect(isPanelAnchor('middle')).toBe(false);
    expect(isPanelAnchor('')).toBe(false);
    expect(isPanelAnchor(null)).toBe(false);
  });
});
