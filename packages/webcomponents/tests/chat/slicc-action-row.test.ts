import { beforeEach, describe, expect, it } from 'vitest';
import { SliccActionRow } from '../../src/chat/slicc-action-row.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

function mount(setup?: (el: SliccActionRow) => void): SliccActionRow {
  const el = document.createElement('slicc-action-row') as SliccActionRow;
  setup?.(el);
  document.body.appendChild(el);
  return el;
}

const head = (el: SliccActionRow): HTMLElement =>
  el.querySelector('.slicc-act__head') as HTMLElement;
const icon = (el: SliccActionRow): HTMLElement => el.querySelector('.slicc-act__ic') as HTMLElement;
const label = (el: SliccActionRow): HTMLElement =>
  el.querySelector('.slicc-act__label') as HTMLElement;
const badge = (el: SliccActionRow): HTMLElement =>
  el.querySelector('.slicc-act__badge') as HTMLElement;
const chev = (el: SliccActionRow): HTMLElement =>
  el.querySelector('.slicc-act__chev') as HTMLElement;
const body = (el: SliccActionRow): HTMLElement =>
  el.querySelector('.slicc-act__body') as HTMLElement;

describe('slicc-action-row', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-action-row')).toBe(SliccActionRow);
  });

  it('renders into light DOM (no shadow root) with all ::part hooks', () => {
    const el = mount((e) => {
      e.label = 'tester · vitest';
    });
    expect(el.shadowRoot).toBeNull();
    expect(el.querySelector('[part="head"]')).not.toBeNull();
    expect(el.querySelector('[part="icon"]')).not.toBeNull();
    expect(el.querySelector('[part="label"]')).not.toBeNull();
    expect(el.querySelector('[part="badge"]')).not.toBeNull();
    expect(el.querySelector('[part="chevron"]')).not.toBeNull();
    expect(el.querySelector('[part="body"]')).not.toBeNull();
  });

  it('renders the header as a real <button type=button>', () => {
    const el = mount();
    const h = head(el) as HTMLButtonElement;
    expect(h.tagName).toBe('BUTTON');
    expect(h.type).toBe('button');
  });

  describe('attribute ↔ property reflection', () => {
    it('reflects open (default closed)', () => {
      const el = mount();
      expect(el.open).toBe(false);
      el.open = true;
      expect(el.hasAttribute('open')).toBe(true);
      el.open = false;
      expect(el.hasAttribute('open')).toBe(false);
    });

    it('reflects icon into the chip glyph (and clears when null)', () => {
      const el = mount((e) => {
        e.icon = '✎';
      });
      expect(el.getAttribute('icon')).toBe('✎');
      expect(icon(el).textContent).toBe('✎');
      el.icon = null;
      expect(el.hasAttribute('icon')).toBe(false);
      expect(icon(el).textContent).toBe('');
    });

    it('reflects tone (default ink, unknown normalizes to ink)', () => {
      const el = mount();
      expect(el.tone).toBe('ink');
      el.tone = 'vi';
      expect(el.getAttribute('tone')).toBe('vi');
      expect(el.tone).toBe('vi');
      el.setAttribute('tone', 'bogus');
      expect(el.tone).toBe('ink');
    });

    it('reflects label into the header (escaped)', () => {
      const el = mount((e) => {
        e.label = 'git · commit';
      });
      expect(label(el).textContent).toBe('git · commit');
      el.label = '<script>x</script>';
      expect(label(el).querySelector('script')).toBeNull();
      expect(label(el).textContent).toBe('<script>x</script>');
    });

    it('reflects result into the badge (escaped) and clears when null', () => {
      const el = mount((e) => {
        e.result = '3 passed';
      });
      expect(badge(el).textContent).toBe('3 passed');
      el.result = null;
      expect(el.hasAttribute('result')).toBe(false);
      expect(badge(el).textContent).toBe('');
    });
  });

  describe('structure & slotting', () => {
    it('orders chip, label, badge, chevron in the header', () => {
      const el = mount((e) => {
        e.icon = '✎';
        e.label = 'edit_file';
        e.result = '4 changes';
      });
      const parts = Array.from(head(el).children).map((c) => c.getAttribute('part'));
      expect(parts).toEqual(['icon', 'label', 'badge', 'chevron']);
    });

    it('relocates slot="body" children into the monospace body region', () => {
      const el = document.createElement('slicc-action-row') as SliccActionRow;
      const out = document.createElement('div');
      out.setAttribute('slot', 'body');
      out.innerHTML = '<span class="ok">✓ done</span>';
      el.appendChild(out);
      document.body.appendChild(el);
      expect(body(el).contains(out)).toBe(true);
      expect(body(el).querySelector('.ok')).not.toBeNull();
    });

    it('routes default-slot (non-body) children into the header label (e.g. a .vlink)', () => {
      const el = document.createElement('slicc-action-row') as SliccActionRow;
      const link = document.createElement('a');
      link.className = 'vlink';
      link.textContent = 'hero.css';
      el.append(document.createTextNode('edit_file · '), link);
      document.body.appendChild(el);
      expect(label(el).querySelector('.vlink')).not.toBeNull();
      expect(label(el).textContent).toContain('edit_file');
    });

    it('preserves slotted default-slot content across attribute re-syncs', () => {
      const el = document.createElement('slicc-action-row') as SliccActionRow;
      const link = document.createElement('a');
      link.className = 'vlink';
      link.textContent = 'hero.css';
      el.appendChild(link);
      document.body.appendChild(el);
      // Changing a non-label attribute must not wipe the slotted label.
      el.result = '4 changes';
      el.tone = 'vi';
      expect(label(el).querySelector('.vlink')).not.toBeNull();
    });
  });

  describe('tone chips (getComputedStyle)', () => {
    it('the default chip ground is the derived context accent, not flat ink', () => {
      const el = mount((e) => {
        e.icon = '●';
      });
      const ground = getComputedStyle(icon(el)).backgroundColor;
      expect(ground).not.toBe('rgb(10, 10, 10)');
      // Flipping --ctx flips the chip — the accent is context-derived.
      el.style.setProperty('--ctx', '#3b6cb2');
      expect(getComputedStyle(icon(el)).backgroundColor).not.toBe(ground);
    });

    const cases: Array<[SliccActionRow['tone'], string]> = [
      ['vi', 'rgb(139, 92, 246)'], // --violet
      ['am', 'rgb(245, 158, 11)'], // --amber
      ['cy', 'rgb(6, 182, 212)'], // --cyan
      ['gh', 'rgb(31, 35, 40)'], // #1f2328
    ];
    for (const [tone, color] of cases) {
      it(`tone="${tone}" paints the chip ${color}`, () => {
        const el = mount((e) => {
          e.icon = '●';
          e.tone = tone;
        });
        expect(getComputedStyle(icon(el)).backgroundColor).toBe(color);
      });
    }
  });

  describe('open / closed body', () => {
    it('hides the body when closed (default)', () => {
      const el = mount((e) => {
        e.label = 'x';
      });
      expect(getComputedStyle(body(el)).display).toBe('none');
    });

    it('shows the body and rotates the chevron when open', () => {
      const el = mount((e) => {
        e.label = 'x';
        e.open = true;
      });
      expect(getComputedStyle(body(el)).display).toBe('block');
      // rotate(90deg) → matrix(0, 1, -1, 0, 0, 0)
      expect(getComputedStyle(chev(el)).transform).toBe('matrix(0, 1, -1, 0, 0, 0)');
    });

    it('chevron is unrotated when closed', () => {
      const el = mount((e) => {
        e.label = 'x';
      });
      const t = getComputedStyle(chev(el)).transform;
      expect(t === 'none' || t === 'matrix(1, 0, 0, 1, 0, 0)').toBe(true);
    });
  });

  describe('badge visibility', () => {
    it('hides the badge region when result is empty', () => {
      const el = mount((e) => {
        e.label = 'x';
      });
      expect(getComputedStyle(badge(el)).display).toBe('none');
    });

    it('shows the badge region when result is set', () => {
      const el = mount((e) => {
        e.label = 'x';
        e.result = '3 passed';
      });
      expect(getComputedStyle(badge(el)).display).not.toBe('none');
    });
  });

  describe('body syntax colors (fixed light-body values)', () => {
    it('colors .add green and .del red', () => {
      const el = document.createElement('slicc-action-row') as SliccActionRow;
      const out = document.createElement('div');
      out.setAttribute('slot', 'body');
      out.innerHTML = '<span class="add">+a</span><span class="del">-b</span>';
      el.setAttribute('open', '');
      el.appendChild(out);
      document.body.appendChild(el);
      const add = body(el).querySelector('.add') as HTMLElement;
      const del = body(el).querySelector('.del') as HTMLElement;
      expect(getComputedStyle(add).color).toBe('rgb(26, 127, 55)'); // #1a7f37
      expect(getComputedStyle(del).color).toBe('rgb(207, 34, 46)'); // #cf222e
    });
  });

  describe('toggle behavior & events', () => {
    it('toggles open when the header is clicked', () => {
      const el = mount((e) => {
        e.label = 'x';
      });
      expect(el.open).toBe(false);
      head(el).click();
      expect(el.open).toBe(true);
      head(el).click();
      expect(el.open).toBe(false);
    });

    it('fires a composed, bubbling slicc-action-row-toggle event with detail.open', () => {
      const el = mount((e) => {
        e.label = 'x';
      });
      const seen: boolean[] = [];
      let composed = false;
      document.body.addEventListener('slicc-action-row-toggle', (e) => {
        const ce = e as CustomEvent<{ open: boolean }>;
        seen.push(ce.detail.open);
        composed = ce.composed && ce.bubbles;
      });
      head(el).click();
      head(el).click();
      expect(seen).toEqual([true, false]);
      expect(composed).toBe(true);
    });

    it('updates aria-expanded on the header in step with open', () => {
      const el = mount((e) => {
        e.label = 'x';
      });
      expect(head(el).getAttribute('aria-expanded')).toBe('false');
      head(el).click();
      expect(head(el).getAttribute('aria-expanded')).toBe('true');
    });

    it('removes the click listener on disconnect', () => {
      const el = mount((e) => {
        e.label = 'x';
      });
      const btn = head(el);
      el.remove();
      btn.click();
      // Detached + listener removed → no state change.
      expect(el.open).toBe(false);
    });
  });

  describe('dark mode', () => {
    it('flips the monospace body background to the dark ghost token', () => {
      const wrap = document.createElement('div');
      wrap.className = 'dark';
      const el = document.createElement('slicc-action-row') as SliccActionRow;
      el.setAttribute('open', '');
      const out = document.createElement('div');
      out.setAttribute('slot', 'body');
      out.textContent = 'log';
      el.appendChild(out);
      wrap.appendChild(el);
      document.body.appendChild(wrap);
      // dark --ghost: #1f1f22 → rgb(31, 31, 34)
      expect(getComputedStyle(body(el)).backgroundColor).toBe('rgb(31, 31, 34)');
    });
  });
});
