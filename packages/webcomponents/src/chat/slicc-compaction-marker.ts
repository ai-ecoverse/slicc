import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';

/**
 * The seam shares the day separator's geometry — a centered caption flanked by
 * hairlines that fill each side — because it means the same thing to a reader:
 * "the thread is discontinuous here". What it adds is a chip: a compaction is
 * something that HAPPENED, with a state and an artifact, not just a label.
 *
 * Every color is an inherited prototype token, so the marker flips with the
 * theme without a `:host-context()` override. `--amber` backs the degraded
 * state; a token-less build falls back to a literal so a truncation is never
 * silently painted as an ordinary compaction.
 */
const STYLE = `
:host {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 20px 0 18px;
  font-family: var(--ui);
  font-size: 11px;
  color: var(--txt-3);
}
:host([hidden]) { display: none; }
/*
 * The flanking hairlines. Each pseudo-element MUST carry content, a non-zero
 * height and a visible background or the line collapses to nothing.
 */
:host::before,
:host::after {
  content: "";
  flex: 1 1 0;
  height: 1px;
  min-width: 0;
  background: var(--line, #e5e5e5);
}
.chip {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 1 auto;
  min-width: 0;
  padding: 4px 10px;
  border: 1px solid var(--line, #e5e5e5);
  border-radius: 999px;
  background: var(--ghost);
  letter-spacing: .02em;
}
.glyph { flex: 0 0 auto; display: flex; }
.label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
/*
 * The degraded state is the one a reader must not skim past: older messages
 * were dropped with no summary standing in for them.
 */
:host([state="fallback"]) .chip {
  /* Amber straight would be unreadable as 11px text on the light canvas, so
     the ink is amber MIXED toward --ink: tinted in both themes, legible in
     both. The border and wash carry the hue at full strength. */
  color: color-mix(in srgb, var(--amber, #f59e0b) 55%, var(--ink));
  border-color: color-mix(in srgb, var(--amber, #f59e0b) 45%, var(--line, #e5e5e5));
  background: color-mix(in srgb, var(--amber, #f59e0b) 12%, var(--canvas));
}
/*
 * In flight: a slow opacity breath, not a spinner. A CSS animation (unlike a
 * rAF loop) needs no frame budget and pauses with the tab on its own.
 */
:host([state="summarizing"]) .chip { animation: slicc-compaction-breathe 1.6s ease-in-out infinite; }
@keyframes slicc-compaction-breathe {
  0%, 100% { opacity: 1; }
  50% { opacity: .55; }
}
@media (prefers-reduced-motion: reduce) {
  :host([state="summarizing"]) .chip { animation: none; }
}
/*
 * The transcript affordance is a real <button>: it is the only way back to
 * what the summary replaced, so it must be reachable from the keyboard.
 */
.path {
  flex: 0 1 auto;
  min-width: 0;
  /* Wide enough for a whole snapshot name (live-cone-ID-HASH.md, ~26 chars) —
     a filename ellipsed mid-id identifies nothing. Narrower viewports still
     ellipse it via min-width:0 rather than pushing the chip out. */
  max-width: 30ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  appearance: none;
  border: 0;
  padding: 0;
  background: none;
  color: inherit;
  font: inherit;
  font-family: var(--mono);
  font-size: 10.5px;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
  opacity: .8;
}
.path:hover, .path:focus-visible { opacity: 1; }
`;

const SHEET = sheet(STYLE);

/** What started the round; mirrors `CompactionMarkerTrigger` on the wire. */
const TRIGGERS = ['threshold', 'overflow', 'idle'] as const;
export type CompactionMarkerTrigger = (typeof TRIGGERS)[number];

/**
 * How the round ended. `discarded` is deliberately absent: a round that kept
 * nothing has no row, so the host removes the element rather than rendering a
 * fourth state.
 */
const STATES = ['summarizing', 'summarized', 'fallback'] as const;
export type CompactionMarkerState = (typeof STATES)[number];

/** Leading glyph per state — the state, not the trigger, decides the icon. */
const GLYPH: Record<CompactionMarkerState, string> = {
  summarizing: 'loader',
  summarized: 'archive',
  fallback: 'triangle-alert',
};

/**
 * The copy, keyed by state and then trigger. This table is the web half of a
 * pair: `CompactionMarkerRow` in the iOS follower holds the same one, because
 * the wire carries STATE, not prose (see `ChatCompactionMarker` in
 * `@slicc/shared-ts`). Change one, change the other.
 */
const LABEL: Record<CompactionMarkerState, Record<CompactionMarkerTrigger, string>> = {
  summarizing: {
    idle: 'Idle — compacting history in the background',
    threshold: 'Context filling up — compacting history',
    overflow: 'Context overflowed — compacting history',
  },
  summarized: {
    idle: 'Compacted while idle',
    threshold: 'History compacted',
    overflow: 'Context overflowed — history compacted',
  },
  // Trigger-independent on purpose: once the summary failed, WHY the round
  // started stops mattering to a reader. What they need is that context is
  // gone with nothing standing in for it.
  fallback: {
    idle: 'Summary unavailable — older messages truncated',
    threshold: 'Summary unavailable — older messages truncated',
    overflow: 'Summary unavailable — older messages truncated',
  },
};

function normalizeTrigger(value: string | null): CompactionMarkerTrigger {
  return (TRIGGERS as readonly string[]).includes(value ?? '')
    ? (value as CompactionMarkerTrigger)
    : 'threshold';
}

function normalizeState(value: string | null): CompactionMarkerState {
  return (STATES as readonly string[]).includes(value ?? '')
    ? (value as CompactionMarkerState)
    : 'summarized';
}

/** Last path segment, for the chip's visible label; the full path is the title. */
function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

/**
 * `<slicc-compaction-marker>` — the thread seam marking one context-compaction
 * round: a hairline rule broken by a small chip that names what happened and,
 * when a snapshot was written, links to it.
 *
 * It exists because a compaction is not something anyone SAID. Rendering it as
 * an assistant bubble put the model's voice on a piece of bookkeeping, and the
 * fake assistant turn it took to get there stranded the composer in its busy
 * state for the rest of the session (#2843).
 *
 * The wire carries state, never prose: `trigger` + `state` select the copy from
 * a table this component owns, so the same envelope reads correctly here and in
 * the iOS follower without either side shipping the other's wording.
 *
 * @attr trigger - `threshold` (default) | `overflow` | `idle`
 * @attr state - `summarizing` (in flight) | `summarized` (default) | `fallback` (truncated, no summary)
 * @attr transcript - `/sessions` path of the pre-compaction snapshot; renders the link chip
 * @attr label - overrides the derived copy entirely
 * @csspart chip - the pill holding glyph, label and transcript link
 * @csspart glyph - the leading state icon
 * @csspart label - the copy
 * @csspart path - the transcript link button
 * @fires slicc-compaction-transcript - `{ path }`, composed + bubbling, on link activation
 */
export class SliccCompactionMarker extends HTMLElement {
  static readonly observedAttributes = ['trigger', 'state', 'transcript', 'label'];

  readonly #root: ShadowRoot;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [SHEET];
  }

  connectedCallback(): void {
    this.#render();
  }

  attributeChangedCallback(): void {
    if (this.isConnected) this.#render();
  }

  /** What started the round. */
  get trigger(): CompactionMarkerTrigger {
    return normalizeTrigger(this.getAttribute('trigger'));
  }

  set trigger(value: CompactionMarkerTrigger) {
    this.setAttribute('trigger', normalizeTrigger(value));
  }

  /** How the round ended. */
  get state(): CompactionMarkerState {
    return normalizeState(this.getAttribute('state'));
  }

  set state(value: CompactionMarkerState) {
    this.setAttribute('state', normalizeState(value));
  }

  /** `/sessions` path of the pre-compaction transcript, or `null`. */
  get transcript(): string | null {
    return this.getAttribute('transcript');
  }

  set transcript(value: string | null) {
    if (value == null) this.removeAttribute('transcript');
    else this.setAttribute('transcript', value);
  }

  /** Copy override; `null` derives it from `trigger` + `state`. */
  get label(): string | null {
    return this.getAttribute('label');
  }

  set label(value: string | null) {
    if (value == null) this.removeAttribute('label');
    else this.setAttribute('label', value);
  }

  #render(): void {
    const state = this.state;
    const trigger = this.trigger;
    // Reflect the normalized values so the state/trigger selectors match even
    // when the host set an unknown value (or none at all).
    if (this.getAttribute('state') !== state) this.setAttribute('state', state);
    if (this.getAttribute('trigger') !== trigger) this.setAttribute('trigger', trigger);

    const label = this.label ?? LABEL[state][trigger];
    const chip = h(
      'span',
      { class: 'chip', part: 'chip' },
      h('span', { class: 'glyph', part: 'glyph' }, iconEl(GLYPH[state], { size: 12 })),
      h('span', { class: 'label', part: 'label' }, label)
    );

    const path = this.transcript;
    if (path) {
      const button = h(
        'button',
        {
          class: 'path',
          part: 'path',
          type: 'button',
          title: path,
          'aria-label': `Open the pre-compaction transcript ${path}`,
        },
        basename(path)
      );
      button.addEventListener('click', () => {
        this.dispatchEvent(
          new CustomEvent('slicc-compaction-transcript', {
            detail: { path },
            bubbles: true,
            composed: true,
          })
        );
      });
      chip.append(button);
    }

    // `role="status"` and not `alert`: a compaction is worth announcing once
    // it lands, never worth interrupting what a screen reader is reading.
    this.#root.replaceChildren(chip);
    if (!this.hasAttribute('role')) this.setAttribute('role', 'status');
  }
}

define('slicc-compaction-marker', SliccCompactionMarker);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-compaction-marker': SliccCompactionMarker;
  }
}
