import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LONG_PRESS_MS } from '../../src/internal/long-press.js';
import {
  DEFAULT_DOUBLE_CLICK_MS,
  SliccPressButton,
  SQUISH_CLASS,
  WOBBLE_CLASS,
} from '../../src/primitives/slicc-press-button.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

/** The inner `<button>` the component renders into its light DOM. */
function btnOf(el: SliccPressButton): HTMLButtonElement {
  return el.querySelector('.slicc-press-btn__btn') as HTMLButtonElement;
}

/** Dispatch an `animationend` on the inner button (the class self-removal hook). */
function fireAnimationEnd(btn: HTMLButtonElement): void {
  btn.dispatchEvent(new AnimationEvent('animationend', { bubbles: true }));
}

/** Sized so the ripple geometry + layout assertions have real pixels. */
function makeButton(): SliccPressButton {
  const el = document.createElement('slicc-press-button');
  el.style.cssText = 'width:40px;height:40px;border-radius:8px;';
  el.innerHTML = '<span class="icon">x</span>';
  return el;
}

/** Dispatch a real MouseEvent on the host (gesture listens on the host). */
function fire(
  el: HTMLElement,
  type: 'mousedown' | 'mouseup' | 'click',
  init: MouseEventInit = {}
): void {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }));
}

describe('slicc-press-button', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-press-button')).toBe(SliccPressButton);
  });

  it('renders into light DOM (no shadow root) with the inner button + press layer', () => {
    const el = makeButton();
    document.body.appendChild(el);
    expect(el.shadowRoot).toBeNull();
    const btn = btnOf(el);
    expect(btn).not.toBeNull();
    expect(btn.type).toBe('button');
    expect(btn.getAttribute('part')).toBe('button');
    const layer = btn.querySelector('.slicc-press-btn__press-layer');
    expect(layer).not.toBeNull();
    expect((layer as HTMLElement).getAttribute('part')).toBe('press-layer');
  });

  it('relocates pre-existing icon children into the inner button, above the press layer', () => {
    const el = makeButton();
    document.body.appendChild(el);
    const btn = btnOf(el);
    const icon = btn.querySelector('.icon') as HTMLElement;
    expect(icon).not.toBeNull();
    expect(icon.textContent).toBe('x');
    // Icon sits above the ripple in the stacking order.
    expect(getComputedStyle(icon).zIndex).toBe('1');
  });

  it('reflects disabled / label / tooltip attributes to properties and back', () => {
    const el = makeButton();
    document.body.appendChild(el);

    expect(el.disabled).toBe(false);
    el.disabled = true;
    expect(el.hasAttribute('disabled')).toBe(true);
    expect(btnOf(el).hasAttribute('disabled')).toBe(true);
    el.disabled = false;
    expect(el.hasAttribute('disabled')).toBe(false);
    expect(btnOf(el).hasAttribute('disabled')).toBe(false);

    el.label = 'Settings';
    expect(el.getAttribute('label')).toBe('Settings');
    expect(btnOf(el).getAttribute('aria-label')).toBe('Settings');
    el.label = null;
    expect(el.hasAttribute('label')).toBe(false);
    expect(btnOf(el).hasAttribute('aria-label')).toBe(false);

    el.tooltip = 'hi';
    expect(btnOf(el).dataset.tooltip).toBe('hi');
    el.tooltip = null;
    expect(btnOf(el).dataset.tooltip).toBeUndefined();
  });

  it('forwards tooltip-pos to the inner button as a data attribute', () => {
    const el = makeButton();
    el.setAttribute('tooltip-pos', 'right');
    document.body.appendChild(el);
    expect(btnOf(el).dataset.tooltipPos).toBe('right');
    el.removeAttribute('tooltip-pos');
    expect(btnOf(el).dataset.tooltipPos).toBeUndefined();
  });

  it('emits a deferred short-click after the double-click window', () => {
    vi.useFakeTimers();
    const el = makeButton();
    document.body.appendChild(el);
    const onShort = vi.fn();
    el.addEventListener('short-click', onShort);

    fire(el, 'click');
    // Deferred — not yet fired.
    expect(onShort).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DEFAULT_DOUBLE_CLICK_MS);
    expect(onShort).toHaveBeenCalledTimes(1);
    const ev = onShort.mock.calls[0][0] as CustomEvent;
    expect(ev.bubbles).toBe(true);
    expect(ev.cancelable).toBe(true);
    expect((ev.detail as { sourceEvent?: MouseEvent }).sourceEvent).toBeInstanceOf(MouseEvent);
  });

  it('coalesces two clicks inside the window into a double-click and suppresses short-click', () => {
    vi.useFakeTimers();
    const el = makeButton();
    document.body.appendChild(el);
    const onShort = vi.fn();
    const onDouble = vi.fn();
    el.addEventListener('short-click', onShort);
    el.addEventListener('double-click', onDouble);

    fire(el, 'click');
    vi.advanceTimersByTime(DEFAULT_DOUBLE_CLICK_MS - 50);
    fire(el, 'click');

    expect(onDouble).toHaveBeenCalledTimes(1);
    // Run out any remaining timers — the deferred short-click must NOT fire.
    vi.advanceTimersByTime(DEFAULT_DOUBLE_CLICK_MS);
    expect(onShort).not.toHaveBeenCalled();
  });

  it('fires short-click immediately when disable-double-click is set', () => {
    vi.useFakeTimers();
    const el = makeButton();
    el.setAttribute('disable-double-click', '');
    document.body.appendChild(el);
    const onShort = vi.fn();
    el.addEventListener('short-click', onShort);

    fire(el, 'click');
    // No deferral — fires synchronously on the click.
    expect(onShort).toHaveBeenCalledTimes(1);
  });

  it('fires long-press when the press is held past the threshold', () => {
    vi.useFakeTimers();
    const el = makeButton();
    el.setAttribute('long-press-ms', '500');
    document.body.appendChild(el);
    const onLong = vi.fn();
    el.addEventListener('long-press', onLong);

    fire(el, 'mousedown', { clientX: 5, clientY: 5 });
    vi.advanceTimersByTime(500);
    expect(onLong).toHaveBeenCalledTimes(1);
  });

  it('treats a modifier-click as a long-press', () => {
    const el = makeButton();
    document.body.appendChild(el);
    const onLong = vi.fn();
    const onShort = vi.fn();
    el.addEventListener('long-press', onLong);
    el.addEventListener('short-click', onShort);

    fire(el, 'click', { metaKey: true });
    expect(onLong).toHaveBeenCalledTimes(1);
    expect(onShort).not.toHaveBeenCalled();
  });

  it('treats a modifier-click during a pending double-click window as a double-click', () => {
    vi.useFakeTimers();
    const el = makeButton();
    document.body.appendChild(el);
    const onDouble = vi.fn();
    const onLong = vi.fn();
    el.addEventListener('double-click', onDouble);
    el.addEventListener('long-press', onLong);

    fire(el, 'click');
    vi.advanceTimersByTime(50);
    fire(el, 'click', { shiftKey: true });
    expect(onDouble).toHaveBeenCalledTimes(1);
    expect(onLong).not.toHaveBeenCalled();
  });

  it('paints a ripple span on press start and clears it on press end', () => {
    const el = makeButton();
    document.body.appendChild(el);
    const layer = el.querySelector('.slicc-press-btn__press-layer') as HTMLElement;

    fire(el, 'mousedown', { clientX: 10, clientY: 10 });
    const ripple = layer.querySelector('.slicc-press-btn__press') as HTMLElement;
    expect(ripple).not.toBeNull();
    // The ripple is a circle tinted from the accent token, above-layer clipped.
    expect(getComputedStyle(ripple).borderRadius).toBe('50%');
    expect(getComputedStyle(ripple).backgroundColor).toBe('rgb(245, 158, 11)'); // --ctx #f59e0b
    expect(getComputedStyle(layer).overflow).toBe('hidden');

    // mouseup ends the press and clears the ripple.
    fire(el, 'mouseup');
    expect(layer.querySelector('.slicc-press-btn__press')).toBeNull();
  });

  it('uses the default long-press threshold when none is supplied', () => {
    vi.useFakeTimers();
    const el = makeButton();
    document.body.appendChild(el);
    const onLong = vi.fn();
    el.addEventListener('long-press', onLong);

    fire(el, 'mousedown', { clientX: 1, clientY: 1 });
    vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    expect(onLong).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onLong).toHaveBeenCalledTimes(1);
  });

  it('replaces icon content via setIcon while preserving the press layer', () => {
    const el = makeButton();
    document.body.appendChild(el);
    el.setIcon('<span class="new-icon">y</span>');
    const btn = btnOf(el);
    expect(btn.querySelector('.icon')).toBeNull();
    expect(btn.querySelector('.new-icon')?.textContent).toBe('y');
    // Press layer survived the swap.
    expect(btn.querySelector('.slicc-press-btn__press-layer')).not.toBeNull();
  });

  it('focuses the internal button', () => {
    const el = makeButton();
    document.body.appendChild(el);
    el.focus();
    expect(document.activeElement).toBe(btnOf(el));
  });

  it('survives detach + re-attach: re-arms the gesture so events still fire', () => {
    vi.useFakeTimers();
    const el = makeButton();
    document.body.appendChild(el);

    el.remove();
    document.body.appendChild(el);

    const onShort = vi.fn();
    el.addEventListener('short-click', onShort);
    fire(el, 'click');
    vi.advanceTimersByTime(DEFAULT_DOUBLE_CLICK_MS);
    expect(onShort).toHaveBeenCalledTimes(1);
  });

  it('stops firing events after disconnect (gesture torn down)', () => {
    vi.useFakeTimers();
    const el = makeButton();
    document.body.appendChild(el);
    const onShort = vi.fn();
    el.addEventListener('short-click', onShort);

    el.remove();
    fire(el, 'click');
    vi.advanceTimersByTime(DEFAULT_DOUBLE_CLICK_MS);
    expect(onShort).not.toHaveBeenCalled();
  });

  it('sizes the inner button to fill the host so the ripple matches the visible button', () => {
    const el = makeButton();
    document.body.appendChild(el);
    const btn = btnOf(el);
    const hostRect = el.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    expect(btnRect.width).toBeCloseTo(hostRect.width, 0);
    expect(btnRect.height).toBeCloseTo(hostRect.height, 0);
    expect(getComputedStyle(el).display).toBe('inline-flex');
  });

  describe('delight animations', () => {
    it('plays the squish animation hook on a committed single press', () => {
      vi.useFakeTimers();
      const el = makeButton();
      document.body.appendChild(el);
      const btn = btnOf(el);

      fire(el, 'click');
      // Animation is keyed to the committed short-click, which is deferred by
      // the double-click window — nothing yet.
      expect(btn.classList.contains(SQUISH_CLASS)).toBe(false);
      vi.advanceTimersByTime(DEFAULT_DOUBLE_CLICK_MS);
      // Squish is applied when the short-click commits; wobble is NOT.
      expect(btn.classList.contains(SQUISH_CLASS)).toBe(true);
      expect(btn.classList.contains(WOBBLE_CLASS)).toBe(false);
    });

    it('plays a DISTINCT wobble animation hook on a double-press (not squish)', () => {
      vi.useFakeTimers();
      const el = makeButton();
      document.body.appendChild(el);
      const btn = btnOf(el);

      fire(el, 'click');
      vi.advanceTimersByTime(DEFAULT_DOUBLE_CLICK_MS - 50);
      fire(el, 'click');

      // The double-press wobbles, and the squish is never left applied.
      expect(btn.classList.contains(WOBBLE_CLASS)).toBe(true);
      expect(btn.classList.contains(SQUISH_CLASS)).toBe(false);
      // The suppressed deferred short-click must not later add a squish.
      vi.advanceTimersByTime(DEFAULT_DOUBLE_CLICK_MS);
      expect(btn.classList.contains(SQUISH_CLASS)).toBe(false);
    });

    it('plays the squish immediately when disable-double-click is set', () => {
      const el = makeButton();
      el.setAttribute('disable-double-click', '');
      document.body.appendChild(el);
      const btn = btnOf(el);

      fire(el, 'click');
      // No deferral — the squish lands synchronously with the short-click.
      expect(btn.classList.contains(SQUISH_CLASS)).toBe(true);
    });

    it('removes the animation class on animationend so it can re-fire', () => {
      const el = makeButton();
      el.setAttribute('disable-double-click', '');
      document.body.appendChild(el);
      const btn = btnOf(el);

      fire(el, 'click');
      expect(btn.classList.contains(SQUISH_CLASS)).toBe(true);
      fireAnimationEnd(btn);
      expect(btn.classList.contains(SQUISH_CLASS)).toBe(false);

      // A second press re-applies the hook (the listener didn't leak/stick).
      fire(el, 'click');
      expect(btn.classList.contains(SQUISH_CLASS)).toBe(true);
    });

    it('does not animate (squish/wobble) on a long-press', () => {
      vi.useFakeTimers();
      const el = makeButton();
      el.setAttribute('long-press-ms', '300');
      document.body.appendChild(el);
      const btn = btnOf(el);

      fire(el, 'mousedown', { clientX: 5, clientY: 5 });
      vi.advanceTimersByTime(300);
      expect(btn.classList.contains(SQUISH_CLASS)).toBe(false);
      expect(btn.classList.contains(WOBBLE_CLASS)).toBe(false);
    });

    it('clears any in-flight animation class on disconnect', () => {
      const el = makeButton();
      el.setAttribute('disable-double-click', '');
      document.body.appendChild(el);
      const btn = btnOf(el);

      fire(el, 'click');
      expect(btn.classList.contains(SQUISH_CLASS)).toBe(true);
      el.remove();
      // Detach drops the hook so a reattach never surfaces a frozen frame.
      expect(btn.classList.contains(SQUISH_CLASS)).toBe(false);
    });

    it('no-ops the animation under prefers-reduced-motion (animation: none) while still firing events', () => {
      // Real Chromium honors the emulated media query; assert the CSS holds the
      // static end state even though the class hook is present.
      const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
      const el = makeButton();
      el.setAttribute('disable-double-click', '');
      document.body.appendChild(el);
      const btn = btnOf(el);
      const onShort = vi.fn();
      el.addEventListener('short-click', onShort);

      fire(el, 'click');
      // The event still fires regardless of motion preference.
      expect(onShort).toHaveBeenCalledTimes(1);
      // The hook class is toggled either way; under reduced-motion the
      // computed animation-name resolves to "none" so nothing paints.
      expect(btn.classList.contains(SQUISH_CLASS)).toBe(true);
      if (reduced) {
        expect(getComputedStyle(btn).animationName).toBe('none');
      } else {
        expect(getComputedStyle(btn).animationName).toBe('slicc-press-squish');
      }
    });
  });
});
