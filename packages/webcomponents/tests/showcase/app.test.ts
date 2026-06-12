import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SliccPill } from '../../src/pill/slicc-pill.js';
// The full-app showcase story assembles the whole surface; importing it
// registers every element it composes (cone chip included).
import { Collapsed, FreezerPreview, ScoopPreview } from '../../src/showcase/app.stories.js';
import { ensureGlobalTokens, setTheme } from '../../src/theme/tokens.js';

/** Render the showcase `Collapsed` story into the document and return its frame. */
function renderShowcase(): HTMLElement {
  const render = Collapsed.render as () => HTMLElement;
  const frame = render();
  document.body.appendChild(frame);
  return frame;
}

/** Render an arbitrary showcase story into the document and return its frame. */
function renderStory(story: { render?: unknown }): HTMLElement {
  const frame = (story.render as () => HTMLElement)();
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

/** Resolve a CSS color (e.g. a hex token) to its computed `rgb(...)` form. */
function resolveColor(css: string): string {
  const probe = document.createElement('span');
  probe.style.color = css;
  document.body.appendChild(probe);
  const rgb = getComputedStyle(probe).color;
  probe.remove();
  return rgb;
}

const FREEZER_TINT = '#3b6cb2';
const RESEARCHER = '#06b6d4';

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

describe('showcase full-app preview states', () => {
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

  const shaderOf = (f: HTMLElement) => f.querySelector('slicc-shader') as HTMLElement;
  const composerOf = (f: HTMLElement) => f.querySelector('slicc-composer') as HTMLElement;
  const tintOf = (f: HTMLElement) => f.querySelector('.sc-tint') as HTMLElement;
  const freezerOf = (f: HTMLElement) => f.querySelector('slicc-freezer') as HTMLElement;
  const scoopChip = (f: HTMLElement, key: string) =>
    f.querySelector(`slicc-pill.scoop[data-k="${key}"]`) as HTMLElement;
  const click = (el: HTMLElement) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));

  it('enters scoop-preview when a scoop chip is clicked', () => {
    frame = renderShowcase();
    click(scoopChip(frame, 'researcher'));

    // Swirl ("scoop") shader, tinted to the scoop's primary color.
    expect(shaderOf(frame).getAttribute('mode')).toBe('scoop');
    expect(shaderOf(frame).getAttribute('tint')).toBe(RESEARCHER);
    // The whole-surface wash carries the scoop color.
    expect(getComputedStyle(tintOf(frame)).backgroundColor).toBe(resolveColor(RESEARCHER));
    expect(frame.style.getPropertyValue('--ctx').trim()).toBe(RESEARCHER);
    // The composer is hidden — the conversation is driven by the cone.
    expect(getComputedStyle(composerOf(frame)).display).toBe('none');
    // The scoop's own history thread replaced the cone thread.
    expect(frame.querySelector('slicc-chat-thread[data-scoop="researcher"]')).toBeTruthy();
    // The scoop chip reads as active.
    expect(scoopChip(frame, 'researcher').hasAttribute('active')).toBe(true);
  });

  it('enters freezer-preview when a frozen session card is clicked', () => {
    frame = renderShowcase();
    const card = frame.querySelector('slicc-freezer-card[slug="hero"]') as HTMLElement;
    click(card);

    // Frost ("freezer") shader + ice-blue wash.
    expect(shaderOf(frame).getAttribute('mode')).toBe('freezer');
    expect(getComputedStyle(tintOf(frame)).backgroundColor).toBe(resolveColor(FREEZER_TINT));
    expect(frame.style.getPropertyValue('--ctx').trim()).toBe(FREEZER_TINT);
    // The freezer chrome takes its ice-blue context accent.
    expect(freezerOf(frame).hasAttribute('ctx')).toBe(true);
    // The composer is hidden — the session is frozen.
    expect(getComputedStyle(composerOf(frame)).display).toBe('none');
    // The frozen conversation loaded; no scoop chip is active.
    expect(frame.querySelector('slicc-chat-thread[data-frozen="hero"]')).toBeTruthy();
    expect(scoopChip(frame, 'researcher').hasAttribute('active')).toBe(false);
  });

  it('returns to the live state when the cone chip is clicked', () => {
    frame = renderShowcase();
    click(scoopChip(frame, 'researcher'));
    // Sanity: we are in a preview before returning.
    expect(frame.getAttribute('data-preview')).toBe('scoop');

    click(coneChip(frame));

    expect(frame.hasAttribute('data-preview')).toBe(false);
    expect(shaderOf(frame).getAttribute('mode')).toBe('cone');
    // The wash fades out and the context override is cleared.
    expect(tintOf(frame).style.opacity).toBe('0');
    expect(frame.style.getPropertyValue('--ctx').trim()).toBe('');
    // The composer is visible again and the live cone thread is restored.
    expect(getComputedStyle(composerOf(frame)).display).not.toBe('none');
    const thread = frame.querySelector('slicc-chatpane > slicc-chat-thread') as HTMLElement;
    expect(thread.getAttribute('context')).toBe('cone');
    expect(thread.hasAttribute('data-scoop')).toBe(false);
    expect(thread.hasAttribute('data-frozen')).toBe(false);
    // The cone chip stays open-idle (not active) in the live state.
    expect(coneChip(frame).hasAttribute('active')).toBe(false);
  });

  it('renders the edit action-row icon as the pencil glyph, not the literal name', () => {
    frame = renderShowcase();
    const chip = frame.querySelector('slicc-action-row [part="icon"]') as HTMLElement;
    expect(chip).toBeTruthy();
    // Regression: the showcase once passed the lucide name 'pencil' to the
    // action-row's glyph-character `icon` attribute, leaking the raw string into
    // the chip. It must render the pencil glyph instead.
    expect(chip.textContent).toBe('✎');
    expect(chip.textContent).not.toBe('pencil');
  });

  it('renders the ScoopPreview story already in scoop-preview', () => {
    frame = renderStory(ScoopPreview);
    expect(frame.getAttribute('data-preview')).toBe('scoop');
    expect(shaderOf(frame).getAttribute('mode')).toBe('scoop');
    expect(shaderOf(frame).getAttribute('tint')).toBe(RESEARCHER);
    expect(getComputedStyle(composerOf(frame)).display).toBe('none');
    expect(frame.querySelector('slicc-chat-thread[data-scoop="researcher"]')).toBeTruthy();
  });

  it('renders the FreezerPreview story already in freezer-preview', () => {
    frame = renderStory(FreezerPreview);
    expect(frame.getAttribute('data-preview')).toBe('freezer');
    expect(shaderOf(frame).getAttribute('mode')).toBe('freezer');
    expect(freezerOf(frame).hasAttribute('ctx')).toBe(true);
    expect(getComputedStyle(composerOf(frame)).display).toBe('none');
    expect(frame.querySelector('slicc-chat-thread[data-frozen="hero"]')).toBeTruthy();
  });
});
