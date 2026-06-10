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

  it('dispose() removes composer drag-drop listeners', () => {
    const { menu, composer, onAttachFiles } = setup();
    menu.open();
    menu.dispose();
    const evt = new Event('drop', { bubbles: true, cancelable: true }) as unknown as DragEvent;
    Object.defineProperty(evt, 'dataTransfer', {
      value: { files: [new File(['x'], 'x.txt')] },
      configurable: true,
    });
    composer.dispatchEvent(evt);
    expect(onAttachFiles).not.toHaveBeenCalled();
  });
});

describe('AddMenu results', () => {
  beforeEach(() => {
    (HTMLElement.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = () => {};
  });

  const items: AddItem[] = [
    { kind: 'file', label: 'README.md', locator: '/workspace/README.md' },
    { kind: 'skill', label: 'sprinkles', locator: 'sprinkles' },
  ];

  it('typing shows results from the aggregator; picking calls onAddReference and closes', async () => {
    const { menu, onAddReference } = setup(items);
    menu.open();
    const input = document.querySelector<HTMLInputElement>('.add-menu__search')!;
    input.value = 'r';
    input.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 150));
    const rows = document.querySelectorAll('.add-menu__item');
    expect(rows.length).toBe(2);
    (rows[0] as HTMLElement).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(onAddReference).toHaveBeenCalledWith(items[0]);
    expect(menu.isOpen()).toBe(false);
  });

  it('ArrowDown + Enter picks the highlighted result', async () => {
    const { menu, onAddReference } = setup(items);
    menu.open();
    const input = document.querySelector<HTMLInputElement>('.add-menu__search')!;
    input.value = 's';
    input.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 150));
    menu.handleKey(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    menu.handleKey(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(onAddReference).toHaveBeenCalledWith(items[1]);
  });

  it('shows a no-matches note for an empty result set', async () => {
    const { menu } = setup([]);
    menu.open();
    const input = document.querySelector<HTMLInputElement>('.add-menu__search')!;
    input.value = 'zzz';
    input.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 150));
    expect(document.querySelector('.add-menu__empty')?.textContent).toContain('No matches');
  });
});
