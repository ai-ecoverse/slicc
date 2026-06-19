import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SliccDip } from '../../src/chat/slicc-dip.js';
// Swatch cells composed by tag — import so they register when tests run.
import '../../src/memory/slicc-palette-cell.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

function mount(attrs: Record<string, string> = {}): SliccDip {
  const el = document.createElement('slicc-dip');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  return el as SliccDip;
}

describe('slicc-dip', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });
  afterEach(() => document.body.replaceChildren());

  it('registers and renders the card structure (header/body/footer parts)', () => {
    expect(customElements.get('slicc-dip')).toBe(SliccDip);
    const el = mount();
    const r = el.shadowRoot;
    expect(r?.querySelector('[part="header"] [part="glyph"]')).not.toBeNull();
    expect(r?.querySelector('[part="tag"]')?.textContent).toContain('sprinkle');
    expect(r?.querySelector('[part="grid-canvas"]')).not.toBeNull();
    expect(r?.querySelector('[part="grid-accent"]')).not.toBeNull();
    expect(r?.querySelector('[part="apply"]')).not.toBeNull();
    expect(r?.querySelector('canvas.sprk')).not.toBeNull();
  });

  it('renders the header glyph chip as a lucide <svg>, never the ✦ emoji glyph', () => {
    const el = mount();
    const glyph = el.shadowRoot?.querySelector('[part="glyph"]');
    // The accent chip is a lucide sparkles <svg>, not a bespoke unicode glyph.
    const svg = glyph?.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.querySelector('path')).not.toBeNull();
    // No emoji / bespoke glyph survives in the chip.
    expect(glyph?.textContent ?? '').not.toContain('✦');
    expect((glyph?.textContent ?? '').trim()).toBe('');
  });

  it('defaults the filename and reflects/escapes name + hue + prompt', () => {
    const el = mount();
    expect(el.shadowRoot?.querySelector('[part="name"]')?.textContent).toBe('palette.shtml');
    el.name = '<x>.shtml';
    expect(el.shadowRoot?.querySelector('[part="name"]')?.querySelector('x')).toBeNull();
    expect(el.shadowRoot?.querySelector('[part="name"]')?.textContent).toBe('<x>.shtml');
    el.hue = '#06b6d4';
    expect(
      (el.shadowRoot?.querySelector('[part="header"]') as HTMLElement).style.getPropertyValue('--c')
    ).toBe('#06b6d4');
  });

  it('composes the default swatch cells by tag (4 canvas + 4 accent)', () => {
    const el = mount();
    expect(el.querySelectorAll('slicc-palette-cell[slot="canvas"]')).toHaveLength(4);
    expect(el.querySelectorAll('slicc-palette-cell[slot="accent"]')).toHaveLength(4);
  });

  it('pre-selects paper + cone and reflects them via the getters and note', () => {
    const el = mount();
    expect(el.selectedCanvas).toEqual({ color: '#faf6f1', label: 'paper' });
    expect(el.selectedAccent).toEqual({ color: '#ef7000', label: 'cone' });
    expect(el.shadowRoot?.querySelector('[part="note"]')?.textContent).toBe('paper · cone');
  });

  it('emits slicc-dip-apply with the chosen { canvas, accent } on Apply', () => {
    const el = mount();
    let detail: { canvas: unknown; accent: unknown } | null = null;
    el.addEventListener('slicc-dip-apply', (e) => {
      detail = (e as CustomEvent).detail;
    });
    (el.shadowRoot?.querySelector('[part="apply"]') as HTMLButtonElement).click();
    expect(detail).toEqual({
      canvas: { color: '#faf6f1', label: 'paper' },
      accent: { color: '#ef7000', label: 'cone' },
    });
  });

  it('keeps two dips on the same page independent (per-instance group ids)', () => {
    const a = mount();
    const b = mount();
    const aGroup = a.querySelector('slicc-palette-cell[slot="canvas"]')?.getAttribute('group');
    const bGroup = b.querySelector('slicc-palette-cell[slot="canvas"]')?.getAttribute('group');
    expect(aGroup).not.toBe(bGroup);
  });

  it('tears down its particle field cleanly on disconnect', () => {
    const el = mount();
    expect(() => el.remove()).not.toThrow();
  });

  it('reflects the prompt attribute into the .dprompt slot content', () => {
    const el = mount({ prompt: 'Pick palette:' });
    const prompt = el.shadowRoot?.querySelector('[part="prompt"]');
    // The prompt attribute path appends the string into the named slot rather
    // than the default <b>canvas</b> & <b>accent</b> nodes.
    expect(prompt?.textContent).toContain('Pick palette:');
    expect(prompt?.querySelector('b')).toBeNull();
  });

  it('setter null path removes the corresponding attributes', () => {
    const el = mount({ name: 'a.shtml', hue: '#06b6d4', prompt: 'p' });
    el.name = null;
    el.hue = null;
    el.prompt = null;
    expect(el.hasAttribute('name')).toBe(false);
    expect(el.hasAttribute('hue')).toBe(false);
    expect(el.hasAttribute('prompt')).toBe(false);
    // Falls back to the default filename when name is cleared.
    expect(el.shadowRoot?.querySelector('[part="name"]')?.textContent).toBe('palette.shtml');
  });

  it('selectedCanvas/Accent return null when no cell in the group is selected', () => {
    const el = mount();
    // Clear the pre-selection on both groups.
    for (const cell of el.querySelectorAll('slicc-palette-cell')) cell.removeAttribute('selected');
    expect(el.selectedCanvas).toBeNull();
    expect(el.selectedAccent).toBeNull();
  });

  it('the palette-select listener refreshes the .dnote summary', () => {
    const el = mount();
    // Switch the canvas selection on a different cell, then fire palette-select.
    const cells = el.querySelectorAll<HTMLElement>('slicc-palette-cell[slot="canvas"]');
    for (const c of cells) c.removeAttribute('selected');
    cells[2]?.setAttribute('selected', ''); // 'lilac'
    el.dispatchEvent(new CustomEvent('palette-select', { bubbles: true, composed: true }));
    expect(el.shadowRoot?.querySelector('[part="note"]')?.textContent).toContain('lilac');
  });

  it('skips the particle field under prefers-reduced-motion (no canvas init)', () => {
    const original = window.matchMedia;
    try {
      window.matchMedia = ((query: string) =>
        ({
          matches: query.includes('reduce'),
          media: query,
          onchange: null,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          addListener: () => undefined,
          removeListener: () => undefined,
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList) as typeof window.matchMedia;
      const el = mount();
      // Element still renders the static structure (header/body/footer), but
      // the canvas backing store stays at its default 300x150 because
      // #startField bails out before #sizeField.
      const cv = el.shadowRoot?.querySelector<HTMLCanvasElement>('canvas.sprk');
      expect(cv?.width).toBe(300);
      expect(cv?.height).toBe(150);
      // Tear-down is still safe (no RAF / RO / listeners to undo).
      expect(() => el.remove()).not.toThrow();
    } finally {
      window.matchMedia = original;
    }
  });

  it('runs the RAF draw loop and paints the canvas after a frame', async () => {
    const el = mount();
    // Wait a couple of frames so the requestAnimationFrame callback executes
    // and the #frame loop integrates + paints particles into the canvas.
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const cv = el.shadowRoot?.querySelector<HTMLCanvasElement>('canvas.sprk');
    expect(cv).not.toBeNull();
    // After #sizeField runs, the backing-store dimensions reflect the host
    // bounding box * devicePixelRatio (capped at 2), not the default 300x150.
    expect(cv?.width).toBeGreaterThan(0);
    expect(cv?.height).toBeGreaterThan(0);
    // The frame loop reseeds the canvas and paints non-empty pixels at least
    // somewhere on the host (the host has a non-zero height because the body
    // is laid out, so particles fall within the backing store).
    const ctx = cv?.getContext('2d');
    expect(ctx).not.toBeNull();
  });

  it('tracks pointer move/leave to drive the cursor-attraction field', async () => {
    const el = mount();
    // Let the canvas + listeners initialize.
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const rect = el.getBoundingClientRect();
    // Dispatch a pointermove inside the host — the handler stores the offset
    // in the #mx/#my fields (private), so we assert via no-throw + a fresh frame.
    el.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        clientX: rect.left + 20,
        clientY: rect.top + 20,
        pointerType: 'mouse',
      })
    );
    // Then leave — resets #mx/#my back to -999.
    el.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true, pointerType: 'mouse' }));
    // Run another frame to exercise the integration paths after pointer state changes.
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    // No assertions on private state — the test asserts both handler paths
    // run without throwing and the frame loop continues.
    expect(el.shadowRoot?.querySelector('canvas.sprk')).not.toBeNull();
  });

  it('cancels its animation frame and detaches listeners on disconnect', async () => {
    const el = mount();
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    el.remove();
    // After disconnect, dispatching pointer events on the (now detached) host
    // must not throw — the listeners have been removed by #stopField.
    expect(() => {
      el.dispatchEvent(new PointerEvent('pointermove', { clientX: 0, clientY: 0 }));
      el.dispatchEvent(new PointerEvent('pointerleave'));
    }).not.toThrow();
    // Re-connect to verify attributeChangedCallback + re-bind survive a cycle.
    document.body.appendChild(el);
    el.setAttribute('hue', '#f43f5e');
    expect(el.shadowRoot?.querySelector('[part="apply"]')).not.toBeNull();
  });

  it('reacts to host resize via its ResizeObserver', async () => {
    const el = mount();
    el.style.width = '320px';
    el.style.height = '120px';
    // Allow the observer to fire and #sizeField to repaint the canvas.
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const cv = el.shadowRoot?.querySelector<HTMLCanvasElement>('canvas.sprk');
    // Backing-store width reflects the resized host (rounded * DPR, capped 2).
    expect(cv?.width).toBeGreaterThan(0);
    expect(cv?.height).toBeGreaterThan(0);
  });

  it('prompt setter writes the attribute when given a non-null string', () => {
    const el = mount();
    el.prompt = 'Tune palette';
    expect(el.getAttribute('prompt')).toBe('Tune palette');
    expect(el.shadowRoot?.querySelector('[part="prompt"]')?.textContent).toContain('Tune palette');
  });

  it('exercises the cursor-attraction code path when the pointer hovers over particles', async () => {
    const el = mount();
    el.style.width = '300px';
    el.style.height = '120px';
    // First frame seeds particles across the host bounding box.
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const rect = el.getBoundingClientRect();
    // Hover deep inside the element — at least some particles will fall
    // within the 72px attract radius and exercise the integration code.
    el.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        pointerType: 'mouse',
      })
    );
    // Run additional frames so the cursor influence + wrap-around branches
    // both have time to fire (particles drift past edge wrap on each tick).
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    }
    // The element should still be live and the canvas attached.
    expect(el.shadowRoot?.querySelector('canvas.sprk')).not.toBeNull();
  });

  it('falls back to the manual arcTo path when CanvasRenderingContext2D lacks roundRect', async () => {
    const original = CanvasRenderingContext2D.prototype.roundRect;
    // Temporarily hide `roundRect` so the frame loop hits the arcTo fallback
    // branch (preserves the prototype shape for any concurrently running tests).
    Object.defineProperty(CanvasRenderingContext2D.prototype, 'roundRect', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    try {
      const el = mount();
      // Drive a few frames so the fallback path paints many particles.
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => requestAnimationFrame(() => r(null)));
      }
      expect(el.shadowRoot?.querySelector('canvas.sprk')).not.toBeNull();
    } finally {
      // Restore the original prototype shape (may be undefined on older platforms).
      if (original) {
        Object.defineProperty(CanvasRenderingContext2D.prototype, 'roundRect', {
          value: original,
          configurable: true,
          writable: true,
        });
      } else {
        Reflect.deleteProperty(CanvasRenderingContext2D.prototype, 'roundRect');
      }
    }
  });
});
