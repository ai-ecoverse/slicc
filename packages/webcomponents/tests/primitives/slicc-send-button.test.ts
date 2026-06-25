import { beforeEach, describe, expect, it } from 'vitest';
import { SliccSendButton } from '../../src/primitives/slicc-send-button.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

/** Emoji / bespoke-glyph characters that must NEVER appear in the rendered output. */
const FORBIDDEN_GLYPHS = ['↑', '■', '▲', '⬆', '⏹', '✦', '➤'];

function mount(): SliccSendButton {
  const el = document.createElement('slicc-send-button');
  document.body.appendChild(el);
  return el;
}

/** Wait a microtask + a frame so async gravatar resolution lands in the DOM. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await new Promise((r) => requestAnimationFrame(() => r(null)));
}

describe('slicc-send-button', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-send-button')).toBe(SliccSendButton);
  });

  // --- icons are lucide svgs, never emoji ---

  it('renders a circular button with a lucide arrow-up SVG (not an emoji)', () => {
    const el = mount();
    const button = el.shadowRoot?.querySelector('button.send');
    expect(button).not.toBeNull();
    const glyph = el.shadowRoot?.querySelector('[part="glyph"]');
    expect(glyph?.querySelector('svg')).not.toBeNull();
    // No unicode arrow / bespoke glyph survives.
    for (const ch of FORBIDDEN_GLYPHS) {
      expect(button?.textContent ?? '').not.toContain(ch);
    }
  });

  it('busy: renders a lucide square (stop) SVG (not an emoji)', () => {
    const el = mount();
    el.busy = true;
    const stop = el.shadowRoot?.querySelector('[part="stop"]');
    expect(stop).not.toBeNull();
    expect(stop?.querySelector('svg')).not.toBeNull();
    // The default arrow glyph is gone in the busy state.
    expect(el.shadowRoot?.querySelector('[part="glyph"]')).toBeNull();
    const button = el.shadowRoot?.querySelector('button');
    for (const ch of FORBIDDEN_GLYPHS) {
      expect(button?.textContent ?? '').not.toContain(ch);
    }
  });

  // --- attribute ↔ property reflection ---

  it('reflects the disabled property to the attribute and back', () => {
    const el = mount();
    expect(el.disabled).toBe(false);
    el.disabled = true;
    expect(el.hasAttribute('disabled')).toBe(true);
    el.disabled = false;
    expect(el.hasAttribute('disabled')).toBe(false);

    el.setAttribute('disabled', '');
    expect(el.disabled).toBe(true);
  });

  it('reflects the busy property to the attribute and back', () => {
    const el = mount();
    expect(el.busy).toBe(false);
    el.busy = true;
    expect(el.hasAttribute('busy')).toBe(true);
    el.busy = false;
    expect(el.hasAttribute('busy')).toBe(false);

    el.setAttribute('busy', '');
    expect(el.busy).toBe(true);
  });

  it('reflects the email property to the attribute and back', () => {
    const el = mount();
    expect(el.email).toBeNull();
    el.email = 'a@b.com';
    expect(el.getAttribute('email')).toBe('a@b.com');
    el.email = null;
    expect(el.hasAttribute('email')).toBe(false);
  });

  it('reflects the src property to the attribute and back', () => {
    const el = mount();
    expect(el.src).toBeNull();
    el.src = 'https://x/y.png';
    expect(el.getAttribute('src')).toBe('https://x/y.png');
    el.src = null;
    expect(el.hasAttribute('src')).toBe(false);
  });

  it('reflects the label property to the attribute and back', () => {
    const el = mount();
    expect(el.label).toBeNull();
    el.label = 'Ship it';
    expect(el.getAttribute('label')).toBe('Ship it');
    el.label = null;
    expect(el.hasAttribute('label')).toBe(false);
  });

  // --- variants / states ---

  it('default: enabled button labelled "Send"', () => {
    const el = mount();
    const button = el.shadowRoot?.querySelector('button') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-label')).toBe('Send');
    expect(button.getAttribute('title')).toBe('Send');
  });

  it('disabled: the inner button is disabled', () => {
    const el = mount();
    el.disabled = true;
    const button = el.shadowRoot?.querySelector('button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('busy: labels "Stop"', () => {
    const el = mount();
    el.busy = true;
    const button = el.shadowRoot?.querySelector('button') as HTMLButtonElement;
    expect(button.getAttribute('aria-label')).toBe('Stop');
  });

  it('honors a custom label over the state default', () => {
    const el = mount();
    el.label = 'Send message';
    const button = el.shadowRoot?.querySelector('button') as HTMLButtonElement;
    expect(button.getAttribute('aria-label')).toBe('Send message');
  });

  it('escapes the label attribute', () => {
    const el = mount();
    el.label = '"><img src=x>';
    const button = el.shadowRoot?.querySelector('button') as HTMLButtonElement;
    // The whole hostile string survives as a single attribute value — no injection.
    expect(button.getAttribute('aria-label')).toBe('"><img src=x>');
    // No injected <img> in the button content (the gravatar face <img> is absent
    // without email/src, so any <img> here would be an injection).
    expect(button.querySelector('img')).toBeNull();
  });

  // --- avatar / gravatar face ---

  it('has no face image by default (rainbow ground shows through)', () => {
    const el = mount();
    const button = el.shadowRoot?.querySelector('button.send') as HTMLButtonElement;
    expect(button.classList.contains('has-face')).toBe(false);
    expect(button.querySelector('.face')).toBeNull();
  });

  it('paints an explicit src as the circular face', () => {
    const el = mount();
    el.src = 'https://avatars.githubusercontent.com/u/9919?s=72&v=4';
    const button = el.shadowRoot?.querySelector('button.send') as HTMLButtonElement;
    const face = button.querySelector('.face[part="face"]') as HTMLImageElement | null;
    expect(face).not.toBeNull();
    expect(face?.getAttribute('src')).toBe('https://avatars.githubusercontent.com/u/9919?s=72&v=4');
    expect(button.classList.contains('has-face')).toBe(true);
    // The arrow glyph still rides on top.
    expect(el.shadowRoot?.querySelector('[part="glyph"] svg')).not.toBeNull();
  });

  it('derives a gravatar face URL from email via SHA-256', async () => {
    const el = mount();
    el.email = 'pat.mercury@example.com';
    await settle();
    const button = el.shadowRoot?.querySelector('button.send') as HTMLButtonElement;
    const face = button.querySelector('.face') as HTMLImageElement | null;
    expect(face).not.toBeNull();
    const url = face?.getAttribute('src') ?? '';
    // Modern gravatar: SHA-256 hex (64 chars) under www.gravatar.com/avatar/.
    expect(url).toMatch(/^https:\/\/www\.gravatar\.com\/avatar\/[0-9a-f]{64}\?/);
    expect(button.classList.contains('has-face')).toBe(true);
  });

  it('src wins over email for the face', () => {
    const el = mount();
    el.email = 'a@b.com';
    el.src = 'https://example.com/me.png';
    const face = el.shadowRoot?.querySelector('.face') as HTMLImageElement | null;
    expect(face?.getAttribute('src')).toBe('https://example.com/me.png');
  });

  // --- behavior / events ---

  it('emits a composed, bubbling `send` event on click in the default state', () => {
    const el = mount();
    let count = 0;
    let composed = false;
    el.addEventListener('send', (e) => {
      count++;
      composed = e.composed;
    });
    (el.shadowRoot?.querySelector('button') as HTMLButtonElement).click();
    expect(count).toBe(1);
    expect(composed).toBe(true);
  });

  it('emits `stop` (not `send`) on click while busy', () => {
    const el = mount();
    el.busy = true;
    let send = 0;
    let stop = 0;
    el.addEventListener('send', () => send++);
    el.addEventListener('stop', () => stop++);
    (el.shadowRoot?.querySelector('button') as HTMLButtonElement).click();
    expect(send).toBe(0);
    expect(stop).toBe(1);
  });

  it('emits nothing when disabled', () => {
    const el = mount();
    el.disabled = true;
    let fired = 0;
    el.addEventListener('send', () => fired++);
    el.addEventListener('stop', () => fired++);
    // Dispatch a raw click — a disabled <button> won't normally fire, so go
    // straight to the click() path the guard protects.
    (el.shadowRoot?.querySelector('button') as HTMLButtonElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true, composed: true })
    );
    expect(fired).toBe(0);
  });

  // --- send animation ('whoosh up') ---

  it('plays the whoosh-up animation on send (arrow translates up)', () => {
    const el = mount();
    el.addEventListener('send', () => {});
    (el.shadowRoot?.querySelector('button') as HTMLButtonElement).click();
    const glyph = el.shadowRoot?.querySelector('.glyph') as HTMLElement;
    expect(glyph.classList.contains('is-whoosh')).toBe(true);
  });

  it('does not whoosh while busy (stop path)', () => {
    const el = mount();
    el.busy = true;
    (el.shadowRoot?.querySelector('button') as HTMLButtonElement).click();
    // No default-state glyph at all when busy.
    expect(el.shadowRoot?.querySelector('.glyph')).toBeNull();
  });

  // --- real-browser appearance fidelity ---

  it('is a 36px circle filled with the rainbow gradient', () => {
    const el = mount();
    const button = el.shadowRoot?.querySelector('button.send') as HTMLButtonElement;
    const cs = getComputedStyle(button);
    expect(cs.width).toBe('36px');
    expect(cs.height).toBe('36px');
    // border-radius 9999px clamps to a full circle.
    expect(parseFloat(cs.borderTopLeftRadius)).toBeGreaterThanOrEqual(18);
    expect(cs.backgroundImage).toContain('gradient');
    // White glyph reads in both themes.
    expect(cs.color).toBe('rgb(255, 255, 255)');
  });

  it('keeps the 36px circle and gradient in dark mode', () => {
    document.body.classList.add('dark');
    try {
      const el = mount();
      const button = el.shadowRoot?.querySelector('button.send') as HTMLButtonElement;
      const cs = getComputedStyle(button);
      expect(cs.width).toBe('36px');
      expect(cs.backgroundImage).toContain('gradient');
      expect(cs.color).toBe('rgb(255, 255, 255)');
    } finally {
      document.body.classList.remove('dark');
    }
  });

  // --- busy fill/clear (12 alternating phases, 10s each, 120s loop) ---

  it('busy: stacks a solid fill copy (.stop-fill) over the stop square', () => {
    const el = mount();
    el.busy = true;
    const fill = el.shadowRoot?.querySelector('.stop .stop-fill');
    expect(fill).not.toBeNull();
    // The fill is a second square SVG (so it can read as a solid filled square).
    expect(fill?.querySelector('svg')).not.toBeNull();
  });

  it('busy: drives the fill with a 120s slicc-send-fill animation', () => {
    const el = mount();
    el.busy = true;
    const fill = el.shadowRoot?.querySelector('.stop-fill') as HTMLElement;
    // Assert the stable CSS longhands (the `animation` shorthand serializes
    // differently across Chromium versions).
    const cs = getComputedStyle(fill);
    expect(cs.animationName).toBe('slicc-send-fill');
    expect(cs.animationDuration).toBe('120s');
    expect(cs.animationIterationCount).toBe('infinite');
  });

  it('busy: the fill keyframes alternate six fills + six clears (12 phases)', () => {
    const el = mount();
    el.busy = true;
    let frames: CSSKeyframeRule[] = [];
    for (const s of el.shadowRoot?.adoptedStyleSheets ?? []) {
      for (const rule of s.cssRules) {
        if (rule instanceof CSSKeyframesRule && rule.name === 'slicc-send-fill') {
          frames = Array.from(rule.cssRules) as CSSKeyframeRule[];
        }
      }
    }
    // 18 keyframes: each of the six fills peaks at the full square, and the
    // alternating clears bottom out empty, with invisible empty-state hand-offs
    // (zero-width/height or centred insets) bridging consecutive phases.
    expect(frames.length).toBe(18);
    // The full square (every directional fill's peak) carries no percentage in
    // its inset; empty states always do (50% centre, or a 100% edge). So exactly
    // six keyframes — the six fill peaks — are percentage-free.
    const fullPeaks = frames.filter((f) => !f.style.clipPath.includes('%'));
    expect(fullPeaks.length).toBe(6);
  });

  it('busy fill is statically filled and neutralized under prefers-reduced-motion', () => {
    const el = mount();
    el.busy = true;
    let baseFilled = false;
    let reducedGuarded = false;
    for (const s of el.shadowRoot?.adoptedStyleSheets ?? []) {
      for (const rule of s.cssRules) {
        // Base .stop-fill rule clips to a full square (solid) when not animating.
        if (
          rule instanceof CSSStyleRule &&
          rule.selectorText === '.stop-fill' &&
          rule.style.clipPath.replace(/\s+/g, ' ').includes('inset(0')
        ) {
          baseFilled = true;
        }
        if (rule instanceof CSSMediaRule && rule.conditionText.includes('prefers-reduced-motion')) {
          for (const inner of rule.cssRules) {
            if (
              inner instanceof CSSStyleRule &&
              inner.selectorText.includes('.stop-fill') &&
              inner.style.animationName === 'none'
            ) {
              reducedGuarded = true;
            }
          }
        }
      }
    }
    expect(baseFilled).toBe(true);
    expect(reducedGuarded).toBe(true);
  });

  // --- idle micro-interactions (hover wiggle, press dip, release fly-out) ---

  it('idle hover: adds is-hover to the arrow glyph and runs the wiggle', () => {
    const el = mount();
    const button = el.shadowRoot?.querySelector('button') as HTMLButtonElement;
    const glyph = el.shadowRoot?.querySelector('.glyph') as HTMLElement;
    button.dispatchEvent(new Event('pointerenter'));
    expect(glyph.classList.contains('is-hover')).toBe(true);
    expect(getComputedStyle(glyph).animationName).toBe('slicc-send-wiggle');
  });

  it('idle press: dips the glyph down ~2px and clears hover', () => {
    const el = mount();
    const button = el.shadowRoot?.querySelector('button') as HTMLButtonElement;
    const glyph = el.shadowRoot?.querySelector('.glyph') as HTMLElement;
    button.dispatchEvent(new Event('pointerenter'));
    button.dispatchEvent(new Event('pointerdown'));
    expect(glyph.classList.contains('is-press')).toBe(true);
    expect(glyph.classList.contains('is-hover')).toBe(false);
    // translateY(2px) → matrix(1, 0, 0, 1, 0, 2).
    expect(getComputedStyle(glyph).transform).toBe('matrix(1, 0, 0, 1, 0, 2)');
  });

  it('idle release: clears the press dip (the click whoosh takes over)', () => {
    const el = mount();
    const button = el.shadowRoot?.querySelector('button') as HTMLButtonElement;
    const glyph = el.shadowRoot?.querySelector('.glyph') as HTMLElement;
    button.dispatchEvent(new Event('pointerdown'));
    button.dispatchEvent(new Event('pointerup'));
    expect(glyph.classList.contains('is-press')).toBe(false);
  });

  it('idle pointerleave: clears both hover and press', () => {
    const el = mount();
    const button = el.shadowRoot?.querySelector('button') as HTMLButtonElement;
    const glyph = el.shadowRoot?.querySelector('.glyph') as HTMLElement;
    button.dispatchEvent(new Event('pointerenter'));
    button.dispatchEvent(new Event('pointerleave'));
    expect(glyph.classList.contains('is-hover')).toBe(false);
    expect(glyph.classList.contains('is-press')).toBe(false);
  });

  it('does not wiggle/dip while busy or disabled', () => {
    const busyEl = mount();
    busyEl.busy = true;
    const busyButton = busyEl.shadowRoot?.querySelector('button') as HTMLButtonElement;
    // No arrow glyph while busy — handlers are no-ops and must not throw.
    expect(() => busyButton.dispatchEvent(new Event('pointerenter'))).not.toThrow();
    expect(busyEl.shadowRoot?.querySelector('.glyph')).toBeNull();

    const disabledEl = mount();
    disabledEl.disabled = true;
    const disabledButton = disabledEl.shadowRoot?.querySelector('button') as HTMLButtonElement;
    const disabledGlyph = disabledEl.shadowRoot?.querySelector('.glyph') as HTMLElement;
    disabledButton.dispatchEvent(new Event('pointerenter'));
    expect(disabledGlyph.classList.contains('is-hover')).toBe(false);
  });

  it('guards the idle wiggle/press motion behind prefers-reduced-motion', () => {
    const el = mount();
    let hoverGuarded = false;
    let pressGuarded = false;
    for (const s of el.shadowRoot?.adoptedStyleSheets ?? []) {
      for (const rule of s.cssRules) {
        if (rule instanceof CSSMediaRule && rule.conditionText.includes('prefers-reduced-motion')) {
          for (const inner of rule.cssRules) {
            if (inner instanceof CSSStyleRule && inner.style.animationName === 'none') {
              if (inner.selectorText.includes('.glyph.is-hover')) hoverGuarded = true;
            }
            if (
              inner instanceof CSSStyleRule &&
              inner.selectorText.includes('.glyph.is-press') &&
              inner.style.transform === 'none'
            ) {
              pressGuarded = true;
            }
          }
        }
      }
    }
    expect(hoverGuarded).toBe(true);
    expect(pressGuarded).toBe(true);
  });

  // --- phase: thinking (LLM-wait) vs tool (spinning) ---

  it('phase: defaults to "thinking" and reflects property ↔ attribute', () => {
    const el = mount();
    expect(el.phase).toBe('thinking');
    el.phase = 'tool';
    expect(el.getAttribute('phase')).toBe('tool');
    expect(el.phase).toBe('tool');
    el.phase = 'thinking';
    expect(el.getAttribute('phase')).toBe('thinking');
    expect(el.phase).toBe('thinking');
  });

  it('phase: invalid / empty values fall back to "thinking"', () => {
    const el = mount();
    el.setAttribute('phase', 'bogus');
    expect(el.phase).toBe('thinking');
    el.setAttribute('phase', '');
    expect(el.phase).toBe('thinking');
    // The setter normalizes any non-"tool" value too.
    el.phase = 'nope' as unknown as 'thinking';
    expect(el.getAttribute('phase')).toBe('thinking');
  });

  it('busy + phase="tool": renders a spinning ring around the stop square (no fill)', () => {
    const el = mount();
    el.busy = true;
    el.phase = 'tool';
    const button = el.shadowRoot?.querySelector('button.send') as HTMLButtonElement;
    expect(button.classList.contains('is-tool')).toBe(true);
    // The stop square is still present (and reads as a lucide square SVG).
    const stop = el.shadowRoot?.querySelector('[part="stop"]');
    expect(stop?.querySelector('svg')).not.toBeNull();
    // A spinner wrapper rides over it; the thinking-phase fill is absent.
    const spinner = el.shadowRoot?.querySelector('[part="spinner"]');
    expect(spinner).not.toBeNull();
    expect(spinner?.querySelector('svg')).not.toBeNull();
    expect(el.shadowRoot?.querySelector('.stop-fill')).toBeNull();
  });

  it('busy + phase="thinking" stays the LLM-wait treatment (fill, no spinner, no is-tool)', () => {
    const el = mount();
    el.busy = true;
    el.phase = 'thinking';
    const button = el.shadowRoot?.querySelector('button.send') as HTMLButtonElement;
    expect(button.classList.contains('is-tool')).toBe(false);
    expect(el.shadowRoot?.querySelector('.stop-fill')).not.toBeNull();
    expect(el.shadowRoot?.querySelector('[part="spinner"]')).toBeNull();
  });

  it('tool phase ignored unless busy (phase set but idle keeps the arrow glyph)', () => {
    const el = mount();
    el.phase = 'tool';
    expect(el.shadowRoot?.querySelector('[part="glyph"] svg')).not.toBeNull();
    expect(el.shadowRoot?.querySelector('[part="spinner"]')).toBeNull();
  });

  it('still emits `stop` (not `send`) on click while busy in the tool phase', () => {
    const el = mount();
    el.busy = true;
    el.phase = 'tool';
    let send = 0;
    let stop = 0;
    el.addEventListener('send', () => send++);
    el.addEventListener('stop', () => stop++);
    (el.shadowRoot?.querySelector('button') as HTMLButtonElement).click();
    expect(send).toBe(0);
    expect(stop).toBe(1);
  });

  it('indeterminate tool spinner carries is-indeterminate and runs the spin animation', () => {
    const el = mount();
    el.busy = true;
    el.phase = 'tool';
    const spinner = el.shadowRoot?.querySelector('[part="spinner"]') as HTMLElement;
    expect(spinner.classList.contains('is-indeterminate')).toBe(true);
    const cs = getComputedStyle(spinner);
    expect(cs.animationName).toBe('slicc-send-spin');
    expect(cs.animationIterationCount).toBe('infinite');
  });

  // --- progress: determinate tool arc ---

  it('progress: reflects a [0,1] fraction property ↔ attribute and clears on null', () => {
    const el = mount();
    expect(el.progress).toBeNull();
    el.progress = 0.4;
    expect(el.getAttribute('progress')).toBe('0.4');
    expect(el.progress).toBe(0.4);
    el.progress = null;
    expect(el.hasAttribute('progress')).toBe(false);
  });

  it('progress: clamps out-of-range and treats non-numeric as absent', () => {
    const el = mount();
    el.setAttribute('progress', '2');
    expect(el.progress).toBe(1);
    el.setAttribute('progress', '-1');
    expect(el.progress).toBe(0);
    el.setAttribute('progress', 'abc');
    expect(el.progress).toBeNull();
  });

  it('determinate tool spinner drops is-indeterminate and draws a static arc', () => {
    const el = mount();
    el.busy = true;
    el.phase = 'tool';
    el.progress = 0.6;
    const spinner = el.shadowRoot?.querySelector('[part="spinner"]') as HTMLElement;
    expect(spinner.classList.contains('is-indeterminate')).toBe(false);
    const arc = spinner.querySelector('.ring-arc') as SVGCircleElement;
    expect(arc).not.toBeNull();
    // The determinate arc starts at 12 o'clock and holds still (no spin class).
    expect(arc.getAttribute('transform')).toBe('rotate(-90 18 18)');
    const dash = arc.getAttribute('stroke-dasharray') ?? '';
    const [lit, full] = dash.split(/\s+/).map(Number);
    const circumference = 2 * Math.PI * 15;
    expect(full).toBeCloseTo(circumference, 3);
    expect(lit).toBeCloseTo(circumference * 0.6, 3);
  });

  it('guards the tool spinner motion behind prefers-reduced-motion', () => {
    const el = mount();
    let spinnerGuarded = false;
    for (const s of el.shadowRoot?.adoptedStyleSheets ?? []) {
      for (const rule of s.cssRules) {
        if (rule instanceof CSSMediaRule && rule.conditionText.includes('prefers-reduced-motion')) {
          for (const inner of rule.cssRules) {
            if (
              inner instanceof CSSStyleRule &&
              inner.selectorText.includes('.spinner.is-indeterminate') &&
              inner.style.animationName === 'none'
            ) {
              spinnerGuarded = true;
            }
          }
        }
      }
    }
    expect(spinnerGuarded).toBe(true);
  });

  it('guards the whoosh/pulse motion behind prefers-reduced-motion (animation: none)', () => {
    // CSS @media (prefers-reduced-motion) is evaluated by the browser, not by a
    // JS matchMedia mock, so assert the adopted stylesheet carries the guard that
    // neutralizes the animations. The click path itself still fires send/stop.
    const el = mount();
    // Walk the adopted sheet for a prefers-reduced-motion media block whose
    // nested rule(s) set animation-name: none.
    let guarded = false;
    for (const s of el.shadowRoot?.adoptedStyleSheets ?? []) {
      for (const rule of s.cssRules) {
        if (rule instanceof CSSMediaRule && rule.conditionText.includes('prefers-reduced-motion')) {
          for (const inner of rule.cssRules) {
            if (inner instanceof CSSStyleRule && inner.style.animationName === 'none') {
              guarded = true;
            }
          }
        }
      }
    }
    expect(guarded).toBe(true);
  });
});
