import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SliccImagePreview } from '../../src/primitives/slicc-image-preview.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

const SRC =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR42mP8z8BQz0AEYBxVSFQ9iV0AAAAASUVORK5CYII=';
const SRC2 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEElEQVR42mNkYPhfz0AEYBxVSFQ9AV0AAAAASUVORK5CYII=';

function frames(n: number): Promise<void> {
  return new Promise((resolve) => {
    let left = n;
    const step = () => (left-- <= 0 ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
}

async function waitVisible(el: SliccImagePreview): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if (el.shadowRoot?.querySelector('.overlay.visible')) return;
    await frames(1);
  }
}

describe('slicc-image-preview', () => {
  let origin: HTMLElement;

  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
    origin = document.createElement('div');
    origin.style.cssText = 'position:absolute;top:100px;left:50px;width:26px;height:26px;';
    document.body.appendChild(origin);
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-image-preview')).toBe(SliccImagePreview);
  });

  it('starts closed and renders nothing in the shadow body', () => {
    const el = document.createElement('slicc-image-preview');
    document.body.appendChild(el);
    expect(el.isOpen).toBe(false);
    expect(el.hasAttribute('open')).toBe(false);
    expect(el.shadowRoot?.querySelector('.overlay')).toBeNull();

    expect(getComputedStyle(el).display).toBe('none');
  });

  it('reflects the src property to the attribute', () => {
    const el = document.createElement('slicc-image-preview') as SliccImagePreview;
    document.body.appendChild(el);
    el.src = SRC;
    expect(el.getAttribute('src')).toBe(SRC);
    el.src = null;
    expect(el.hasAttribute('src')).toBe(false);
  });

  it('open() mounts the overlay structure with part hooks and reflects open/src', () => {
    const el = document.createElement('slicc-image-preview') as SliccImagePreview;
    document.body.appendChild(el);
    el.open(SRC, origin);

    expect(el.isOpen).toBe(true);
    expect(el.hasAttribute('open')).toBe(true);
    expect(el.getAttribute('src')).toBe(SRC);

    const overlay = el.shadowRoot?.querySelector('.overlay');
    const backdrop = el.shadowRoot?.querySelector('.backdrop');
    const img = el.shadowRoot?.querySelector('.image') as HTMLImageElement;
    expect(overlay?.getAttribute('part')).toBe('overlay');
    expect(backdrop?.getAttribute('part')).toBe('backdrop');
    expect(img?.getAttribute('part')).toBe('image');
    expect(img?.src).toBe(SRC);
    expect(img?.alt).toBe('Image preview');

    expect(getComputedStyle(el).display).toBe('block');
  });

  it('animates the image to its resting transform after the FLIP frames', async () => {
    const el = document.createElement('slicc-image-preview') as SliccImagePreview;
    document.body.appendChild(el);
    el.open(SRC, origin);
    await waitVisible(el);

    const overlay = el.shadowRoot?.querySelector('.overlay');
    const img = el.shadowRoot?.querySelector('.image') as HTMLImageElement;
    expect(overlay?.classList.contains('visible')).toBe(true);

    expect(img.style.transform).toBe('translate(0px, 0px) scale(1, 1)');
    expect(img.style.borderRadius).toBe('6px');

    expect(getComputedStyle(overlay as Element).cursor).toBe('pointer');
  });

  it('close() begins dismissal and emits the close event', async () => {
    const el = document.createElement('slicc-image-preview') as SliccImagePreview;
    document.body.appendChild(el);
    let closed: string | null = 'unset';
    el.addEventListener('slicc-image-preview-close', (e) => {
      closed = (e as CustomEvent).detail.src;
    });

    el.open(SRC, origin);
    await waitVisible(el);
    el.close();

    const overlay = el.shadowRoot?.querySelector('.overlay');
    expect(overlay?.classList.contains('closing')).toBe(true);
    expect(overlay?.classList.contains('visible')).toBe(false);
    expect(closed).toBe(SRC);
  });

  it('emits the open event with the src', () => {
    const el = document.createElement('slicc-image-preview') as SliccImagePreview;
    document.body.appendChild(el);
    let opened: string | null = null;
    el.addEventListener('slicc-image-preview-open', (e) => {
      opened = (e as CustomEvent).detail.src;
    });
    el.open(SRC, origin);
    expect(opened).toBe(SRC);
  });

  it('dismisses on overlay click', async () => {
    const el = document.createElement('slicc-image-preview') as SliccImagePreview;
    document.body.appendChild(el);
    el.open(SRC, origin);
    await waitVisible(el);
    const overlay = el.shadowRoot?.querySelector('.overlay') as HTMLElement;
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(overlay.classList.contains('closing')).toBe(true);
  });

  it('dismisses on Escape', async () => {
    const el = document.createElement('slicc-image-preview') as SliccImagePreview;
    document.body.appendChild(el);
    el.open(SRC, origin);
    await waitVisible(el);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    const overlay = el.shadowRoot?.querySelector('.overlay');
    expect(overlay?.classList.contains('closing')).toBe(true);
  });

  it('only allows one preview open at a time (static helper)', () => {
    const dismiss1 = SliccImagePreview.show(SRC, origin);
    const dismiss2 = SliccImagePreview.show(SRC2, origin);
    const hosts = document.querySelectorAll('slicc-image-preview[data-shared]');

    expect(hosts.length).toBe(1);
    const overlays = document.querySelectorAll('slicc-image-preview[data-shared]');
    expect(overlays.length).toBe(1);
    expect(typeof dismiss1).toBe('function');
    expect(typeof dismiss2).toBe('function');
  });

  it('static show() opens a shared host and returns a working dismiss fn', async () => {
    const dismiss = SliccImagePreview.show(SRC, origin);
    const host = document.querySelector('slicc-image-preview[data-shared]') as SliccImagePreview;
    expect(host).toBeTruthy();
    expect(host.isOpen).toBe(true);
    await waitVisible(host);
    dismiss();
    const overlay = host.shadowRoot?.querySelector('.overlay');
    expect(overlay?.classList.contains('closing')).toBe(true);
  });

  it('cleans up the keydown listener and overlay on disconnect', async () => {
    const el = document.createElement('slicc-image-preview') as SliccImagePreview;
    document.body.appendChild(el);
    el.open(SRC, origin);
    await waitVisible(el);
    el.remove();
    expect(el.shadowRoot?.querySelector('.overlay')).toBeNull();
    expect(el.hasAttribute('open')).toBe(false);

    expect(() =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    ).not.toThrow();
  });

  it('re-opening replaces the overlay cleanly (single overlay node)', async () => {
    const el = document.createElement('slicc-image-preview') as SliccImagePreview;
    document.body.appendChild(el);
    el.open(SRC, origin);
    await waitVisible(el);
    el.open(SRC2, origin);
    const overlays = el.shadowRoot?.querySelectorAll('.overlay');
    expect(overlays?.length).toBe(1);
    const img = el.shadowRoot?.querySelector('.image') as HTMLImageElement;
    expect(img.src).toBe(SRC2);
  });

  it('setSrc swaps the image while open without replacing the overlay', async () => {
    const el = document.createElement('slicc-image-preview') as SliccImagePreview;
    document.body.appendChild(el);
    el.open(SRC, origin);
    await waitVisible(el);
    const overlay = el.shadowRoot?.querySelector('.overlay');
    el.setSrc(SRC2);
    expect(el.isOpen).toBe(true);
    expect(el.getAttribute('src')).toBe(SRC2);
    expect(el.shadowRoot?.querySelector('.overlay')).toBe(overlay);
    expect((el.shadowRoot?.querySelector('.image') as HTMLImageElement).src).toBe(SRC2);
  });

  it('setSrc updates the reflected src when the lightbox is closed', () => {
    const el = document.createElement('slicc-image-preview') as SliccImagePreview;
    document.body.appendChild(el);
    el.setSrc(SRC);
    expect(el.isOpen).toBe(false);
    expect(el.getAttribute('src')).toBe(SRC);
  });

  it('falls back to the host element as origin when none is supplied', () => {
    const el = document.createElement('slicc-image-preview') as SliccImagePreview;
    document.body.appendChild(el);
    expect(() => el.open(SRC)).not.toThrow();
    expect(el.shadowRoot?.querySelector('.image')).toBeTruthy();
  });

  it('reflects the drive attribute and paints a driving chip', async () => {
    const el = document.createElement('slicc-image-preview') as SliccImagePreview;
    document.body.appendChild(el);
    expect(el.drive).toBe(false);
    el.drive = true;
    expect(el.hasAttribute('drive')).toBe(true);
    el.open(SRC, origin);
    await waitVisible(el);
    const chip = el.shadowRoot?.querySelector('.chip');
    expect(chip?.getAttribute('part')).toBe('chip');
    expect(chip?.textContent).toBe('driving');
    el.drive = false;
    expect(el.hasAttribute('drive')).toBe(false);
  });

  it('emits image clicks/scroll/keys in drive mode and still releases on Escape', async () => {
    const el = document.createElement('slicc-image-preview') as SliccImagePreview;
    document.body.appendChild(el);
    el.drive = true;
    const inputs: Array<{ kind: string; key?: string; button?: number; dy?: number }> = [];
    el.addEventListener('slicc-image-preview-input', (e) => {
      inputs.push((e as CustomEvent).detail);
    });
    el.open(SRC, origin);
    await waitVisible(el);
    const img = el.shadowRoot?.querySelector('.image') as HTMLImageElement;
    const overlay = el.shadowRoot?.querySelector('.overlay') as HTMLElement;
    img.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    img.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 40, cancelable: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(inputs.map((d) => d.kind)).toEqual(['click', 'scroll', 'key']);
    expect(inputs[0]?.button).toBe(1);
    expect(inputs[1]?.dy).toBe(1);
    expect(inputs[2]?.key).toBe('a');
    expect(overlay.classList.contains('closing')).toBe(false);

    img.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    img.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 2 }));
    expect(inputs.map((d) => d.kind)).toEqual(['click', 'scroll', 'key', 'click', 'click']);
    expect(inputs[3]?.button).toBe(2);
    expect(inputs[4]?.button).toBe(3);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(overlay.classList.contains('closing')).toBe(true);
    expect(inputs.some((d) => d.key === 'Escape')).toBe(false);
  });

  it('backdrop clicks still close in drive mode', async () => {
    const el = document.createElement('slicc-image-preview') as SliccImagePreview;
    document.body.appendChild(el);
    el.drive = true;
    el.open(SRC, origin);
    await waitVisible(el);
    const overlay = el.shadowRoot?.querySelector('.overlay') as HTMLElement;
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(overlay.classList.contains('closing')).toBe(true);
  });
});
