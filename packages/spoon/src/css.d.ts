// SVG imports as raw strings — parsed via DOMParser at runtime so the markup
// can be appended without `.innerHTML`. The `?raw` form is resolved by esbuild
// (build.mjs raw-svg plugin) and by consuming bundlers (Vite's `?raw`).
declare module '*.svg?raw' {
  const svg: string;
  export default svg;
}
