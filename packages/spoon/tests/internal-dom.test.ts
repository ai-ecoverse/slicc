// The innerHTML-free DOM builder + the guarded custom-element registration.
// Both are tiny, but they are the two pieces every component in this package
// (and therefore every runtime that embeds the overlay IIFE) is built on: `h()`
// is the reason there is no HTML-injection surface, and `define()` is the
// reason importing the barrel twice — or in a registry-less MV3 ISOLATED world
// — doesn't throw.

import { describe, expect, it } from 'vitest';
import { define } from '../src/internal/define.js';
import { append, frag, h, sheet } from '../src/internal/dom.js';

describe('internal/dom h()', () => {
  it('builds an element with no props at all', () => {
    const el = h('div');
    expect(el.tagName).toBe('DIV');
    expect(el.attributes.length).toBe(0);
    expect(el.childNodes.length).toBe(0);
    // An explicit null props slot behaves the same as omitting it.
    expect(h('span', null).attributes.length).toBe(0);
  });

  it('maps class/part/style and stringifies numeric attribute values', () => {
    const el = h('div', { class: 'a b', part: 'thing', style: 'color: red', tabindex: -1 });
    expect(el.className).toBe('a b');
    expect(el.getAttribute('part')).toBe('thing');
    expect(el.style.color).toBe('red');
    expect(el.getAttribute('tabindex')).toBe('-1');
  });

  it('renders `true` as a bare boolean attribute and drops false/null/undefined', () => {
    const el = h('input', { hidden: true, disabled: false, title: null, lang: undefined });
    expect(el.getAttribute('hidden')).toBe('');
    expect(el.hasAttribute('disabled')).toBe(false);
    expect(el.hasAttribute('title')).toBe(false);
    expect(el.hasAttribute('lang')).toBe(false);
  });

  it('escapes string children instead of parsing them as markup', () => {
    const el = h('div', null, '<img src=x onerror=alert(1)>');
    expect(el.childNodes.length).toBe(1);
    expect(el.childNodes[0]?.nodeType).toBe(Node.TEXT_NODE);
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('accepts nodes, numbers, and skips null/undefined/false children', () => {
    const child = h('b', null, 'bold');
    const el = h('div', null, child, 0, null, undefined, false, 'tail');
    expect(el.childNodes.length).toBe(3);
    expect(el.firstChild).toBe(child);
    expect(el.textContent).toBe('bold0tail');
  });
});

describe('internal/dom frag() + append()', () => {
  it('collects children into a document fragment', () => {
    const f = frag('a', 1, null, h('i', null, 'x'), false, undefined);
    expect(f.nodeType).toBe(Node.DOCUMENT_FRAGMENT_NODE);
    expect(f.childNodes.length).toBe(3);
    expect(f.textContent).toBe('a1x');
    // Appending the fragment moves its children into the host.
    const host = document.createElement('div');
    host.appendChild(f);
    expect(host.childNodes.length).toBe(3);
    expect(f.childNodes.length).toBe(0);
  });

  it('appends onto an existing parent node', () => {
    const parent = h('ul');
    append(parent, ['one', null, h('li', null, 'two')]);
    expect(parent.childNodes.length).toBe(2);
    expect(parent.textContent).toBe('onetwo');
  });

  it('appending an empty list is a no-op', () => {
    const parent = h('ul', null, 'kept');
    append(parent, []);
    expect(parent.childNodes.length).toBe(1);
  });
});

describe('internal/dom sheet()', () => {
  it('returns a constructable stylesheet that a shadow root can adopt', () => {
    const s = sheet(':host { color: rgb(1, 2, 3); }');
    expect(s).toBeInstanceOf(CSSStyleSheet);
    expect(s.cssRules.length).toBe(1);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = [s];
    root.appendChild(h('span', null, 'x'));
    expect(getComputedStyle(host).color).toBe('rgb(1, 2, 3)');
    expect(root.querySelector('style')).toBeNull();
    host.remove();
  });
});

describe('internal/define', () => {
  it('registers an element once and ignores repeat definitions', () => {
    const tag = 'spoon-define-once';
    class First extends HTMLElement {}
    class Second extends HTMLElement {}
    define(tag, First);
    // A second call with a *different* constructor must not throw the
    // "this name has already been used" DOMException.
    expect(() => {
      define(tag, Second);
    }).not.toThrow();
    expect(customElements.get(tag)).toBe(First);
  });

  it.each([
    ['null (MV3 ISOLATED world)', null],
    ['undefined (no registry at all)', undefined],
  ])('no-ops in a registry-less world: %s', (label, registry) => {
    const tag = `spoon-define-registryless-${label.startsWith('null') ? 'null' : 'undef'}`;
    const original = Object.getOwnPropertyDescriptor(window, 'customElements');
    Object.defineProperty(window, 'customElements', {
      configurable: true,
      get: () => registry,
    });
    try {
      expect(() => {
        define(tag, class extends HTMLElement {});
      }).not.toThrow();
    } finally {
      if (original) Object.defineProperty(window, 'customElements', original);
    }
    // The real registry is untouched: the element was never defined.
    expect(customElements.get(tag)).toBeUndefined();
  });
});
