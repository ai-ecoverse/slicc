declare module '*.css?raw' {
  const css: string;
  export default css;
}

declare module '*.css' {
  const css: string;
  export default css;
}

declare module '*.svg?raw' {
  const svg: string;
  export default svg;
}
