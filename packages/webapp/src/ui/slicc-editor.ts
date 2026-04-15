/**
 * <slicc-editor> — Pre-bundled CodeMirror 6 custom element for sprinkles.
 *
 * Ships as a standalone IIFE injected into sprinkle iframes so that
 * CM6's singleton `instanceof` checks work (all packages share one bundle).
 *
 * Usage:
 *   <slicc-editor language="json" line-numbers>placeholder text</slicc-editor>
 *
 * API:
 *   .value          get/set editor content
 *   .addEventListener('change', e => e.detail.value)
 *   .setHighlighter(streamParser)   custom StreamLanguage mode
 *   .setGutterMarkers(markers)      gutter annotations
 */

import { EditorState, Compartment, type Extension } from '@codemirror/state';
import {
  EditorView,
  keymap,
  placeholder,
  lineNumbers,
  gutter,
  GutterMarker,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import {
  defaultHighlightStyle,
  syntaxHighlighting,
  StreamLanguage,
  type StreamParser,
} from '@codemirror/language';
import { HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';

// Built-in language imports (lazy-loaded via compartment swap)
const LANG_LOADERS: Record<string, () => Promise<Extension>> = {
  json: async () => {
    const { json } = await import('@codemirror/lang-json');
    return json();
  },
  markdown: async () => {
    const { markdown } = await import('@codemirror/lang-markdown');
    return markdown();
  },
  html: async () => {
    const { html } = await import('@codemirror/lang-html');
    return html();
  },
};

/**
 * Build the S2-themed CodeMirror highlight style.
 * Uses hardcoded colors that match the .tok-* classes from markdown.css / tokens.css.
 * Dark/light detection is done at mount time by checking inherited CSS variables.
 */
function buildHighlightStyle(isDark: boolean): HighlightStyle {
  if (isDark) {
    return HighlightStyle.define([
      { tag: tags.keyword, color: '#d19afc' },
      { tag: tags.string, color: '#87d68d' },
      { tag: tags.number, color: '#f5a76c' },
      { tag: tags.comment, color: '#8a8a8a', fontStyle: 'italic' },
      { tag: tags.punctuation, color: '#7cc5e9' },
      { tag: tags.function(tags.variableName), color: '#7ea8f8' },
      { tag: tags.propertyName, color: '#7ea8f8' },
      { tag: tags.bool, color: '#f5a76c' },
      { tag: tags.null, color: '#f5a76c' },
      { tag: tags.operator, color: '#7cc5e9' },
      { tag: tags.typeName, color: '#d19afc' },
      { tag: tags.tagName, color: '#d19afc' },
      { tag: tags.attributeName, color: '#87d68d' },
      { tag: tags.attributeValue, color: '#87d68d' },
      { tag: tags.heading, fontWeight: 'bold' },
      { tag: tags.emphasis, fontStyle: 'italic' },
      { tag: tags.strong, fontWeight: 'bold' },
    ]);
  }
  return HighlightStyle.define([
    { tag: tags.keyword, color: '#8839ef' },
    { tag: tags.string, color: '#40a02b' },
    { tag: tags.number, color: '#d05d1a' },
    { tag: tags.comment, color: '#8a8a8a', fontStyle: 'italic' },
    { tag: tags.punctuation, color: '#1e66f5' },
    { tag: tags.function(tags.variableName), color: '#2b6cb0' },
    { tag: tags.propertyName, color: '#2b6cb0' },
    { tag: tags.bool, color: '#d05d1a' },
    { tag: tags.null, color: '#d05d1a' },
    { tag: tags.operator, color: '#1e66f5' },
    { tag: tags.typeName, color: '#8839ef' },
    { tag: tags.tagName, color: '#8839ef' },
    { tag: tags.attributeName, color: '#40a02b' },
    { tag: tags.attributeValue, color: '#40a02b' },
    { tag: tags.heading, fontWeight: 'bold' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: tags.strong, fontWeight: 'bold' },
  ]);
}

/** Detect dark/light theme from inherited CSS vars or class. */
function detectDarkMode(el: HTMLElement): boolean {
  // Check for .theme-light on any ancestor
  if (el.closest?.('.theme-light')) return false;
  if (document.documentElement.classList.contains('theme-light')) return false;
  // Default to dark
  return true;
}

/** Build the CM6 editor theme using S2 CSS custom properties. */
function buildEditorTheme() {
  return EditorView.theme({
    '&': {
      fontSize: '13px',
      border: '1px solid var(--s2-border-subtle, #333)',
      borderRadius: 'var(--s2-radius-default, 8px)',
      overflow: 'hidden',
    },
    '&.cm-focused': {
      outline: 'none',
      borderColor: 'var(--s2-border-focus, var(--s2-accent, #3562ff))',
    },
    '.cm-content': {
      fontFamily: 'var(--s2-font-mono, "SF Mono", "Fira Code", Consolas, monospace)',
      caretColor: 'var(--s2-accent, #3562ff)',
      padding: '8px 0',
    },
    '.cm-scroller': {
      overflow: 'auto',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: 'var(--s2-accent, #3562ff)',
    },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground':
      {
        background: 'color-mix(in srgb, var(--s2-accent, #3562ff) 20%, transparent)',
      },
    '.cm-activeLine': {
      background: 'color-mix(in srgb, var(--s2-accent, #3562ff) 5%, transparent)',
    },
    '.cm-gutters': {
      backgroundColor: 'var(--s2-bg-layer-1, #1a1a1a)',
      color: 'var(--s2-content-tertiary, #5a5a5a)',
      borderRight: 'none',
      borderRadius: 'var(--s2-radius-default, 8px) 0 0 var(--s2-radius-default, 8px)',
    },
    '.cm-lineNumbers .cm-gutterElement': {
      padding: '0 8px 0 12px',
      minWidth: '32px',
    },
    '.cm-placeholder': {
      color: 'var(--s2-content-tertiary, #5a5a5a)',
      fontStyle: 'italic',
    },
  });
}

/** CSS injected into the shadow DOM for base styling. */
const SHADOW_CSS = `
:host {
  display: block;
  background: var(--s2-bg-layer-2, var(--s2-gray-75, #252525));
  border-radius: var(--s2-radius-default, 8px);
  color: var(--s2-content-default, #cfcfcf);
}
.cm-editor {
  background: var(--s2-bg-layer-2, var(--s2-gray-75, #252525));
}
`;

/** Custom gutter marker with a colored dot. */
class DotMarker extends GutterMarker {
  constructor(
    private color: string,
    private tooltip?: string
  ) {
    super();
  }
  toDOM(): HTMLElement {
    const dot = document.createElement('span');
    dot.style.cssText = `display:inline-block;width:8px;height:8px;border-radius:50%;background:${this.color};`;
    if (this.tooltip) dot.title = this.tooltip;
    return dot;
  }
}

export class SliccEditorElement extends HTMLElement {
  private view: EditorView | null = null;
  private langCompartment = new Compartment();
  private highlightCompartment = new Compartment();
  private lineNumberCompartment = new Compartment();
  private readonlyCompartment = new Compartment();
  private gutterCompartment = new Compartment();
  private placeholderCompartment = new Compartment();
  private shadowRoot_: ShadowRoot;
  private placeholderText = '';
  private connected = false;

  static get observedAttributes() {
    return ['language', 'line-numbers', 'readonly'];
  }

  constructor() {
    super();
    this.shadowRoot_ = this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    if (this.connected) return;
    this.connected = true;

    // Read placeholder from initial text content before CM6 replaces DOM
    this.placeholderText = this.textContent?.trim() ?? '';
    this.textContent = '';

    const isDark = detectDarkMode(this);
    const highlightStyle = buildHighlightStyle(isDark);

    // Build initial extensions
    const extensions: Extension[] = [
      buildEditorTheme(),
      this.highlightCompartment.of(syntaxHighlighting(highlightStyle)),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      this.langCompartment.of([]),
      this.lineNumberCompartment.of(this.hasAttribute('line-numbers') ? lineNumbers() : []),
      this.readonlyCompartment.of(EditorState.readOnly.of(this.hasAttribute('readonly'))),
      this.gutterCompartment.of([]),
      this.placeholderCompartment.of(this.placeholderText ? placeholder(this.placeholderText) : []),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          this.dispatchEvent(
            new CustomEvent('change', {
              detail: { value: update.state.doc.toString() },
              bubbles: true,
            })
          );
        }
      }),
    ];

    // Inject styles into shadow DOM
    const style = document.createElement('style');
    style.textContent = SHADOW_CSS;
    this.shadowRoot_.appendChild(style);

    // Create the editor container
    const container = document.createElement('div');
    this.shadowRoot_.appendChild(container);

    this.view = new EditorView({
      state: EditorState.create({ extensions }),
      parent: container,
      root: this.shadowRoot_,
    });

    // Load initial language if specified
    const lang = this.getAttribute('language');
    if (lang) {
      void this.loadLanguage(lang);
    }
  }

  disconnectedCallback() {
    this.view?.destroy();
    this.view = null;
    this.connected = false;
  }

  attributeChangedCallback(name: string, _oldValue: string | null, newValue: string | null) {
    if (!this.view) return;

    switch (name) {
      case 'language':
        if (newValue) {
          void this.loadLanguage(newValue);
        } else {
          this.view.dispatch({
            effects: this.langCompartment.reconfigure([]),
          });
        }
        break;
      case 'line-numbers':
        this.view.dispatch({
          effects: this.lineNumberCompartment.reconfigure(newValue !== null ? lineNumbers() : []),
        });
        break;
      case 'readonly':
        this.view.dispatch({
          effects: this.readonlyCompartment.reconfigure(EditorState.readOnly.of(newValue !== null)),
        });
        break;
    }
  }

  /** Get the current editor content. */
  get value(): string {
    return this.view?.state.doc.toString() ?? '';
  }

  /** Set the editor content, replacing everything. */
  set value(text: string) {
    if (!this.view) return;
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
    });
  }

  /**
   * Set a custom syntax highlighter using a StreamLanguage parser.
   * The parser object should have a `token(stream, state)` method.
   */
  setHighlighter(parser: StreamParser<unknown>): void {
    if (!this.view) return;
    const lang = StreamLanguage.define(parser);
    this.view.dispatch({
      effects: this.langCompartment.reconfigure(lang),
    });
  }

  /**
   * Set gutter markers on specific lines.
   * @param markers Record of 1-based line numbers to marker config.
   */
  setGutterMarkers(markers: Record<number, { color: string; tooltip?: string }>): void {
    if (!this.view) return;

    const markerMap = new Map<number, DotMarker>();
    for (const [lineStr, config] of Object.entries(markers)) {
      markerMap.set(Number(lineStr), new DotMarker(config.color, config.tooltip));
    }

    const gutterExt = gutter({
      class: 'cm-slicc-markers',
      lineMarker: (view, line) => {
        const lineNo = view.state.doc.lineAt(line.from).number;
        return markerMap.get(lineNo) ?? null;
      },
    });

    this.view.dispatch({
      effects: this.gutterCompartment.reconfigure(gutterExt),
    });
  }

  private async loadLanguage(name: string): Promise<void> {
    const loader = LANG_LOADERS[name.toLowerCase()];
    if (!loader) {
      // Unknown language — clear the language extension
      this.view?.dispatch({
        effects: this.langCompartment.reconfigure([]),
      });
      return;
    }

    const ext = await loader();
    this.view?.dispatch({
      effects: this.langCompartment.reconfigure(ext),
    });
  }
}

customElements.define('slicc-editor', SliccEditorElement);
