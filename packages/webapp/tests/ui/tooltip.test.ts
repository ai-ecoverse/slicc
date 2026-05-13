// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { initTooltips } from '../../src/ui/tooltip.js';

// The tooltip is laid out as `font-size: 11px` text with `4px 8px` padding;
// pick stable dimensions so the placement math is deterministic in jsdom
// (which never computes layout — getBoundingClientRect returns zeros).
const TIP_WIDTH = 64;
const TIP_HEIGHT = 22;

function makeRect(r: Partial<DOMRect>): DOMRect {
  const merged = {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    ...r,
  };
  return { ...merged, toJSON: () => merged } as DOMRect;
}

const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;

beforeAll(() => {
  // jsdom doesn't lay out elements, so stub getBoundingClientRect: the
  // singleton tooltip element reports a fixed size, and every other element
  // reports whatever rect the test pinned on it via `__rect`.
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    if (this instanceof HTMLElement && this.classList.contains('s2-tooltip')) {
      return makeRect({
        width: TIP_WIDTH,
        height: TIP_HEIGHT,
        right: TIP_WIDTH,
        bottom: TIP_HEIGHT,
      });
    }
    const pinned = (this as unknown as { __rect?: DOMRect }).__rect;
    return pinned ?? makeRect({});
  };
  initTooltips();
});

afterAll(() => {
  Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
});

afterEach(() => {
  vi.useRealTimers();
  for (const trigger of Array.from(document.querySelectorAll('[data-tooltip]'))) {
    trigger.remove();
  }
});

function makeTrigger(pos: string, rect: Partial<DOMRect>): HTMLElement {
  const btn = document.createElement('button');
  btn.dataset.tooltip = 'Memory';
  btn.dataset.tooltipPos = pos;
  document.body.appendChild(btn);
  (btn as unknown as { __rect: DOMRect }).__rect = makeRect(rect);
  return btn;
}

function hoverAndReadTooltip(trigger: HTMLElement): { top: number; left: number } {
  vi.useFakeTimers();
  trigger.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
  vi.advanceTimersByTime(500); // past the show-delay
  const tip = document.querySelector('.s2-tooltip') as HTMLElement;
  return { top: parseFloat(tip.style.top), left: parseFloat(tip.style.left) };
}

describe('tooltip placement', () => {
  it('keeps a left-positioned tooltip on screen for the bottom-most rail button', () => {
    // The "Memory" button is the bottom icon of the right-side rail, so its
    // tooltip sits near the bottom-right corner (jsdom viewport is 1024x768).
    const trigger = makeTrigger('left', {
      left: 984,
      right: 1016,
      top: 720,
      bottom: 752,
      width: 32,
      height: 32,
    });

    const { top, left } = hoverAndReadTooltip(trigger);

    expect(top).toBeGreaterThanOrEqual(0);
    expect(top + TIP_HEIGHT).toBeLessThanOrEqual(window.innerHeight);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(left + TIP_WIDTH).toBeLessThanOrEqual(window.innerWidth);
    // ...and it actually renders to the LEFT of the trigger, not over it.
    expect(left + TIP_WIDTH).toBeLessThanOrEqual(984);
  });

  it('renders a left-positioned tooltip beside the trigger, vertically centered', () => {
    const trigger = makeTrigger('left', {
      left: 500,
      right: 532,
      top: 300,
      bottom: 332,
      width: 32,
      height: 32,
    });

    const { top, left } = hoverAndReadTooltip(trigger);

    // Trigger left edge (500) − gap (6) − tooltip width (64) = 430.
    expect(left).toBe(430);
    // Centered on the 32px-tall trigger: 300 + 16 − 11 = 305.
    expect(top).toBe(305);
  });

  it('flips a left-positioned tooltip to the right when the left side would clip it', () => {
    const trigger = makeTrigger('left', {
      left: 8,
      right: 40,
      top: 300,
      bottom: 332,
      width: 32,
      height: 32,
    });

    const { left } = hoverAndReadTooltip(trigger);

    // No room on the left (8 − 6 − 64 < 0), so it flips to the trigger's right edge + gap.
    expect(left).toBe(46);
  });
});
