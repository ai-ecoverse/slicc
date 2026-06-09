import { beforeEach, describe, expect, it } from 'vitest';
import { SliccActionCard } from '../../src/chat/slicc-action-card.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

function mount(setup?: (el: SliccActionCard) => void): SliccActionCard {
  const el = document.createElement('slicc-action-card') as SliccActionCard;
  setup?.(el);
  document.body.appendChild(el);
  return el;
}

const card = (el: SliccActionCard) => el.querySelector('[part="card"]') as HTMLElement;
const body = (el: SliccActionCard) => el.querySelector('.tb') as HTMLElement;

describe('slicc-action-card', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-action-card')).toBe(SliccActionCard);
  });

  it('renders into light DOM (no shadow root) with the scoped host class', () => {
    const el = mount();
    expect(el.shadowRoot).toBeNull();
    expect(el.classList.contains('slicc-action-card')).toBe(true);
    expect(card(el)).not.toBeNull();
  });

  describe('attribute ↔ property reflection', () => {
    it('reflects variant (default tool) and normalizes bogus values', () => {
      const el = mount();
      expect(el.variant).toBe('tool');
      el.variant = 'pr';
      expect(el.getAttribute('variant')).toBe('pr');
      expect(el.variant).toBe('pr');
      el.setAttribute('variant', 'bogus');
      expect(el.variant).toBe('tool');
    });

    it('reflects tone (default ink) and normalizes bogus values', () => {
      const el = mount();
      expect(el.tone).toBe('ink');
      el.tone = 'cy';
      expect(el.getAttribute('tone')).toBe('cy');
      expect(el.tone).toBe('cy');
      el.setAttribute('tone', 'bogus');
      expect(el.tone).toBe('ink');
    });

    it('reflects glyph / title / badge', () => {
      const el = mount((e) => {
        e.glyph = '⚡';
        e.title = 'bash';
        e.badge = 'done';
      });
      expect(el.getAttribute('glyph')).toBe('⚡');
      expect(el.getAttribute('title')).toBe('bash');
      expect(el.getAttribute('badge')).toBe('done');
      el.badge = null;
      expect(el.hasAttribute('badge')).toBe(false);
    });

    it('reflects every PR field property ↔ attribute', () => {
      const el = mount((e) => {
        e.variant = 'pr';
        e.number = '#128';
        e.status = 'Open';
        e.branch = 'warm-hero → main';
        e.files = '2';
        e.add = '38';
        e.del = '21';
        e.checks = '✓ passing';
      });
      expect(el.getAttribute('number')).toBe('#128');
      expect(el.add).toBe('38');
      expect(el.del).toBe('21');
      expect(el.checks).toBe('✓ passing');
      el.add = null;
      expect(el.hasAttribute('add')).toBe(false);
    });
  });

  describe('tool variant (.tcard)', () => {
    it('renders the .tcard scaffold with header parts and a terminal body', () => {
      const el = mount((e) => {
        e.glyph = '⚡';
        e.title = 'bash · run tests';
      });
      expect(card(el).classList.contains('tcard')).toBe(true);
      expect(card(el).classList.contains('light')).toBe(false);
      expect((el.querySelector('[part="icon"]') as HTMLElement).textContent).toBe('⚡');
      expect((el.querySelector('[part="title"]') as HTMLElement).textContent).toBe(
        'bash · run tests'
      );
      expect(body(el)).not.toBeNull();
    });

    it('applies the icon tone class (ink → no class, cy/vi/am/gh → class)', () => {
      const ink = mount();
      expect((ink.querySelector('.ic') as HTMLElement).className).toBe('ic');
      for (const tone of ['cy', 'vi', 'am', 'gh'] as const) {
        const el = mount((e) => {
          e.tone = tone;
        });
        expect((el.querySelector('.ic') as HTMLElement).classList.contains(tone)).toBe(true);
      }
    });

    it('omits the badge by default and renders it when set', () => {
      const plain = mount();
      expect(plain.querySelector('.badge')).toBeNull();
      const badged = mount((e) => {
        e.badge = 'warm-hero';
      });
      expect((badged.querySelector('[part="badge"]') as HTMLElement).textContent).toBe('warm-hero');
    });

    it('relocates slotted light children into the terminal body', () => {
      const el = document.createElement('slicc-action-card') as SliccActionCard;
      const span = document.createElement('span');
      span.className = 'ok';
      span.textContent = '✓ passed';
      el.appendChild(span);
      document.body.appendChild(el);
      expect(body(el).contains(span)).toBe(true);
    });

    it('keeps the slotted body across a re-render (variant flip and back)', () => {
      const el = document.createElement('slicc-action-card') as SliccActionCard;
      const span = document.createElement('span');
      span.className = 'p';
      span.textContent = '❯ ls';
      el.appendChild(span);
      document.body.appendChild(el);
      // Flip to pr then back to tool — the captured child re-homes into the body.
      el.variant = 'pr';
      el.variant = 'tool';
      expect(body(el).contains(span)).toBe(true);
    });

    it('escapes the title text', () => {
      const el = mount((e) => {
        e.title = '<script>x</script>';
      });
      expect(el.querySelector('[part="title"] script')).toBeNull();
      expect((el.querySelector('[part="title"]') as HTMLElement).textContent).toBe(
        '<script>x</script>'
      );
    });
  });

  describe('light variant (.tcard.light)', () => {
    it('adds the .light class to the card', () => {
      const el = mount((e) => {
        e.variant = 'light';
      });
      expect(card(el).classList.contains('tcard')).toBe(true);
      expect(card(el).classList.contains('light')).toBe(true);
    });

    it('paints the body on the canvas surface, not the dark shell', () => {
      const el = mount((e) => {
        e.variant = 'light';
      });
      // .tcard.light .tb → var(--canvas) #fff.
      expect(getComputedStyle(body(el)).backgroundColor).toBe('rgb(255, 255, 255)');
    });
  });

  describe('pr variant (.prcard)', () => {
    it('renders the .prcard scaffold with header + meta parts', () => {
      const el = mount((e) => {
        e.variant = 'pr';
        e.title = 'feat(hero): warm redesign';
        e.number = '#128';
        e.branch = 'warm-hero → main';
        e.files = '2';
        e.add = '38';
        e.del = '21';
        e.checks = '✓ passing';
      });
      expect(card(el).classList.contains('prcard')).toBe(true);
      expect((el.querySelector('[part="title"]') as HTMLElement).textContent).toBe(
        'feat(hero): warm redesign'
      );
      expect((el.querySelector('.pn') as HTMLElement).textContent).toBe('#128');
      const meta = el.querySelector('[part="meta"]') as HTMLElement;
      expect(meta.textContent).toContain('warm-hero → main');
      expect(meta.textContent).toContain('2');
      expect((meta.querySelector('.add') as HTMLElement).textContent).toBe('+38');
      expect((meta.querySelector('.del') as HTMLElement).textContent).toBe('−21');
      expect(meta.textContent).toContain('✓ passing');
    });

    it('defaults the status pill to Open and renders the green brand hue', () => {
      const el = mount((e) => {
        e.variant = 'pr';
        e.title = 'pr';
      });
      const pill = el.querySelector('[part="status"]') as HTMLElement;
      expect(pill.textContent).toBe('Open');
      // .open → background #1a7f37.
      expect(getComputedStyle(pill).backgroundColor).toBe('rgb(26, 127, 55)');
    });

    it('honors a custom status pill text', () => {
      const el = mount((e) => {
        e.variant = 'pr';
        e.status = 'Draft';
      });
      expect((el.querySelector('[part="status"]') as HTMLElement).textContent).toBe('Draft');
    });

    it('omits the number when unset', () => {
      const el = mount((e) => {
        e.variant = 'pr';
        e.title = 'pr';
      });
      expect(el.querySelector('.pn')).toBeNull();
    });

    it('lets a meta slot override the attribute-derived stats row', () => {
      const el = document.createElement('slicc-action-card') as SliccActionCard;
      el.setAttribute('variant', 'pr');
      el.setAttribute('branch', 'ignored → main');
      const custom = document.createElement('span');
      custom.setAttribute('slot', 'meta');
      custom.textContent = 'custom meta';
      el.appendChild(custom);
      document.body.appendChild(el);
      const meta = el.querySelector('[part="meta"]') as HTMLElement;
      expect(meta.contains(custom)).toBe(true);
      expect(meta.textContent).not.toContain('ignored → main');
    });
  });

  describe('appearance fidelity', () => {
    it('paints the tool terminal body as the fixed dark shell (#0c0c0e)', () => {
      const el = mount();
      // .tcard .tb → background #0c0c0e regardless of theme.
      expect(getComputedStyle(body(el)).backgroundColor).toBe('rgb(12, 12, 14)');
    });

    it('keeps the dark terminal shell even under a dark theme scope', () => {
      const wrap = document.createElement('div');
      wrap.className = 'dark';
      const el = document.createElement('slicc-action-card') as SliccActionCard;
      wrap.appendChild(el);
      document.body.appendChild(wrap);
      expect(getComputedStyle(el.querySelector('.tb') as HTMLElement).backgroundColor).toBe(
        'rgb(12, 12, 14)'
      );
    });

    it('rounds the card chrome to the prototype 12px radius', () => {
      const el = mount();
      expect(getComputedStyle(card(el)).borderTopLeftRadius).toBe('12px');
    });

    it('tints the cyan icon chip from the --cyan token', () => {
      const el = mount((e) => {
        e.tone = 'cy';
      });
      // --cyan #06b6d4 → rgb(6, 182, 212).
      expect(getComputedStyle(el.querySelector('.ic') as HTMLElement).backgroundColor).toBe(
        'rgb(6, 182, 212)'
      );
    });

    it('flips the card surface to the dark canvas under a dark scope', () => {
      const wrap = document.createElement('div');
      wrap.className = 'dark';
      const el = document.createElement('slicc-action-card') as SliccActionCard;
      el.setAttribute('variant', 'pr');
      wrap.appendChild(el);
      document.body.appendChild(wrap);
      expect(getComputedStyle(el.querySelector('.prcard') as HTMLElement).backgroundColor).toBe(
        'rgb(22, 22, 24)'
      );
    });
  });

  describe('events', () => {
    it('fires a composed, bubbling slicc-action-card-change on variant change', () => {
      const el = mount();
      let detail: { variant: string } | null = null;
      document.body.addEventListener('slicc-action-card-change', (e) => {
        detail = (e as CustomEvent<{ variant: string }>).detail;
      });
      el.variant = 'pr';
      expect(detail).toEqual({ variant: 'pr' });

      detail = null;
      el.variant = 'tool';
      expect(detail).toEqual({ variant: 'tool' });
    });

    it('does not fire the change event for non-variant attribute updates', () => {
      const el = mount();
      let fired = false;
      document.body.addEventListener('slicc-action-card-change', () => {
        fired = true;
      });
      el.title = 'changed';
      expect(fired).toBe(false);
    });
  });
});
