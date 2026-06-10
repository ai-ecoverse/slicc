import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SliccPill } from '../../src/pill/slicc-pill.js';
// The full-app showcase story assembles the whole surface; importing it
// registers every element it composes (cone chip included).
import { Collapsed } from '../../src/showcase/app.stories.js';
import { ensureGlobalTokens, setTheme } from '../../src/theme/tokens.js';

/** Render the showcase `Collapsed` story into the document and return its frame. */
function renderShowcase(): HTMLElement {
  const render = Collapsed.render as () => HTMLElement;
  const frame = render();
  document.body.appendChild(frame);
  return frame;
}

/** The cone chip rendered by the nav scoop switcher. */
function coneChip(frame: HTMLElement): SliccPill {
  return frame.querySelector('slicc-pill.scoop[data-k="cone"]') as SliccPill;
}

/** The cone chip's inner pill button (shadow DOM). */
function conePill(frame: HTMLElement): HTMLElement {
  return coneChip(frame).shadowRoot?.querySelector('.pill') as HTMLElement;
}

describe('showcase full-app cone chip', () => {
  let frame: HTMLElement | null = null;

  beforeEach(() => {
    ensureGlobalTokens();
    setTheme('light');
    document.body.replaceChildren();
  });

  afterEach(() => {
    frame?.remove();
    frame = null;
  });

  it('renders the cone chip in the nav switcher', () => {
    frame = renderShowcase();
    const cone = coneChip(frame);
    expect(cone).toBeTruthy();
    expect(cone.getAttribute('type')).toBe('cone');
  });

  it('uses the open-idle configuration (not active) for the cone', () => {
    frame = renderShowcase();
    const cone = coneChip(frame);
    // The "open idle" look is the non-active pill: no active attribute/class, so
    // the accent never fills the chip.
    expect(cone.hasAttribute('active')).toBe(false);
    expect(cone.classList.contains('active')).toBe(false);
    expect(conePill(frame).classList.contains('active')).toBe(false);
  });

  it('shows a white (transparent) background instead of the accent color fill', () => {
    frame = renderShowcase();
    const cs = getComputedStyle(conePill(frame));
    // Idle pill background is transparent, so the light surface (white) shows
    // through — the accent fill would resolve to an opaque rgb() instead.
    expect(cs.backgroundColor).toBe('rgba(0, 0, 0, 0)');
  });

  it('keeps dark (non-inverted) label text rather than the white-on-fill label', () => {
    frame = renderShowcase();
    const label = coneChip(frame).shadowRoot?.querySelector('.label') as HTMLElement;
    // The active color-fill chip inverts the label to pure white (#fff); the
    // open-idle chip keeps its own dark/contrast label token.
    expect(getComputedStyle(label).color).not.toBe('rgb(255, 255, 255)');
  });

  it('keeps the cone eye-tracking intact (cone, eyes open, pupils follow the cursor)', () => {
    frame = renderShowcase();
    const cone = coneChip(frame);
    expect(cone.getAttribute('eyes')).toBe('open');
    const svg = cone.shadowRoot?.querySelector('.eyes-svg') as SVGElement;
    expect(svg).toBeTruthy();
    const r = svg.getBoundingClientRect();
    document.dispatchEvent(
      new MouseEvent('mousemove', {
        clientX: r.left + r.width + 500,
        clientY: r.top + r.height + 500,
      })
    );
    const left = cone.shadowRoot?.querySelector('.pupil-l') as SVGGElement;
    const right = cone.shadowRoot?.querySelector('.pupil-r') as SVGGElement;
    expect(left.getAttribute('transform')).toMatch(/^translate\(/);
    expect(right.getAttribute('transform')).toMatch(/^translate\(/);
  });
});
