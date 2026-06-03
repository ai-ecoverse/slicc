// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SlashCommandPicker } from '../../src/ui/slash-command-picker.js';

describe('SlashCommandPicker', () => {
  let anchor: HTMLTextAreaElement;
  let onAccept: ReturnType<typeof vi.fn>;
  let onDismiss: ReturnType<typeof vi.fn>;
  let picker: SlashCommandPicker;

  beforeEach(() => {
    document.body.innerHTML = '';
    anchor = document.createElement('textarea');
    document.body.appendChild(anchor);
    onAccept = vi.fn();
    onDismiss = vi.fn();
    picker = new SlashCommandPicker({ anchor, onAccept, onDismiss });
  });

  it('is hidden by default', () => {
    expect(picker.isVisible()).toBe(false);
  });

  it('show() renders the given items', () => {
    picker.show([
      { name: 'clear', description: 'Clear chat', kind: 'action' },
      { name: 'new', description: 'New session', kind: 'action' },
    ]);
    expect(picker.isVisible()).toBe(true);
    const items = document.querySelectorAll('.slash-picker__item');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('clear');
    expect(items[1].textContent).toContain('new');
  });

  it('first item is highlighted by default', () => {
    picker.show([
      { name: 'a', kind: 'action' },
      { name: 'b', kind: 'action' },
    ]);
    const items = document.querySelectorAll('.slash-picker__item');
    expect(items[0].classList.contains('slash-picker__item--active')).toBe(true);
    expect(items[1].classList.contains('slash-picker__item--active')).toBe(false);
  });

  it('ArrowDown moves highlight, ArrowUp moves back, wrapping at edges', () => {
    picker.show([
      { name: 'a', kind: 'action' },
      { name: 'b', kind: 'action' },
      { name: 'c', kind: 'action' },
    ]);
    picker.handleKey(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(
      document
        .querySelectorAll('.slash-picker__item')[1]
        .classList.contains('slash-picker__item--active')
    ).toBe(true);
    picker.handleKey(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    picker.handleKey(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(
      document
        .querySelectorAll('.slash-picker__item')[0]
        .classList.contains('slash-picker__item--active')
    ).toBe(true);
    picker.handleKey(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    expect(
      document
        .querySelectorAll('.slash-picker__item')[2]
        .classList.contains('slash-picker__item--active')
    ).toBe(true);
  });

  it('Enter accepts the highlighted item', () => {
    picker.show([{ name: 'clear', kind: 'action' }]);
    const consumed = picker.handleKey(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(consumed).toBe(true);
    expect(onAccept).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'clear', kind: 'action' })
    );
  });

  it('Tab accepts the highlighted item', () => {
    picker.show([{ name: 'skill', kind: 'skill' }]);
    const consumed = picker.handleKey(new KeyboardEvent('keydown', { key: 'Tab' }));
    expect(consumed).toBe(true);
    expect(onAccept).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'skill', kind: 'skill' })
    );
  });

  it('Escape dismisses', () => {
    picker.show([{ name: 'a', kind: 'action' }]);
    const consumed = picker.handleKey(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(consumed).toBe(true);
    expect(onDismiss).toHaveBeenCalled();
    expect(picker.isVisible()).toBe(false);
  });

  it('returns false from handleKey when not visible', () => {
    expect(picker.handleKey(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(false);
  });

  it('returns false from handleKey for non-navigation keys', () => {
    picker.show([{ name: 'a', kind: 'action' }]);
    expect(picker.handleKey(new KeyboardEvent('keydown', { key: 'a' }))).toBe(false);
  });

  it('hide() removes the picker from the DOM', () => {
    picker.show([{ name: 'a', kind: 'action' }]);
    picker.hide();
    expect(picker.isVisible()).toBe(false);
    expect((document.querySelector('.slash-picker') as HTMLElement).style.display).toBe('none');
  });

  it('show() with empty list calls onDismiss and stays hidden', () => {
    picker.show([]);
    expect(picker.isVisible()).toBe(false);
    expect(onDismiss).toHaveBeenCalled();
  });

  it('clicking an item accepts it', () => {
    picker.show([
      { name: 'a', kind: 'action' },
      { name: 'b', kind: 'skill' },
    ]);
    const items = document.querySelectorAll<HTMLElement>('.slash-picker__item');
    items[1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(onAccept).toHaveBeenCalledWith(expect.objectContaining({ name: 'b', kind: 'skill' }));
  });

  it('skill items render a kind hint span', () => {
    picker.show([
      { name: 'sprinkles', kind: 'skill' },
      { name: 'clear', kind: 'action' },
    ]);
    const items = document.querySelectorAll('.slash-picker__item');
    expect(items[0].querySelector('.slash-picker__kind')).not.toBeNull();
    expect(items[0].querySelector('.slash-picker__kind')?.textContent).toBe('skill');
    expect(items[1].querySelector('.slash-picker__kind')).toBeNull();
  });

  it('submenu items render without a kind hint span', () => {
    picker.show([{ name: 'skills', kind: 'submenu', description: 'Reference an installed skill' }]);
    const items = document.querySelectorAll('.slash-picker__item');
    expect(items).toHaveLength(1);
    expect(items[0].querySelector('.slash-picker__kind')).toBeNull();
    expect(items[0].textContent).toContain('/skills');
  });

  it('item labels render as /name', () => {
    picker.show([{ name: 'settings', kind: 'action' }]);
    const label = document.querySelector('.slash-picker__label');
    expect(label?.textContent).toBe('/settings');
  });
});
