import { beforeEach, describe, expect, it } from 'vitest';
import { deepActiveElement, withFocusPreserved } from '../../src/internal/focus.js';

function scope(): { root: HTMLElement; a: HTMLElement; b: HTMLElement } {
  const root = document.createElement('div');
  const a = document.createElement('div');
  const b = document.createElement('div');
  root.append(a, b);
  document.body.append(root);
  return { root, a, b };
}

describe('withFocusPreserved', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('gives the focus back to a textarea the rebuild moved, caret included', () => {
    const { root, a, b } = scope();
    const ta = document.createElement('textarea');
    a.append(ta);
    ta.value = 'hello world';
    ta.focus();
    ta.setSelectionRange(5, 5);

    withFocusPreserved(root, () => b.append(ta));

    expect(document.activeElement).toBe(ta);
    expect([ta.selectionStart, ta.selectionEnd]).toEqual([5, 5]);
  });

  it('without it, the same move drops the focus to the body', () => {
    const { a, b } = scope();
    const ta = document.createElement('textarea');
    a.append(ta);
    ta.focus();

    b.append(ta);

    expect(document.activeElement).toBe(document.body);
  });

  it('restores focus that sits inside a shadow root within the scope', () => {
    const { root, a, b } = scope();
    const host = document.createElement('div');
    const ta = document.createElement('textarea');
    host.attachShadow({ mode: 'open' }).append(ta);
    a.append(host);
    ta.focus();

    withFocusPreserved(root, () => b.append(host));

    expect(deepActiveElement(document)).toBe(ta);
  });

  it('leaves focus outside the scope alone', () => {
    const { root, a, b } = scope();
    const outside = document.createElement('input');
    document.body.append(outside);
    const inside = document.createElement('textarea');
    a.append(inside);
    outside.focus();

    withFocusPreserved(root, () => {
      b.append(inside);
      inside.focus();
    });

    expect(document.activeElement).toBe(inside);
  });

  it('does not focus anything when nothing inside held the focus', () => {
    const { root, a, b } = scope();
    const ta = document.createElement('textarea');
    a.append(ta);

    withFocusPreserved(root, () => b.append(ta));

    expect(document.activeElement).toBe(document.body);
  });

  it('does not resurrect focus on an element the rebuild removed', () => {
    const { root, a } = scope();
    const ta = document.createElement('textarea');
    a.append(ta);
    ta.focus();

    withFocusPreserved(root, () => ta.remove());

    expect(document.activeElement).toBe(document.body);
  });

  it('returns the rebuild result', () => {
    const { root } = scope();
    expect(withFocusPreserved(root, () => 42)).toBe(42);
  });
});
