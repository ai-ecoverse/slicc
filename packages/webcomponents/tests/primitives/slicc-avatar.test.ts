import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SliccAvatar } from '../../src/primitives/slicc-avatar.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

function mount(setup?: (el: SliccAvatar) => void): SliccAvatar {
  const el = document.createElement('slicc-avatar');
  setup?.(el);
  document.body.appendChild(el);
  return el;
}

describe('slicc-avatar', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-avatar')).toBe(SliccAvatar);
  });

  it('renders the circular avatar container in its shadow root', () => {
    const el = mount((e) => {
      e.initials = 'PM';
    });
    const avatar = el.shadowRoot?.querySelector('[part="avatar"]');
    expect(avatar).not.toBeNull();
    expect(avatar?.classList.contains('me')).toBe(true);
  });

  it('reflects the initials attribute to/from the property', () => {
    const el = mount((e) => {
      e.initials = 'PM';
    });
    expect(el.getAttribute('initials')).toBe('PM');
    el.setAttribute('initials', 'XY');
    expect(el.initials).toBe('XY');
  });

  it('reflects name, src, size, and label attributes to properties', () => {
    const el = mount((e) => {
      e.name = 'Pat Mercury';
      e.src = 'https://example.test/a.png';
      e.size = '48px';
      e.label = 'Account';
    });
    expect(el.getAttribute('name')).toBe('Pat Mercury');
    expect(el.getAttribute('src')).toBe('https://example.test/a.png');
    expect(el.getAttribute('size')).toBe('48px');
    expect(el.getAttribute('label')).toBe('Account');
    el.name = null;
    expect(el.hasAttribute('name')).toBe(false);
  });

  it('VARIANT initials: shows explicit initials uppercased and capped at 2 chars', () => {
    const el = mount((e) => {
      e.initials = 'pm';
    });
    const ini = el.shadowRoot?.querySelector('[part="initials"]');
    expect(ini?.textContent).toBe('PM');
    expect(el.resolvedInitials).toBe('PM');
  });

  it('VARIANT derived initials: builds from first + last word of name', () => {
    const el = mount((e) => {
      e.name = 'Pat Mercury';
    });
    expect(el.resolvedInitials).toBe('PM');
    expect(el.shadowRoot?.querySelector('[part="initials"]')?.textContent).toBe('PM');
  });

  it('VARIANT derived initials: single-word name yields first two letters', () => {
    const el = mount((e) => {
      e.name = 'sliccy';
    });
    expect(el.resolvedInitials).toBe('SL');
  });

  it('explicit initials win over name', () => {
    const el = mount((e) => {
      e.name = 'Pat Mercury';
      e.initials = 'ZZ';
    });
    expect(el.resolvedInitials).toBe('ZZ');
  });

  it('VARIANT image-backed: renders a cover image instead of initials', () => {
    const el = mount((e) => {
      e.name = 'Pat Mercury';
      e.src = 'https://example.test/a.png';
    });
    const img = el.shadowRoot?.querySelector('[part="image"]') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe('https://example.test/a.png');
    expect(el.shadowRoot?.querySelector('[part="initials"]')).toBeNull();
  });

  it('escapes interpolated text (src + label)', () => {
    const el = mount((e) => {
      e.label = '<img src=x onerror=alert(1)>';
      e.initials = 'PM';
    });
    expect(el.shadowRoot?.querySelector('img[onerror]')).toBeNull();
    expect(el.getAttribute('aria-label')).toBe('<img src=x onerror=alert(1)>');
  });

  it('BEHAVIOR: emits a composed, bubbling slicc-avatar-click on click', () => {
    const el = mount((e) => {
      e.initials = 'PM';
    });
    const handler = vi.fn();
    document.addEventListener('slicc-avatar-click', handler);
    const seen = vi.fn();
    el.addEventListener('slicc-avatar-click', (ev) => {
      seen();
      expect(ev.bubbles).toBe(true);
      expect(ev.composed).toBe(true);
    });
    el.click();
    expect(seen).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1); // bubbled to document
    document.removeEventListener('slicc-avatar-click', handler);
  });

  it('BEHAVIOR: Enter and Space activate the avatar', () => {
    const el = mount((e) => {
      e.initials = 'PM';
    });
    const handler = vi.fn();
    el.addEventListener('slicc-avatar-click', handler);
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('exposes a button role and is focusable', () => {
    const el = mount((e) => {
      e.initials = 'PM';
    });
    expect(el.getAttribute('role')).toBe('button');
    expect(el.getAttribute('tabindex')).toBe('0');
  });

  it('APPEARANCE: renders a circular rainbow-gradient square at --ctl-h with white text', () => {
    const el = mount((e) => {
      e.initials = 'PM';
    });
    const cs = getComputedStyle(el);
    // --ctl-h default is 30px
    expect(cs.width).toBe('30px');
    expect(cs.height).toBe('30px');
    // radius 9999px resolves to a fully rounded shape
    expect(cs.borderTopLeftRadius).toBe('9999px');
    // rainbow gradient is a background image
    expect(cs.backgroundImage).toContain('gradient');
    // fixed white initials, weight 600, 11px
    expect(cs.color).toBe('rgb(255, 255, 255)');
    expect(cs.fontWeight).toBe('600');
    expect(cs.fontSize).toBe('11px');
  });

  it('APPEARANCE: white text + rainbow gradient are fixed in dark mode', () => {
    document.body.classList.add('dark');
    try {
      const el = mount((e) => {
        e.initials = 'PM';
      });
      const cs = getComputedStyle(el);
      expect(cs.color).toBe('rgb(255, 255, 255)');
      expect(cs.backgroundImage).toContain('gradient');
    } finally {
      document.body.classList.remove('dark');
    }
  });

  it('SIZE variant: the size attribute overrides the --ctl-h square', () => {
    const el = mount((e) => {
      e.initials = 'PM';
      e.size = '48px';
    });
    const cs = getComputedStyle(el);
    expect(cs.width).toBe('48px');
    expect(cs.height).toBe('48px');
    el.size = null;
    expect(getComputedStyle(el).width).toBe('30px');
  });
});
