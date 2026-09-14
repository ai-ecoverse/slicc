import { beforeEach, describe, expect, it } from 'vitest';
import { type FollowerHudRow, SliccFollowerHud } from '../../src/primitives/slicc-follower-hud.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

function rows(): FollowerHudRow[] {
  return [
    {
      id: 'follower-cli1',
      icon: 'terminal',
      title: 'CLI · build-box',
      detail: 'lars@build-box · darwin/arm64',
      state: 'active',
      stateText: 'connected 2h',
      chips: ['can run commands'],
    },
    {
      id: 'follower-ios1',
      icon: 'smartphone',
      title: 'iOS · phone1',
      state: 'warn',
      stateText: 'stalled 12m',
    },
  ];
}

function mount(configure?: (el: SliccFollowerHud) => void): SliccFollowerHud {
  const el = document.createElement('slicc-follower-hud');
  configure?.(el);
  document.body.appendChild(el);
  return el;
}

describe('slicc-follower-hud', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-follower-hud')).toBe(SliccFollowerHud);
  });

  describe('visibility', () => {
    it('hides the card until `open` is set', () => {
      const el = mount((node) => {
        node.rows = rows();
      });
      const card = el.shadowRoot?.querySelector('.card') as HTMLElement;
      expect(getComputedStyle(card).display).toBe('none');
      el.open = true;
      expect(getComputedStyle(el.shadowRoot?.querySelector('.card') as HTMLElement).display).toBe(
        'flex'
      );
    });

    it('reflects `open` between attribute and property', () => {
      const el = mount();
      expect(el.open).toBe(false);
      el.open = true;
      expect(el.hasAttribute('open')).toBe(true);
      el.removeAttribute('open');
      expect(el.open).toBe(false);
    });

    it('ignores pointer events while closed so it cannot swallow clicks', () => {
      const el = mount((node) => {
        node.rows = rows();
      });
      expect(getComputedStyle(el).pointerEvents).toBe('none');
      el.open = true;
      expect(getComputedStyle(el).pointerEvents).toBe('auto');
    });
  });

  describe('rows', () => {
    it('renders one row per follower with title, detail, state and chips', () => {
      const el = mount((node) => {
        node.rows = rows();
        node.open = true;
      });
      const rendered = el.shadowRoot?.querySelectorAll('.row');
      expect(rendered).toHaveLength(2);
      expect(el.shadowRoot?.textContent).toContain('CLI · build-box');
      expect(el.shadowRoot?.textContent).toContain('lars@build-box · darwin/arm64');
      expect(el.shadowRoot?.textContent).toContain('can run commands');
      expect(el.shadowRoot?.textContent).toContain('stalled 12m');
    });

    it('renders an icon per row', () => {
      const el = mount((node) => {
        node.rows = rows();
        node.open = true;
      });
      expect(el.shadowRoot?.querySelectorAll('.row svg')).toHaveLength(2);
    });

    it('colours the state dot by state', () => {
      const el = mount((node) => {
        node.rows = rows();
        node.open = true;
      });
      const dots = Array.from(el.shadowRoot?.querySelectorAll('.sdot') ?? []);
      expect(dots.map((dot) => dot.getAttribute('data-state'))).toEqual(['active', 'warn']);
      expect(getComputedStyle(dots[0]).backgroundColor).not.toBe(
        getComputedStyle(dots[1]).backgroundColor
      );
    });

    it('titles the section with a count that agrees in number', () => {
      const el = mount((node) => {
        node.rows = [rows()[0]];
        node.open = true;
      });
      expect(el.shadowRoot?.querySelector('.section-title')?.textContent).toBe('1 follower');
      el.rows = rows();
      expect(el.shadowRoot?.querySelector('.section-title')?.textContent).toBe('2 followers');
    });

    it('re-renders when rows are replaced', () => {
      const el = mount((node) => {
        node.rows = rows();
        node.open = true;
      });
      el.rows = [];
      expect(el.shadowRoot?.querySelectorAll('.row')).toHaveLength(0);
      expect(el.shadowRoot?.textContent).toContain('No followers connected.');
    });

    it('omits the detail line and chip row when the row carries neither', () => {
      const el = mount((node) => {
        node.rows = [rows()[1]];
        node.open = true;
      });
      expect(el.shadowRoot?.querySelector('.row-detail')).toBeNull();
      expect(el.shadowRoot?.querySelector('.chips')).toBeNull();
    });
  });

  describe('hint', () => {
    it('renders a footer hint only when set to a non-blank string', () => {
      const el = mount((node) => {
        node.rows = rows();
        node.open = true;
      });
      expect(el.shadowRoot?.querySelector('.hint')).toBeNull();
      el.hint = 'Click for sharing options.';
      expect(el.shadowRoot?.querySelector('.hint')?.textContent).toBe('Click for sharing options.');
      el.hint = '   ';
      expect(el.shadowRoot?.querySelector('.hint')).toBeNull();
    });
  });
});
