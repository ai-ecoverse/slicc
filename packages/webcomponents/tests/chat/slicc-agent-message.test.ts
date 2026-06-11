import { beforeEach, describe, expect, it } from 'vitest';
import { SliccAgentMessage } from '../../src/chat/slicc-agent-message.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

function mount(setup?: (el: SliccAgentMessage) => void): SliccAgentMessage {
  const el = document.createElement('slicc-agent-message') as SliccAgentMessage;
  setup?.(el);
  document.body.appendChild(el);
  return el;
}

/** The `.body` prose region inside the light-DOM host. */
function bodyOf(el: SliccAgentMessage): HTMLElement {
  return el.querySelector('.body') as HTMLElement;
}

describe('slicc-agent-message', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-agent-message')).toBe(SliccAgentMessage);
  });

  it('renders into light DOM (no shadow root) as a .msg.bot block with a body part', () => {
    const el = mount();
    expect(el.shadowRoot).toBeNull();
    expect(el.classList.contains('msg')).toBe(true);
    expect(el.classList.contains('bot')).toBe(true);
    const body = bodyOf(el);
    expect(body).not.toBeNull();
    expect(body.getAttribute('part')).toBe('body');
    expect(el.querySelector('[part="body"]')).not.toBeNull();
  });

  it('preserves host classes set before connect', () => {
    const el = document.createElement('slicc-agent-message') as SliccAgentMessage;
    el.classList.add('custom-host');
    document.body.appendChild(el);
    expect(el.classList.contains('custom-host')).toBe(true);
    expect(el.classList.contains('msg')).toBe(true);
  });

  it('relocates pre-existing light children into the body', () => {
    const el = document.createElement('slicc-agent-message') as SliccAgentMessage;
    const p = document.createElement('p');
    p.textContent = 'rendered markdown';
    el.appendChild(p);
    document.body.appendChild(el);
    expect(bodyOf(el).contains(p)).toBe(true);
  });

  describe('attribute ↔ property reflection', () => {
    it('reflects thinking', () => {
      const el = mount();
      expect(el.thinking).toBe(false);
      el.thinking = true;
      expect(el.hasAttribute('thinking')).toBe(true);
      expect(el.thinking).toBe(true);
      el.thinking = false;
      expect(el.hasAttribute('thinking')).toBe(false);
    });

    it('reflects streaming', () => {
      const el = mount();
      expect(el.streaming).toBe(false);
      el.streaming = true;
      expect(el.hasAttribute('streaming')).toBe(true);
      el.streaming = false;
      expect(el.hasAttribute('streaming')).toBe(false);
    });
  });

  describe('prose body', () => {
    it('hosts rendered HTML via setBodyHtml', () => {
      const el = mount();
      el.setBodyHtml('<p>hello <strong>world</strong></p>');
      expect(bodyOf(el).querySelector('strong')?.textContent).toBe('world');
    });

    it('exposes the body element via the body getter', () => {
      const el = mount();
      expect(el.body).toBe(bodyOf(el));
    });
  });

  describe('plan variant', () => {
    it('renders a colored-dot ul.plan via setPlan', () => {
      const el = mount();
      el.setPlan(['first', 'second', 'third']);
      const plan = el.querySelector('ul.plan') as HTMLUListElement;
      expect(plan).not.toBeNull();
      expect(plan.getAttribute('part')).toBe('plan');
      expect(plan.querySelectorAll('li')).toHaveLength(3);
      expect(plan.querySelector('li')?.textContent).toBe('first');
    });

    it('escapes plan item text', () => {
      const el = mount();
      el.setPlan(['<script>x</script>']);
      expect(el.querySelector('.plan li script')).toBeNull();
      expect((el.querySelector('.plan li') as HTMLElement).textContent).toBe('<script>x</script>');
    });

    it('paints the first three bullets rose / violet / cyan', () => {
      const el = mount();
      el.setPlan(['a', 'b', 'c']);
      const lis = el.querySelectorAll('.plan li');
      // ::before background — --rose #f43f5e, --violet #8b5cf6, --cyan #06b6d4.
      expect(getComputedStyle(lis[0], '::before').backgroundColor).toBe('rgb(244, 63, 94)');
      expect(getComputedStyle(lis[1], '::before').backgroundColor).toBe('rgb(139, 92, 246)');
      expect(getComputedStyle(lis[2], '::before').backgroundColor).toBe('rgb(6, 182, 212)');
    });
  });

  describe('check variant', () => {
    it('renders a ul.check with default green badges via setCheck', () => {
      const el = mount();
      el.setCheck([{ text: 'done' }, { text: 'also done' }]);
      const check = el.querySelector('ul.check') as HTMLUListElement;
      expect(check).not.toBeNull();
      expect(check.getAttribute('part')).toBe('check');
      const badges = check.querySelectorAll('.ck');
      expect(badges).toHaveLength(2);
      // Default badge background #1a7f37 → rgb(26, 127, 55).
      expect(getComputedStyle(badges[0]).backgroundColor).toBe('rgb(26, 127, 55)');
      expect(badges[0].textContent).toBe('✓');
    });

    it('applies the r/cy/vi/am badge accents', () => {
      const el = mount();
      el.setCheck([
        { text: 'rose', variant: 'r' },
        { text: 'cyan', variant: 'cy' },
        { text: 'violet', variant: 'vi' },
        { text: 'amber', variant: 'am' },
      ]);
      const badges = el.querySelectorAll('.check .ck');
      expect(getComputedStyle(badges[0]).backgroundColor).toBe('rgb(244, 63, 94)'); // --rose
      expect(getComputedStyle(badges[1]).backgroundColor).toBe('rgb(6, 182, 212)'); // --cyan
      expect(getComputedStyle(badges[2]).backgroundColor).toBe('rgb(139, 92, 246)'); // --violet
      expect(getComputedStyle(badges[3]).backgroundColor).toBe('rgb(245, 158, 11)'); // --amber
    });

    it('ignores unknown variants (falls back to default green)', () => {
      const el = mount();
      // @ts-expect-error — exercising runtime guard against an invalid variant.
      el.setCheck([{ text: 'x', variant: 'bogus' }]);
      const badge = el.querySelector('.check .ck') as HTMLElement;
      expect(badge.className).toBe('ck');
    });

    it('escapes check row text and a custom glyph', () => {
      const el = mount();
      el.setCheck([{ text: '<b>x</b>', glyph: '<i>!</i>' }]);
      const li = el.querySelector('.check li') as HTMLElement;
      expect(li.querySelector('b')).toBeNull();
      expect((li.querySelector('.ctext') as HTMLElement).textContent).toBe('<b>x</b>');
      expect((li.querySelector('.ck') as HTMLElement).textContent).toBe('<i>!</i>');
    });
  });

  describe('thinking state', () => {
    it('shows three bouncing dots and hides the body when thinking', () => {
      const el = mount((e) => {
        e.setBodyHtml('<p>typed plan</p>');
        e.thinking = true;
      });
      expect(el.classList.contains('thinkrow')).toBe(true);
      const dots = el.querySelector('.dots');
      expect(dots).not.toBeNull();
      expect(dots?.querySelectorAll('i')).toHaveLength(3);
      expect(getComputedStyle(bodyOf(el)).display).toBe('none');
    });

    it('colors the three dots rose / cyan / violet', () => {
      const el = mount((e) => {
        e.thinking = true;
      });
      const dots = el.querySelectorAll('.dots i');
      expect(getComputedStyle(dots[0]).backgroundColor).toBe('rgb(244, 63, 94)'); // rose
      expect(getComputedStyle(dots[1]).backgroundColor).toBe('rgb(6, 182, 212)'); // cyan
      expect(getComputedStyle(dots[2]).backgroundColor).toBe('rgb(139, 92, 246)'); // violet
    });

    it('replaces the dots with the typed body when thinking clears', () => {
      const el = mount((e) => {
        e.setBodyHtml('<p>typed plan</p>');
        e.thinking = true;
      });
      el.thinking = false;
      expect(el.classList.contains('thinkrow')).toBe(false);
      expect(el.querySelector('.dots')).toBeNull();
      expect(getComputedStyle(bodyOf(el)).display).not.toBe('none');
      expect(bodyOf(el).textContent).toContain('typed plan');
    });
  });

  describe('progress message', () => {
    it('reflects the progress attribute ↔ property', () => {
      const el = mount();
      expect(el.progress).toBeNull();
      el.progress = 'Running tools…';
      expect(el.getAttribute('progress')).toBe('Running tools…');
      el.progress = null;
      expect(el.hasAttribute('progress')).toBe(false);
    });

    it('shows the progress label beside the dots while thinking', () => {
      const el = mount((e) => {
        e.thinking = true;
        e.progress = 'Running tools — edit_file';
      });
      const label = el.querySelector('.progress') as HTMLElement;
      expect(label).not.toBeNull();
      expect(label.getAttribute('part')).toBe('progress');
      expect(label.textContent).toBe('Running tools — edit_file');
      // The dots and the label live in the same inline row.
      expect(el.querySelector('.thinkrow-row .dots')).not.toBeNull();
      expect(el.querySelector('.thinkrow-row .progress')).toBe(label);
    });

    it('updates the progress label text in place', () => {
      const el = mount((e) => {
        e.thinking = true;
        e.progress = 'Thinking…';
      });
      el.progress = 'Waiting for your reply…';
      expect(el.querySelectorAll('.progress')).toHaveLength(1);
      expect((el.querySelector('.progress') as HTMLElement).textContent).toBe(
        'Waiting for your reply…'
      );
    });

    it('removes the progress label when cleared or thinking stops', () => {
      const el = mount((e) => {
        e.thinking = true;
        e.progress = 'Thinking…';
      });
      el.progress = null;
      expect(el.querySelector('.progress')).toBeNull();
      el.progress = 'back';
      el.thinking = false;
      expect(el.querySelector('.progress')).toBeNull();
      expect(el.querySelector('.thinkrow-row')).toBeNull();
    });

    it('renders the progress label in the inherited --ui font stack', () => {
      const el = mount((e) => {
        e.thinking = true;
        e.progress = 'Thinking…';
      });
      const ff = getComputedStyle(el.querySelector('.progress') as HTMLElement).fontFamily;
      expect(ff).toContain('adobe-clean');
    });
  });

  describe('streaming state', () => {
    it('appends a typewriter caret to the body while streaming', () => {
      const el = mount((e) => {
        e.setBodyHtml('<p>partial</p>');
        e.streaming = true;
      });
      const caret = bodyOf(el).querySelector('.tw-caret') as HTMLElement;
      expect(caret).not.toBeNull();
      expect(caret.getAttribute('part')).toBe('caret');
      // The caret renders with the --ink color (#0a0a0a → rgb(10, 10, 10)).
      expect(getComputedStyle(caret).backgroundColor).toBe('rgb(10, 10, 10)');
    });

    it('keeps the caret last after a body re-render', () => {
      const el = mount((e) => {
        e.streaming = true;
      });
      el.setBodyHtml('<p>new content</p>');
      const body = bodyOf(el);
      expect(body.lastElementChild?.classList.contains('tw-caret')).toBe(true);
      // Still exactly one caret.
      expect(body.querySelectorAll('.tw-caret')).toHaveLength(1);
    });

    it('removes the caret when streaming stops', () => {
      const el = mount((e) => {
        e.streaming = true;
      });
      expect(bodyOf(el).querySelector('.tw-caret')).not.toBeNull();
      el.streaming = false;
      expect(bodyOf(el).querySelector('.tw-caret')).toBeNull();
    });
  });

  describe('events', () => {
    it('fires a composed, bubbling thinking event on state change', () => {
      const el = mount();
      let detail: { thinking: boolean } | null = null;
      document.body.addEventListener('slicc-agent-message-thinking', (e) => {
        detail = (e as CustomEvent<{ thinking: boolean }>).detail;
      });
      el.thinking = true;
      expect(detail).toEqual({ thinking: true });
      detail = null;
      el.thinking = false;
      expect(detail).toEqual({ thinking: false });
    });

    it('fires a composed, bubbling streaming event on state change', () => {
      const el = mount();
      let detail: { streaming: boolean } | null = null;
      document.body.addEventListener('slicc-agent-message-streaming', (e) => {
        detail = (e as CustomEvent<{ streaming: boolean }>).detail;
      });
      el.streaming = true;
      expect(detail).toEqual({ streaming: true });
      detail = null;
      el.streaming = false;
      expect(detail).toEqual({ streaming: false });
    });
  });

  describe('appearance', () => {
    it('renders the prose body in the inherited --ui font stack, not a browser default', () => {
      const el = mount();
      el.setBodyHtml('<p>warm hero</p>');
      // --ui is "adobe-clean", "Inter", system-ui, sans-serif — regression guard
      // for the body falling back to the browser default font.
      const ff = getComputedStyle(bodyOf(el)).fontFamily;
      expect(ff).toContain('adobe-clean');
      expect(ff).toContain('Inter');
    });

    it('renders markdown headings in the --ui font stack', () => {
      const el = mount();
      el.setBodyHtml('<h2>Findings</h2>');
      const h2 = el.querySelector('h2') as HTMLElement;
      expect(getComputedStyle(h2).fontFamily).toContain('adobe-clean');
    });

    it('styles blockquote edge, links, and bold with the derived context accent', () => {
      const el = mount();
      el.setBodyHtml(
        '<blockquote><p>quote</p></blockquote><p><a href="#x">link</a> <strong>bold</strong></p>'
      );
      const bq = el.querySelector('blockquote') as HTMLElement;
      const a = el.querySelector('a') as HTMLElement;
      const strong = el.querySelector('strong') as HTMLElement;
      // One consistent accent (--ctx mixed with --ink) across all three.
      const accent = getComputedStyle(a).color;
      expect(accent).not.toBe('rgb(139, 92, 246)'); // no longer the fixed violet
      expect(getComputedStyle(bq).borderLeftColor).toBe(accent);
      expect(getComputedStyle(strong).color).toBe(accent);
      // The accent follows the context: flipping --ctx flips all of them.
      el.style.setProperty('--ctx', '#3b6cb2');
      expect(getComputedStyle(a).color).not.toBe(accent);
      expect(getComputedStyle(bq).borderLeftColor).toBe(getComputedStyle(a).color);
    });

    it('renders a fenced code block in the mono font with the inline-code chrome stripped', () => {
      const el = mount();
      el.setBodyHtml('<pre><code>const x = 1;</code></pre>');
      const pre = el.querySelector('pre') as HTMLElement;
      expect(getComputedStyle(pre).fontFamily).toContain('Mono');
      const code = pre.querySelector('code') as HTMLElement;
      // pre > code drops the inline --ghost pill background (rgba(0,0,0,0) = transparent).
      expect(getComputedStyle(code).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    });

    it('does not apply the generic list padding to the bespoke .plan list', () => {
      const el = mount();
      el.setPlan(['a', 'b']);
      const plan = el.querySelector('ul.plan') as HTMLElement;
      // The generic `.body ul` rule excludes `.plan` / `.check` via :not(), so the
      // prototype list keeps its flush padding.
      expect(getComputedStyle(plan).paddingLeft).toBe('0px');
    });

    it('renders inline code context-tinted (--ctx over --canvas) with mono font', () => {
      const el = mount();
      el.setBodyHtml('<p>run <code>npm test</code></p>');
      const code = el.querySelector('code') as HTMLElement;
      const cs = getComputedStyle(code);
      // 12% --ctx over --canvas: a soft accent wash, not the old flat grey.
      expect(cs.backgroundColor).toMatch(/^(rgb|color)\(/);
      expect(cs.backgroundColor).not.toBe('rgb(236, 236, 239)');
      expect(cs.fontFamily).toContain('Source Code Pro');
    });

    it('the inline-code tint follows the context accent (--ctx)', () => {
      const el = mount();
      el.setBodyHtml('<p><code>x</code></p>');
      const code = el.querySelector('code') as HTMLElement;
      const amber = getComputedStyle(code).backgroundColor;
      el.style.setProperty('--ctx', '#3b6cb2');
      const ice = getComputedStyle(code).backgroundColor;
      expect(ice).not.toBe(amber);
    });

    it('wide tables scroll inside themselves, not the whole column', () => {
      const host = document.createElement('div');
      host.style.cssText = 'width:300px;';
      const el = document.createElement('slicc-agent-message') as SliccAgentMessage;
      host.append(el);
      document.body.append(host);
      el.setBodyHtml(`<table><tr>${'<td>very-wide-cell-content</td>'.repeat(12)}</tr></table>`);
      const table = el.querySelector('table') as HTMLElement;
      const cs = getComputedStyle(table);
      expect(cs.display).toBe('block');
      expect(cs.overflowX).toBe('auto');
      // The table itself is clamped to the column; its CONTENT overflows
      // into the table's own scroll area.
      expect(table.clientWidth).toBeLessThanOrEqual(300);
      expect(table.scrollWidth).toBeGreaterThan(table.clientWidth);
      host.remove();
    });

    it('fenced blocks carry the context-accent edge', () => {
      const el = mount();
      el.setBodyHtml('<pre><code>ls -la</code></pre>');
      const pre = el.querySelector('pre') as HTMLElement;
      const cs = getComputedStyle(pre);
      // The accent edge is the 3px left border.
      expect(cs.borderLeftWidth).toBe('3px');
      expect(cs.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    });
  });
});
