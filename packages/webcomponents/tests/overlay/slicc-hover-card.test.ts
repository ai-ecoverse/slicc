import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { placeHoverCard, SliccHoverCard } from '../../src/overlay/slicc-hover-card.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

const VIEW = { width: 1000, height: 800 };
const rect = (top: number, left: number, width = 60, height = 18) => ({
  top,
  left,
  width,
  height,
  bottom: top + height,
  right: left + width,
});

describe('placeHoverCard', () => {
  it('places the card below the anchor, aligned to its left edge', () => {
    expect(placeHoverCard(rect(100, 200), { width: 300, height: 200 }, VIEW)).toEqual({
      top: 124,
      left: 200,
      placement: 'below',
    });
  });

  it('flips above when below would clip and above has more room', () => {
    const pos = placeHoverCard(rect(700, 200), { width: 300, height: 200 }, VIEW);
    expect(pos.placement).toBe('above');
    expect(pos.top).toBe(700 - 6 - 200);
  });

  it('stays below when neither side fits but below has more room', () => {
    const pos = placeHoverCard(rect(300, 10), { width: 300, height: 900 }, VIEW);
    expect(pos.placement).toBe('below');
    expect(pos.top).toBe(8);
  });

  it('clamps horizontally inside the viewport edge', () => {
    expect(placeHoverCard(rect(100, 950), { width: 300, height: 100 }, VIEW).left).toBe(692);
    expect(placeHoverCard(rect(100, -20), { width: 300, height: 100 }, VIEW).left).toBe(8);
  });
});

describe('slicc-hover-card', () => {
  let anchor: HTMLElement;

  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
    anchor = document.createElement('span');
    anchor.textContent = 'anchor';
    document.body.append(anchor);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers the custom element with a slot and one adopted sheet', () => {
    const card = document.createElement('slicc-hover-card');
    expect(card).toBeInstanceOf(SliccHoverCard);
    expect(card.shadowRoot?.querySelector('slot')).not.toBeNull();
    expect(card.shadowRoot?.adoptedStyleSheets.length).toBe(1);
  });

  it('shared() returns one card per document and recreates it once removed', () => {
    const a = SliccHoverCard.shared();
    expect(SliccHoverCard.shared()).toBe(a);
    expect(a.parentElement).toBe(document.body);
    expect(a.getAttribute('role')).toBe('dialog');
    a.remove();
    const b = SliccHoverCard.shared();
    expect(b).not.toBe(a);
    expect(b.isConnected).toBe(true);
  });

  it('showFor opens next to the anchor with the given content', () => {
    const card = SliccHoverCard.shared();
    const content = document.createElement('p');
    content.textContent = 'hello';
    card.showFor(anchor, content);
    expect(card.open).toBe(true);
    expect(card.anchor).toBe(anchor);
    expect(card.firstElementChild).toBe(content);
    expect(getComputedStyle(card).display).toBe('block');
    expect(card.getAttribute('data-placement')).toBe('below');
    expect(card.style.top).toMatch(/px$/);
  });

  it('showFor with null content keeps the existing content', () => {
    const card = SliccHoverCard.shared();
    const content = document.createElement('p');
    card.showFor(anchor, content);
    card.showFor(anchor, null);
    expect(card.firstElementChild).toBe(content);
  });

  it('hide clears content and fires hover-card-close once', () => {
    const card = SliccHoverCard.shared();
    const onClose = vi.fn();
    document.addEventListener('hover-card-close', onClose);
    card.showFor(anchor, document.createElement('p'));
    card.hide();
    card.hide();
    document.removeEventListener('hover-card-close', onClose);
    expect(card.open).toBe(false);
    expect(card.anchor).toBeNull();
    expect(card.childElementCount).toBe(0);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('scheduleHide closes after the delay unless cancelled', () => {
    vi.useFakeTimers();
    const card = SliccHoverCard.shared();
    card.showFor(anchor, document.createElement('p'));
    card.scheduleHide(100);
    vi.advanceTimersByTime(50);
    card.cancelHide();
    vi.advanceTimersByTime(200);
    expect(card.open).toBe(true);
    card.scheduleHide(100);
    vi.advanceTimersByTime(150);
    expect(card.open).toBe(false);
  });

  it('pointer entering the card cancels a pending hide; leaving schedules one', () => {
    vi.useFakeTimers();
    const card = SliccHoverCard.shared();
    card.showFor(anchor, document.createElement('p'));
    card.scheduleHide(100);
    card.dispatchEvent(new PointerEvent('pointerenter'));
    vi.advanceTimersByTime(500);
    expect(card.open).toBe(true);
    card.dispatchEvent(new PointerEvent('pointerleave'));
    vi.advanceTimersByTime(500);
    expect(card.open).toBe(false);
  });

  it('Escape closes the card', () => {
    const card = SliccHoverCard.shared();
    card.showFor(anchor, document.createElement('p'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(card.open).toBe(false);
  });

  it('closes on scroll once its anchor has left the DOM', () => {
    const card = SliccHoverCard.shared();
    card.showFor(anchor, document.createElement('p'));
    anchor.remove();
    window.dispatchEvent(new Event('scroll'));
    expect(card.open).toBe(false);
  });

  it('reposition is a no-op while closed', () => {
    const card = SliccHoverCard.shared();
    card.reposition();
    expect(card.hasAttribute('data-placement')).toBe(false);
  });
});
