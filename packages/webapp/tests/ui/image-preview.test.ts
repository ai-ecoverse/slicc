// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { showImagePreview } from '../../src/ui/image-preview.js';

describe('showImagePreview', () => {
  let originEl: HTMLElement;
  const testSrc =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  beforeEach(() => {
    originEl = document.createElement('div');
    originEl.style.width = '26px';
    originEl.style.height = '26px';
    originEl.style.position = 'absolute';
    originEl.style.top = '100px';
    originEl.style.left = '50px';
    document.body.appendChild(originEl);
  });

  afterEach(() => {
    originEl.remove();
    document.querySelectorAll('.image-preview-overlay').forEach((el) => {
      el.remove();
    });
  });

  it('creates an overlay element in the DOM', () => {
    showImagePreview(testSrc, originEl);
    const overlay = document.querySelector('.image-preview-overlay');
    expect(overlay).toBeTruthy();
  });

  it('contains a backdrop and an image element', () => {
    showImagePreview(testSrc, originEl);
    const overlay = document.querySelector('.image-preview-overlay')!;
    expect(overlay.querySelector('.image-preview-backdrop')).toBeTruthy();
    expect(overlay.querySelector('.image-preview-image')).toBeTruthy();
  });

  it('sets the image src correctly', () => {
    showImagePreview(testSrc, originEl);
    const img = document.querySelector('.image-preview-image') as HTMLImageElement;
    expect(img.src).toBe(testSrc);
  });

  it('removes overlay on click', () => {
    showImagePreview(testSrc, originEl);
    const overlay = document.querySelector('.image-preview-overlay')!;
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(overlay.classList.contains('image-preview-overlay--closing')).toBe(true);
  });

  it('removes overlay on Escape key', () => {
    showImagePreview(testSrc, originEl);
    const overlay = document.querySelector('.image-preview-overlay')!;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(overlay.classList.contains('image-preview-overlay--closing')).toBe(true);
  });

  it('returns a dismiss function', () => {
    const dismiss = showImagePreview(testSrc, originEl);
    expect(typeof dismiss).toBe('function');
    dismiss();
    const overlay = document.querySelector('.image-preview-overlay')!;
    expect(overlay.classList.contains('image-preview-overlay--closing')).toBe(true);
  });

  it('only allows one preview at a time', () => {
    showImagePreview(testSrc, originEl);
    showImagePreview(testSrc, originEl);
    const overlays = document.querySelectorAll('.image-preview-overlay');
    expect(overlays.length).toBe(1);
  });
});
