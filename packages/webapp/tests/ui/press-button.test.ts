// @vitest-environment jsdom
/**
 * Tests for the `<slicc-press-button>` custom element — the reusable
 * click + long-press + double-click button used by the side rail, the
 * thread-header new-session button, and the chat copy button.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SliccPressButton, DEFAULT_DOUBLE_CLICK_MS } from '../../src/ui/press-button.js';
import { LONG_PRESS_MS } from '../../src/ui/long-press.js';

function mkBtn(opts: { disableDouble?: boolean; label?: string } = {}): SliccPressButton {
  const el = document.createElement('slicc-press-button') as SliccPressButton;
  if (opts.disableDouble) el.setAttribute('disable-double-click', '');
  if (opts.label) el.setAttribute('label', opts.label);
  document.body.appendChild(el);
  return el;
}

describe('<slicc-press-button>', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('is registered as a custom element on module import', () => {
    expect(customElements.get('slicc-press-button')).toBe(SliccPressButton);
  });

  it('initializes a press-layer-wrapped inner button on connect', () => {
    const el = mkBtn();
    const inner = el.querySelector('.slicc-press-btn__btn') as HTMLButtonElement;
    expect(inner).not.toBeNull();
    expect(inner.tagName).toBe('BUTTON');
    expect(inner.type).toBe('button');
    expect(el.querySelector('.slicc-press-btn__press-layer')).not.toBeNull();
  });

  it('mirrors label / tooltip / tooltip-pos to the inner button', () => {
    const el = mkBtn({ label: 'Copy' });
    el.setAttribute('tooltip', 'Copy last response');
    el.setAttribute('tooltip-pos', 'left');
    const inner = el.querySelector<HTMLButtonElement>('.slicc-press-btn__btn')!;
    expect(inner.getAttribute('aria-label')).toBe('Copy');
    expect(inner.dataset.tooltip).toBe('Copy last response');
    expect(inner.dataset.tooltipPos).toBe('left');
  });

  it('moves pre-existing host children into the inner button', () => {
    const el = document.createElement('slicc-press-button') as SliccPressButton;
    el.innerHTML = '<svg data-id="icon"></svg>';
    document.body.appendChild(el);
    const inner = el.querySelector<HTMLButtonElement>('.slicc-press-btn__btn')!;
    expect(inner.querySelector('[data-id="icon"]')).not.toBeNull();
  });

  it('setIcon swaps content while preserving the press-layer', () => {
    const el = mkBtn();
    el.setIcon('<svg data-id="new"></svg>');
    const inner = el.querySelector<HTMLButtonElement>('.slicc-press-btn__btn')!;
    expect(inner.querySelector('[data-id="new"]')).not.toBeNull();
    expect(el.querySelector('.slicc-press-btn__press-layer')).not.toBeNull();
  });

  it('fires short-click immediately when disable-double-click is set', () => {
    const el = mkBtn({ disableDouble: true });
    const sc = vi.fn();
    el.addEventListener('short-click', sc);
    el.click();
    expect(sc).toHaveBeenCalledTimes(1);
  });

  it('defers short-click by the double-click window and fires once', () => {
    vi.useFakeTimers();
    const el = mkBtn();
    const sc = vi.fn();
    el.addEventListener('short-click', sc);
    el.click();
    expect(sc).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DEFAULT_DOUBLE_CLICK_MS + 1);
    expect(sc).toHaveBeenCalledTimes(1);
  });

  it('second click inside the window emits double-click and suppresses short-click', () => {
    vi.useFakeTimers();
    const el = mkBtn();
    const sc = vi.fn();
    const dc = vi.fn();
    el.addEventListener('short-click', sc);
    el.addEventListener('double-click', dc);
    el.click();
    vi.advanceTimersByTime(50);
    el.click();
    vi.advanceTimersByTime(DEFAULT_DOUBLE_CLICK_MS + 1);
    expect(dc).toHaveBeenCalledTimes(1);
    expect(sc).not.toHaveBeenCalled();
  });

  it('long-press past threshold fires long-press and skips the trailing click', () => {
    vi.useFakeTimers();
    const el = mkBtn();
    const lp = vi.fn();
    const sc = vi.fn();
    el.addEventListener('long-press', lp);
    el.addEventListener('short-click', sc);
    el.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    vi.advanceTimersByTime(LONG_PRESS_MS + 1);
    el.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
    el.dispatchEvent(new MouseEvent('click'));
    vi.advanceTimersByTime(DEFAULT_DOUBLE_CLICK_MS + 1);
    expect(lp).toHaveBeenCalledTimes(1);
    expect(sc).not.toHaveBeenCalled();
  });

  it('modifier-click during a pending double-click window is the second click, not long-press', () => {
    vi.useFakeTimers();
    const el = mkBtn();
    const dc = vi.fn();
    const lp = vi.fn();
    el.addEventListener('double-click', dc);
    el.addEventListener('long-press', lp);
    el.click();
    el.dispatchEvent(new MouseEvent('click', { metaKey: true }));
    expect(dc).toHaveBeenCalledTimes(1);
    expect(lp).not.toHaveBeenCalled();
  });

  it('modifier-click outside a pending window fires long-press', () => {
    const el = mkBtn({ disableDouble: true });
    const lp = vi.fn();
    el.addEventListener('long-press', lp);
    el.dispatchEvent(new MouseEvent('click', { metaKey: true }));
    expect(lp).toHaveBeenCalledTimes(1);
  });

  it('re-attaches gesture handling after disconnect → reconnect', () => {
    // disconnectedCallback destroys the gesture handle but leaves the
    // element marked initialized. Without the re-attach guard in
    // connectedCallback, a host removed and re-inserted into the DOM
    // would lose all click handling — regression for PR #718.
    const el = mkBtn({ disableDouble: true });
    const sc = vi.fn();
    el.addEventListener('short-click', sc);

    // Sanity-check the gesture is wired before we detach.
    el.click();
    expect(sc).toHaveBeenCalledTimes(1);

    // Detach + re-attach to the DOM.
    el.remove();
    document.body.appendChild(el);

    // Click after re-attach must still fire short-click.
    el.click();
    expect(sc).toHaveBeenCalledTimes(2);
  });

  it('paints a ripple inside the press layer with the long-press transition duration', () => {
    vi.useFakeTimers();
    const el = mkBtn();
    el.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 4, clientY: 4 }));
    const ripple = el.querySelector<HTMLElement>('.slicc-press-btn__press');
    expect(ripple).not.toBeNull();
    expect(ripple!.style.transitionDuration).toBe(`${LONG_PRESS_MS}ms`);
    el.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
    expect(el.querySelector('.slicc-press-btn__press')).toBeNull();
  });
});
