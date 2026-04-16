/**
 * <slicc-diff> — Pre-bundled diff viewer custom element for sprinkles.
 *
 * Wraps @pierre/diffs (FileDiff) as a web component that can be used
 * inside sprinkle iframes. The library handles syntax highlighting via
 * Shiki and renders into Shadow DOM automatically.
 *
 * Usage (attributes):
 *   <slicc-diff
 *     old-name="file.ts" old-contents="const x = 1;"
 *     new-name="file.ts" new-contents="const x = 2;"
 *     diff-style="split"
 *   ></slicc-diff>
 *
 * Usage (JS properties):
 *   el.oldFile = { name: 'file.ts', contents: oldCode };
 *   el.newFile = { name: 'file.ts', contents: newCode };
 *
 * Patch mode:
 *   el.patch = unifiedDiffString;
 */

import {
  FileDiff,
  parseDiffFromFile,
  parsePatchFiles,
  type FileContents,
  type ThemeTypes,
} from '@pierre/diffs';
// Register the <diffs-container> web component that provides the core CSS
// via adoptedStyleSheets in its Shadow DOM. FileDiff renders into this element.
// @ts-expect-error — not in package exports map but needed for core CSS injection
import '@pierre/diffs/dist/components/web-components.js';

/** Detect dark/light theme from inherited CSS or class. */
function detectThemeType(): ThemeTypes {
  if (document.documentElement.classList.contains('theme-light')) return 'light';
  return 'dark';
}

export class SliccDiffElement extends HTMLElement {
  private diff: FileDiff | null = null;
  private container: HTMLElement | null = null;
  private connected = false;

  // Property-based API
  private _oldFile: FileContents | null = null;
  private _newFile: FileContents | null = null;
  private _patch: string | null = null;
  private _options: {
    diffStyle?: 'split' | 'unified';
    overflow?: 'scroll' | 'wrap';
    disableFileHeader?: boolean;
  } = {};

  static get observedAttributes() {
    return [
      'old-name',
      'old-contents',
      'new-name',
      'new-contents',
      'patch',
      'diff-style',
      'overflow',
      'disable-header',
    ];
  }

  get oldFile(): FileContents | null {
    return this._oldFile;
  }

  set oldFile(value: FileContents | null) {
    this._oldFile = value;
    this.scheduleRender();
  }

  get newFile(): FileContents | null {
    return this._newFile;
  }

  set newFile(value: FileContents | null) {
    this._newFile = value;
    this.scheduleRender();
  }

  get patch(): string | null {
    return this._patch;
  }

  set patch(value: string | null) {
    this._patch = value;
    this.scheduleRender();
  }

  get options() {
    return this._options;
  }

  set options(value: typeof this._options) {
    this._options = { ...value };
    this.scheduleRender();
  }

  connectedCallback() {
    if (this.connected) return;
    this.connected = true;

    // Ensure the host element is block-level so it has dimensions
    if (!this.style.display) {
      this.style.display = 'block';
    }

    // Use <diffs-container> which provides the core CSS via adoptedStyleSheets
    this.container = document.createElement('diffs-container');
    this.container.style.cssText = 'display:block;width:100%;min-height:0;';
    this.appendChild(this.container);

    // Read initial attributes into properties
    this.syncAttributesToProperties();
    this.scheduleRender();
  }

  disconnectedCallback() {
    this.connected = false;
    this.diff = null;
    this.container = null;
  }

  attributeChangedCallback() {
    if (!this.connected) return;
    this.syncAttributesToProperties();
    this.scheduleRender();
  }

  private syncAttributesToProperties(): void {
    const oldName = this.getAttribute('old-name');
    const oldContents = this.getAttribute('old-contents');
    if (oldName !== null || oldContents !== null) {
      this._oldFile = {
        name: oldName ?? '',
        contents: oldContents ?? '',
      };
    }

    const newName = this.getAttribute('new-name');
    const newContents = this.getAttribute('new-contents');
    if (newName !== null || newContents !== null) {
      this._newFile = {
        name: newName ?? '',
        contents: newContents ?? '',
      };
    }

    const patchAttr = this.getAttribute('patch');
    if (patchAttr !== null) {
      this._patch = patchAttr;
    }

    const diffStyle = this.getAttribute('diff-style');
    if (diffStyle === 'unified' || diffStyle === 'split') {
      this._options.diffStyle = diffStyle;
    }

    const overflow = this.getAttribute('overflow');
    if (overflow === 'scroll' || overflow === 'wrap') {
      this._options.overflow = overflow;
    }

    this._options.disableFileHeader = this.hasAttribute('disable-header');
  }

  private renderTimeout: ReturnType<typeof setTimeout> | null = null;

  private scheduleRender(): void {
    if (this.renderTimeout) return;
    this.renderTimeout = setTimeout(() => {
      this.renderTimeout = null;
      void this.doRender();
    }, 0);
  }

  private async doRender(): Promise<void> {
    if (!this.connected || !this.container) return;

    const themeType = detectThemeType();

    // Create or update the FileDiff instance
    if (!this.diff) {
      this.diff = new FileDiff({
        diffStyle: this._options.diffStyle ?? 'split',
        overflow: this._options.overflow ?? 'scroll',
        theme: { dark: 'pierre-dark', light: 'pierre-light' },
        themeType,
        disableFileHeader: this._options.disableFileHeader ?? false,
      });
    } else {
      this.diff.setThemeType(themeType);
    }

    try {
      if (this._patch) {
        // Patch mode — parsePatchFiles returns ParsedPatch[] with .files arrays
        const patches = parsePatchFiles(this._patch);
        if (patches.length > 0 && patches[0].files.length > 0) {
          this.diff.render({
            fileDiff: patches[0].files[0],
            fileContainer: this.container,
          });
        }
      } else if (this._oldFile && this._newFile) {
        // Two-file mode — pass files directly and let FileDiff handle diffing
        this.diff.render({
          oldFile: this._oldFile,
          newFile: this._newFile,
          fileContainer: this.container,
        });
      }
    } catch (err) {
      console.error('[slicc-diff] render error:', err);
    }
  }
}

if (!customElements.get('slicc-diff')) {
  customElements.define('slicc-diff', SliccDiffElement);
}
