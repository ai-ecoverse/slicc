import { define } from '../internal/define.js';
import { SliccShader } from './slicc-shader.js';

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
