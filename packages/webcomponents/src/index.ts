// @slicc/webcomponents — public barrel.
//
// Importing a component module self-registers its custom element (see
// internal/define.ts). Re-export each class for typed construction and the
// theme utilities. registerAllSliccComponents() is the convenience entry that
// imports every element for side-effect registration.

export { define } from './internal/define.js';
export { SliccLogo } from './primitives/slicc-logo.js';
export { registerAllSliccComponents } from './register.js';
export * from './theme/tokens.js';
