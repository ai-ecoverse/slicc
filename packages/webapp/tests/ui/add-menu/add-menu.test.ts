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
  const onClose = vi.fn();
  const captureScreenshot = vi.fn(async () => null);
  const requestUpload = vi.fn();
  const aggregator = { search: vi.fn(async () => items) };
  const menu = new AddMenu({
    composer,
    toggleButton: toggle,
    aggregator,
    onAttachFiles,
    onAddReference,
    captureScreenshot,
    requestUpload,
    onClose,
  });
  return {
    menu,
    composer,
    toggle,
    onAttachFiles,
    onAddReference,
    onClose,
    captureScreenshot,
    requestUpload,
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
    expect(actions.length).toBe(2);
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

  it('clicking the screenshot action invokes captureScreenshot', async () => {
    const { menu, captureScreenshot } = setup();
    menu.open();
    await Promise.resolve();
    const screenshot = Array.from(document.querySelectorAll<HTMLElement>('.add-menu__action')).find(
      (el) => /screenshot/i.test(el.textContent ?? '')
    );
    screenshot?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(captureScreenshot).toHaveBeenCalled();
  });

  it('fires onClose when closed via close() and Escape', () => {
    const { menu, onClose } = setup();
    menu.open();
    menu.close();
    expect(onClose).toHaveBeenCalledTimes(1);
    menu.open();
    menu.handleKey(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('mousedown outside the panel closes the menu and fires onClose', () => {
    const { menu, onClose } = setup();
    menu.open();
    expect(menu.isOpen()).toBe(true);
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(menu.isOpen()).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('mousedown inside the panel does NOT close the menu', () => {
    const { menu } = setup();
    menu.open();
    const panel = document.querySelector('.add-menu') as HTMLElement;
    panel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(menu.isOpen()).toBe(true);
  });

  it('mousedown on the toggle button does NOT close the menu', () => {
    const { menu, toggle } = setup();
    menu.open();
    toggle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(menu.isOpen()).toBe(true);
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

describe('AddMenu action keyboard navigation', () => {
  beforeEach(() => {
    (HTMLElement.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = () => {};
  });

  it('ArrowDown selects the first action', () => {
    const { menu } = setup();
    menu.open();
    menu.handleKey(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    const actions = Array.from(document.querySelectorAll('.add-menu__action'));
    expect(actions[0].classList.contains('add-menu__action--active')).toBe(true);
    expect(actions[1].classList.contains('add-menu__action--active')).toBe(false);
  });

  it('ArrowDown twice selects the second action', () => {
    const { menu } = setup();
    menu.open();
    menu.handleKey(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    menu.handleKey(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    const actions = Array.from(document.querySelectorAll('.add-menu__action'));
    expect(actions[0].classList.contains('add-menu__action--active')).toBe(false);
    expect(actions[1].classList.contains('add-menu__action--active')).toBe(true);
  });

  it('ArrowUp from nothing selects the last action', () => {
    const { menu } = setup();
    menu.open();
    menu.handleKey(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    const actions = Array.from(document.querySelectorAll('.add-menu__action'));
    expect(actions[actions.length - 1].classList.contains('add-menu__action--active')).toBe(true);
  });

  it('ArrowDown wraps from last action back to first', () => {
    const { menu } = setup();
    menu.open();
    // Two actions: Down → [0], Down → [1], Down → wraps to [0]
    menu.handleKey(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    menu.handleKey(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    menu.handleKey(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    const actions = Array.from(document.querySelectorAll('.add-menu__action'));
    expect(actions[0].classList.contains('add-menu__action--active')).toBe(true);
  });

  it('Enter triggers the highlighted action and closes the menu', () => {
    const { menu, captureScreenshot } = setup();
    menu.open();
    // ArrowDown → [0] Upload, ArrowDown → [1] Screenshot
    menu.handleKey(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    menu.handleKey(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    menu.handleKey(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(captureScreenshot).toHaveBeenCalled();
  });

  it('Enter on the Upload action invokes requestUpload', () => {
    const { menu, requestUpload } = setup();
    menu.open();
    menu.handleKey(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    menu.handleKey(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(requestUpload).toHaveBeenCalled();
  });

  it('Enter with no action highlighted does not consume the event', () => {
    const { menu } = setup();
    menu.open();
    // No ArrowDown pressed — nothing highlighted
    const consumed = menu.handleKey(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(consumed).toBe(false);
  });

  it('action highlight is cleared when the menu closes', () => {
    const { menu } = setup();
    menu.open();
    menu.handleKey(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    menu.close();
    menu.open();
    // Highlight should be reset: no active class on any action
    const active = document.querySelectorAll('.add-menu__action--active');
    expect(active.length).toBe(0);
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

  it('routes ArrowDown + Enter from the focused search input to result selection', async () => {
    const { menu, onAddReference } = setup(items);
    menu.open();
    const input = document.querySelector<HTMLInputElement>('.add-menu__search')!;
    input.value = 's';
    input.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 150));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onAddReference).toHaveBeenCalledWith(items[1]);
    expect(menu.isOpen()).toBe(false);
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

  it('ArrowDown/Up do not consume the keypress in the empty-results state', async () => {
    const { menu } = setup([]);
    menu.open();
    const input = document.querySelector<HTMLInputElement>('.add-menu__search')!;
    input.value = 'zzz';
    input.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 150));
    // Both arrays empty — navigateResults should return false so callers know
    // not to preventDefault on Arrow keys.
    expect(menu.handleKey(new KeyboardEvent('keydown', { key: 'ArrowDown' }))).toBe(false);
    expect(menu.handleKey(new KeyboardEvent('keydown', { key: 'ArrowUp' }))).toBe(false);
  });
});
