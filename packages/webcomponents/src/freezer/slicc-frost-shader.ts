import { define } from '../internal/define.js';
import { SliccShader } from './slicc-shader.js';

/**
 * `<slicc-frost-shader>` — the freezer frost background. A thin back-compat alias
 * of `<slicc-shader mode="freezer">` (the prototype's `FRAG_FREEZER` program):
 * water crystallizing into ice from the corner. New code should prefer
 * `<slicc-shader mode="freezer">`; this element forces `freezer` mode and keeps
 * the original `coverage` / `intensity` / `no-webgl` API.
 */
export class SliccFrostShader extends SliccShader {
  connectedCallback(): void {
    if (this.getAttribute('mode') !== 'freezer') this.setAttribute('mode', 'freezer');
    super.connectedCallback();
  }
}

define('slicc-frost-shader', SliccFrostShader);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-frost-shader': SliccFrostShader;
  }
}
