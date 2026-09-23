import { beforeEach, describe, expect, it } from 'vitest';
import { deepFocus, isTypable, typingElement } from '../../src/internal/typing-focus.js';

function input(type: string, readOnly = false): HTMLInputElement {
  const el = document.createElement('input');
  el.type = type;
  el.readOnly = readOnly;
  return el;
}

describe('typing-focus', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('isTypable: text fields, textareas and contenteditable — nothing else', () => {
    expect(isTypable(null)).toBe(false);
    expect(isTypable(input('text'))).toBe(true);
    expect(isTypable(input('password'))).toBe(true);
    expect(isTypable(input('search'))).toBe(true);
    expect(isTypable(input('text', true))).toBe(false);
    for (const type of ['button', 'checkbox', 'radio', 'submit', 'range', 'file']) {
      expect(isTypable(input(type))).toBe(false);
    }
    const textarea = document.createElement('textarea');
    expect(isTypable(textarea)).toBe(true);
    textarea.readOnly = true;
    expect(isTypable(textarea)).toBe(false);
    expect(isTypable(document.createElement('button'))).toBe(false);
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    const child = document.createElement('span');
    editable.append(child);
    document.body.append(editable);
    expect(isTypable(editable)).toBe(true);
    expect(isTypable(child)).toBe(true);
  });

  it('typingElement pierces shadow roots', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const textarea = document.createElement('textarea');
    host.attachShadow({ mode: 'open' }).append(textarea);
    expect(typingElement(document)).toBeNull();
    textarea.focus();
    expect(document.activeElement).toBe(host);
    expect(deepFocus(document)).toBe(textarea);
    expect(typingElement(document)).toBe(textarea);
    textarea.blur();
    const button = document.createElement('button');
    document.body.append(button);
    button.focus();
    expect(typingElement(document)).toBeNull();
  });

  it('typingElement pierces a same-origin frame', async () => {
    const frame = document.createElement('iframe');
    frame.srcdoc = '<input id="f"><button id="b">b</button>';
    const loaded = new Promise((r) => frame.addEventListener('load', r, { once: true }));
    document.body.append(frame);
    await loaded;
    const inner = frame.contentDocument as Document;
    (inner.getElementById('f') as HTMLInputElement).focus();
    expect(document.activeElement).toBe(frame);
    expect(typingElement(document)).toBe(inner.getElementById('f'));
    (inner.getElementById('b') as HTMLButtonElement).focus();
    expect(typingElement(document)).toBeNull();
  });

  it('counts a focused frame it cannot read into as typing', () => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    // Stand-in for a cross-origin frame: reading its document throws.
    Object.defineProperty(frame, 'contentDocument', {
      get: () => {
        throw new DOMException('Blocked', 'SecurityError');
      },
    });
    const doc = { activeElement: frame } as unknown as Document;
    expect(typingElement(doc)).toBe(frame);
  });
});
