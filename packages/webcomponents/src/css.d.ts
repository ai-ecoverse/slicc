// CSS imports used by components and tooling. `?raw` returns the stylesheet text
// (Vite feature) so components can adopt it into a constructable stylesheet; the
// bare `*.css` form is a side-effecting style import used by Storybook/preview.
declare module '*.css?raw' {
  const css: string;
  export default css;
}

declare module '*.css' {
  const css: string;
  export default css;
}

// SVG imports as raw strings — parsed via DOMParser at runtime so the markup
// can be appended without `.innerHTML` (forbidden in shipped component source;
// see `lint:no-innerhtml`).
declare module '*.svg?raw' {
  const svg: string;
  export default svg;
}
