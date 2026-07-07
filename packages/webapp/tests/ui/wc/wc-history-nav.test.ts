// @vitest-environment jsdom
/**
 * Composer arrow-key history navigation: ArrowUp walks backwards through the
 * thread's user messages, ArrowDown walks forward and hands focus back to the
 * composer past the most recent one. The walk index resets on thread
 * interaction and on composer typing.
 */

import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { wireWcHistoryNav } from '../../../src/ui/wc/wc-history-nav.js';

interface Harness {
  thread: HTMLElement & { scrollToBottom: Mock<() => void> };
  inputCard: HTMLElement & { focusEnd: Mock<() => void> };
  messages: HTMLElement[];
  scrolled: ReturnType<typeof vi.fn>;
  up(): void;
  down(): void;
}

function harness(messageCount = 3): Harness {
  const thread = document.createElement('div') as unknown as Harness['thread'];
  thread.scrollToBottom = vi.fn<() => void>();
  const scrolled = vi.fn();
  const messages: HTMLElement[] = [];
  for (let i = 0; i < messageCount; i += 1) {
    const m = document.createElement('slicc-user-message');
    m.textContent = `prompt ${i}`;
    m.scrollIntoView = ((opts: ScrollIntoViewOptions) => scrolled(i, opts)) as never;
    thread.appendChild(m);
    messages.push(m);
  }
  const inputCard = document.createElement('div') as unknown as Harness['inputCard'];
  inputCard.focusEnd = vi.fn<() => void>();
  document.body.append(thread, inputCard);
  wireWcHistoryNav({ thread, inputCard });
  return {
    thread,
    inputCard,
    messages,
    scrolled,
    up: () => inputCard.dispatchEvent(new CustomEvent('history-up')),
    down: () => inputCard.dispatchEvent(new CustomEvent('history-down')),
  };
}

describe('wireWcHistoryNav', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('ArrowUp walks backwards from the most recent user message', () => {
    const h = harness(3);
    h.up();
    expect(h.scrolled).toHaveBeenLastCalledWith(
      2,
      expect.objectContaining({ block: 'center', behavior: 'smooth' })
    );
    h.up();
    expect(h.scrolled).toHaveBeenLastCalledWith(1, expect.anything());
    h.up();
    expect(h.scrolled).toHaveBeenLastCalledWith(0, expect.anything());
  });

  it('clamps at the oldest message instead of wrapping', () => {
    const h = harness(2);
    h.up();
    h.up();
    h.up();
    h.up();
    expect(h.scrolled).toHaveBeenLastCalledWith(0, expect.anything());
    expect(h.scrolled).toHaveBeenCalledTimes(4);
  });

  it('ArrowDown is a no-op before any ArrowUp walk started', () => {
    const h = harness(3);
    h.down();
    expect(h.scrolled).not.toHaveBeenCalled();
    expect(h.thread.scrollToBottom).not.toHaveBeenCalled();
    expect(h.inputCard.focusEnd).not.toHaveBeenCalled();
  });

  it('ArrowDown walks forward, then returns focus to the composer at the end', () => {
    const h = harness(3);
    h.up(); // -> 2
    h.up(); // -> 1
    h.up(); // -> 0
    h.down(); // -> 1
    expect(h.scrolled).toHaveBeenLastCalledWith(1, expect.anything());
    h.down(); // -> 2 (most recent)
    expect(h.scrolled).toHaveBeenLastCalledWith(2, expect.anything());
    h.down(); // past the most recent: bottom + composer focus
    expect(h.thread.scrollToBottom).toHaveBeenCalledTimes(1);
    expect(h.inputCard.focusEnd).toHaveBeenCalledTimes(1);
  });

  it('falls back to scrollTop when the thread has no scrollToBottom', () => {
    const thread = document.createElement('div');
    Object.defineProperty(thread, 'scrollHeight', { value: 500 });
    const m = document.createElement('slicc-user-message');
    m.scrollIntoView = vi.fn() as never;
    thread.appendChild(m);
    const inputCard = document.createElement('div');
    document.body.append(thread, inputCard);
    wireWcHistoryNav({ thread, inputCard });
    inputCard.dispatchEvent(new CustomEvent('history-up'));
    inputCard.dispatchEvent(new CustomEvent('history-down'));
    expect(thread.scrollTop).toBe(500);
  });

  it('the walk restarts from the most recent message after stepping past it', () => {
    const h = harness(2);
    h.up(); // -> 1
    h.down(); // past: reset
    h.up(); // -> 1 again, not 0
    expect(h.scrolled).toHaveBeenLastCalledWith(1, expect.anything());
  });

  it('resets the walk when the user touches the thread', () => {
    const h = harness(3);
    h.up(); // -> 2
    h.up(); // -> 1
    h.thread.dispatchEvent(new Event('pointerdown'));
    h.up(); // -> 2 again
    expect(h.scrolled).toHaveBeenLastCalledWith(2, expect.anything());
  });

  it('resets the walk when the user types into the composer', () => {
    const h = harness(3);
    h.up(); // -> 2
    h.up(); // -> 1
    h.inputCard.dispatchEvent(new Event('input'));
    h.up(); // -> 2 again
    expect(h.scrolled).toHaveBeenLastCalledWith(2, expect.anything());
  });

  it('ignores ArrowUp with no user messages in the thread', () => {
    const h = harness(0);
    h.up();
    h.down();
    expect(h.scrolled).not.toHaveBeenCalled();
    expect(h.inputCard.focusEnd).not.toHaveBeenCalled();
  });

  it('hops out of the follow slack zone before a glide that starts at the bottom', () => {
    const h = harness(3);
    Object.defineProperty(h.thread, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(h.thread, 'clientHeight', { value: 400, configurable: true });
    h.thread.scrollTop = 600; // pinned to the bottom: fromBottom = 0
    h.up();
    // The instant pre-hop leaves requestFollow's near-bottom zone so a live
    // append mid-glide raises the chip instead of yanking back down.
    expect(h.thread.scrollTop).toBe(400);

    // Already far from the bottom: no hop, the glide runs untouched.
    h.thread.scrollTop = 100;
    h.up();
    expect(h.thread.scrollTop).toBe(100);
  });
});
