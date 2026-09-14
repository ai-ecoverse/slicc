import { define } from '../internal/define.js';
import { h } from '../internal/dom.js';

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
  overflow-wrap: anywhere;
  word-break: break-word;
}
`;

const STYLE_ID = 'slicc-chat-table-style';

function ensureTableStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

function splitHeaders(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

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

  #build(): void {
    if (this.#built) return;
    this.#built = true;

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

    this.#renderHeaders();

    this.appendChild(this.#table);
  }

  #renderHeaders(): void {
    if (!this.#built) return;
    const existing = this.#head.querySelector('tr');

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
