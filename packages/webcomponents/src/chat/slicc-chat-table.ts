import { define } from '../internal/define.js';
import { h } from '../internal/dom.js';

/**
 * Scoped, document-level stylesheet for `<slicc-chat-table>`. Light-DOM
 * components cannot carry an inline `<style>` in a shadow root, so the chrome is
 * injected once into the host document (idempotent) and selected by the host
 * class on the generated `<table class="ctable">`.
 *
 * Lifted verbatim from the prototype `.ctable` block
 * (proto/StellarRubySwift.html): the rounded 1px-bordered in-chat data table
 * with a `var(--ghost)` small-caps header, `var(--line)` row rules, an
 * emphasized (`var(--ink)`) first cell, muted-current (`.was`) and
 * green-proposed (`.now`, fixed `#1a7f37`) value tones, and inline `<code>`
 * chips. Everything else is var-driven (--ghost / --line / --txt-2 / --ink /
 * --mono) so dark mode flips automatically via the inherited theme scope.
 */
const STYLE = `
slicc-chat-table { display: block; }
slicc-chat-table > .ctable {
  width: 100%;
  border-collapse: collapse;
  margin: 2px 0 18px;
  font-size: 13px;
  border: 1px solid var(--line);
  border-radius: 11px;
  overflow: hidden;
}
slicc-chat-table > .ctable thead th {
  background: var(--ghost);
  text-align: left;
  font-weight: 600;
  font-size: 11px;
  letter-spacing: .02em;
  color: var(--txt-2);
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
}
slicc-chat-table > .ctable td {
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
}
slicc-chat-table > .ctable tr:last-child td { border-bottom: none; }
slicc-chat-table > .ctable td:first-child {
  font-weight: 500;
  color: var(--ink);
}
slicc-chat-table > .ctable .was { color: var(--txt-2); }
slicc-chat-table > .ctable .now { color: #1a7f37; font-weight: 500; }
slicc-chat-table > .ctable code {
  font-family: var(--mono);
  font-size: 11.5px;
  background: var(--ghost);
  border-radius: 5px;
  padding: 1px 5px;
}
`;

const STYLE_ID = 'slicc-chat-table-style';

/** Inject the scoped table stylesheet into a document once (idempotent). */
function ensureTableStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/** Split a comma-separated attribute into trimmed, non-empty tokens. */
function splitHeaders(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * `<slicc-chat-table>` — the in-chat data table (`.ctable`) from the prototype:
 * a rounded 1px-bordered comparison table with a ghost-bg small-caps `<thead>`,
 * `<tbody>` rows whose first cell is emphasized and whose value cells carry the
 * muted-current (`.was`) / green-proposed (`.now`) tones, often wrapping inline
 * `<code>` chips.
 *
 * Light DOM (no shadow root): the host renders its own `<table class="ctable">`
 * scaffold and relocates light children into the head/body regions so the host
 * app can style it and populate rows directly. This element is presentational —
 * rows are slotted or written by the host; there is no internal state.
 *
 * Population:
 * - **Slotted (primary):** put `<tr>` children with `slot="head"` to seed the
 *   `<thead>`; every other `<tr>` (or `slot="body"`) lands in the `<tbody>`.
 *   Use the `.was` / `.now` classes and `<code>` chips on cells exactly as in
 *   the prototype markup.
 * - **`headers` attribute (convenience):** a comma-separated list builds a
 *   header row of `<th>` cells when no slotted `<tr slot="head">` is supplied.
 *
 * @attr headers - comma-separated header labels; builds the `<thead>` row when no `slot="head"` row is provided
 * @csspart table - the generated `<table class="ctable">`
 * @csspart head - the `<thead>` region (hidden when empty)
 * @csspart body - the `<tbody>` region
 * @slot head - one or more `<tr>` header rows (relocated into `<thead>`)
 * @slot body - default `<tr>` data rows (relocated into `<tbody>`)
 * @fires slicc-chat-table-change - composed + bubbling; `detail.headers` on `headers` change
 */
export class SliccChatTable extends HTMLElement {
  static readonly observedAttributes = ['headers'];

  #table!: HTMLTableElement;
  #head!: HTMLTableSectionElement;
  #body!: HTMLTableSectionElement;
  #built = false;

  connectedCallback(): void {
    ensureTableStyle(this.ownerDocument);
    this.#build();
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (name !== 'headers' || oldValue === newValue) return;
    if (this.#built) this.#renderHeaders();
    if (this.isConnected) {
      this.dispatchEvent(
        new CustomEvent('slicc-chat-table-change', {
          bubbles: true,
          composed: true,
          detail: { headers: this.headers },
        })
      );
    }
  }

  /** Comma-separated header labels driving the generated `<thead>` row. */
  get headers(): string[] {
    const raw = this.getAttribute('headers');
    return raw ? splitHeaders(raw) : [];
  }

  set headers(value: string[] | string | null) {
    if (value == null) {
      this.removeAttribute('headers');
    } else if (Array.isArray(value)) {
      this.setAttribute('headers', value.join(','));
    } else {
      this.setAttribute('headers', value);
    }
  }

  /**
   * Build the `<table class="ctable">` scaffold once and relocate any
   * pre-existing light `<tr>` children into the head/body regions. Idempotent —
   * safe across re-connects.
   */
  #build(): void {
    if (this.#built) return;
    this.#built = true;

    // Collect children that existed before we owned the subtree.
    const incoming = Array.from(this.childNodes).filter(
      (n) => !(n instanceof HTMLTableElement && n.classList.contains('ctable'))
    );

    this.#table = this.ownerDocument.createElement('table');
    this.#table.className = 'ctable';
    this.#table.setAttribute('part', 'table');

    this.#head = this.ownerDocument.createElement('thead');
    this.#head.setAttribute('part', 'head');

    this.#body = this.ownerDocument.createElement('tbody');
    this.#body.setAttribute('part', 'body');

    this.#table.append(this.#head, this.#body);

    for (const node of incoming) {
      if (node instanceof HTMLElement && node.getAttribute('slot') === 'head') {
        this.#head.appendChild(node);
      } else {
        this.#body.appendChild(node);
      }
    }

    // Seed a header row from the attribute when no slotted header row exists.
    this.#renderHeaders();

    this.appendChild(this.#table);
  }

  /**
   * Populate the `<thead>` from the `headers` attribute. A slotted
   * `<tr slot="head">` always wins — the attribute only fills an empty head.
   */
  #renderHeaders(): void {
    if (!this.#built) return;
    const existing = this.#head.querySelector('tr');
    // A genuinely slotted header row wins; an attribute-generated row is
    // replaceable so live `headers` changes re-render.
    if (existing && !existing.hasAttribute('data-slicc-generated')) return;
    const labels = this.headers;
    if (labels.length === 0) {
      this.#head.replaceChildren();
      return;
    }
    const row = h('tr', { 'data-slicc-generated': '' });
    for (const label of labels) row.append(h('th', null, label));
    this.#head.replaceChildren(row);
  }
}

define('slicc-chat-table', SliccChatTable);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-chat-table': SliccChatTable;
  }
}
