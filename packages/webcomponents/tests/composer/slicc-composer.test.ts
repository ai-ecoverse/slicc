import { beforeEach, describe, expect, it } from 'vitest';
// Siblings from earlier waves — already registered; safe to import so the
// populated composer mirrors the prototype's footer (input card + meta row).
import '../../src/add-menu/slicc-add-menu.js';
import { SliccComposer } from '../../src/composer/slicc-composer.js';
import '../../src/primitives/slicc-send-button.js';
import { ensureGlobalTokens, setTheme } from '../../src/theme/tokens.js';

/** The inner `.composer-inner` band the host renders into its light DOM. */
function innerOf(el: SliccComposer): HTMLElement {
  return el.querySelector('.slicc-composer__inner') as HTMLElement;
}

/**
 * Build a realistic, populated composer: an `.inputcard` carrying the add-menu
 * toolbar + send button, and a `.meta` row with model / thinking controls and a
 * keyboard `.hint` — matching the prototype footer markup.
 */
function makeComposer(): SliccComposer {
  const el = document.createElement('slicc-composer');
  // The walkie-talkie dictation gesture is opt-in (demo-only); these tests
  // exercise it explicitly.
  el.setAttribute('ptt', '');
  // Give the band real width so the 680px-max + centering geometry resolves.
  el.style.cssText = 'width:1000px;display:block;';
  el.innerHTML = `
    <div class="inputcard">
      <textarea class="ta" rows="1" placeholder="Ask sliccy…"></textarea>
      <div class="toolbar">
        <slicc-add-menu></slicc-add-menu>
        <slicc-send-button></slicc-send-button>
      </div>
    </div>
    <div class="meta">
      <button class="ctl msel">Opus 4.8</button>
      <button class="ctl tsel">Sprofondato</button>
      <div class="mspacer"></div>
      <span class="hint slicc-composer__hint" data-composer-hint>⏎ send · ⇧⏎ newline</span>
    </div>`;
  return el;
}

describe('slicc-composer', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    setTheme('light');
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-composer')).toBe(SliccComposer);
  });

  it('renders into light DOM (no shadow root) with the inner band exposed as part="inner"', () => {
    const el = makeComposer();
    document.body.appendChild(el);
    expect(el.shadowRoot).toBeNull();
    const inner = innerOf(el);
    expect(inner).not.toBeNull();
    expect(inner.getAttribute('part')).toBe('inner');
    // The `inner` getter returns that same band.
    expect(el.inner).toBe(inner);
  });

  it('relocates pre-existing slotted children (input card + meta row) into the inner band, in order', () => {
    const el = makeComposer();
    document.body.appendChild(el);
    const inner = innerOf(el);
    const card = inner.querySelector('.inputcard');
    const meta = inner.querySelector('.meta');
    expect(card).not.toBeNull();
    expect(meta).not.toBeNull();
    // DOM order preserved: input card precedes the meta row.
    expect(card!.compareDocumentPosition(meta!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The composed siblings live inside the band.
    expect(inner.querySelector('slicc-add-menu')).not.toBeNull();
    expect(inner.querySelector('slicc-send-button')).not.toBeNull();
  });

  it('appends nodes into the inner band via append()', () => {
    const el = document.createElement('slicc-composer') as SliccComposer;
    document.body.appendChild(el);
    const extra = document.createElement('div');
    extra.className = 'late';
    el.append(extra);
    expect(innerOf(el).querySelector('.late')).toBe(extra);
  });

  it('reflects the open attribute to the property and back', () => {
    const el = makeComposer();
    document.body.appendChild(el);

    expect(el.open).toBe(false);
    el.open = true;
    expect(el.hasAttribute('open')).toBe(true);
    expect(el.open).toBe(true);
    el.open = false;
    expect(el.hasAttribute('open')).toBe(false);

    el.setAttribute('open', '');
    expect(el.open).toBe(true);
  });

  it('survives detach + re-attach without rebuilding / duplicating the inner band', () => {
    const el = makeComposer();
    document.body.appendChild(el);
    const inner = innerOf(el);

    el.remove();
    document.body.appendChild(el);

    // Same band instance, exactly one band — children were not re-wrapped.
    expect(innerOf(el)).toBe(inner);
    expect(el.querySelectorAll('.slicc-composer__inner').length).toBe(1);
  });

  it('is a frosted footer band: top border, relative z-index 2, blurred backdrop', () => {
    const el = makeComposer();
    document.body.appendChild(el);
    const cs = getComputedStyle(el);

    // Top border from --line; the other edges stay borderless.
    expect(cs.borderTopStyle).toBe('solid');
    expect(cs.borderTopWidth).toBe('1px');
    expect(cs.borderBottomStyle).toBe('none');

    // z-index:2 over a positioned band so the add-menu results panel overlays
    // the thread (which sits at the default stacking level).
    expect(cs.position).toBe('relative');
    expect(cs.zIndex).toBe('2');

    // Frosted glass: blur + saturate backdrop filter.
    const backdrop =
      cs.backdropFilter || (cs as unknown as { webkitBackdropFilter: string }).webkitBackdropFilter;
    expect(backdrop).toContain('blur(18px)');
    expect(backdrop).toContain('saturate(1.4)');

    // Prototype band padding.
    expect(cs.paddingTop).toBe('14px');
    expect(cs.paddingLeft).toBe('16px');
  });

  it('tints the band background with --ctx over --bg (a resolved, non-transparent color-mix)', () => {
    const el = makeComposer();
    document.body.appendChild(el);
    const bg = getComputedStyle(el).backgroundColor;
    // color-mix resolves to a concrete color — not the keyword and not fully
    // transparent. Modern Chromium serializes it as color(srgb …), not rgb(…).
    expect(bg).not.toBe('transparent');
    expect(bg).not.toBe('rgba(0, 0, 0, 0)');
    expect(/(rgba?|color)\(/.test(bg)).toBe(true);
  });

  it('centers the inner band at max-width 680px so it slides with the chat column', () => {
    const el = makeComposer();
    document.body.appendChild(el);
    const inner = innerOf(el);
    const ics = getComputedStyle(inner);
    expect(ics.maxWidth).toBe('680px');
    // Inside the 1000px host the band is clamped to 680px and centered (auto margins).
    expect(inner.getBoundingClientRect().width).toBeCloseTo(680, 0);
    expect(ics.marginLeft).toBe(ics.marginRight);
  });

  it('default state: the meta keyboard hint is visible', () => {
    const el = makeComposer();
    document.body.appendChild(el);
    const hint = el.querySelector('.slicc-composer__hint') as HTMLElement;
    expect(getComputedStyle(hint).display).not.toBe('none');
  });

  it('open / narrow state: hides the meta keyboard hint (mirrors .shell.open .meta .hint)', () => {
    const el = makeComposer();
    el.setAttribute('open', '');
    document.body.appendChild(el);

    const hint = el.querySelector('.slicc-composer__hint') as HTMLElement;
    expect(getComputedStyle(hint).display).toBe('none');
    // Model + thinking controls stay visible in the narrow layout.
    const model = el.querySelector('.msel') as HTMLElement;
    expect(getComputedStyle(model).display).not.toBe('none');

    // Toggling back off restores the hint.
    el.open = false;
    expect(getComputedStyle(hint).display).not.toBe('none');
  });

  it('also hides a hint matched by the data-composer-hint attribute when open', () => {
    const el = document.createElement('slicc-composer') as SliccComposer;
    el.setAttribute('open', '');
    const meta = document.createElement('div');
    meta.className = 'meta';
    const hint = document.createElement('span');
    hint.setAttribute('data-composer-hint', '');
    hint.textContent = '⏎ send';
    meta.appendChild(hint);
    el.appendChild(meta);
    document.body.appendChild(el);

    expect(getComputedStyle(hint).display).toBe('none');
  });

  it('recomputes the frosted tint in dark mode (background differs from light)', () => {
    const el = makeComposer();
    document.body.appendChild(el);
    const light = getComputedStyle(el).backgroundColor;

    setTheme('dark');
    const dark = getComputedStyle(el).backgroundColor;
    // --bg flips dark, so the color-mix tint resolves to a different surface.
    expect(dark).not.toBe(light);
    expect(dark).not.toBe('rgba(0, 0, 0, 0)');
  });

  // --- push-to-talk "walkie-talkie" dictation gesture ---

  /** The textarea the host renders / relocates into its light DOM. */
  function taOf(el: SliccComposer): HTMLTextAreaElement {
    return el.querySelector('textarea') as HTMLTextAreaElement;
  }

  /** Press-and-hold the textarea (primary button), arming the gesture. */
  function press(el: SliccComposer): HTMLTextAreaElement {
    const ta = taOf(el);
    ta.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    return ta;
  }

  /** The active push-to-talk overlay, if any. */
  function pttOf(el: SliccComposer): HTMLElement | null {
    return el.querySelector('.slicc-composer__ptt');
  }

  it('mousedown turns the band into a walkie-talkie button: mic + prompt + progress bar', () => {
    const el = makeComposer();
    document.body.appendChild(el);
    press(el);

    const ptt = pttOf(el);
    expect(ptt).not.toBeNull();
    // A live mic <svg> (lucide), never an emoji.
    expect(ptt!.querySelector('.slicc-composer__ptt-mic svg')).not.toBeNull();
    // The dictation prompt.
    const label = ptt!.querySelector('.slicc-composer__ptt-label') as HTMLElement;
    expect(label.textContent).toBe('Keep mouse pressed to dictate');
    // The simulated model-load row: text + progress bar fill.
    expect(ptt!.querySelector('.slicc-composer__ptt-load-text')?.textContent).toBe(
      'Loading speech recognition model'
    );
    expect(ptt!.querySelector('.slicc-composer__ptt-bar-fill')).not.toBeNull();
  });

  it('drives the progress bar with the stable slicc-ptt-load animation longhands', () => {
    const el = makeComposer();
    document.body.appendChild(el);
    press(el);

    const fill = pttOf(el)!.querySelector('.slicc-composer__ptt-bar-fill') as HTMLElement;
    const cs = getComputedStyle(fill);
    // Real Chromium honors the emulated media query; assert the precise longhands
    // (the `animation` shorthand serializes differently across versions). Under
    // reduced-motion the CSS neutralizes the sweep to animation-name: none.
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      expect(cs.animationName).toBe('none');
    } else {
      expect(cs.animationName).toBe('slicc-ptt-load');
      expect(cs.animationDuration).toBe('1.2s');
    }
  });

  it('mouseup hides the overlay AND populates the textarea with a transcript', () => {
    const el = makeComposer();
    document.body.appendChild(el);
    const ta = press(el);
    expect(ta.value).toBe('');

    // A real release anywhere ends the gesture.
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

    expect(pttOf(el)).toBeNull();
    expect(ta.value.trim().length).toBeGreaterThan(0);
    expect(ta.value).toContain('warmer');
  });

  it('pointer leaving mid-press cancels: overlay torn down, textarea left untouched', () => {
    const el = makeComposer();
    document.body.appendChild(el);
    const ta = press(el);
    expect(pttOf(el)).not.toBeNull();

    // Leaving the host is the stuck-state guard — overlay drops, no transcript.
    el.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
    expect(pttOf(el)).toBeNull();
    expect(ta.value).toBe('');

    // A subsequent release no longer reaches us (listeners removed).
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(ta.value).toBe('');
  });

  it('guards the progress sweep + mic pulse behind prefers-reduced-motion (animation-name: none)', () => {
    // CSS @media (prefers-reduced-motion) is evaluated by the browser, not a JS
    // mock, so assert the document stylesheet carries the guard that neutralizes
    // the bar sweep. Mount a composer first so the scoped <style> is injected.
    const el = makeComposer();
    document.body.appendChild(el);

    const sheet = Array.from(document.styleSheets).find(
      (s) => (s.ownerNode as Element | null)?.id === 'slicc-composer-style'
    );
    expect(sheet).toBeDefined();

    let guarded = false;
    for (const rule of Array.from(sheet!.cssRules)) {
      if (rule instanceof CSSMediaRule && rule.conditionText.includes('prefers-reduced-motion')) {
        for (const inner of Array.from(rule.cssRules)) {
          if (
            inner instanceof CSSStyleRule &&
            inner.selectorText.includes('slicc-composer__ptt-bar-fill') &&
            inner.style.animationName === 'none'
          ) {
            guarded = true;
          }
        }
      }
    }
    expect(guarded).toBe(true);
  });
});

describe('slicc-composer / ptt opt-in', () => {
  it('without the ptt attribute, pressing the textarea stays native (no overlay, no transcript)', () => {
    const el = document.createElement('slicc-composer');
    el.style.cssText = 'width:1000px;display:block;';
    const ta = document.createElement('textarea');
    ta.className = 'ta';
    el.append(ta);
    document.body.appendChild(el);

    ta.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, cancelable: true }));
    expect(el.querySelector('.slicc-composer__ptt')).toBeNull();

    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(ta.value).toBe('');
    el.remove();
  });
});
