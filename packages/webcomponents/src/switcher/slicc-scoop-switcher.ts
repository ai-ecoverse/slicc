import { define } from '../internal/define.js';
import { escapeHtml } from '../internal/html.js';
// The switcher instantiates <slicc-pill> chips and the <slicc-scoop-overflow>
// more-popup, so it owns their registration (side-effect imports) — otherwise
// the created elements would be inert empty boxes.
import '../pill/slicc-pill.js';
import './slicc-scoop-overflow.js';
import type {
  SliccScoopOverflow,
  SliccScoopOverflowItem,
  SliccScoopSelectDetail,
} from './slicc-scoop-overflow.js';

/**
 * One scoop chip descriptor. The switcher renders one `<slicc-pill class="scoop">`
 * per entry, cone-first. Lifted from the prototype's `SCOOP_COLORS` /
 * `SHADER_FOR` data shape (`proto/StellarRubySwift.html`). The `key` is the
 * prototype's `data-k` — it is also the `id` forwarded in the select event and
 * fed to the overflow popup.
 */
export interface ScoopDescriptor {
  /** Stable key (the prototype's `data-k`); emitted on select + reflected to `data-k`. */
  key: string;
  /** Glyph type — `cone` for the leader chip, `scoop` for everything else. */
  type?: 'cone' | 'scoop';
  /** Accent hex; the pill glyph + the chip's `--h` hue derive from it. */
  color?: string;
  /** Chip label text (falls back to the key). */
  label?: string;
  /** Eye state forwarded to the pill (`open` | `none` | `dead`). */
  eyes?: 'open' | 'none' | 'dead';
  /** Marks an ephemeral (auto-spawned, transient) scoop chip. */
  ephemeral?: boolean;
}

/**
 * The `slicc-scoop-select` detail. Extends the overflow's shared
 * {@link SliccScoopSelectDetail} (`{ id, label }`) with the prototype's `key`
 * (== `id`) so consumers can read either name. The global
 * `HTMLElementEventMap['slicc-scoop-select']` declaration is owned by
 * `slicc-scoop-overflow`; this widening shape is runtime-compatible with it.
 */
export interface ScoopSelectDetail extends SliccScoopSelectDetail {
  /** The selected scoop's key (identical to {@link SliccScoopSelectDetail.id}). */
  key: string;
}

/**
 * Per-`data-k` hue map, lifted verbatim from the prototype switcher CSS
 * (`.scoop[data-k=cone]{--h:var(--waffle)}` …). The hue drives the active fill
 * and the `lit` landing glow. Unknown keys fall back to `--rose` (the prototype
 * `.scoop` default).
 */
const DATA_K_HUE: Record<string, string> = {
  cone: 'var(--waffle)',
  researcher: 'var(--cyan)',
  designer: 'var(--violet)',
  tester: 'var(--amber)',
  triage: 'var(--green)',
};

/** Reserve ~40px for the `⋯` more-button when computing the chip budget (prototype `MORE_RESERVE`). */
const MORE_RESERVE = 40;
/** Inter-chip gap in px — matches `.switcher{gap:6px}` so width math stays exact. */
const CHIP_GAP = 6;

/**
 * Scoped, document-level stylesheet for `<slicc-scoop-switcher>`. A light-DOM
 * host can't carry a shadow-root `<style>`, so the `.switcher` chrome is injected
 * once into the host document (idempotent), lifted verbatim from the prototype
 * (`proto/StellarRubySwift.html` `.switcher` / `.scoop` rules). The host class
 * `.slicc-scoop-switcher` scopes every rule so it can't leak.
 *
 * The legacy `.scoop` chrome (border, dot, padding) is intentionally stripped on
 * the `slicc-pill.scoop` host because the pill draws its own chip in shadow DOM —
 * exactly as the prototype does. The `data-k` hue, the `lit` glow, and
 * `display:none` for overflow-hidden chips live here on the host so they survive
 * the shadow boundary.
 */
const STYLE = `
.slicc-scoop-switcher {
  display: flex;
  gap: ${CHIP_GAP}px;
  flex-wrap: nowrap;
  min-width: 0;
  overflow: hidden;
}
/* Each chip carries an explicit width: as a flex item the pill is blockified,
   so its inline-block shadow content no longer establishes an intrinsic size and
   the chip (and the whole switcher) would collapse to 0. --pill-w is the pill's
   own width token. */
.slicc-scoop-switcher .scoop { flex: 0 0 auto; width: var(--pill-w, 140px); --h: var(--rose); }
.slicc-scoop-switcher .scoop[data-k=cone] { --h: var(--waffle); }
.slicc-scoop-switcher .scoop[data-k=researcher] { --h: var(--cyan); }
.slicc-scoop-switcher .scoop[data-k=designer] { --h: var(--violet); }
.slicc-scoop-switcher .scoop[data-k=tester] { --h: var(--amber); }
.slicc-scoop-switcher .scoop[data-k=triage] { --h: var(--green); }
.slicc-scoop-switcher .scoop.hide { display: none; }
/* slicc-pill renders its own pill in shadow DOM — strip the legacy .scoop chrome
   on the host so only the pill's own rounded chip shows (prototype Wave 11d). */
.slicc-scoop-switcher slicc-pill.scoop {
  display: inline-block;
  padding: 0;
  border: none;
  background: transparent;
  border-radius: 9999px;
  --pill-w: 140px;
  line-height: 1;
  vertical-align: middle;
}
.slicc-scoop-switcher slicc-pill.scoop::part(icon) { width: 27px; height: 27px; }
.slicc-scoop-switcher slicc-pill.scoop::part(pill) { outline: none; }
.slicc-scoop-switcher slicc-pill.scoop:focus,
.slicc-scoop-switcher slicc-pill.scoop:focus-visible { outline: none; }
/* landing glow ("lit") — a 3px hue ring; re-tints over --canvas in dark mode */
.slicc-scoop-switcher slicc-pill.scoop.lit::part(pill) {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--h) 45%, transparent);
}
.dark .slicc-scoop-switcher slicc-pill.scoop.lit::part(icon),
[data-theme="dark"] .slicc-scoop-switcher slicc-pill.scoop.lit::part(icon) {
  background: color-mix(in srgb, var(--h) 24%, var(--canvas));
}
`;

const STYLE_ID = 'slicc-scoop-switcher-style';

/** Inject the scoped switcher stylesheet into a document once (idempotent). */
function ensureSwitcherStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/** Resolve a scoop's hue token from its key (prototype `data-k` map → `--rose` fallback). */
function hueForKey(key: string): string {
  return DATA_K_HUE[key] ?? 'var(--rose)';
}

/** Read a `slicc-pill`'s eye attribute, normalizing to the pill's accepted set. */
function eyesOf(el: Element, fallback: 'open' | 'none' | 'dead'): 'open' | 'none' | 'dead' {
  const e = el.getAttribute('eyes');
  return e === 'open' || e === 'none' || e === 'dead' ? e : fallback;
}

/**
 * `<slicc-scoop-switcher>` — the horizontal scoop-chip row from the prototype nav
 * (`.switcher`). Composes one `<slicc-pill class="scoop">` per scoop (cone first,
 * then scoops), tracks the active chip, and collapses chips that don't fit into a
 * `<slicc-scoop-overflow>` more-popup via a `ResizeObserver` reflow — the cone
 * (first) chip is never hidden.
 *
 * Light DOM (no shadow root): the host renders the chips into itself so the host
 * app can style/slot them; the scoped stylesheet is injected once into the host
 * document. Slotted `slicc-pill` children present at connect time are adopted into
 * the `scoops` list, then the declarative `scoops` property takes over.
 *
 * The overflow popup is composed BY TAG (`<slicc-scoop-overflow>`); it is created
 * lazily as a sibling after the row on first overflow and fed the hidden chips via
 * its `items` property. Both the row and the popup emit the same
 * `slicc-scoop-select` event; the switcher re-emits the popup's selection as the
 * canonical source so the active chip stays in sync.
 *
 * @attr active - the key of the active chip (reflected to/from the `active` property)
 * @csspart row - the chip row (the host element itself carries `part="row"`)
 * @slot - pre-existing `slicc-pill` children, adopted into `scoops` at connect time
 * @fires slicc-scoop-select - a chip was clicked; `detail` is {@link ScoopSelectDetail}
 *   (`{ id, key, label }`, where `id === key`)
 */
export class SliccScoopSwitcher extends HTMLElement {
  static get observedAttributes(): string[] {
    return ['active'];
  }

  #scoops: ScoopDescriptor[] = [];
  #overflow: SliccScoopOverflow | null = null;
  #ro: ResizeObserver | null = null;
  /** Guards against ResizeObserver re-entering reflow mid-pass. */
  #reflowing = false;
  #onClick: ((e: Event) => void) | null = null;
  #initialized = false;

  connectedCallback(): void {
    ensureSwitcherStyle(this.ownerDocument);
    this.classList.add('slicc-scoop-switcher');
    this.setAttribute('part', 'row');
    if (!this.#initialized) {
      this.#adoptSlotted();
      this.#initialized = true;
    }
    if (!this.#onClick) {
      this.#onClick = (e: Event) => this.#handleClick(e);
      this.addEventListener('click', this.#onClick);
    }
    this.#render();
    this.#observe();
    // Initial reflow after layout settles (mirrors the prototype's
    // requestAnimationFrame double-pass).
    requestAnimationFrame(() => this.reflow());
  }

  disconnectedCallback(): void {
    this.#ro?.disconnect();
    this.#ro = null;
    if (this.#onClick) {
      this.removeEventListener('click', this.#onClick);
      this.#onClick = null;
    }
  }

  attributeChangedCallback(name: string): void {
    if (name === 'active' && this.#initialized) this.#syncActive();
  }

  /** The scoop list. Cone-first ordering is the caller's responsibility (the
   *  reflow never hides the FIRST chip, so put the cone there). Returns a copy. */
  get scoops(): ScoopDescriptor[] {
    return this.#scoops.map((s) => ({ ...s }));
  }

  set scoops(value: ScoopDescriptor[]) {
    this.#scoops = Array.isArray(value) ? value.map((s) => ({ ...s })) : [];
    if (this.#initialized && this.isConnected) {
      this.#render();
      this.reflow();
    }
  }

  /** The active scoop key (reflected to the `active` attribute). */
  get active(): string | null {
    return this.getAttribute('active');
  }

  set active(value: string | null) {
    if (value == null) this.removeAttribute('active');
    else this.setAttribute('active', value);
  }

  /**
   * Recompute overflow: measure each chip against the available width and hide
   * (`.hide`) the chips that don't fit, feeding them to the
   * `<slicc-scoop-overflow>` popup. The FIRST chip (the cone) is never hidden.
   * Lifted from the prototype's `reflow()` — public so a host can force a pass
   * after a layout change.
   */
  reflow(): void {
    if (!this.isConnected || this.#reflowing) return;
    this.#reflowing = true;
    try {
      this.#reflowOnce();
    } finally {
      this.#reflowing = false;
    }
  }

  #reflowOnce(): void {
    const chips = [...this.querySelectorAll<HTMLElement>('slicc-pill.scoop')];
    // Reset so previously-hidden chips can be re-measured at full width.
    for (const c of chips) c.classList.remove('hide');
    const visible = chips.filter((c) => c.offsetParent !== null || c.offsetWidth > 0);
    if (visible.length === 0) {
      this.#feedOverflow([]);
      return;
    }
    // Available width is the switcher's OWN box (overflow:hidden, sized by the
    // nav) — a stable measurement. Do NOT fold in the more-button width: it
    // exists only while overflowing, so adding it makes the overflow decision
    // flip-flop on every ResizeObserver tick and the boundary chip flickers at
    // frame rate. Room for the more-button is reserved below via MORE_RESERVE.
    const avail = this.clientWidth;
    // Not laid out yet (width 0): show every chip and retry once layout settles,
    // rather than hiding everything against a bogus 0 width.
    if (avail <= 0) {
      this.#feedOverflow([]);
      requestAnimationFrame(() => {
        if (this.isConnected && this.clientWidth > 0) this.reflow();
      });
      return;
    }
    const widths = visible.map((c) => c.offsetWidth + CHIP_GAP);
    const total = widths.reduce((a, b) => a + b, 0);
    if (total <= avail + 1) {
      this.#feedOverflow([]);
      return;
    }
    // Overflow path: reserve room for the more-button; never hide the first chip.
    const budget = Math.max(0, avail - MORE_RESERVE);
    const hidden: HTMLElement[] = [];
    let used = 0;
    visible.forEach((c, i) => {
      if (i === 0) {
        used += widths[i];
        return;
      }
      if (used + widths[i] <= budget) used += widths[i];
      else {
        c.classList.add('hide');
        hidden.push(c);
      }
    });
    this.#feedOverflow(hidden);
  }

  /** Programmatic selection: set the active chip and emit `slicc-scoop-select`. */
  select(key: string): void {
    this.active = key;
    const label = this.#scoops.find((s) => s.key === key)?.label ?? key;
    this.dispatchEvent(
      new CustomEvent<ScoopSelectDetail>('slicc-scoop-select', {
        detail: { id: key, key, label },
        bubbles: true,
        composed: true,
      })
    );
  }

  /** Adopt any slotted `slicc-pill` children into the `scoops` list (light DOM
   *  has no native `<slot>`, so we read them once at connect time, then rebuild
   *  them canonically via `#render`). */
  #adoptSlotted(): void {
    const pills = [...this.querySelectorAll<HTMLElement>('slicc-pill')];
    if (pills.length === 0) return;
    const adopted: ScoopDescriptor[] = pills.map((p) => {
      const key = p.dataset.k ?? p.getAttribute('label') ?? '';
      const type = p.getAttribute('type') === 'cone' ? 'cone' : 'scoop';
      return {
        key,
        type,
        color: p.getAttribute('color') ?? undefined,
        label: p.getAttribute('label') ?? key,
        eyes: eyesOf(p, type === 'cone' ? 'open' : 'none'),
        ephemeral: p.classList.contains('ephemeral'),
      };
    });
    for (const p of pills) p.remove();
    if (this.#scoops.length === 0) this.#scoops = adopted;
  }

  /** Rebuild the chip row from the scoop list (cone-first ordering preserved). */
  #render(): void {
    const active = this.active;
    const html = this.#scoops
      .map((s) => {
        const key = s.key;
        const type = s.type === 'cone' || key === 'cone' ? 'cone' : 'scoop';
        const color = s.color ?? '';
        const label = s.label ?? key;
        const eyes = s.eyes ?? (type === 'cone' ? 'open' : 'none');
        const isActive = active != null && active === key;
        const cls = `scoop${s.ephemeral ? ' ephemeral' : ''}`;
        const hue = hueForKey(key);
        return (
          `<slicc-pill class="${cls}" data-k="${escapeHtml(key)}" type="${type}"` +
          (color ? ` color="${escapeHtml(color)}"` : '') +
          ` eyes="${eyes}" label="${escapeHtml(label)}"` +
          (isActive ? ' active' : '') +
          ` style="--h:${hue}"></slicc-pill>`
        );
      })
      .join('');
    this.innerHTML = html;
  }

  /** Toggle the `active` class/attribute on chips to match the `active` property
   *  without a full rebuild (keeps pill eye-state/tracking listeners intact). */
  #syncActive(): void {
    const active = this.active;
    for (const c of this.querySelectorAll<HTMLElement>('slicc-pill.scoop')) {
      const on = c.dataset.k === active;
      c.classList.toggle('active', on);
      c.toggleAttribute('active', on);
    }
  }

  /** Hand the overflow set to the composed `<slicc-scoop-overflow>` element,
   *  mapping hidden chips to {@link SliccScoopOverflowItem}s. */
  #feedOverflow(hidden: HTMLElement[]): void {
    if (hidden.length === 0) {
      if (this.#overflow) this.#overflow.items = [];
      return;
    }
    const ofl = this.#ensureOverflow();
    ofl.items = hidden.map((c) => {
      const id = c.dataset.k ?? '';
      return {
        id,
        label: c.getAttribute('label') ?? id,
        type: c.getAttribute('type') === 'cone' ? 'cone' : 'scoop',
        color: c.getAttribute('color') ?? undefined,
        eyes: eyesOf(c, c.getAttribute('type') === 'cone' ? 'open' : 'none'),
      };
    });
  }

  /** Create + wire the overflow element on first use (composed BY TAG). It lives
   *  as a sibling right after the row so it can position its popup. */
  #ensureOverflow(): SliccScoopOverflow {
    if (this.#overflow) return this.#overflow;
    const ofl = this.ownerDocument.createElement('slicc-scoop-overflow') as SliccScoopOverflow;
    // The popup emits the same select event; forward it as the switcher's own so
    // the active chip + the canonical event source stay unified.
    ofl.addEventListener('slicc-scoop-select', (e: Event) => {
      const id = (e as CustomEvent<SliccScoopSelectDetail>).detail?.id;
      if (typeof id === 'string') {
        e.stopPropagation();
        this.select(id);
      }
    });
    this.after(ofl);
    this.#overflow = ofl;
    return ofl;
  }

  /** Click delegation → select the clicked chip and emit `slicc-scoop-select`. */
  #handleClick(e: Event): void {
    const target = e.target as HTMLElement | null;
    const chip = target?.closest<HTMLElement>('slicc-pill.scoop');
    if (!chip || !this.contains(chip)) return;
    const key = chip.dataset.k;
    if (key) this.select(key);
  }

  /** Start the reflow ResizeObserver (idempotent). Observes the host so the chip
   *  budget tracks the actual row width. */
  #observe(): void {
    if (this.#ro || typeof ResizeObserver === 'undefined') return;
    this.#ro = new ResizeObserver(() => this.reflow());
    this.#ro.observe(this);
  }
}

define('slicc-scoop-switcher', SliccScoopSwitcher);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-scoop-switcher': SliccScoopSwitcher;
  }
}
