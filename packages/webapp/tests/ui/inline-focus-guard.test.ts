import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it } from 'vitest';
import { FOCUS_GESTURE_WINDOW_MS, guardInlineFocus } from '../../src/ui/inline-focus-guard.js';

describe('guardInlineFocus', () => {
  let doc: Document;
  let win: Window & typeof globalThis;
  let composer: HTMLTextAreaElement;
  let scope: HTMLElement;
  let field: HTMLInputElement;
  let other: HTMLInputElement;
  let clock: number;
  let release: () => void;

  beforeEach(() => {
    const dom = new JSDOM(
      '<!doctype html><html><body><textarea id="composer">hello world</textarea>' +
        '<div id="sprinkle"><input id="field"><input id="other"></div></body></html>',
      { url: 'http://localhost' }
    );
    win = dom.window as unknown as Window & typeof globalThis;
    doc = win.document;
    composer = doc.getElementById('composer') as HTMLTextAreaElement;
    scope = doc.getElementById('sprinkle')!;
    field = doc.getElementById('field') as HTMLInputElement;
    other = doc.getElementById('other') as HTMLInputElement;
    clock = 10_000;
    composer.focus();
    composer.setSelectionRange(5, 5);
    release = guardInlineFocus(scope, () => clock);
  });

  it('hands a programmatic focus steal back to the composer, caret intact', () => {
    field.focus();
    expect(doc.activeElement).toBe(composer);
    expect(composer.selectionStart).toBe(5);
  });

  it('keeps outer focusin listeners from seeing the undone steal', () => {
    const seen: EventTarget[] = [];
    doc.addEventListener('focusin', (e) => {
      if (e.target) seen.push(e.target);
    });
    field.focus();
    expect(seen).not.toContain(field);
  });

  it('drops the steal when nothing held the focus before', () => {
    composer.blur();
    field.focus();
    expect(doc.activeElement).toBe(doc.body);
  });

  it('lets a pointer press inside the sprinkle focus its field', () => {
    field.dispatchEvent(new win.Event('pointerdown', { bubbles: true }));
    field.focus();
    expect(doc.activeElement).toBe(field);
  });

  it('closes the door again once the gesture window has passed', () => {
    field.dispatchEvent(new win.Event('pointerdown', { bubbles: true }));
    clock += FOCUS_GESTURE_WINDOW_MS + 1;
    field.focus();
    expect(doc.activeElement).toBe(composer);
  });

  it('lets Tab navigate into the sprinkle', () => {
    composer.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    field.focus();
    expect(doc.activeElement).toBe(field);
  });

  it('ignores ordinary typing in the composer as a gesture', () => {
    composer.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    field.focus();
    expect(doc.activeElement).toBe(composer);
  });

  it('lets the sprinkle move focus between its own fields once it holds it', () => {
    field.dispatchEvent(new win.Event('pointerdown', { bubbles: true }));
    field.focus();
    clock += FOCUS_GESTURE_WINDOW_MS * 10;
    other.focus();
    expect(doc.activeElement).toBe(other);
  });

  it('restores to the latest outside holder, not the one at install time', () => {
    const later = doc.createElement('input');
    doc.body.appendChild(later);
    later.focus();
    field.focus();
    expect(doc.activeElement).toBe(later);
  });

  it('stops guarding once released', () => {
    release();
    field.focus();
    expect(doc.activeElement).toBe(field);
  });
});
