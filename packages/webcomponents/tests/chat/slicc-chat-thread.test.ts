import { beforeEach, describe, expect, it } from 'vitest';
// Sibling composed by tag in the thread; imported here so it is registered at test time.
import '../../src/primitives/slicc-day-separator.js';
import { SliccChatThread } from '../../src/chat/slicc-chat-thread.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

function mount(setup?: (el: SliccChatThread) => void): SliccChatThread {
  const el = document.createElement('slicc-chat-thread') as SliccChatThread;
  setup?.(el);
  document.body.appendChild(el);
  return el;
}

/** The centered, frosted reading column inside the host. */
function inner(el: SliccChatThread): HTMLElement {
  return el.querySelector('.slicc-thread__inner') as HTMLElement;
}

/** Wait for layout and its ResizeObserver delivery. */
async function settleResize(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

describe('slicc-chat-thread', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-chat-thread')).toBe(SliccChatThread);
  });

  it('renders the inner column with the ::part hook (light DOM, no shadow root)', () => {
    const el = mount();
    expect(el.shadowRoot).toBeNull();
    const col = inner(el);
    expect(col).toBeTruthy();
    expect(col.getAttribute('part')).toBe('inner');
    expect(el.inner).toBe(col);
  });

  it('sets the reading-column text to --ink so message prose flips with the theme', () => {
    // Regression: without an explicit color the prose inherits UA-default black,
    // which is invisible on the dark frosted surface in dark mode.
    const el = mount();
    const light = getComputedStyle(inner(el)).color;
    document.documentElement.classList.add('dark');
    document.body.classList.add('dark');
    const dark = getComputedStyle(inner(el)).color;
    document.documentElement.classList.remove('dark');
    document.body.classList.remove('dark');
    // dark --ink (#f5f5f2) is a light color; it must differ from the light-mode ink.
    expect(dark).toBe('rgb(245, 245, 242)');
    expect(dark).not.toBe(light);
  });

  it('relocates pre-existing light children into the inner column in DOM order', () => {
    const el = document.createElement('slicc-chat-thread') as SliccChatThread;
    const a = document.createElement('slicc-day-separator');
    a.setAttribute('label', 'Today');
    const b = document.createElement('div');
    b.className = 'msg';
    b.textContent = 'hi';
    el.append(a, b);
    document.body.appendChild(el);

    const col = inner(el);
    expect(col.children).toHaveLength(2);
    expect(col.children[0]).toBe(a);
    expect(col.children[1]).toBe(b);
    // No relocated child is left dangling as a direct host child beside the
    // column and the sticky follow chip.
    expect(el.querySelectorAll(':scope > *')).toHaveLength(2);
    expect(el.querySelector(':scope > .slicc-thread__follow')).toBeTruthy();
  });

  it('does not double-wrap when reconnected', () => {
    const el = mount();
    el.remove();
    document.body.appendChild(el);
    expect(el.querySelectorAll(':scope > .slicc-thread__inner')).toHaveLength(1);
  });

  describe('attribute ↔ property reflection', () => {
    it('reflects open', () => {
      const el = mount();
      expect(el.open).toBe(false);
      el.open = true;
      expect(el.hasAttribute('open')).toBe(true);
      el.open = false;
      expect(el.hasAttribute('open')).toBe(false);
    });

    it('reflects context', () => {
      const el = mount();
      expect(el.context).toBeNull();
      el.context = 'researcher';
      expect(el.getAttribute('context')).toBe('researcher');
      expect(el.context).toBe('researcher');
      el.context = null;
      expect(el.hasAttribute('context')).toBe(false);
    });

    it('reflects accent', () => {
      const el = mount();
      expect(el.accent).toBeNull();
      el.accent = '#8b5cf6';
      expect(el.getAttribute('accent')).toBe('#8b5cf6');
      expect(el.accent).toBe('#8b5cf6');
      el.accent = null;
      expect(el.hasAttribute('accent')).toBe(false);
    });
  });

  describe('variants / states', () => {
    it('default (wide) uses 56px/72px padding', () => {
      const el = mount();
      const cs = getComputedStyle(inner(el));
      expect(cs.paddingTop).toBe('56px');
      expect(cs.paddingLeft).toBe('72px');
    });

    it('open uses tighter 24px/32px padding', () => {
      const el = mount((e) => {
        e.open = true;
      });
      const cs = getComputedStyle(inner(el));
      expect(cs.paddingTop).toBe('24px');
      expect(cs.paddingLeft).toBe('32px');
    });

    it('toggling open switches padding live', () => {
      const el = mount();
      expect(getComputedStyle(inner(el)).paddingLeft).toBe('72px');
      el.open = true;
      expect(getComputedStyle(inner(el)).paddingLeft).toBe('32px');
      el.open = false;
      expect(getComputedStyle(inner(el)).paddingLeft).toBe('72px');
    });

    it('caps the reading column at 776px and centers it', () => {
      const el = mount();
      const cs = getComputedStyle(inner(el));
      expect(cs.maxWidth).toBe('776px');
      expect(cs.marginLeft).toBe(cs.marginRight); // auto/auto → equal
    });

    it('keeps the 776px reading cap when open (workbench rail) on a wide viewport', () => {
      // Opening the rail must NOT full-bleed the reading column on a wide screen
      // — it stays capped + centered, matching the collapsed layout. Full-bleed
      // is reserved for the ≤560px overlay (asserted against the sheet below).
      const el = mount((e) => {
        e.open = true;
      });
      const cs = getComputedStyle(inner(el));
      expect(cs.maxWidth).toBe('776px');
      expect(cs.marginLeft).toBe(cs.marginRight); // auto/auto → equal
    });

    it('full-bleeds the reading column ONLY behind the ≤560px overlay media query', () => {
      // The browser-test viewport is wide (1280px), so assert the full-bleed
      // branch against the adopted document stylesheet rather than an
      // incidentally-small window (same approach as the scoop-overflow test).
      mount();
      const sheet = (document.getElementById('slicc-chat-thread-style') as HTMLStyleElement).sheet;
      const media = Array.from(sheet?.cssRules ?? []).find(
        (r): r is CSSMediaRule => r instanceof CSSMediaRule && r.conditionText.includes('560px')
      );
      expect(media).toBeDefined();
      const innerRule = Array.from((media as CSSMediaRule).cssRules).find(
        (r): r is CSSStyleRule =>
          r instanceof CSSStyleRule && r.selectorText.includes('.slicc-thread__inner')
      );
      expect(innerRule?.style.maxWidth).toBe('none');
    });

    it('the thread wrapper scrolls vertically', () => {
      const el = mount();
      expect(getComputedStyle(el).overflowY).toBe('auto');
    });

    it('contains vertical overscroll at the thread boundary', () => {
      const el = mount();
      expect(getComputedStyle(el).overscrollBehaviorY).toBe('contain');
    });

    it('reserves a stable scrollbar gutter so context swaps do not shift the column', () => {
      const el = mount();
      expect(getComputedStyle(el).scrollbarGutter).toBe('stable');
    });

    it('the inner column has NO background, blur, or feather mask (sits on the shader)', () => {
      // The frosted reading card was deliberately dropped: text contrast comes
      // from the shader rendering low-contrast, not from a card muting it.
      const el = mount();
      const cs = getComputedStyle(inner(el));
      expect(cs.backgroundColor).toBe('rgba(0, 0, 0, 0)');
      expect(cs.backdropFilter === 'none' || cs.backdropFilter === '').toBe(true);
      const mask = cs.maskImage || (cs as unknown as { webkitMaskImage: string }).webkitMaskImage;
      expect(mask === 'none' || mask === '').toBe(true);
    });

    it('forces the local --ctx shader tint from the accent attribute', () => {
      const el = mount((e) => {
        e.accent = '#8b5cf6';
      });
      expect(el.style.getPropertyValue('--ctx')).toBe('#8b5cf6');
      el.accent = null;
      expect(el.style.getPropertyValue('--ctx')).toBe('');
    });
  });

  describe('switchContext (snapshot swap)', () => {
    it('snapshots the current column and restores it on return', () => {
      const el = mount((e) => {
        e.context = 'cone';
      });
      const msg = document.createElement('div');
      msg.className = 'msg';
      msg.textContent = 'cone message';
      el.append(msg);

      el.switchContext('researcher');
      expect(el.context).toBe('researcher');
      // Fresh context → empty column.
      expect(inner(el).children).toHaveLength(0);

      el.switchContext('cone');
      expect(el.context).toBe('cone');
      expect(inner(el).textContent).toContain('cone message');
    });

    it('keeps the reading-column width stable across a swap that changes content length', () => {
      const el = mount((e) => {
        e.context = 'cone';
      });
      el.style.height = '160px';
      el.style.width = '420px';
      // A long, overflowing context — would show a scrollbar without a stable gutter.
      for (let i = 0; i < 40; i += 1) {
        const m = document.createElement('div');
        m.textContent = `cone line ${i}`;
        m.style.height = '24px';
        el.append(m);
      }
      const wideWidth = inner(el).clientWidth;

      // Swap to a fresh (empty) context — no scrollbar. The gutter stays reserved,
      // so the centered column keeps the same width and does not shift.
      el.switchContext('researcher');
      expect(inner(el).children).toHaveLength(0);
      expect(inner(el).clientWidth).toBe(wideWidth);
    });

    it('no-ops when switching to the current context', () => {
      const el = mount((e) => {
        e.context = 'cone';
      });
      el.append(document.createElement('div'));
      let fired = 0;
      el.addEventListener('slicc-context-change', () => {
        fired += 1;
      });
      el.switchContext('cone');
      expect(fired).toBe(0);
      expect(inner(el).children).toHaveLength(1);
    });

    it('emits slicc-context-change with context + previous (composed + bubbling)', async () => {
      const el = mount((e) => {
        e.context = 'cone';
      });
      const detail = await new Promise<{ context: string; previous: string | null }>((resolve) => {
        // Listen on the document to prove the event bubbles + is composed.
        document.addEventListener(
          'slicc-context-change',
          (e) => resolve((e as CustomEvent).detail),
          { once: true }
        );
        el.switchContext('designer');
      });
      expect(detail.context).toBe('designer');
      expect(detail.previous).toBe('cone');
    });
  });

  describe('behavior / events', () => {
    it('append() adds children to the inner column', () => {
      const el = mount();
      const sep = document.createElement('slicc-day-separator');
      el.append(sep);
      expect(inner(el).contains(sep)).toBe(true);
    });

    it('replaceContent() swaps the inner column children, keeping the wrapper', () => {
      const el = mount();
      const first = document.createElement('slicc-day-separator');
      el.append(first);
      const wrapper = inner(el);

      const next = document.createElement('slicc-user-message');
      el.replaceContent(next);
      expect(inner(el)).toBe(wrapper);
      expect(wrapper.contains(first)).toBe(false);
      expect(wrapper.contains(next)).toBe(true);

      el.replaceContent();
      expect(inner(el)).toBe(wrapper);
      expect(wrapper.childNodes.length).toBe(0);
    });

    it('keeps an at= restore authoritative over same-frame column growth', async () => {
      const originalUrl = window.location.href;
      const restoreUrl = new URL(originalUrl);
      restoreUrl.searchParams.set('at', '240');
      const RealResizeObserver = globalThis.ResizeObserver;
      let capturedCb: ResizeObserverCallback | undefined;
      class FakeResizeObserver {
        constructor(cb: ResizeObserverCallback) {
          capturedCb = cb;
        }
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      }
      history.replaceState(null, '', restoreUrl);
      globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
      let el: SliccChatThread | null = null;
      try {
        el = mount((thread) => {
          thread.urlState = true;
          thread.style.cssText = 'display:block;height:120px;overflow-y:auto;';
        });
        const tall = document.createElement('div');
        tall.style.height = '1200px';
        el.replaceContent(tall);

        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        expect(el.scrollTop).toBe(240);
        capturedCb?.([], {} as ResizeObserver);
        expect(el.scrollTop).toBe(240);
      } finally {
        el?.remove();
        globalThis.ResizeObserver = RealResizeObserver;
        history.replaceState(null, '', originalUrl);
      }
    });

    it('keeps following when an at= restore resolves to the bottom', async () => {
      const originalUrl = window.location.href;
      const restoreUrl = new URL(originalUrl);
      restoreUrl.searchParams.set('at', '99999');
      history.replaceState(null, '', restoreUrl);
      let el: SliccChatThread | null = null;
      try {
        el = mount((thread) => {
          thread.urlState = true;
          thread.style.cssText = 'display:block;height:120px;overflow-y:auto;';
        });
        const tall = document.createElement('div');
        tall.style.height = '1200px';
        el.replaceContent(tall);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        expect(el.scrollHeight - el.scrollTop - el.clientHeight).toBeLessThanOrEqual(1);

        tall.style.height = '1600px';
        await settleResize();
        expect(el.scrollHeight - el.scrollTop - el.clientHeight).toBeLessThanOrEqual(1);
      } finally {
        el?.remove();
        history.replaceState(null, '', originalUrl);
      }
    });

    it('re-emits child clicks as a delegated slicc-thread-action', async () => {
      const el = mount();
      const btn = document.createElement('button');
      btn.className = 'db';
      el.append(btn);
      const detail = await new Promise<{ target: HTMLElement }>((resolve) => {
        document.addEventListener(
          'slicc-thread-action',
          (e) => resolve((e as CustomEvent).detail),
          {
            once: true,
          }
        );
        btn.click();
      });
      expect(detail.target).toBe(btn);
    });

    it('removes the delegated click listener on disconnect', () => {
      const el = mount();
      const btn = document.createElement('button');
      el.append(btn);
      const col = inner(el);
      el.remove();
      let fired = false;
      document.addEventListener('slicc-thread-action', () => {
        fired = true;
      });
      // The column is detached and the listener removed — clicking is inert.
      col.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(fired).toBe(false);
    });

    it('scrollToBottom pins the wrapper to the latest message', () => {
      const el = mount();
      el.style.height = '120px';
      el.style.display = 'block';
      el.style.overflowY = 'auto';
      for (let i = 0; i < 40; i += 1) {
        const m = document.createElement('div');
        m.textContent = `line ${i}`;
        m.style.height = '24px';
        el.append(m);
      }
      el.scrollToBottom();
      // Allow for sub-pixel rounding at the scroll extent.
      expect(el.scrollTop).toBeGreaterThan(0);
      expect(el.scrollHeight - el.scrollTop - el.clientHeight).toBeLessThanOrEqual(1);
    });

    it('persists rounded at= positions during a continuous scroll without adding history', async () => {
      const originalUrl = window.location.href;
      const cleanUrl = new URL(originalUrl);
      cleanUrl.search = '';
      history.replaceState(null, '', cleanUrl);
      const historyDepth = history.length;
      let scrollTimer: number | undefined;
      let el: SliccChatThread | null = null;
      try {
        el = mount((thread) => {
          thread.urlState = true;
          thread.style.cssText = 'display:block;height:120px;overflow-y:auto;';
        });
        const thread = el;
        const tall = document.createElement('div');
        tall.style.height = '1200px';
        thread.replaceContent(tall);
        let position = 160.4;
        thread.scrollTop = position;
        thread.dispatchEvent(new Event('scroll'));
        expect(new URLSearchParams(window.location.search).get('at')).toBe('160');

        scrollTimer = window.setInterval(() => {
          position += 80.4;
          thread.scrollTop = position;
          thread.dispatchEvent(new Event('scroll'));
        }, 40);

        await new Promise((resolve) => setTimeout(resolve, 190));

        const liveAt = Number(new URLSearchParams(window.location.search).get('at'));
        expect(liveAt).toBeGreaterThan(Math.round(160.4));
        expect(Number.isInteger(liveAt)).toBe(true);
        expect(history.length).toBe(historyDepth);
      } finally {
        if (scrollTimer != null) clearInterval(scrollTimer);
        el?.remove();
        history.replaceState(null, '', originalUrl);
      }
    });
  });

  describe('new-messages follow chip', () => {
    /** A scrollable thread filled with enough content to overflow. */
    function mountScrollable(): SliccChatThread {
      const el = mount();
      el.style.height = '120px';
      el.style.display = 'block';
      el.style.overflowY = 'auto';
      for (let i = 0; i < 40; i += 1) {
        const m = document.createElement('div');
        m.textContent = `line ${i}`;
        m.style.height = '24px';
        el.append(m);
      }
      return el;
    }

    function chip(el: SliccChatThread): HTMLButtonElement {
      return el.querySelector('.slicc-thread__follow button') as HTMLButtonElement;
    }

    it('builds the sticky chip, hidden until has-new is set', () => {
      const el = mountScrollable();
      const follow = el.querySelector('.slicc-thread__follow') as HTMLElement;
      expect(follow).toBeTruthy();
      expect(getComputedStyle(follow).display).toBe('none');
      el.setAttribute('has-new', '');
      expect(getComputedStyle(follow).display).toBe('flex');
    });

    it('requestFollow scrolls when the viewer is near the bottom', () => {
      const el = mountScrollable();
      el.scrollToBottom();
      // Within FOLLOW_SLACK of the bottom counts as following.
      el.scrollTop -= SliccChatThread.FOLLOW_SLACK / 2;
      el.requestFollow();
      expect(el.scrollHeight - el.scrollTop - el.clientHeight).toBeLessThanOrEqual(1);
      expect(el.hasAttribute('has-new')).toBe(false);
    });

    it('requestFollow raises the chip instead of yanking a scrolled-away viewer', () => {
      const el = mountScrollable();
      el.scrollTop = 0;
      el.dispatchEvent(new Event('scroll'));
      el.requestFollow();
      expect(el.scrollTop).toBe(0);
      expect(el.hasAttribute('has-new')).toBe(true);
    });

    it('append() routes through requestFollow (chip when scrolled away)', () => {
      const el = mountScrollable();
      el.scrollTop = 0;
      el.dispatchEvent(new Event('scroll'));
      const m = document.createElement('div');
      m.textContent = 'new arrival';
      el.append(m);
      expect(el.scrollTop).toBe(0);
      expect(el.hasAttribute('has-new')).toBe(true);
    });

    it('clicking the chip scrolls to the bottom and clears has-new', () => {
      const el = mountScrollable();
      el.scrollTop = 0;
      el.dispatchEvent(new Event('scroll'));
      el.requestFollow();
      chip(el).click();
      expect(el.scrollHeight - el.scrollTop - el.clientHeight).toBeLessThanOrEqual(1);
      expect(el.hasAttribute('has-new')).toBe(false);
    });

    it('scrolling back near the bottom clears has-new without a click', () => {
      const el = mountScrollable();
      el.scrollTop = 0;
      el.dispatchEvent(new Event('scroll'));
      el.requestFollow();
      el.scrollTop = el.scrollHeight; // user scrolls down themselves
      el.dispatchEvent(new Event('scroll'));
      expect(el.hasAttribute('has-new')).toBe(false);
    });

    it('replaceContent clears a stale chip', () => {
      const el = mountScrollable();
      el.scrollTop = 0;
      el.dispatchEvent(new Event('scroll'));
      el.requestFollow();
      expect(el.hasAttribute('has-new')).toBe(true);
      el.replaceContent(document.createElement('div'));
      expect(el.hasAttribute('has-new')).toBe(false);
    });

    it('keeps a bottom-pinned viewer pinned after one large append', async () => {
      const el = mountScrollable();
      el.scrollToBottom();
      const arrival = document.createElement('div');
      arrival.style.height = `${SliccChatThread.FOLLOW_SLACK + 220}px`;
      el.append(arrival);

      await settleResize();

      expect(el.scrollHeight - el.scrollTop - el.clientHeight).toBeLessThanOrEqual(1);
      expect(el.hasAttribute('has-new')).toBe(false);
    });

    it('stays pinned through consecutive large appends', async () => {
      const el = mountScrollable();
      el.scrollToBottom();
      for (let i = 0; i < 3; i += 1) {
        const arrival = document.createElement('div');
        arrival.style.height = `${SliccChatThread.FOLLOW_SLACK + 120}px`;
        el.append(arrival);
        await settleResize();
        expect(el.scrollHeight - el.scrollTop - el.clientHeight).toBeLessThanOrEqual(1);
      }
      expect(el.hasAttribute('has-new')).toBe(false);
    });

    it('does not yank a deliberately scrolled-up viewer after a large append', async () => {
      const el = mountScrollable();
      const pinnedArrival = document.createElement('div');
      pinnedArrival.style.height = `${SliccChatThread.FOLLOW_SLACK + 220}px`;
      el.append(pinnedArrival);
      await settleResize();
      expect(el.scrollHeight - el.scrollTop - el.clientHeight).toBeLessThanOrEqual(1);

      el.scrollTop = 0;
      el.dispatchEvent(new Event('scroll'));
      const arrival = document.createElement('div');
      arrival.style.height = `${SliccChatThread.FOLLOW_SLACK + 220}px`;
      el.append(arrival);

      await settleResize();

      expect(el.scrollTop).toBe(0);
      expect(el.hasAttribute('has-new')).toBe(true);
    });

    it('re-arms following from the chip for subsequent large appends', async () => {
      const el = mountScrollable();
      el.scrollTop = 0;
      el.dispatchEvent(new Event('scroll'));
      el.append(Object.assign(document.createElement('div'), { textContent: 'first arrival' }));
      expect(el.hasAttribute('has-new')).toBe(true);

      chip(el).click();
      const arrival = document.createElement('div');
      arrival.style.height = `${SliccChatThread.FOLLOW_SLACK + 220}px`;
      el.append(arrival);
      await settleResize();

      expect(el.scrollHeight - el.scrollTop - el.clientHeight).toBeLessThanOrEqual(1);
      expect(el.hasAttribute('has-new')).toBe(false);
    });

    it('stays pinned when existing content grows without requestFollow', async () => {
      const el = mountScrollable();
      const lateContent = document.createElement('div');
      lateContent.style.height = '24px';
      el.append(lateContent);
      await settleResize();
      el.scrollToBottom();

      lateContent.style.height = `${SliccChatThread.FOLLOW_SLACK + 320}px`;
      await settleResize();

      expect(el.scrollHeight - el.scrollTop - el.clientHeight).toBeLessThanOrEqual(1);
      expect(el.hasAttribute('has-new')).toBe(false);
    });
  });

  describe('rail-toggle scroll re-anchor', () => {
    /** A scrollable thread filled with enough content to overflow. */
    function mountScrollable(): SliccChatThread {
      const el = mount();
      el.style.height = '120px';
      el.style.display = 'block';
      el.style.overflowY = 'auto';
      for (let i = 0; i < 40; i += 1) {
        const m = document.createElement('div');
        m.textContent = `line ${i}`;
        m.style.height = '24px';
        el.append(m);
      }
      return el;
    }

    it('re-anchors to the bottom when the rail toggles and the viewer was pinned there', () => {
      const el = mountScrollable();
      el.open = true; // rail open → tight padding
      el.scrollToBottom();
      // Closing the rail loosens the column padding (24/32 → 56/72), growing
      // scrollHeight; a bottom-pinned viewer must be re-pinned to the new bottom
      // rather than left stranded 64px above it.
      el.open = false;
      expect(el.scrollHeight - el.scrollTop - el.clientHeight).toBeLessThanOrEqual(1);
    });

    it('leaves a scrolled-up viewer where they are when the rail toggles', () => {
      const el = mountScrollable();
      el.scrollTop = 0;
      // A viewer parked in history is not following, so rail changes respect their position.
      el.open = true;
      expect(el.scrollTop).toBe(0);
    });

    it('re-anchors on CLOSE even when the viewer was near (not pixel-pinned to) the bottom', () => {
      // Regression: the CLOSE loosen (24/32 → 56/72) grows the column after the
      // viewer has already chosen to follow. The growth follow path must retain
      // that intent instead of re-measuring after the padding change and leaving
      // the newest message stranded below the fold.
      const el = mountScrollable();
      el.open = true; // rail open → tight padding
      el.scrollToBottom();
      // Ease off the bottom by half the slack: still "following" pre-toggle.
      el.scrollTop -= SliccChatThread.FOLLOW_SLACK / 2;
      expect(el.scrollHeight - el.scrollTop - el.clientHeight).toBeLessThanOrEqual(
        SliccChatThread.FOLLOW_SLACK
      );
      el.open = false; // CLOSE → padding loosens, column grows
      // Column growth keeps a following viewer pinned: newest message stays in view.
      expect(el.scrollHeight - el.scrollTop - el.clientHeight).toBeLessThanOrEqual(1);
    });

    it('does NOT re-anchor on CLOSE when the viewer is scrolled up in history', () => {
      // A reader parked in history is not following, so CLOSE-driven column
      // growth does not scroll them; their reading position stays fixed.
      const el = mountScrollable();
      el.open = true;
      el.scrollTop = 0;
      el.open = false;
      expect(el.scrollTop).toBe(0);
    });

    it('lets an intentional upward scroll mid-animation break the re-anchor pin', () => {
      // The persistent column-growth observer checks the explicit follow mode on
      // each delivery instead of re-measuring near-bottom geometry. If an upward
      // gesture lands during a guarded component write, the guard must preserve it
      // until the scroll event disarms following rather than yank the viewer down.
      const RealResizeObserver = globalThis.ResizeObserver;
      let capturedCb: ResizeObserverCallback | undefined;
      class FakeResizeObserver {
        constructor(cb: ResizeObserverCallback) {
          capturedCb = cb;
        }
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      }
      globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
      try {
        const el = mountScrollable();
        el.open = true; // rail open → tight padding
        el.scrollToBottom();
        el.open = false; // CLOSE while pinned → guarded synchronous follow write
        expect(capturedCb).toBeTypeOf('function');
        // The viewer deliberately scrolls up past FOLLOW_SLACK.
        el.scrollTop = 0;
        // A resize delivery arrives before the scroll event; preserve the upward gesture.
        capturedCb?.([], {} as ResizeObserver);
        expect(el.scrollTop).toBe(0);
      } finally {
        globalThis.ResizeObserver = RealResizeObserver;
      }
    });
  });
});
