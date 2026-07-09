import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';

/**
 * Per-instance stylesheet, lifted verbatim from the prototype's
 * `.msg.deleg` / `.msg.deleg.src` rules. The host *is* the `.msg.deleg`
 * line: layout, typography, and the hue-tinted `src` highlight all hang off
 * `:host`. The hue comes from the inherited `--c` custom property (set via the
 * `hue` attribute), falling back to `--violet` exactly like the prototype.
 *
 * All colors/spacing/fonts reference the inherited prototype tokens
 * (`--ui`, `--mono`, `--txt-2`, `--txt-3`, `--ghost`, `--line`, `--canvas`,
 * `--violet`); none are re-declared here.
 */
const STYLE = `
:host {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-family: var(--ui);
  font-size: 12px;
  color: var(--txt-2);
  margin: -4px 0 18px;
  padding: 7px 10px;
  border: 1px solid transparent;
  border-radius: 9px;
  transition: background .25s, border-color .25s;
}
:host([source]) {
  /* Mix the source tint over the inherited --canvas (which flips #fff -> dark
     with the theme), so the highlight tracks light/dark automatically without a
     fragile, Chromium-only :host-context() override. */
  background: color-mix(in srgb, var(--c, var(--violet)) 8%, var(--canvas));
  border-color: color-mix(in srgb, var(--c, var(--violet)) 28%, var(--line));
}
/* Slots disappear from layout so their content are direct flex children of the
   host — preserving the prototype's per-chip 8px gap + wrap. */
slot { display: contents; }
.darrow { color: var(--txt-3); flex: 0 0 auto; }
.label { display: contents; }
b { font-weight: 600; }
.scoop { font-weight: 600; }
code {
  font-family: var(--mono);
  font-size: 11.5px;
  background: var(--ghost);
  border-radius: 5px;
  padding: 1px 5px;
  overflow-wrap: anywhere;
  word-break: break-word;
}
`;

const SHEET = sheet(STYLE);

/** The delegation/event kinds this line can render. */
const KINDS = ['feed', 'scoop', 'drop', 'sprinkle'] as const;

/** A delegation/event kind — a scoop action (`feed`/`scoop`/`drop`) or a sprinkle. */
export type DelegationKind = (typeof KINDS)[number];

/** Leading lucide icon name per delegation/event kind. */
const GLYPH: Record<DelegationKind, string> = {
  feed: 'arrow-right', // feed_scoop — delegate work
  scoop: 'circle-plus', // scoop_scoop — spin up a sub-agent
  drop: 'circle-check', // drop_scoop — wrap up a sub-agent
  sprinkle: 'sparkles', // sprinkle-opened
};

/**
 * Human-readable default verb per kind — the developer-coded tool names
 * (`feed_scoop` / `scoop_scoop` / `drop_scoop`) are never shown to users; the
 * line reads as a friendly phrase instead. Sprinkle has no default verb (its
 * prose lives in the `label`).
 */
const KIND_VERB: Record<DelegationKind, string> = {
  feed: 'Delegated to',
  scoop: 'Spun up',
  drop: 'Wrapped up',
  sprinkle: '',
};

/**
 * Maps the internal tool/action names to the same human-readable labels, so a
 * caller that passes the raw action name through the `verb` attribute (e.g.
 * `feed_scoop`) still renders the friendly phrase. Unknown verbs pass through
 * verbatim, so free-text verbs keep working.
 */
const ACTION_LABELS: Record<string, string> = {
  feed_scoop: 'Delegated to',
  scoop_scoop: 'Spun up',
  drop_scoop: 'Wrapped up',
  'sprinkle-opened': 'Opened',
};

/** Resolve a verb to its human-readable label (raw action names → friendly phrase). */
function humanizeVerb(verb: string): string {
  return ACTION_LABELS[verb] ?? verb;
}

/** Normalize an arbitrary kind string to a known {@link DelegationKind} (default `feed`). */
function normalizeKind(value: string | null): DelegationKind {
  return (KINDS as readonly string[]).includes(value ?? '') ? (value as DelegationKind) : 'feed';
}

/** Split a comma/whitespace-free args attribute into discrete `<code>` chips. */
function parseArgs(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * `<slicc-delegation-line>` — the thin labeled "dust source" line from the
 * prototype chat stream (`.msg.deleg`). It marks a scoop delegation
 * (`→ feed_scoop`) or a sprinkle being opened (`✦ … opened`), hue-tinted via
 * the inherited `--c` custom property.
 *
 * Structure: a leading `.darrow` glyph, a label (bold colored scoop name +
 * surrounding prose), and inline `<code>` arg chips. The whole line lights up
 * with a hue-tinted background/border when `source` (the prototype's `.src`
 * active-source highlight) is set; dark mode re-bases the tint over `--canvas`.
 *
 * The default content (glyph · verb · `<b>` scoop · prose · args) is built from
 * attributes, but the three regions are named `<slot>`s (`arrow`, `label`,
 * `args`), each `display:contents`, so a host can override any region with
 * richer markup while keeping the per-chip flex layout + line styling.
 *
 * @attr kind - `feed` (delegate, default) | `scoop` (spin up) | `drop` (wrap up) | `sprinkle`
 * @attr hue - accent hex/CSS color; sets the inherited `--c` (label + tint)
 * @attr verb - the verb/connector text; raw action names (`feed_scoop`,
 *   `scoop_scoop`, `drop_scoop`) are humanized, free text passes through
 * @attr scoop - the bold, hue-colored scoop/sprinkle name
 * @attr label - trailing prose after the scoop name (e.g. `opened …`)
 * @attr args - comma-separated values rendered as `<code>` chips
 * @attr source - boolean; the active-source highlight (tinted bg/border in `--c`)
 * @csspart arrow - the leading glyph
 * @csspart label - the label/prose region (verb + scoop + trailing prose)
 * @csspart scoop - the bold colored scoop name
 * @csspart code - each inline arg chip
 * @slot arrow - overrides the leading glyph
 * @slot label - overrides the whole prose region (verb + scoop + prose)
 * @slot args - overrides the inline `<code>` arg chips
 */
export class SliccDelegationLine extends HTMLElement {
  static readonly observedAttributes = ['kind', 'hue', 'verb', 'scoop', 'label', 'args', 'source'];

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

  /** Delegation kind — `feed` / `scoop` / `drop` (scoop actions) or `sprinkle`. */
  get kind(): DelegationKind {
    return normalizeKind(this.getAttribute('kind'));
  }

  set kind(value: DelegationKind) {
    this.setAttribute('kind', normalizeKind(value));
  }

  /** Accent hue (sets the inherited `--c`); `null` falls back to `--violet`. */
  get hue(): string | null {
    return this.getAttribute('hue');
  }

  set hue(value: string | null) {
    if (value == null) this.removeAttribute('hue');
    else this.setAttribute('hue', value);
  }

  /** Verb/connector text (default `feed_scoop` for the feed kind). */
  get verb(): string | null {
    return this.getAttribute('verb');
  }

  set verb(value: string | null) {
    if (value == null) this.removeAttribute('verb');
    else this.setAttribute('verb', value);
  }

  /** The bold, hue-colored scoop / sprinkle name. */
  get scoop(): string | null {
    return this.getAttribute('scoop');
  }

  set scoop(value: string | null) {
    if (value == null) this.removeAttribute('scoop');
    else this.setAttribute('scoop', value);
  }

  /** Trailing prose after the scoop name. */
  get label(): string | null {
    return this.getAttribute('label');
  }

  set label(value: string | null) {
    if (value == null) this.removeAttribute('label');
    else this.setAttribute('label', value);
  }

  /** Comma-separated arg values rendered as inline `<code>` chips. */
  get args(): string | null {
    return this.getAttribute('args');
  }

  set args(value: string | null) {
    if (value == null) this.removeAttribute('args');
    else this.setAttribute('args', value);
  }

  /** The active-source highlight (prototype `.src`): tinted bg/border in `--c`. */
  get source(): boolean {
    return this.hasAttribute('source');
  }

  set source(value: boolean) {
    this.toggleAttribute('source', value);
  }

  #render(): void {
    const kind = this.kind;
    const hue = this.hue;
    const rawVerb = this.verb;
    const verb = rawVerb != null ? humanizeVerb(rawVerb) : KIND_VERB[kind];
    const scoop = this.scoop;
    const label = this.label;
    const args = this.args ? parseArgs(this.args) : [];

    // Inline `--c` so the hue inherits into the host (and out to children).
    if (hue) this.style.setProperty('--c', hue);
    else this.style.removeProperty('--c');

    // Leading glyph slot — a live lucide <svg> as the default content.
    const arrowSlot = h('slot', { name: 'arrow' }, iconEl(GLYPH[kind], { size: 13 }));
    const arrowSpan = h('span', { class: 'darrow', part: 'arrow' }, arrowSlot);

    // Label slot — verb + bold scoop name + trailing prose as default content.
    const labelSlot = h('slot', { name: 'label' });
    if (verb) labelSlot.append(h('span', { class: 'verb' }, verb));
    if (scoop) {
      labelSlot.append(
        h('b', { class: 'scoop', part: 'scoop', style: hue ? `color:${hue}` : undefined }, scoop)
      );
    }
    if (label) labelSlot.append(h('span', { class: 'prose' }, label));
    const labelSpan = h('span', { class: 'label', part: 'label' }, labelSlot);

    // Args slot — one <code> chip per arg as default content.
    const argsSlot = h('slot', { name: 'args' });
    for (const a of args) argsSlot.append(h('code', { part: 'code' }, a));

    this.#root.replaceChildren(arrowSpan, labelSpan, argsSlot);
  }
}

define('slicc-delegation-line', SliccDelegationLine);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-delegation-line': SliccDelegationLine;
  }
}
