// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddItem } from '../../../src/ui/add-menu/add-item.js';
import { AddMenu } from '../../../src/ui/add-menu/add-menu.js';

function setup(items: AddItem[] = []) {
  document.body.innerHTML = '';
  const composer = document.createElement('div');
  const toggle = document.createElement('button');
  document.body.append(composer, toggle);
  const onAttachFiles = vi.fn();
  const onAddReference = vi.fn();
  const capturePhoto = vi.fn(async () => null);
  const captureScreenshot = vi.fn(async () => null);
  const aggregator = { search: vi.fn(async () => items) };
  const menu = new AddMenu({
    composer,
    toggleButton: toggle,
    aggregator,
    onAttachFiles,
    onAddReference,
    capturePhoto,
    captureScreenshot,
  });
  return {
    menu,
    composer,
    toggle,
    onAttachFiles,
    onAddReference,
    capturePhoto,
    captureScreenshot,
    aggregator,
  };
}

describe('AddMenu shell', () => {
  beforeEach(() => {
    (HTMLElement.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = () => {};
  });

  it('is closed by default', () => {
    const { menu } = setup();
    expect(menu.isOpen()).toBe(false);
  });

  it('open() shows the panel, grows the composer, and renders action items', async () => {
    const { menu, composer } = setup();
    menu.open();
    await Promise.resolve();
    expect(menu.isOpen()).toBe(true);
    expect(composer.classList.contains('composer--add-open')).toBe(true);
    const actions = document.querySelectorAll('.add-menu__action');
    expect(actions.length).toBe(3);
    expect(document.querySelector('.add-menu__search')).not.toBeNull();
  });

  it('close() hides the panel and ungrows', () => {
    const { menu, composer } = setup();
    menu.open();
    menu.close();
    expect(menu.isOpen()).toBe(false);
    expect(composer.classList.contains('composer--add-open')).toBe(false);
  });

  it('Escape closes', () => {
    const { menu } = setup();
    menu.open();
    const consumed = menu.handleKey(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(consumed).toBe(true);
    expect(menu.isOpen()).toBe(false);
  });

  it('clicking the photo action invokes capturePhoto', async () => {
    const { menu, capturePhoto } = setup();
    menu.open();
    await Promise.resolve();
    const photo = Array.from(document.querySelectorAll<HTMLElement>('.add-menu__action')).find(
      (el) => /photo/i.test(el.textContent ?? '')
    );
    photo?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(capturePhoto).toHaveBeenCalled();
  });
});
